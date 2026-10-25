/**
 * dsh-xhs-scroll —— host 半端（中文名「刷小红书」）
 * ============================================================================
 * 骨架照搬 dsh-bili-scroll（MIT），三件事一模一样：
 *   1. 插件内部起那份 MCP（`server/mcp_server.mjs`），把能力注册成 dsh 工具；
 *   2. 每天到点开跑：`dsh --profile headless --patch <overlay> <prompt>`，
 *      overlay 把 MCP 挂进那一轮，prompt 里塞 `duty.md`（章程）+ 用户配置；
 *   3. 设置页（client.js）通过 `/api/xhs-duty/*` 读写配置、看状态、扫码登录、看日报。
 *
 * 跟 B站 那套的三处不同（都是小红书这边的硬约束）：
 *   · **抓取在浏览器里做**（Playwright + 本机 Edge），且**必须 headful**（无头会被判风险环境）；
 *   · **搜索必须登录** ⇒ 首次要在设置页扫一次码，Cookie 存在插件家目录的 browser-profile 里；
 *   · **只读**：绝不点赞/收藏/评论/关注 —— 工具层就没有这些能力。
 *
 * 家里（`$DSH_HOME/xhs-duty/`）：config.json / browser-profile/ / duty.md / out/ / digest/ / seen.md / 两个 log。
 * ============================================================================
 */
import { loadHostDeps } from './lib/hostdeps.mjs'

const hostDeps = await loadHostDeps()
const defineTool = hostDeps.defineTool

import { spawn } from 'node:child_process'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpClient } from './lib/mcp.mjs'
import { stateDirOf, readJson, writeJson, ensureCharter, charterPath, minutesOf, dayKey, monthKey } from './lib/state.mjs'
import { summarizeReport, summaryText, deliverToSession, sendMail, markdownToHtml, toastNotify, defaultSessionsRoot, readIf } from './lib/deliver.mjs'

export const name = 'xhs-scroll'
export const inject = ['webServer', 'tools']

/* 默认关注方向（用户在设置页里一行一个改掉就行） */
const DEFAULT_DIRECTIONS = ['AI 工具 / 效率', '消费 / 品牌', '职场 / 副业']

/** 工作区镜像目录的默认值：**留空 = 不镜像**（在设置页里自己填，别把别人的路径写死） */
const DEFAULT_MIRROR = ''

const DEFAULTS = {
  enabled: true,
  runAt: '21:00',
  catchUp: true,
  directions: DEFAULT_DIRECTIONS.join('\n'),
  perDirection: 20,
  deepRead: 8,
  sort: 'general',
  readComments: true,
  reportLevel: 'full',
  mirrorDir: DEFAULT_MIRROR,
  workspace: '',
  headlessProfile: 'headless',
  dshBin: '',
  overlayMcp: true,
  channel: 'msedge',
  pythonPath: '',
  // ── 投递（怎么把结果送到你手上）──
  /** off=不投 / latest=投给最近活跃的会话 / fixed=投给 sessionId 指定的那个 */
  sessionTarget: 'latest',
  sessionId: '',
  /** 会话里让 AI 用几句话把要点说出来（而不是把全文塞进去） */
  sessionSpeak: true,
  deliverMail: false,
  smtpHost: 'smtp.qq.com',
  smtpPort: 465,
  smtpSecure: true,
  smtpUser: '',
  smtpFrom: '',
  mailTo: '',
  /** ⚠️ 只有 DSH credentials 服务拿不到时才用这个明文兜底 */
  smtpPass: '',
  deliverToast: false,
  /** 撞到风控信号后冷却多少小时（这期间一律不许再跑） */
  riskCooldownHours: 24,
}

/** SMTP 授权码在 DSH credentials 里的引用名（不写进 config.json） */
const SMTP_REF = 'XHS_SMTP_PASS'

