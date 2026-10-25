/**
 * lib/deliver.mjs —— 把日报"送到人手上"
 * ============================================================================
 * 三条通道，各自可关：
 *   ① **会话投递**：`ctx.get('agents').get(sessionId).followup(message)` —— 直接推进某个 DSH 会话，
 *      会话里的 AI 会当场把要点说出来（机制抄 dsh-selfwake，MIT；它的血泪教训：必须
 *      `source: { kind: 'user' }` + `followup()`，换成 send/steer 消息就进不了界面）。
 *   ② **邮件**：nodemailer 走 SMTP。授权码不写进 config.json —— 交给 DSH 的 credentials 服务
 *      （`ctx.get('credentials').set(ref, value)`），拿不到服务才退到配置文件并明确警告。
 *   ③ **桌面通知**：PowerShell 弹 Toast，兜底用（窗口没开、会话不在活跃列表时它至少能"响一下"）。
 *
 * ⚠️ 会话投递会让那个会话**真的跑一轮模型**（因为消息来源是 user）—— 这是有成本的，
 *    所以默认只投一个短摘要 + "让我说两句"的指令，不把整篇日报塞进去。
 * ============================================================================
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/* ───────────────────────── 从日报里抽摘要 ───────────────────────── */

export function summarizeReport(md, { file = '', mirror = '' } = {}) {
  const text = String(md || '')
  const lines = text.split(/\r?\n/)
  const dateMatch = text.match(/小红书热点日报\s*[·・\-]\s*(\d{4}-\d{2}-\d{2})/)
  const date = dateMatch ? dateMatch[1] : ''
  const oneLiner = (() => {
    for (const l of lines) {
      const m = l.match(/^>\s*(?:\*\*)?一句话总结(?:\*\*)?[:：]\s*(.+)$/)
      if (m) return m[1].trim()
    }
    return ''
  })()

  /** 取某个二级标题下所有 `### ` 标题 */
  const sectionItems = (headingRe) => {
    const out = []
    let on = false
    for (const l of lines) {
      if (/^##\s/.test(l)) {
        if (on) break
        on = headingRe.test(l)
        continue
      }
      if (!on) continue
      const m = l.match(/^###\s+(.+)$/)
      // 报告里主题/事件可能自带「1. 」「2、」编号 —— 别在摘要里变成「1. 1. xxx」
      if (m) out.push(m[1].trim().replace(/^\d+\s*[.、)]\s*/, ''))
    }
    return out
  }

  const topics = sectionItems(/今日热点主题/)
  const events = sectionItems(/热点事件/)
  const picks = sectionItems(/值得细看/)
  const account = (() => {
    const out = []
    let on = false
    for (const l of lines) {
      if (/^##\s/.test(l)) { if (on) break; on = /本轮口径/.test(l); continue }
      if (on && /^[-*]\s/.test(l)) out.push(l.replace(/^[-*]\s+/, '').trim())
    }
    return out
  })()

  return { date, oneLiner, topics, events, picks, account, file, mirror, chars: text.length }
}

/** 日报 → 给人看的纯文本摘要（邮件 / 通知共用） */
export function summaryText(s, { includeReport = true } = {}) {
  const out = []
  if (s.oneLiner) out.push(s.oneLiner)
  if (s.topics.length) {
    out.push('', '热点主题：')
    s.topics.forEach((t, i) => out.push(`  ${i + 1}. ${t}`))
  }
  if (s.events.length) {
    out.push('', '热点事件：')
    s.events.forEach((t) => out.push(`  · ${t}`))
  }
  if (s.picks.length) out.push('', `值得细看：${s.picks.length} 篇`)
  if (includeReport) {
    out.push('', '完整日报：')
    if (s.mirror) out.push(`  ${s.mirror}`)
    if (s.file) out.push(`  ${s.file}`)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/* ───────────────────────── 会话投递 ───────────────────────── */

/** 扫 sessions 目录找最近的会话 id（只看目录 mtime，不碰会话正文） */
export function latestSessionIds(sessionsRoot, limit = 5) {
  const found = []
  const walk = (dir, depth) => {
    if (depth > 2) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const p = join(dir, entry.name)
      if (entry.name.startsWith('session-')) {
        let m = 0
        try {
          for (const f of readdirSync(p)) {
            try { const st = statSync(join(p, f)); if (st.mtimeMs > m) m = st.mtimeMs } catch { /* 跳过 */ }
          }
        } catch { /* 跳过 */ }
        found.push({ id: entry.name, mtime: m })
      } else {
        walk(p, depth + 1)
      }
    }
  }
  walk(sessionsRoot, 0)
  return found.sort((a, b) => b.mtime - a.mtime).slice(0, limit).map((x) => x.id)
}

/**
 * 把一段话**真的投进某个会话**。
 * 语义：这会让那个会话里跑一次模型（消息来源是 user）—— 我们故意这么用：
 * 让 AI 用两句话把今天的要点说出来，比扔一堆文件路径有用。
 */
export function deliverToSession(ctx, { sessionsRoot, text, sessionId, strict = false }) {
  const agents = ctx.get?.('agents')
  if (!agents || typeof agents.get !== 'function') return { ok: false, why: '拿不到 agents 服务（宿主版本不支持？）' }

  const candidates = []
  if (sessionId) candidates.push(sessionId)
  // strict：钉死了会话就**只**投它（不活跃就失败），免得日报跑到别人的话题里
  if (!strict) {
    for (const id of latestSessionIds(sessionsRoot)) if (!candidates.includes(id)) candidates.push(id)
  }

  const tried = []
  for (const id of candidates) {
    let handle
    try { handle = agents.get(id) } catch (e) { tried.push(`${id.slice(0, 14)}…(get 抛错)`); continue }
    if (!handle) { tried.push(`${id.slice(0, 14)}…(不活跃)`); continue }
    const agent = handle.agent ?? handle
    const message = {
      id: `xhs-duty-${Date.now()}`,
      role: 'user',
      content: [{ type: 'text', text }],
      // 🔴 别改成 'plugin'/'system'：dsh-selfwake 实测只有 kind:'user' 这条路的消息会真的进界面
      source: { kind: 'user' },
    }
    try {
      if (typeof agent.followup === 'function') agent.followup(message)
      else if (typeof agent.send === 'function') agent.send(message, 'next-turn', true)
      else { tried.push(`${id.slice(0, 14)}…(没有投递口)`); continue }
      return { ok: true, sessionId: id, via: typeof agent.followup === 'function' ? 'followup' : 'send' }
    } catch (e) {
      tried.push(`${id.slice(0, 14)}…(${String(e?.message ?? e).slice(0, 40)})`)
    }
  }
  return { ok: false, why: candidates.length ? `没有可用会话：${tried.join(' / ')}` : '没有找到任何会话' }
}

/* ───────────────────────── 邮件 ───────────────────────── */

/**
 * 发邮件。nodemailer 是**按需 import**：没装也不影响其它通道。
 * 授权码来源（优先级）：显式传入的 pass > DSH credentials（ref 名默认 XHS_SMTP_PASS）> config 里的 pass
 */
export async function sendMail({ host, port = 465, secure = true, user, pass, from, to, subject, text, html, attachments = [] }) {
  if (!host || !user || !pass || !to) {
    return { ok: false, why: '邮件配置不全（要有 SMTP 服务器 / 账号 / 授权码 / 收件人）' }
  }
  let nodemailer
  try { nodemailer = (await import('nodemailer')).default ?? (await import('nodemailer')) }
  catch (e) { return { ok: false, why: `没装 nodemailer（在插件目录跑一次 npm install）：${String(e?.message ?? e).slice(0, 80)}` } }

  try {
    const transporter = nodemailer.createTransport({
      host,
      port: Number(port) || 465,
      secure: Boolean(secure),
      auth: { user, pass },
      connectionTimeout: 20000,
      greetingTimeout: 15000,
      socketTimeout: 30000,
    })
    const info = await transporter.sendMail({
      from: from || user,
      to,
      subject,
      text,
      html,
      attachments,
    })
    return { ok: true, messageId: info.messageId, accepted: info.accepted, response: String(info.response || '').slice(0, 120) }
  } catch (e) {
    return { ok: false, why: `发信失败：${String(e?.message ?? e).slice(0, 200)}` }
  }
}

/** 把 markdown 粗略转成能看的 HTML（不引依赖） */
export function markdownToHtml(md) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const out = []
  let inList = false
  const closeList = () => { if (inList) { out.push('</ul>'); inList = false } }
  for (const raw of String(md || '').split(/\r?\n/)) {
    const line = raw.trimEnd()
    if (!line.trim()) { closeList(); out.push(''); continue }
    const h = line.match(/^(#{1,4})\s+(.+)$/)
    if (h) {
      closeList()
      const level = Math.min(h[1].length + 1, 5)
      out.push(`<h${level}>${esc(h[2])}</h${level}>`)
      continue
    }
    if (/^>\s?/.test(line)) { closeList(); out.push(`<blockquote>${esc(line.replace(/^>\s?/, ''))}</blockquote>`); continue }
    if (/^[-*]\s+/.test(line)) {
      if (!inList) { out.push('<ul>'); inList = true }
      out.push(`<li>${esc(line.replace(/^[-*]\s+/, '')).replace(/\[(.+?)\]\((https?:[^)]+)\)/g, '<a href="$2">$1</a>')}</li>`)
      continue
    }
    closeList()
    out.push(`<p>${esc(line).replace(/\[(.+?)\]\((https?:[^)]+)\)/g, '<a href="$2">$1</a>')}</p>`)
  }
  closeList()
  return `<div style="font:14px/1.7 -apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif;color:#222;max-width:720px;margin:0 auto">${out.join('\n')}</div>`
}

/* ───────────────────────── 桌面通知 ───────────────────────── */

/**
 * Windows Toast（best-effort）。不开新依赖：借 PowerShell 的 WinRT Toast。
 * 失败就是失败，绝不抛 —— 通知永远只是兜底。
 */
export function toastNotify({ title, body, spawn, log = () => {} }) {
  if (process.platform !== 'win32') return { ok: false, why: '只有 Windows 做了通知' }
  const clean = (s) => String(s || '').replace(/[`"]/g, '').slice(0, 300)
  const ps = [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null',
    `$t = '${clean(title || '刷小红书')}'`,
    `$b = '${clean(body || '')}'`,
    '$xml = "<toast><visual><binding template=\\"ToastGeneric\\"><text>$t</text><text>$b</text></binding></visual></toast>"',
    '$doc = New-Object Windows.Data.Xml.Dom.XmlDocument',
    '$doc.LoadXml($xml)',
    '$toast = New-Object Windows.UI.Notifications.ToastNotification $doc',
    '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("刷小红书").Show($toast)',
  ].join('\r\n')
  try {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, stdio: 'ignore' })
    child.on?.('error', (e) => log(`桌面通知失败：${e?.message ?? e}`))
    return { ok: true, why: '已交给 PowerShell（不保证弹出来）' }
  } catch (e) {
    return { ok: false, why: String(e?.message ?? e) }
  }
}

/** 默认家目录（拿不到 ctx 时兜底） */
export function defaultSessionsRoot() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'sessions')
}

/** 读文件（读不到返回空串） */
export function readIf(p) {
  try { return existsSync(p) ? readFileSync(p, 'utf8') : '' } catch { return '' }
}