export function apply(ctx, config) {
  const pluginDir = dirname(fileURLToPath(import.meta.url))
  const stateDir = stateDirOf(ctx)
  const cfgFile = join(stateDir, 'config.json')
  const logFile = join(stateDir, 'duty.log')
  const installLogFile = join(stateDir, 'install.log')
  const outDir = join(stateDir, 'out')
  const digestDir = join(stateDir, 'digest')
  const seenFile = join(stateDir, 'seen.md')
  const stateFile = join(stateDir, 'state.json')
  const serverScript = join(pluginDir, 'server', 'mcp_server.mjs')
  mkdirSync(outDir, { recursive: true })
  mkdirSync(digestDir, { recursive: true })

  const myVer = () => {
    try { return String(JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8')).version || '') } catch { return '' }
  }

  const log = (msg) => {
    const line = `${new Date().toISOString()}  ${msg}`
    try { appendFileSync(logFile, line + '\n', 'utf8') } catch { /* 写不进去也不致命 */ }
    try { ctx.logger?.info?.(`[xhs-duty] ${msg}`) } catch { /* 没有 logger 就算了 */ }
  }
  const appendInstall = (s) => { try { appendFileSync(installLogFile, s, 'utf8') } catch { /* 无所谓 */ } }

  for (const n of hostDeps.notes) log(n)

  /* ─────────────── 配置 ───────────────
   * ⚠️ 2026-10-14 事故（dsh-bili-scroll 那边踩的，照抄教训）：apply 传进来的 config 字段值
   *    **不保证是标量**；对象是真值，守卫会全部失效 ⇒ 定时器回调里抛 TypeError ⇒ 整个宿主被杀。
   *    ⇒ ① 逐字段按默认值类型挑一遍；② 定时器回调绝不让异常外冒。
   */
  const normalize = (src, base) => {
    const out = { ...base }
    for (const k of Object.keys(base)) {
      const v = src?.[k]
      if (v === undefined || v === null) continue
      if (Array.isArray(base[k])) { if (Array.isArray(v)) out[k] = v.filter((x) => typeof x === 'string') }
      else if (typeof base[k] === 'number') { const n = Number(v); if (Number.isFinite(n)) out[k] = n }
      else if (typeof base[k] === 'boolean') { if (typeof v === 'boolean') out[k] = v }
      else if (typeof base[k] === 'string') { if (typeof v === 'string') out[k] = v }
    }
    return out
  }

  const clampPatch = (patch) => {
    const p = { ...patch }
    if ('perDirection' in p) p.perDirection = Math.max(5, Math.min(Number(p.perDirection) || 20, 50))
    if ('deepRead' in p) p.deepRead = Math.max(1, Math.min(Number(p.deepRead) || 8, 30))
    if ('reportLevel' in p) p.reportLevel = ['full', 'brief'].includes(String(p.reportLevel)) ? String(p.reportLevel) : 'full'
    if ('sort' in p) p.sort = ['general', 'latest', 'popular'].includes(String(p.sort)) ? String(p.sort) : 'general'
    if ('channel' in p) p.channel = ['msedge', 'chrome', 'chromium'].includes(String(p.channel)) ? String(p.channel) : 'msedge'
    if ('runAt' in p) p.runAt = minutesOf(p.runAt) === null ? '21:00' : String(p.runAt)
    if ('sessionTarget' in p) p.sessionTarget = ['off', 'latest', 'fixed'].includes(String(p.sessionTarget)) ? String(p.sessionTarget) : 'off'
    if ('smtpPort' in p) p.smtpPort = Math.max(1, Math.min(Number(p.smtpPort) || 465, 65535))
    if ('riskCooldownHours' in p) p.riskCooldownHours = Math.max(1, Math.min(Number(p.riskCooldownHours) || 24, 240))
    if ('smtpSecure' in p) p.smtpSecure = Boolean(p.smtpSecure)
    if ('deliverMail' in p) p.deliverMail = Boolean(p.deliverMail)
    if ('deliverToast' in p) p.deliverToast = Boolean(p.deliverToast)
    if ('sessionSpeak' in p) p.sessionSpeak = Boolean(p.sessionSpeak)
    if ('directions' in p) {
      const lines = String(p.directions || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 12)
      p.directions = lines.join('\n')
    }
    return p
  }

  let cfg = normalize(readJson(cfgFile, {}), normalize(config, { ...DEFAULTS }))
  const refreshCfg = () => { cfg = normalize({ ...cfg, ...readJson(cfgFile, {}) }, { ...DEFAULTS }); return cfg }
  const saveCfg = (patch) => {
    const next = normalize({ ...cfg, ...clampPatch(patch) }, { ...DEFAULTS })
    writeJson(cfgFile, next)
    cfg = next
    return cfg
  }
  const directions = () => String(cfg.directions || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)

  /* ─────────────── MCP 子进程（host 侧） ─────────────── */

  const nodeCmd = () => process.execPath
  const mcpEnv = (extra = {}) => ({
    ...process.env,
    XHS_DUTY_HOME: stateDir,
    XHS_CHANNEL: String(cfg.channel || 'msedge'),
    PYTHONUTF8: '1',
    ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    ...extra,
  })

  let mcp = null
  let mcpStarting = null
  const ensureMcp = async () => {
    if (mcp?.running) return mcp
    if (mcpStarting) return mcpStarting
    mcpStarting = (async () => {
      if (!existsSync(serverScript)) throw new Error(`缺文件：${serverScript}`)
      const client = new McpClient({
        command: nodeCmd(),
        args: [serverScript],
        cwd: pluginDir,
        env: mcpEnv(),
        log,
      })
      await client.start()
      mcp = client
      return client
    })()
    try { return await mcpStarting } finally { mcpStarting = null }
  }
  const call = async (toolName, args, opts) => {
    const client = await ensureMcp()
    return client.call(toolName, args, opts)
  }
  const stopMcp = () => { try { mcp?.stop() } catch { /* 已停 */ }; mcp = null }

  /* ─────────────── 登录标记（跑一轮的门禁） ─────────────── */

  const loginFile = join(stateDir, 'login.json')
  /**
   * 登录成功后记一笔。跑一轮**之前**拿它当门禁：
   * 2026-10-18 的教训 —— 登录判定假阳性让使用者以为登好了，结果跑了一轮，
   * 小红书把搜索挡在登录墙上 ⇒ 白烧一轮 + 写出一份"失败日报"。没登录就别开跑。
   */
  const markLoggedIn = (r) => {
    try { writeJson(loginFile, { at: new Date().toISOString(), nickname: String(r?.nickname || '') }) } catch (e) { log(`写登录标记失败：${e?.message ?? e}`) }
  }
  const loginInfo = () => readJson(loginFile, null)

  /* ─────────────── 风控冷却（熔断） ───────────────
   * 2026-10-19：使用者在 App 里收到「异常操作」提醒之后加的。
   * 规矩：**抓取端看到风险信号就留痕 → 宿主记账 → 冷却期内一律不许再跑**。
   * ⚠️ 这不是"伪装"，是"撞了墙就别再撞"。
   */
  const riskFile = join(stateDir, 'risk.json')
  const riskSignalsFile = join(stateDir, 'risk-signals.jsonl')
  const riskState = () => readJson(riskFile, { pauseUntil: 0 })
  const cooldownLeftMs = () => Math.max(0, Number(riskState().pauseUntil || 0) - Date.now())
  const fmtLeft = (ms) => {
    const h = Math.floor(ms / 3600000)
    const m = Math.round((ms % 3600000) / 60000)
    return h > 0 ? `${h} 小时 ${m} 分钟` : `${m} 分钟`
  }
  const setPause = (hours, reason, extra = {}) => {
    const until = Date.now() + Math.max(0, hours) * 3600_000
    writeJson(riskFile, { ...riskState(), ...extra, pauseUntil: until, reason, at: new Date().toISOString() })
    return riskState()
  }
  const clearPause = (why) => {
    writeJson(riskFile, { ...riskState(), pauseUntil: 0, clearedAt: new Date().toISOString(), clearedNote: String(why || '') })
    log('风控冷却已手动解除')
    return riskState()
  }
  /** 把抓取端攒下的风险信号消费掉，并据此开启冷却 */
  const consumeRiskSignals = () => {
    let lines = []
    try { lines = readFileSync(riskSignalsFile, 'utf8').split('\n').filter(Boolean) } catch { return null }
    if (!lines.length) return null
    let last = null
    try { last = JSON.parse(lines[lines.length - 1]) } catch { last = { kind: 'unknown' } }
    try { writeFileSync(riskSignalsFile, '', 'utf8') } catch { /* 清不掉也没关系 */ }
    const hours = Math.max(1, Math.min(Number(cfg.riskCooldownHours) || 24, 240))
    setPause(hours, `风控信号：${last?.kind || 'unknown'}`, { lastSignal: last })
    log(`⚠️ 检测到风控信号（${last?.kind || 'unknown'}：${String(last?.detail || '').slice(0, 60)}）⇒ 冷却 ${hours} 小时`)
    return { signal: last, hours }
  }

  /* ─────────────── 投递：会话 / 邮件 / 桌面通知 ─────────────── */

  const sessionsRoot = defaultSessionsRoot()
  const credService = () => { try { return typeof ctx.get === 'function' ? ctx.get('credentials') : undefined } catch { return undefined } }
  /** 设置页要"授权码配没配"，但不能把值读出来 —— 探一次记住 */
  const smtpCache = { configured: false }

  /** SMTP 授权码：优先 DSH credentials（加密托管），拿不到才退到 config.json */
  const smtpPass = async () => {
    try {
      const c = credService()
      if (c && typeof c.resolve === 'function') {
        const r = await c.resolve(SMTP_REF)
        if (r?.value) { smtpCache.configured = true; return { pass: r.value, from: 'credentials' } }
      }
    } catch (e) { log(`读 credentials 失败：${e?.message ?? e}`) }
    smtpCache.configured = Boolean(cfg.smtpPass)
    return { pass: String(cfg.smtpPass || ''), from: cfg.smtpPass ? 'config.json（明文）' : '' }
  }
  const saveSmtpPass = async (v) => {
    const c = credService()
    if (c && typeof c.set === 'function') {
      await c.set(SMTP_REF, String(v))
      smtpCache.configured = true
      return { ok: true, where: 'credentials', note: '授权码已交给 DSH credentials 服务托管（不落明文）' }
    }
    saveCfg({ smtpPass: String(v) })
    smtpCache.configured = Boolean(v)
    return { ok: true, where: 'config.json', note: '⚠️ 这个宿主没有 credentials 服务，授权码只能明文存进 config.json' }
  }

  /** 组装"投进会话"的那段话（短：要点 + 让人说两句，不塞全文） */
  const sessionMessage = (s) => {
    const head = `📮 自动投递 · 小红书日报${s.date ? `（${s.date}）` : ''}`
    const lines = [head, '']
    if (s.oneLiner) lines.push(s.oneLiner)
    if (s.topics.length) { lines.push('', '热点主题：'); s.topics.slice(0, 6).forEach((t, i) => lines.push(`${i + 1}. ${t}`)) }
    if (s.events.length) { lines.push('', '热点事件：'); s.events.slice(0, 3).forEach((t) => lines.push(`· ${t}`)) }
    if (s.picks.length) lines.push('', `值得细看：${s.picks.length} 篇`)
    if (s.file) lines.push('', `完整日报：${s.file}`)
    if (cfg.sessionSpeak) {
      lines.push('', '请用 3~5 句话跟我说清楚今天最值得知道的是什么。不要复述全文、不要列清单、不要说"这是一条自动投递"。')
    }
    return lines.join('\n')
  }

  /**
   * 跑完一轮之后的投递。三个通道各自独立，谁失败都不影响别人。
   * ⚠️ 全部包在 try/catch 里：这是 child.on('exit') 的回调，抛异常会杀掉整个宿主。
   */
  const deliverReport = async (reason = 'round', { only = '' } = {}) => {
    const result = { at: new Date().toISOString(), reason, channels: {} }
    try {
      refreshCfg()
      const report = readIf(reportPath())
      const st = readJson(stateFile, {})
      if (!report) {
        result.skipped = '今天没有日报文件'
        result.notes = st.skipped === 'not-logged-in' ? '这一轮因为没登录被跳过' : '这一轮没写出报告'
      }
      const s = summarizeReport(report || '', { file: reportPath(), mirror: mirrorPath() })
      if (!report) { s.date = dayKey(); s.oneLiner = result.notes || '这一轮没有生成日报' }

      // ① 会话
      if (only ? only === 'session' : (cfg.sessionTarget && cfg.sessionTarget !== 'off')) {
        try {
          const wanted = cfg.sessionTarget === 'fixed' ? String(cfg.sessionId || '') : ''
          result.channels.session = deliverToSession(ctx, {
            sessionsRoot,
            text: sessionMessage(s),
            sessionId: wanted,
            strict: cfg.sessionTarget === 'fixed',
          })
        } catch (e) { result.channels.session = { ok: false, why: String(e?.message ?? e) } }
      }

      // ② 邮件
      if (only ? only === 'mail' : cfg.deliverMail) {
        try {
          const { pass, from: passFrom } = await smtpPass()
          const mail = await sendMail({
            host: cfg.smtpHost,
            port: cfg.smtpPort,
            secure: cfg.smtpSecure,
            user: cfg.smtpUser,
            pass,
            from: cfg.smtpFrom || cfg.smtpUser,
            to: cfg.mailTo,
            subject: `小红书热点日报 ${s.date || ''}${s.oneLiner ? ' ｜ ' + s.oneLiner.slice(0, 28) : ''}`.trim(),
            text: summaryText(s) + (report ? '\n\n（完整日报见附件）' : ''),
            html: markdownToHtml(report || summaryText(s)),
            attachments: report ? [{ filename: `xhs-daily-${s.date || dayKey()}.md`, content: report, contentType: 'text/markdown' }] : [],
          })
          result.channels.mail = { ...mail, passFrom }
        } catch (e) { result.channels.mail = { ok: false, why: String(e?.message ?? e) } }
      }

      // ③ 桌面通知（兜底）
      if (only ? only === 'toast' : cfg.deliverToast) {
        try {
          result.channels.toast = toastNotify({
            title: '小红书日报好了',
            body: (s.oneLiner || '日报已生成').slice(0, 120),
            spawn,
            log,
          })
        } catch (e) { result.channels.toast = { ok: false, why: String(e?.message ?? e) } }
      }

      const tried = Object.entries(result.channels)
      result.ok = tried.length ? tried.some(([, v]) => v?.ok) : false
      if (!tried.length) result.skipped = result.skipped || '三个通道都关着（设置里可以开）'
      log(`投递（${reason}）：${tried.length ? tried.map(([k, v]) => `${k}=${v?.ok ? 'ok' : 'fail'}`).join(' ') : '没有通道开启'}`)
      try { writeJson(stateFile, { ...readJson(stateFile, {}), lastDelivery: result }) } catch { /* 无所谓 */ }
    } catch (e) {
      log(`投递整体失败（已兜住）：${e?.stack ?? e}`)
      result.error = String(e?.message ?? e)
    }
    return result
  }

  /* ─────────────── 工具 ─────────────── */

  const textOutput = {
    schema: { type: 'object', properties: {}, additionalProperties: true },
    render: (_args, value) => [{
      type: 'text',
      text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
    }],
  }

  /** 宿主要的是"无损 JSON"：塞函数/循环引用/类实例会报 value is not lossless JSON */
  const safe = (v) => {
    if (v === undefined || v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
    try { return JSON.parse(JSON.stringify(v)) } catch { return String(v) }
  }

  const tool = (spec) => ctx.tools.register(defineTool({
    ...spec,
    output: textOutput,
    async execute(args, exec) { return safe(await spec.execute(args, exec)) },
  }))

  const hasProfile = () => existsSync(join(stateDir, 'browser-profile'))

  tool({
    name: 'xhs_status',
    description: '看「刷小红书」今天的状态：跑没跑、登录没登录、浏览器能不能起来、家目录在哪、下次什么时候跑。',
    parameters: {},
    async execute() {
      refreshCfg()
      const st = readJson(stateFile, {})
      const today = dayKey()
      return {
        ok: true,
        today,
        ranToday: st.lastRunDay === today,
        pickedToday: countPickedToday(),
        autoRun: Boolean(cfg.enabled),
        runAt: cfg.runAt,
        directions: directions(),
        perDirection: cfg.perDirection,
        deepRead: cfg.deepRead,
        report: join(outDir, `${today}.md`),
        reportExists: existsSync(join(outDir, `${today}.md`)),
        mirror: mirrorPath(today),
        profileExists: hasProfile(),
        lastLogin: loginInfo(),
        lastDelivery: st.lastDelivery || null,
        delivery: {
          session: cfg.sessionTarget,
          mail: cfg.deliverMail,
          toast: cfg.deliverToast,
        },
        risk: {
          inCooldown: cooldownLeftMs() > 0,
          cooldownLeftMs: cooldownLeftMs(),
          pauseUntil: riskState().pauseUntil || 0,
          reason: riskState().reason || '',
          lastSignal: riskState().lastSignal || null,
        },
        build: 3,
        home: stateDir,
        version: myVer(),
      }
    },
  })

  tool({
    name: 'xhs_login_start',
    description: '开一个真实浏览器窗口打开小红书登录页，把二维码截下来（返回 PNG 路径）。\n'
      + '用法：拿到 PNG 用 `present` 推给本人（小红书 App → 我 → 扫一扫），再用 `xhs_login_poll` 轮询。\n'
      + '⚠️ 二维码约 2 分钟有效，出码要马上递过去；手机上确认后 Cookie 会存进插件家目录，之后长期有效。',
    parameters: {},
    async execute() {
      refreshCfg()
      // 出码前先收掉旧进程：旧浏览器可能已经关了 / 旧代码可能还热着 —— 重新起一个最干净
      stopMcp()
      const r = await call('xhs_login_start', {}, { timeoutMs: 120000 })
      let png = ''
      if (r?.png) {
        try {
          png = join(stateDir, 'qrcode_login.png')
          writeFileSync(png, Buffer.from(String(r.png).split(',')[1] || '', 'base64'))
        } catch { png = '' }
      }
      return { ok: true, loggedIn: Boolean(r?.loggedIn), png, from: r?.from, hint: r?.hint }
    },
  })

  tool({
    name: 'xhs_login_poll',
    description: '查扫码结果：ok=已登录 / waiting=还没确认 / no-browser=登录窗口关了。',
    parameters: {},
    async execute() {
      const r = await call('xhs_login_poll', {}, { timeoutMs: 90000 })
      if (r?.state === 'ok') { markLoggedIn(r); log(`登录成功（${r.nickname || '未知昵称'}）`); setTimeout(stopMcp, 1500) }
      return r
    },
  })

  tool({
    name: 'xhs_search',
    description: '按关键词搜小红书笔记，返回 id / 链接 / 标题 / 作者 / 点赞·收藏·评论数。\n'
      + '⚠️ 刷一轮的用法：每个方向搜一次（20 条左右），再挑值得的读正文（xhs_note）—— 别看标题下结论。',
    parameters: {
      keyword: { type: 'string', description: '关键词（一个方向一个词）' },
      limit: { type: 'number', description: '返回几条（默认 20，最大 50）' },
      sort: { type: 'string', description: 'general=综合 / latest=最新 / popular=最热' },
    },
    async execute(args) {
      return call('xhs_search', {
        keyword: String(args.keyword ?? ''),
        limit: Math.max(1, Math.min(Number(args.limit) || 20, 50)),
        sort: String(args.sort || cfg.sort || 'general'),
      }, { timeoutMs: 300000 })
    },
  })

  tool({
    name: 'xhs_note',
    description: '读一条笔记的正文全文（标题/正文/标签/作者/赞藏评/发布时间）。判断内容就靠它。',
    parameters: {
      url: { type: 'string', description: '笔记链接（搜索结果的 url 直接传）' },
      id: { type: 'string', description: '或者直接给 noteId' },
    },
    async execute(args) { return call('xhs_note', { url: String(args.url ?? ''), id: String(args.id ?? '') }, { timeoutMs: 180000 }) },
  })

  tool({
    name: 'xhs_comments',
    description: '读一条笔记的评论（作者/内容/点赞/时间）。评论区常常是"热点事件"的第一手现场。',
    parameters: {
      url: { type: 'string', description: '笔记链接' },
      id: { type: 'string', description: '或者直接给 noteId' },
      limit: { type: 'number', description: '取几条（默认 20）' },
    },
    async execute(args) {
      return call('xhs_comments', { url: String(args.url ?? ''), id: String(args.id ?? ''), limit: Math.max(1, Number(args.limit) || 20) }, { timeoutMs: 180000 })
    },
  })

  tool({
    name: 'xhs_run',
    description: '**立刻跑一轮**（不等 21:00）：起一个 headless 会话，把 duty.md 交给它去刷、写日报。适合"我现在就想看一份"。',
    parameters: {},
    async execute() { return { ok: true, ...runDuty('manual') } },
  })

  tool({
    name: 'xhs_config',
    description: '读 / 改「刷小红书」的设置。不给 patch 就是读；给了就改。\n'
      + '抓取：enabled, runAt("21:00"), catchUp, directions("一行一个方向"), perDirection(5-50), deepRead(1-30), '
      + 'sort(general|latest|popular), readComments, reportLevel(full|brief), mirrorDir, workspace, headlessProfile, channel(msedge|chrome)。\n'
      + '投递：sessionTarget(off|latest|fixed), sessionId, sessionSpeak, deliverMail, smtpHost, smtpPort, smtpSecure, '
      + 'smtpUser, smtpFrom, mailTo, deliverToast。\n'
      + '⚠️ SMTP 授权码**不要**走这个工具（会明文落盘）；用 xhs_config 的 smtp-pass 接口或设置页填，存进 DSH credentials。\n'
      + '例：`{"sessionTarget":"latest","deliverMail":true,"smtpHost":"smtp.qq.com","smtpPort":465,"smtpUser":"me@qq.com","mailTo":"me@qq.com"}`',
    parameters: { patch: { type: 'object', additionalProperties: true, description: '要改的字段（可省）' } },
    async execute(args) {
      if (args?.patch && typeof args.patch === 'object' && !Array.isArray(args.patch)) saveCfg(args.patch)
      const p = await smtpPass()
      return {
        ok: true,
        config: cfg,
        directions: directions(),
        home: stateDir,
        loggedInGuess: hasProfile(),
        smtpPassConfigured: Boolean(p.pass),
        smtpPassFrom: p.from || '未配置',
      }
    },
  })

  tool({
    name: 'xhs_doctor',
    description: '自检：浏览器能不能起来、登录态还在不在、依赖齐不齐。回答的是"现在到底能不能用"。',
    parameters: {},
    async execute() {
      refreshCfg()
      const out = { ok: false, checks: [] }
      const add = (name, ok, note) => out.checks.push({ name, ok, note })
      add('server 脚本', existsSync(serverScript), serverScript)
      add('浏览器 profile', hasProfile(), join(stateDir, 'browser-profile'))
      try {
        const st = await call('xhs_status', {}, { timeoutMs: 120000 })
        add('浏览器启动', true, `channel=${st.channel}`)
        add('登录态', Boolean(st.loggedIn), st.loggedIn ? (st.nickname || '已登录') : (st.verdict || st.error || '未登录'))
        if (st.loggedIn) markLoggedIn(st)
        out.loggedIn = Boolean(st.loggedIn)
        out.nickname = st.nickname || ''
        out.ok = Boolean(st.loggedIn)
      } catch (e) {
        add('浏览器启动', false, String(e?.message ?? e).slice(0, 300))
      }
      return out
    },
  })

  tool({
    name: 'xhs_bind_session',
    description: '**把日报绑定到「当前这个会话」**：以后每轮跑完就把摘要投进这里，AI 会当场念给你听。\n'
      + '用法：打开你想要收日报的那个会话（比如新建一个叫「小红书日报」的），在里面说一句「把刷小红书日报投到这个会话」。\n'
      + '⚠️ 投进去的消息来源是 user，所以每次投递都会让这个会话跑一轮模型（有成本）。',
    parameters: {},
    async execute(_args, exec) {
      refreshCfg()
      const sid = String(exec?.agent?.sessionId || exec?.agent?.id || '')
      if (!sid) {
        return { ok: false, error: '拿不到当前会话 id（这个宿主版本没把 agent 传给工具）—— 请手动在设置里填会话 ID' }
      }
      saveCfg({ sessionTarget: 'fixed', sessionId: sid })
      log(`日报会话已绑定到 ${sid}`)
      return { ok: true, boundTo: sid, sessionTarget: 'fixed', hint: '以后每轮跑完，摘要就投到这个会话；要取消就去设置里改成「不投」或「最近活跃」' }
    },
  })

  tool({
    name: 'xhs_clear_risk',
    description: '**解除风控冷却**（只有在你自己已经确认账号恢复正常之后才用）。\n'
      + '⚠️ 冷却期是保护你的：撞到「安全限制 / 异常操作 / 验证码」之后继续跑，最容易把"提醒"升级成"封号"。',
    parameters: { note: { type: 'string', description: '为什么解除（记一笔，方便以后回看）' } },
    async execute(args) {
      refreshCfg()
      const before = riskState()
      clearPause(String(args?.note || '使用者手动解除'))
      return { ok: true, before: before.pauseUntil || 0, now: riskState(), hint: '冷却已解除。建议先把「每个方向抓几条」降到 20、"精读"降到 8，别再用之前的量。' }
    },
  })

  tool({
    name: 'xhs_deliver',
    description: '把今天（或指定某天）的日报**主动送到你手上**：会话投递 / 邮件 / 桌面通知。\n'
      + 'what = all（按设置三个通道都走）/ session（只投会话）/ mail（只发邮件）/ toast（只弹通知）。\n'
      + '⚠️ 会话投递会在那个会话里**真的跑一轮模型**（消息来源是 user），这是有成本的；邮件走 SMTP（授权码在设置里填）。\n'
      + '场景：想验一下邮件通不通、或者现在就想把昨天的日报补发到邮箱。',
    parameters: {
      what: { type: 'string', description: 'all / session / mail / toast（默认 all）' },
      day: { type: 'string', description: '哪一天（YYYY-MM-DD，默认今天）' },
    },
    async execute(args) {
      refreshCfg()
      const what = ['all', 'session', 'mail', 'toast'].includes(String(args.what || '')) ? String(args.what || '') : 'all'
      const day = String(args.day || '').match(/^\d{4}-\d{2}-\d{2}$/) ? String(args.day) : dayKey()
      const file = join(outDir, `${day}.md`)
      const exists = existsSync(file)
      const r = await deliverReport(`manual:${what}`, { only: what === 'all' ? '' : what })
      return { ok: r.ok, day, reportExists: exists, report: file, ...r }
    },
  })

  tool({
    name: 'xhs_install',
    description: '补齐浏览器依赖（playwright-core）：在插件目录里跑一次 npm install，进度看家目录的 install.log。'
      + '一般用不到 —— 插件装好时就带了；只有把插件目录挪走 / node_modules 丢了才需要。',
    parameters: {},
    async execute() { return runInstall() },
  })

  /* ─────────────── 报告 / 计数 ─────────────── */

  const reportPath = (day = dayKey()) => join(outDir, `${day}.md`)
  const mirrorPath = (day = dayKey()) => {
    const dir = String(cfg.mirrorDir || '').trim()
    return dir ? join(dir, `${day}.md`) : ''
  }

  /**
   * 今天挑了几条：数报告里 `### <笔记ID>` 这种标题行。
   * ⚠️ 2026-10-19 修的坑：原来数的是**所有** `### ` 行 —— 但报告里「热点主题 / 热点事件」
   *    也用 `###`（比如 `### 1. 情绪区出现…`），于是 4 篇笔记被数成 8 条，
   *    prompt 里那句"今天已经挑过 N 条"直接骗了模型（它会以为额度用完了）。
   *    现在只认长得像笔记 ID 的（16–32 位十六进制）。
   */
  const countPickedToday = () => {
    try {
      const txt = readFileSync(reportPath(), 'utf8')
      return (txt.match(/^###\s+[0-9a-f]{16,32}\s*$/gim) || []).length
    } catch { return 0 }
  }

  /* ─────────────── 找 dsh ─────────────── */

  const resolveDsh = () => {
    const explicit = String(cfg.dshBin || '').trim()
    if (explicit && existsSync(explicit)) return { command: process.execPath, args: [explicit], shell: false }
    const guesses = [
      join(process.env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
      '/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
    ].filter(Boolean)
    // 桌面版（Electron）把 dsh 打在应用里
    if (process.resourcesPath) {
      for (const rel of [
        ['app.asar.unpacked', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'],
        ['app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'],
        ['node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'],
      ]) {
        const p = join(process.resourcesPath, ...rel)
        if (existsSync(p)) return { command: process.execPath, args: [p], shell: false }
      }
    }
    for (const g of guesses) if (existsSync(g)) return { command: process.execPath, args: [g], shell: false }
    log('⚠️ 找不到 dsh：桌面版多半不是 npm 全局安装的 ⇒ 请在设置里把「dsh 路径」指到 <应用目录>/…/@deepseek-ai/dsh/lib/bin.js')
    return { command: 'dsh', args: [], shell: true }
  }

  /* ─────────────── 跑一轮 ─────────────── */

  const ensureOverlay = () => {
    if (!cfg.overlayMcp) return null
    const file = join(stateDir, 'headless-overlay.yml')
    const posix = (p) => String(p).replace(/\\/g, '/')
    const whitelist = ['xhs_search', 'xhs_note', 'xhs_comments', 'xhs_status']
    const yml = [
      '- insert:',
      '    - id: mcp-xhs-duty',
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      config:',
      '        serverName: xhs-duty',
      '        transport: stdio',
      `        command: '${posix(nodeCmd())}'`,
      '        args:',
      `          - '${posix(serverScript)}'`,
      '        env:',
      `          XHS_DUTY_HOME: '${posix(stateDir)}'`,
      `          XHS_CHANNEL: '${String(cfg.channel || 'msedge')}'`,
      `          XHS_TOOLS: '${whitelist.join(',')}'`,
      ...(process.versions.electron ? ["          ELECTRON_RUN_AS_NODE: '1'"] : []),
      '',
    ].join('\n')
    try { writeFileSync(file, yml, 'utf8'); return file } catch (e) { log(`写 overlay 失败：${e?.message ?? e}`); return null }
  }

  const promptFor = () => {
    let duty = charterPath(pluginDir, stateDir)
    try { duty = String(duty).split('<家目录>').join(stateDir) } catch { /* 原样用 */ }
    const dirs = directions()
    const st = readJson(stateFile, {})
    const picked = countPickedToday()
    // 使用者的 AGENTS.md（人设）由我们自己读进来喂给它 —— 那一轮 cwd 是插件家，读不到工作区
    let ownerDoc = ''
    try {
      const wsDir = String(cfg.workspace || '').trim()
      const agents = wsDir ? join(wsDir, 'AGENTS.md') : ''
      if (agents && existsSync(agents)) {
        ownerDoc = '\n\n===== 使用者的 AGENTS.md（他写给自己 AI 的准则，**按这个来**）=====\n'
          + readFileSync(agents, 'utf8').slice(0, 6000)
          + '\n===== 设定结束 =====\n'
      }
    } catch { /* 读不到就算了 */ }

    return `你是这个账号的「小红书观察员」，替使用者刷一轮小红书。`
      + `\n\n⭐ 硬规矩：**只读**。不许点赞、收藏、评论、关注、私信、发布 —— 工具里也没有这些能力。`
      + ownerDoc
      + `\n\n先读章程 ${duty}，严格按里面的要求和输出格式做。`
      + `\n今天要关注的**方向**（${dirs.length} 个）：${dirs.map((d, i) => `${i + 1}) ${d}`).join('；')}`
      + `\n每个方向用 xhs_search 搜一次，取 ${Number(cfg.perDirection) || 20} 条候选（sort=${cfg.sort || 'general'}）；`
      + `全部方向加起来**精读 ${Number(cfg.deepRead) || 8} 条**（用 xhs_note 读正文；`
      + `${cfg.readComments ? '热点/争议/新品类的挑几条用 xhs_comments 看评论' : '这一轮不读评论'}）。`
      + `\n⭐ 读到"同一件事"的多条笔记就算一个**热点事件**；只按数量多的算热点主题 —— 别把一条爆款当趋势。`
      + `\n\n日报写到 ${reportPath()}`
      + `（今天已经挑过 ${picked} 条；有上一轮的内容就**追加到末尾**，别覆盖）。`
      + `\n⭐ 报告里**每挑中一条**，第一行写成 \`### 笔记ID\`（例如 \`### 67f0a1b2c3d4e5f6a7b8c9d0\`）—— 宿主就数这些标题行。`
      + `\n⭐ 归档（给以后检索用，**看过的每一条都要进**，挑中的和跳过的都算）：${join(digestDir, `${monthKey()}.md`)}`
      + ` —— 一行一条：日期 · 笔记ID · 标题 · 作者 · 赞 · 一句话结论 · 链接（跳过的那条注明理由）。`
      + `\n判重表 = ${seenFile}（**就是这个绝对路径**）：已经记过的笔记不要再进日报；读不出来/写不进去就在报告里明说。`
      + (mirrorPath()
        ? `\n⭐ 报告写完后再把**同一份内容**写到 ${mirrorPath()}（工作区镜像，宿主也会兜底复制一次）。`
        : '')
      + `\n⭐ 报告末尾必须写「本轮口径」：搜了哪些方向、各拿到多少条、精读了几条、跳过几条、有没有失败/风控。`
      + `\n最后用一句话汇报你提炼出的今日热点。现在几点了自己看一眼系统时间。`
  }

  let running = false
  const stubReportIfMissing = (code, why) => {
    try {
      const f = reportPath()
      if (existsSync(f)) return
      let tail = ''
      try { tail = readFileSync(logFile, 'utf8').slice(-1500) } catch { /* 无所谓 */ }
      writeFileSync(f, [
        `# 刷小红书 · ${dayKey()} —— 这一轮没写出报告`,
        '',
        `> ⚠️ 那一轮结束了（${why}，退出码 ${code}），但没有生成正常报告。`,
        '> 常见原因：登录态过期、被风控拦了、或者它卡在某个工具上反复重试。下一轮会重来。',
        '> 下面附日志尾部；完整日志在插件家目录的 `duty.log`。',
        '',
        '```',
        String(tail).trim(),
        '```',
        '',
      ].join('\n'), 'utf8')
      log('这一轮没写报告 ⇒ 宿主补了一份占位报告')
    } catch (e) { log(`补占位报告失败：${e?.message ?? e}`) }
  }

  const mirrorReport = () => {
    const dest = mirrorPath()
    if (!dest) return
    try {
      const src = reportPath()
      if (!existsSync(src)) return
      mkdirSync(dirname(dest), { recursive: true })
      copyFileSync(src, dest)
      log(`日报已复制到工作区：${dest}`)
    } catch (e) { log(`复制到工作区失败：${e?.message ?? e}`) }
  }

  const runDuty = (why = 'schedule') => {
    try {
      refreshCfg()
      if (running) return { started: false, why, error: '上一轮还在跑' }
      // 🔴 风控冷却期：一律不许跑（连手动也不许，除非先「解除冷却」）
      const left = cooldownLeftMs()
      if (left > 0) {
        const rs = riskState()
        log(`风控冷却中，这一轮不跑（${why}）：还剩 ${fmtLeft(left)}`)
        return {
          started: false, why, cooldown: true, cooldownLeftMs: left, pauseUntil: rs.pauseUntil, reason: rs.reason || '',
          error: `风控冷却中：还剩 ${fmtLeft(left)}${rs.reason ? `（${rs.reason}）` : ''}。确认账号已经正常后，先在设置页点「解除冷却」。`,
        }
      }
      // 🔴 没登录就别开跑：小红书搜索会被登录墙挡住，跑了也只是白烧一轮 + 一份"失败日报"
      if (!loginInfo()?.at) {
        log(`没登录，这一轮不跑（${why}）`)
        try { writeJson(stateFile, { ...readJson(stateFile, {}), lastRunDay: dayKey(), lastWhy: why, skipped: 'not-logged-in' }) } catch { /* 无所谓 */ }
        return {
          started: false, why, needLogin: true,
          error: '还没登录：先去「刷小红书」设置页点「扫码登录」，登录后再跑（这一轮没开跑，也没花 token）',
        }
      }
      const dsh = resolveDsh()
      const overlay = ensureOverlay()
      const args = [...dsh.args, '--profile', cfg.headlessProfile || 'headless']
      if (overlay) args.push('--patch', overlay)
      args.push(promptFor())
      const cwd = stateDir
      running = true
      writeJson(stateFile, { ...readJson(stateFile, {}), lastRunDay: dayKey(), lastRunAt: new Date().toISOString(), lastWhy: why })
      log(`开跑（${why}）：${dsh.command} ${args.slice(0, 3).join(' ')} … cwd=${cwd}`)
      const child = spawn(dsh.command, args, {
        cwd,
        shell: dsh.shell,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: mcpEnv(),
      })
      const pick = (buf) => { try { appendFileSync(logFile, String(buf), 'utf8') } catch { /* 绝不能抛 */ } }
      child.stdout?.on('data', pick)
      child.stderr?.on('data', pick)
      child.on('exit', (code) => {
        running = false
        log(`结束（${why}，code=${code}）`)
        stubReportIfMissing(code, why)
        mirrorReport()
        try { writeJson(stateFile, { ...readJson(stateFile, {}), lastExit: code, pickedToday: countPickedToday(), finishedAt: new Date().toISOString() }) } catch { /* 无所谓 */ }
        rotateLogIfBig()
        // 抓取端攒的风险信号：消费掉 → 记账 → 进冷却（连手动跑也要挡住）
        try {
          const r = consumeRiskSignals()
          if (r) log(`已进冷却 ${r.hours} 小时（信号 ${r.signal?.kind}）`)
        } catch (e) { log(`消费风险信号失败：${e?.message ?? e}`) }
        // 投递再等几秒：让模型自己把文件写完 / 镜像复制完再读报告
        const t = setTimeout(() => { Promise.resolve(deliverReport(why)).catch((e) => log('投递异常：' + (e?.message ?? e))) }, 4000)
        t.unref?.()
      })
      child.on('error', (e) => { running = false; log(`起不来：${e?.message ?? e}`) })
      return { started: true, why, profile: cfg.headlessProfile, cwd, log: logFile, report: reportPath() }
    } catch (e) {
      running = false
      log(`开跑失败（${why}）：${e?.stack ?? e}`)
      return { started: false, why, error: String(e?.message ?? e) }
    }
  }

  const rotateLogIfBig = () => {
    try {
      if (!existsSync(logFile)) return
      if (statSync(logFile).size < 2 * 1024 * 1024) return
      const keep = join(stateDir, 'duty.log.1')
      try { writeFileSync(keep, readFileSync(logFile, 'utf8').slice(-300 * 1024), 'utf8') } catch { /* 无所谓 */ }
      writeFileSync(logFile, '', 'utf8')
    } catch { /* 无所谓 */ }
  }

  /* ─────────────── 每天到点跑 ─────────────── */

  const tick = () => {
    try {
      refreshCfg()
      if (running) return
      // 抓取端可能在某轮里留下了风险信号（比如那一轮崩了没走到 exit）—— 每一跳都收一下
      try { consumeRiskSignals() } catch { /* 无所谓 */ }
      if (cooldownLeftMs() > 0) return      // 冷却期：定时器什么都不做，也不刷日志
      if (!cfg.enabled) return
      const now = new Date()
      const cur = now.getHours() * 60 + now.getMinutes()
      const at = minutesOf(cfg.runAt)
      if (at === null) return
      if (cur < at) return
      const today = dayKey()
      const st = readJson(stateFile, {})
      if (st.lastRunDay === today) return                 // 今天已经跑过
      if (existsSync(reportPath(today))) return            // 今天已经有报告
      if (!cfg.catchUp && cur - at > 20) return            // 错过超过 20 分钟就不补跑
      log(`到点了（${cfg.runAt}），开跑`)
      runDuty('schedule')
    } catch (e) {
      log(`定时器这一跳出错（已兜住，不影响宿主）：${e?.stack ?? e}`)
    }
  }

  try {
    const timer = setInterval(tick, 60_000)
    timer.unref?.()
    ctx.effect(() => () => clearInterval(timer), 'xhs-duty: 定时器')
    // 起插件时也看一眼（避免 "21:00 那会儿 DSH 没开就永远不跑"）
    setTimeout(tick, 20_000).unref?.()
  } catch (e) { log(`定时器没起来：${e?.message ?? e}`) }

  /* ─────────────── 补依赖 ─────────────── */

  let installing = false
  const runInstall = () => {
    if (installing) return { ok: true, installing: true, log: installLogFile, hint: '已经在装了，看日志' }
    installing = true
    appendInstall(`\n=== ${new Date().toISOString()} 补 playwright-core ===\n`)
    try {
      const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm',
        ['install', 'playwright-core', '--no-audit', '--no-fund', '--save'],
        { cwd: pluginDir, windowsHide: true, shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
      const pick = (b) => appendInstall(String(b))
      child.stdout?.on('data', pick)
      child.stderr?.on('data', pick)
      child.on('exit', (code) => {
        installing = false
        appendInstall(`=== 结束（exit ${code}）—— 依赖装完要重启 dsh ===\n`)
      })
      child.on('error', (e) => { installing = false; appendInstall('起不来：' + String(e?.message ?? e) + '\n') })
      return { ok: true, started: true, log: installLogFile, hint: '正在装（几十秒），装完重启一次 dsh' }
    } catch (e) {
      installing = false
      appendInstall('失败：' + String(e?.stack ?? e) + '\n')
      return { ok: false, error: String(e?.message ?? e) }
    }
  }

  /* ─────────────── HTTP（设置页用） ─────────────── */

  const sendJson = (res, code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(obj))
  }
  const readBody = (req) => new Promise((resolve) => {
    let data = ''
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    req.on('data', (c) => { data += c; if (data.length > 1_000_000) { data = ''; finish({}); req.destroy() } })
    req.on('end', () => { try { finish(JSON.parse(data || '{}')) } catch { finish({}) } })
    req.on('error', () => finish({}))
  })

  const statusPayload = () => {
    refreshCfg()
    const today = dayKey()
    const st = readJson(stateFile, {})
    return {
      ok: true,
      version: myVer(),
      today,
      config: cfg,
      directions: directions(),
      report: reportPath(today),
      reportExists: existsSync(reportPath(today)),
      mirror: mirrorPath(today),
      pickedToday: countPickedToday(),
      running,
      lastRunAt: st.lastRunAt || '',
      lastRunDay: st.lastRunDay || '',
      lastLogin: loginInfo(),
      lastDelivery: st.lastDelivery || null,
      risk: {
        inCooldown: cooldownLeftMs() > 0,
        cooldownLeftMs: cooldownLeftMs(),
        cooldownLeftText: cooldownLeftMs() > 0 ? fmtLeft(cooldownLeftMs()) : '',
        pauseUntil: riskState().pauseUntil || 0,
        reason: riskState().reason || '',
        lastSignal: riskState().lastSignal || null,
        cooldownHours: cfg.riskCooldownHours,
      },
      smtpPassConfigured: Boolean(cfg.smtpPass) || smtpCache.configured,
      build: 4,
      profileExists: hasProfile(),
      home: stateDir,
      installing,
    }
  }

  const handle = async (req, res, url) => {
    const path = url.pathname
    if (req.method === 'GET' && path === '/api/xhs-duty/status') return sendJson(res, 200, statusPayload())

    if (req.method === 'POST' && path === '/api/xhs-duty/config') {
      const body = await readBody(req)
      const patch = body?.patch && typeof body.patch === 'object' ? body.patch : body
      saveCfg(patch || {})
      log(`设置已改：${Object.keys(patch || {}).join(',')}`)
      return sendJson(res, 200, { ok: true, ...statusPayload() })
    }

    if (req.method === 'POST' && path === '/api/xhs-duty/run') {
      const body = await readBody(req)
      return sendJson(res, 200, { ok: true, ...runDuty(body?.why || 'manual'), ...statusPayload() })
    }

    if (req.method === 'GET' && path === '/api/xhs-duty/report') {
      const day = String(url.searchParams.get('day') || dayKey()).replace(/[^0-9-]/g, '') || dayKey()
      const file = join(outDir, `${day}.md`)
      let text = ''
      let exists = false
      try { exists = existsSync(file); if (exists) text = readFileSync(file, 'utf8').slice(0, 400000) } catch { /* 读不到就给空 */ }
      return sendJson(res, 200, { ok: true, day, exists, file, text })
    }

    if (req.method === 'POST' && path === '/api/xhs-duty/open') {
      const body = await readBody(req)
      const what = String(body?.what || 'out')
      const dir = what === 'home' ? stateDir : what === 'digest' ? digestDir : outDir
      if (process.platform !== 'win32') return sendJson(res, 200, { ok: false, error: '这个按钮目前只做了 Windows' })
      const attempts = [
        ['cmd.exe', ['/c', 'start', '', dir]],
        [join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe'), [dir]],
      ]
      let lastErr = ''
      for (const [cmd, args] of attempts) {
        const err = await new Promise((resolve) => {
          let done = false
          let child
          try { child = spawn(cmd, args, { detached: true, stdio: 'ignore' }) } catch (e) { resolve(String(e?.message ?? e)); return }
          child.on('error', (e) => { if (!done) { done = true; resolve(String(e?.message ?? e)) } })
          setTimeout(() => { if (!done) { done = true; try { child.unref() } catch { /* 无所谓 */ } resolve('') } }, 500)
        })
        if (!err) return sendJson(res, 200, { ok: true, opened: dir, via: cmd })
        lastErr = err
      }
      return sendJson(res, 200, { ok: false, error: lastErr, dir })
    }

    if (req.method === 'POST' && path === '/api/xhs-duty/login/start') {
      try {
        refreshCfg()
        stopMcp()   // 同上：重新起一个干净的浏览器进程
        const r = await call('xhs_login_start', {}, { timeoutMs: 120000 })
        log(`出码：${r?.from || '未知来源'}（loggedIn=${Boolean(r?.loggedIn)}）`)
        return sendJson(res, 200, { ok: true, png: r?.png || '', loggedIn: Boolean(r?.loggedIn), hint: r?.hint || '' })
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: String(e?.message ?? e) })
      }
    }

    if (req.method === 'POST' && path === '/api/xhs-duty/login/poll') {
      try {
        const r = await call('xhs_login_poll', {}, { timeoutMs: 90000 })
        if (r?.state === 'ok') { markLoggedIn(r); log(`登录成功（${r.nickname || ''}）`); setTimeout(stopMcp, 1500) }
        return sendJson(res, 200, { ok: true, ...r })
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: String(e?.message ?? e) })
      }
    }

    if (req.method === 'POST' && path === '/api/xhs-duty/doctor') {
      try {
        const st = await call('xhs_status', {}, { timeoutMs: 120000 })
        if (st?.loggedIn) markLoggedIn(st)
        return sendJson(res, 200, { ok: Boolean(st.loggedIn), ...st })
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: String(e?.message ?? e) })
      }
    }

    if (req.method === 'POST' && path === '/api/xhs-duty/install') return sendJson(res, 200, runInstall())

    // ── 风控冷却 ──
    if (req.method === 'POST' && path === '/api/xhs-duty/risk/clear') {
      const body = await readBody(req)
      const st = clearPause(String(body?.note || '设置页手动解除'))
      return sendJson(res, 200, { ok: true, risk: st })
    }
    if (req.method === 'POST' && path === '/api/xhs-duty/risk/pause') {
      const body = await readBody(req)
      const hours = Math.max(1, Math.min(Number(body?.hours) || 24, 240))
      const st = setPause(hours, String(body?.reason || '手动暂停'))
      log(`手动进入冷却 ${hours} 小时`)
      return sendJson(res, 200, { ok: true, risk: st, hours })
    }

    // ── 投递 ──
    if (req.method === 'POST' && path === '/api/xhs-duty/deliver/test') {
      const body = await readBody(req)
      const what = ['session', 'mail', 'toast'].includes(String(body?.what || '')) ? String(body.what) : 'mail'
      const r = await deliverReport(`test:${what}`, { only: what })
      return sendJson(res, 200, { ok: r.ok, what, ...r })
    }

    if (req.method === 'POST' && path === '/api/xhs-duty/deliver/now') {
      const body = await readBody(req)
      const what = ['all', 'session', 'mail', 'toast'].includes(String(body?.what || '')) ? String(body.what) : 'all'
      const r = await deliverReport('manual', { only: what === 'all' ? '' : what })
      return sendJson(res, 200, { ok: r.ok, what, ...r })
    }

    if (req.method === 'POST' && path === '/api/xhs-duty/smtp-pass') {
      const body = await readBody(req)
      const pass = String(body?.pass || '')
      if (!pass) return sendJson(res, 200, { ok: false, error: '授权码是空的' })
      try {
        const r = await saveSmtpPass(pass)
        log(`SMTP 授权码已保存（${r.where}）`)
        return sendJson(res, 200, { ...r, configured: true })
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: String(e?.message ?? e) })
      }
    }

    if (req.method === 'POST' && path === '/api/xhs-duty/smtp-pass/clear') {
      try {
        const c = credService()
        if (c && typeof c.unset === 'function') await c.unset(SMTP_REF)
        saveCfg({ smtpPass: '' })
        smtpCache.configured = false
        return sendJson(res, 200, { ok: true, configured: false })
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: String(e?.message ?? e) })
      }
    }

    if (req.method === 'GET' && path === '/api/xhs-duty/logs') {
      let tail = ''
      try { tail = readFileSync(installLogFile, 'utf8').slice(-2000) } catch { tail = '' }
      return sendJson(res, 200, { ok: true, tail })
    }

    return sendJson(res, 404, { ok: false, error: `unknown ${req.method} ${path}` })
  }

  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/api/xhs-duty',
      handler: async (req, res) => {
        try { await handle(req, res, new URL(req.url, 'http://127.0.0.1')) } catch (e) {
          sendJson(res, 500, { ok: false, error: e?.message ?? String(e) })
        }
      },
    }), 'xhs-duty: /api/xhs-duty 路由')
  } catch (e) { log(`HTTP 路由没挂上：${e?.message ?? e}`) }

  try { ensureCharter(pluginDir, stateDir, log) } catch (e) { log(`章程没铺好：${e?.message ?? e}`) }

  ctx.effect(() => () => { try { stopMcp() } catch { /* 收摊 */ } }, 'xhs-duty: 收 MCP 子进程')
  log(`已挂载（家=${stateDir}，每天 ${cfg.runAt} 跑，方向=${directions().length} 个，channel=${cfg.channel}）`)
}
