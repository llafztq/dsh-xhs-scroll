#!/usr/bin/env node
/**
 * server/mcp_server.mjs —— 刷小红书 的 MCP 服务器（stdio）
 * ============================================================================
 * 干什么：用 Playwright 驱动**本机真实浏览器**（Edge / Chrome，带持久化 profile），
 * 按关键词搜小红书、读笔记详情、读评论，把结构化数据吐给调用方。
 *
 * 为什么这么抓（而不是像 RedNote-MCP 那样逐条点开抄 DOM）：
 *   小红书前端自己会请求 `edith.xiaohongshu.com/api/sns/web/...` —— 那些响应就是干净的 JSON
 *   （标题、作者、点赞、正文、标签、图片、评论）。我们**只是让页面自己走一遍**，顺手把响应截下来。
 *   ⇒ 抗改版（DOM 结构变了不影响）、快（不用点开每一条等渲染）、字段全。
 *   三级兜底：① 截接口 JSON → ② 页面里的 `window.__INITIAL_STATE__` → ③ DOM 文本。
 *
 * 🔴 硬约束（都是实测出来的）：
 *   1. **必须 headful**：无头模式下小红书直接返回「安全限制 / IP存在风险 / 300012」。
 *      所以默认开一个**移到屏幕外**的真实窗口（`--window-position=-2400,-2400`），用户看不到但它是真窗口。
 *   2. **搜索必须登录**：没登录时搜索页只显示「登录后查看搜索结果」。登录态靠持久化 profile 里的 cookie 维持。
 *   3. 二维码是页面里的 `.qrcode` 元素 —— 直接对这个元素截图给用户扫。
 *   4. 一次只跑一个工具调用（浏览器是独享资源），并把动作间隔做成「人手速」。
 *
 * 环境变量：
 *   XHS_DUTY_HOME  插件家目录（profile / 日志都在这）
 *   XHS_CHANNEL    msedge | chrome | chromium（默认 msedge，找不到会自动退）
 *   XHS_TOOLS      白名单（逗号分隔，值班轮用；不设 = 全放）
 * ============================================================================
 */
import { chromium } from 'playwright-core'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const VERSION = '0.1.0'
const HOME = process.env.XHS_DUTY_HOME || join(homedir(), '.dsh', 'xhs-duty')
const PROFILE_DIR = join(HOME, 'browser-profile')
const LOG_FILE = join(HOME, 'browser.log')
mkdirSync(HOME, { recursive: true })

const log = (msg) => {
  const line = `${new Date().toISOString()}  ${msg}`
  try { appendFileSync(LOG_FILE, line + '\n', 'utf8') } catch { /* 写不进去就算了 */ }
  try { process.stderr.write(line + '\n') } catch { /* 无所谓 */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const jitter = (min, max) => sleep(min + Math.random() * (max - min))
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

/**
 * 风险信号留痕：追加一行 JSON。**宿主**定期消费它并决定"要不要进冷却期"。
 * 为什么不用模型在报告里写：报告是模型写的，它可能没注意到、也可能写漏；
 * 风控这种事必须由**真正看到页面的那一层**记账。
 */
const RISK_FILE = join(HOME, 'risk-signals.jsonl')
function noteRisk(kind, detail) {
  try {
    appendFileSync(RISK_FILE, JSON.stringify({ at: new Date().toISOString(), kind, detail: clean(detail).slice(0, 240) }) + '\n', 'utf8')
  } catch { /* 写不进去也不能炸 */ }
}

/* ────────────────────────────── 浏览器 ────────────────────────────── */

let ctx = null
let ctxVisible = null
let ctxChannel = null

const CHANNELS = (() => {
  const want = String(process.env.XHS_CHANNEL || 'msedge').trim()
  return [want, ...['msedge', 'chrome', 'chromium'].filter((c) => c !== want)]
})()

async function launch({ visible = false } = {}) {
  const errors = []
  for (const channel of CHANNELS) {
    try {
      const args = [
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--no-default-browser-check',
      ]
      if (!visible) args.push('--window-position=-2400,-2400', '--window-size=1000,760')
      const c = await chromium.launchPersistentContext(PROFILE_DIR, {
        channel,
        headless: false,          // 🔴 不能是无头：无头会被判成风险环境
        viewport: { width: 1366, height: 900 },
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
        args,
      })
      await c.addInitScript(() => {
        try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }) } catch { /* 旧内核 */ }
      })
      log(`浏览器已启动（channel=${channel}，visible=${visible}）`)
      return { ctx: c, channel }
    } catch (e) {
      errors.push(`${channel}: ${String(e?.message ?? e).slice(0, 200)}`)
    }
  }
  throw new Error('起不来浏览器（本机 Edge / Chrome 都试过了）：' + errors.join(' | '))
}

/** 浏览器还活着吗（用户手动关掉窗口 / 崩溃后这里会变 false） */
function alive() {
  if (!ctx) return false
  try {
    const b = ctx.browser?.()
    if (b && typeof b.isConnected === 'function') return b.isConnected()
    ctx.pages()          // 没有 browser() 的持久化上下文：拿页面探一下
    return true
  } catch { return false }
}

/** 拿到浏览器（默认屏幕外）；要换可见性就重启一个 */
async function handle({ visible = false } = {}) {
  if (ctx && ctxVisible === visible && alive()) return ctx
  if (ctx) { try { await ctx.close() } catch { /* 已经关了 */ } ; ctx = null; ctxVisible = null }
  const r = await launch({ visible })
  ctx = r.ctx
  ctxVisible = visible
  ctxChannel = r.channel
  // 👉 用户关掉窗口 / 浏览器崩了：必须把 ctx 清掉，否则后面每次调用都报
  //    "Target page, context or browser has been closed"，而且永远自愈不了
  try {
    ctx.on('close', () => { if (ctx === r.ctx) { ctx = null; ctxVisible = null } })
  } catch { /* 旧版本没有这个事件 */ }
  return ctx
}

async function closeBrowser() {
  if (!ctx) return
  try { await ctx.close() } catch { /* 无所谓 */ }
  ctx = null; ctxVisible = null; ctxChannel = null
}

/** 页面里别开着旧的（保持一个工作页，导航复用它） */
async function workPage(c) {
  const pages = c.pages().filter((p) => !p.isClosed())
  const page = pages[0] || (await c.newPage())
  page.setDefaultTimeout(30000)
  page.setDefaultNavigationTimeout(45000)
  return page
}

/** 把窗口最小化 / 移出屏幕（失败就算了，不影响抓取） */
async function softenWindow(page) {
  try {
    const s = await page.context().newCDPSession(page)
    const { windowId } = await s.send('Browser.getWindowForTarget')
    await s.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } })
  } catch { /* 不是 Chromium 系或缺权限，忽略 */ }
}

/** 拦截指定接口的 JSON 响应 */
function capture(page, matchers) {
  const hits = []
  const onResp = (resp) => {
    const url = resp.url()
    if (!matchers.some((re) => re.test(url))) return
    // 不 await：拿 body 是异步的，失败也不能影响页面
    resp.text().then((txt) => {
      let json = null
      try { json = JSON.parse(txt) } catch { /* 非 JSON */ }
      hits.push({ url, status: resp.status(), json, len: txt.length })
    }).catch(() => { /* 重定向 / 被取消 */ })
  }
  page.on('response', onResp)
  return {
    hits,
    stop: () => { try { page.off('response', onResp) } catch { /* 页面已关 */ } },
    async waitFor(ms = 20000, pred = () => true) {
      const t0 = Date.now()
      while (Date.now() - t0 < ms) {
        const h = hits.filter((x) => x.json && pred(x))
        if (h.length) return h
        await sleep(300)
      }
      return []
    },
  }
}

/* ─────────────────────── 从乱七八糟的 JSON 里挖笔记 ─────────────────────── */

/**
 * 🔴 2026-10-18 实测：搜索接口已经搬到 `so.xiaohongshu.com/api/sns/web/v2/search/notes`
 *    （不再是 `edith…/v1/search/notes`）⇒ 原来那几条正则一条都匹配不上，
 *    结果**全靠 DOM 兜底**：DOM 里的链接是裸 id、没有 xsec_token ⇒ 打开详情页只显示
 *    「当前笔记暂时无法浏览」。所以这里的规则要同时覆盖「多个域名 + v1/v2」。
 */
const NOTE_API = [
  /\/api\/sns\/web\/(?:v\d\/)?search\/notes/,
  /\/api\/sns\/web\/v\d\/feed/,
  /\/api\/sns\/web\/v\d\/note\/detail/,
]
const COMMENT_API = [
  /\/api\/sns\/web\/v\d\/comment\/(?:page|list|sub)/,
]

/**
 * 🔴 导航一律用 `waitUntil: 'commit'`。
 *    实测 `domcontentloaded` 在小红书上经常 45 秒都不触发（第三方脚本/埋点卡住），
 *    但我们真正要的只是「页面开始加载了，然后等接口响应」——`commit` 几百毫秒就返回。
 */
async function go(page, url, ms = 30000) {
  try {
    await page.goto(url, { waitUntil: 'commit', timeout: ms })
    return true
  } catch (e) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 })
      return true
    } catch (e2) {
      log(`打开页面失败（${url.slice(0, 60)}）：${clean(e2?.message ?? e2)}`)
      return false
    }
  }
}

/** 递归找「像笔记卡片」的对象 */
function digNoteCards(node, out = [], depth = 0) {
  if (!node || depth > 8 || out.length > 400) return out
  if (Array.isArray(node)) { for (const x of node) digNoteCards(x, out, depth + 1); return out }
  if (typeof node !== 'object') return out
  const card = node.note_card || node.noteCard
  if (card && typeof card === 'object') {
    out.push({ ...card, __id: node.id || card.note_id || card.noteId || '', __xsec: node.xsec_token || card.xsec_token || '' })
    return out
  }
  if (node.display_title !== undefined && (node.interact_info || node.user)) {
    out.push({ ...node, __id: node.note_id || node.noteId || node.id || '', __xsec: node.xsec_token || '' })
    return out
  }
  for (const k of Object.keys(node)) {
    if (k === '__INITIAL_STATE__') continue
    digNoteCards(node[k], out, depth + 1)
  }
  return out
}

function num(v) {
  if (typeof v === 'number') return v
  const s = clean(v)
  if (!s) return 0
  if (s.includes('万')) return Math.round(parseFloat(s.replace('万', '')) * 10000) || 0
  const n = parseInt(s.replace(/[^\d]/g, ''), 10)
  return Number.isFinite(n) ? n : 0
}

function noteUrl(id, xsec) {
  const base = `https://www.xiaohongshu.com/explore/${id}`
  return xsec ? `${base}?xsec_token=${encodeURIComponent(xsec)}&xsec_source=pc_search` : base
}

function pickList(x, keys) {
  for (const k of keys) { if (Array.isArray(x?.[k])) return x[k] }
  return []
}

function noteToLite(card) {
  const id = clean(card.__id)
  const xsec = clean(card.__xsec)
  const cover = card.cover?.url_default || card.cover?.url || card.image_list?.[0]?.url_default || card.image_list?.[0]?.url || ''
  return {
    id,
    url: id ? noteUrl(id, xsec) : '',
    title: clean(card.display_title || card.title || card.desc || '').slice(0, 120),
    author: clean(card.user?.nickname || card.user?.nick_name || card.user?.name || ''),
    likes: num(card.interact_info?.liked_count ?? card.interact_info?.likedCount ?? card.liked_count),
    collects: num(card.interact_info?.collected_count ?? card.collected_count),
    comments: num(card.interact_info?.comment_count ?? card.comment_count),
    type: clean(card.type || ''),
    cover,
  }
}

/** 从页面上下文里读 __INITIAL_STATE__（Vue 的响应式代理 JSON 化后就是普通对象） */
async function readInitialState(page) {
  try {
    return await page.evaluate(() => {
      const s = window.__INITIAL_STATE__
      if (!s) return null
      try { return JSON.parse(JSON.stringify(s)) } catch { return null }
    })
  } catch { return null }
}

/* ────────────────────────────── 登录 ────────────────────────────── */

async function openLoginPage(page) {
  await go(page, 'https://www.xiaohongshu.com/explore')
  await jitter(1500, 2500)
  // 没弹出登录框就点一下「登录」
  const hasQr = await page.$('.qrcode')
  if (!hasQr) {
    const btn = await page.$('text=登录')
    if (btn) { try { await btn.click({ timeout: 5000 }) } catch { /* 可能是文字按钮 */ } }
    await jitter(1200, 2200)
  }
}

/**
 * 🔴 登录态的**唯一权威依据**是 `/api/sns/web/v2/user/me` 返回的 `data.guest`。
 *    2026-10-18 踩的坑：原来只看「cookie 里有 web_session + 页面上没二维码」⇒
 *    **游客也有 web_session（38 字符）**、页面在跳转间隙也没有二维码 ⇒ 误报"登录成功"，
 *    使用者以为登好了去跑一轮，结果搜索被登录墙挡住（白烧一轮 + 写出一份"失败日报"）。
 *    现在：guest === true 一律算没登录；拿不到 user/me 就不下结论（返回 unknown ⇒ 继续等）。
 */
let loginHits = []          // 登录会话期间截到的 user/me
let loginWatchPage = null
let lastVerifyAt = 0

function startMeWatch(page) {
  loginHits = []
  loginWatchPage = page
  try { page.off('response', onMeResponse) } catch { /* 没挂过 */ }
  page.on('response', onMeResponse)
}
function onMeResponse(resp) {
  try {
    if (!resp.url().includes('/api/sns/web/v2/user/me')) return
    resp.text().then((t) => {
      const j = JSON.parse(t)
      if (j?.data && typeof j.data === 'object') loginHits.push(j.data)
    }).catch(() => { /* 重定向 / 取消 */ })
  } catch { /* 无所谓 */ }
}
function lastMe() {
  const h = loginHits.filter((x) => x && typeof x === 'object').pop()
  return h || null
}
const isLoggedInMe = (me) => Boolean(me) && me.guest !== true

/** 主动核一次登录态：导航到 /explore，截 user/me（权威），DOM 只做兜底 */
async function verifyLogin(page) {
  const hits = []
  const onResp = (resp) => {
    if (!resp.url().includes('/api/sns/web/v2/user/me')) return
    resp.text().then((t) => {
      try {
        const j = JSON.parse(t)
        if (j?.data && typeof j.data === 'object') hits.push(j.data)
      } catch { /* 非 JSON */ }
    }).catch(() => { /* 无所谓 */ })
  }
  page.on('response', onResp)
  try {
    await go(page, 'https://www.xiaohongshu.com/explore')
  } catch { /* 页面没打开也继续看已有信号 */ }
  for (let i = 0; i < 25 && !hits.length; i++) await sleep(400)
  try { page.off('response', onResp) } catch { /* 无所谓 */ }
  const me = hits.pop() || null
  let dom = {}
  try {
    dom = await page.evaluate(() => {
      const txt = document.body?.innerText || ''
      return {
        hasQr: Boolean(document.querySelector('.qrcode, .login-container')),
        loginWall: /登录后查看|登录后推荐/.test(txt.slice(0, 600)),
        textHead: txt.slice(0, 80),
      }
    })
  } catch { /* 页面没了 */ }
  lastVerifyAt = Date.now()
  return {
    // 拿不到 user/me 就说"不知道"，绝不当成已登录
    known: Boolean(me),
    guest: me ? me.guest === true : null,
    loggedIn: isLoggedInMe(me),
    nickname: clean(me?.nickname || me?.user_nickname || ''),
    userId: clean(me?.user_id || ''),
    hasQr: Boolean(dom.hasQr),
    loginWall: Boolean(dom.loginWall),
  }
}

/** 登录页上不导航、只看当前页面的信号（轮询时用，避免把二维码刷掉） */
async function loginSnapshot(page) {
  const me = lastMe()
  if (isLoggedInMe(me)) {
    return { state: 'ok', loggedIn: true, nickname: clean(me.nickname || '') }
  }
  let dom = {}
  try {
    dom = await page.evaluate(() => ({
      hasQr: Boolean(document.querySelector('.qrcode')),
      loginModal: Boolean(document.querySelector('.login-container')),
      scanning: /扫码成功|扫描成功|请在手机确认|确认登录/.test(document.body?.innerText || ''),
    }))
  } catch { /* 页面没了 */ }
  if (dom.hasQr || dom.loginModal || dom.scanning) {
    return { state: 'waiting', loggedIn: false, note: dom.scanning ? '扫到了，等手机上点确认' : '' }
  }
  return { state: 'unknown', loggedIn: false }
}

async function loginStart() {
  const c = await handle({ visible: true })
  const page = await workPage(c)
  try {
    await openLoginPage(page)
  } catch (e) {
    log(`打开登录页失败：${e?.message ?? e}`)
    await closeBrowser()
    throw new Error('打开小红书登录页失败（网络不通 / 浏览器被关）：' + clean(e?.message ?? e))
  }
  await jitter(1000, 1600)
  // 从现在起，页面自己发的 user/me 都记下来 —— 扫完码它会自己刷新一次，那就是权威信号
  startMeWatch(page)
  let buf = null
  let shotOf = ''
  for (const sel of ['.qrcode img', '.qrcode canvas', '.qrcode', '.login-container img', 'img[src^="data:image"]']) {
    const el = await page.$(sel)
    if (!el) continue
    try {
      const box = await el.boundingBox()
      if (box && box.width > 60 && box.height > 60) { buf = await el.screenshot(); shotOf = sel; break }
    } catch { /* 试下一个 */ }
  }
  if (!buf) { try { buf = await page.screenshot() ; shotOf = 'page' } catch { /* 放弃 */ } }
  const png = buf ? 'data:image/png;base64,' + buf.toString('base64') : ''
  const snap = await loginSnapshot(page)
  log(`登录页已打开（二维码来源=${shotOf || '无'}，state=${snap.state}）`)
  return {
    ok: true,
    loggedIn: Boolean(snap.loggedIn),
    png,
    from: shotOf,
    hint: snap.loggedIn
      ? '已经是登录状态，不用扫码。'
      : '把这张二维码发给本人扫（小红书 App → 我 → 左上角扫一扫），手机上点确认；扫完调 xhs_login_poll 查结果。二维码约 2 分钟内有效。',
  }
}

async function loginPoll() {
  if (!ctx || !alive()) {
    await closeBrowser()
    return { ok: false, state: 'no-browser', message: '登录窗口已经关了（或浏览器崩了）—— 重新点「扫码登录」' }
  }
  try {
    const page = await workPage(ctx)
    if (page !== loginWatchPage) startMeWatch(page)
    const snap = await loginSnapshot(page)
    if (snap.state === 'ok') {
      try { await softenWindow(page) } catch { /* 无所谓 */ }
      log(`登录成功（昵称=${snap.nickname || '未知'}，user/me: guest=false）`)
      return { ok: true, state: 'ok', loggedIn: true, nickname: snap.nickname || '', message: '登录成功（已用 user/me 接口核实），Cookie 存在插件家目录的 browser-profile' }
    }
    if (snap.state === 'waiting') {
      return { ok: true, state: 'waiting', loggedIn: false, message: snap.note || '还没扫 / 还没确认' }
    }
    // 页面既没二维码也没已知登录信号 —— 8 秒一次，主动核一下（导航会刷新页面，所以别太频繁）
    if (Date.now() - lastVerifyAt > 8000) {
      const v = await verifyLogin(page)
      if (v.loggedIn) {
        try { await softenWindow(page) } catch { /* 无所谓 */ }
        log(`登录成功（主动核实：guest=false，昵称=${v.nickname || '未知'}）`)
        return { ok: true, state: 'ok', loggedIn: true, nickname: v.nickname || '', message: '登录成功（已核实）' }
      }
      return { ok: true, state: 'waiting', loggedIn: false, message: v.known ? '还没登录（接口显示仍是游客）' : '页面状态不明，重新点一次「扫码登录」' }
    }
    return { ok: true, state: 'waiting', loggedIn: false, message: '还没扫 / 还没确认' }
  } catch (e) {
    log(`查登录状态失败（浏览器多半被关了）：${e?.message ?? e}`)
    await closeBrowser()
    return { ok: false, state: 'no-browser', message: '登录窗口已经关了（或浏览器崩了）—— 重新点「扫码登录」' }
  }
}

/* ────────────────────────────── 搜索 ────────────────────────────── */

const SORTS = { general: 'general', 综合: 'general', latest: 'time_descending', 最新: 'time_descending', popular: 'popularity_descending', 最热: 'popularity_descending' }

async function searchNotes({ keyword, limit = 20, sort = 'general', noteType = 0 } = {}) {
  const kw = clean(keyword)
  if (!kw) throw new Error('keyword 不能为空')
  const target = Math.max(1, Math.min(Number(limit) || 20, 50))
  const c = await handle({ visible: false })
  const page = await workPage(c)
  const cap = capture(page, NOTE_API)
  const url = `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(kw)}`
    + `&source=web_search_result_notes&type=${Number(noteType) || 0}`
    + `&sort=${SORTS[String(sort)] || 'general'}`
  log(`搜索：${kw}（target=${target}）`)
  await go(page, url)
  await jitter(1800, 2600)

  const collect = () => {
    const all = []
    for (const h of cap.hits) for (const card of digNoteCards(h.json)) all.push(noteToLite(card))
    return dedupe(all)
  }

  let notes = []
  for (let i = 0; i < 8; i++) {
    await cap.waitFor(4000)
    notes = collect()
    if (notes.length >= target) break
    await page.mouse.wheel(0, 1600 + Math.random() * 900)
    await jitter(900, 1600)
  }
  // 兜底 ①：__INITIAL_STATE__（有些版本首屏数据在 SSR 里）
  if (!notes.length) {
    const st = await readInitialState(page)
    if (st) notes = dedupe(digNoteCards(st).map(noteToLite))
  }
  // 兜底 ②：DOM
  if (!notes.length) notes = await domNotes(page)
  cap.stop()

  // 判一下是不是被登录墙拦了 / 撞上风控
  let wall = ''
  try {
    wall = await page.evaluate(() => (document.body?.innerText || '').slice(0, 400))
  } catch { /* 页面没了 */ }
  const loginWall = /登录后查看搜索结果/.test(wall)
  const risk = /安全限制|IP存在风险|300012|异常操作|账号异常|验证后继续/.test(wall)
  const captcha = /滑动验证|拖动滑块|请完成验证|安全验证/.test(wall)
  // ⭐ 留痕：宿主靠这个文件判断"是不是该进冷却"，而不是靠模型在报告里写没写
  if (risk) noteRisk('risk-page', wall.slice(0, 200))
  if (captcha) noteRisk('captcha', wall.slice(0, 200))
  if (loginWall) noteRisk('login-wall', wall.slice(0, 120))

  log(`搜索「${kw}」拿到 ${notes.length} 条${loginWall ? '（被登录墙拦住）' : ''}${risk ? '（触发风控）' : ''}${captcha ? '（要验证码）' : ''}`)
  return {
    ok: !risk,
    keyword: kw,
    count: Math.min(notes.length, target),
    notes: notes.slice(0, target),
    loginWall,
    captcha,
    risk,
    hint: loginWall ? '还没登录（或登录态过期）：去「刷小红书」设置页点「扫码登录」'
      : risk ? '触发了风控（安全限制）：**立刻停手**，别再重试 —— 先在手机上正常用几天'
        : captcha ? '要过验证码：**停手**，在手机上手动过一次'
          : '',
  }
}

function dedupe(list) {
  const seen = new Set()
  const out = []
  for (const n of list) {
    const k = n.id || n.url || n.title
    if (!k || seen.has(k)) continue
    seen.add(k)
    out.push(n)
  }
  return out
}

async function domNotes(page) {
  try {
    return await page.evaluate(() => {
      const out = []
      document.querySelectorAll('section.note-item, .note-item, .feeds-container > *').forEach((el) => {
        const a = el.querySelector('a[href*="/explore/"], a[href*="/search_result/"]')
        const title = el.querySelector('.title, .note-title, footer')?.textContent?.trim() || ''
        const author = el.querySelector('.author .name, .user-name, .name')?.textContent?.trim() || ''
        const like = el.querySelector('.like-wrapper .count, .count')?.textContent?.trim() || ''
        if (a || title) out.push({ id: '', url: a ? a.href : '', title, author, likes: like, cover: el.querySelector('img')?.src || '' })
      })
      return out
    })
  } catch { return [] }
}

/* ────────────────────────────── 笔记详情 ────────────────────────────── */

const ID_RE = /(?:explore|discovery\/item|search_result)\/([0-9a-zA-Z]{16,32})/

async function noteDetail({ url, id } = {}) {
  let noteId = clean(id)
  let xsec = ''
  if (!noteId && url) {
    const m = String(url).match(ID_RE)
    noteId = m ? m[1] : ''
    const tm = String(url).match(/xsec_token=([^&]+)/)
    xsec = tm ? decodeURIComponent(tm[1]) : ''
  }
  if (!noteId) throw new Error('没认出笔记 id：给完整链接或 noteId（那串 24 位左右的字母数字）')
  // 同上：缺 token 就别去打开详情页（只会撞到「安全限制」页，白白多一次可疑请求）
  if (!xsec) throw new Error('缺 xsec_token：请传 xhs_search 返回的完整 url（裸 noteId 打不开，还会触发"安全限制"页）')

  const c = await handle({ visible: false })
  const page = await workPage(c)
  const cap = capture(page, NOTE_API)
  const target = noteUrl(noteId, xsec)
  log(`读笔记：${noteId}`)
  await go(page, target)
  await jitter(1600, 2400)

  /**
   * ⭐ 2026-10-18 实测：详情页**根本不调 feed 接口** —— 笔记正文是 SSR 直接塞进
   *    `window.__INITIAL_STATE__.note.noteDetailMap[<id>].note` 的，而且是**驼峰字段**
   *    （title / desc / tagList / interactInfo / imageList / user）。
   *    原来的 digNoteCards 只认蛇形 note_card ⇒ 永远命中不了，最后退到 DOM，
   *    而 DOM 里连正文都没有（它渲染在虚拟滚动容器里）⇒ 详情只剩标题和标签。
   *    ⇒ 这里**先读 __INITIAL_STATE__**，再退接口，最后才退 DOM。
   */
  let body = null
  let from = ''

  // ① SSR 里的 noteDetailMap（首选：一次全拿到，还不占网络）
  for (let i = 0; i < 12 && !body; i++) {
    body = await readStateNote(page, noteId)
    if (body) { from = 'initial-state'; break }
    await sleep(500)
  }

  // ② 接口 JSON（有时候详情以卡片形式出现在 feed / note detail 里）
  if (!body) {
    for (let i = 0; i < 5; i++) {
      await cap.waitFor(3000)
      const cards = digNoteCards(cap.hits.map((h) => h.json))
      const card = cards.find((x) => clean(x.__id) === noteId) || cards.find((x) => String(x.desc || '').length > 20) || null
      if (card) { body = cardBody(card); from = 'api'; break }
      await page.mouse.wheel(0, 1200)
      await jitter(700, 1200)
    }
  }
  cap.stop()

  // ③ DOM 最后兜底（可能只有标题/标签）
  if (!body) {
    const dom = await page.evaluate(() => {
      const q = (s) => document.querySelector(s)?.textContent?.trim() || ''
      return {
        title: q('#detail-title') || q('.title'),
        desc: q('#detail-desc .note-text') || q('.note-text'),
        author: q('.author-wrapper .username') || q('.author-container .info .username'),
        tags: Array.from(document.querySelectorAll('#detail-desc a, .note-text a')).map((a) => String(a.textContent || '').trim()).filter(Boolean),
      }
    })
    if (dom.title || dom.desc) {
      return { ok: true, id: noteId, url: target, ...dom, likes: 0, collects: 0, comments: 0, from: 'dom', warning: '正文没读到（只有页面上的标题/标签），可能被风控或笔记被限制' }
    }
    throw new Error('没读到笔记内容（可能被风控 / 笔记已删 / 链接缺 xsec_token）—— 换成搜索结果里给的完整链接再试')
  }

  log(`读完笔记：${body.title || noteId}（赞 ${body.likes}·藏 ${body.collects}·评 ${body.comments}，来源=${from}）`)
  await sweepRisk(page)
  return { ok: true, id: noteId, url: target, ...body, from }
}

/** 顺手扫一眼页面上有没有风控/验证码的痕迹（读笔记、读评论时都调） */
async function sweepRisk(page) {
  try {
    const t = await page.evaluate(() => (document.body?.innerText || '').slice(0, 500))
    if (/安全限制|IP存在风险|300012|异常操作|账号异常/.test(t)) noteRisk('risk-page', t.slice(0, 160))
    else if (/滑动验证|拖动滑块|请完成验证|安全验证/.test(t)) noteRisk('captcha', t.slice(0, 160))
  } catch { /* 页面没了 */ }
}

/**
 * 在**页面里**把一条笔记从 SSR state 里按字段抄出来（驼峰）。
 * ⚠️ 为什么不做 `JSON.parse(JSON.stringify(window.__INITIAL_STATE__))`：
 *    Vue 的响应式对象带循环引用 / 函数 ⇒ 整体序列化会抛，结果永远是 null（踩过）。
 *    只挑我们要的标量，一个一个 String()/Number() 转，稳。
 */
async function readStateNote(page, noteId) {
  try {
    const raw = await page.evaluate((id) => {
      const map = window.__INITIAL_STATE__?.note?.noteDetailMap
      if (!map) return null
      const key = id && map[id] ? id : Object.keys(map)[0]
      const n = key ? map[key]?.note : null
      if (!n) return null
      const s = (x) => (x === undefined || x === null ? '' : String(x))
      const like = n.interactInfo || n.interact_info || {}
      return {
        title: s(n.title),
        desc: s(n.desc),
        tags: (n.tagList || n.tag_list || []).map((t) => s(t?.name || t?.tag_name)),
        author: s(n.user?.nickname || n.user?.nickName),
        authorId: s(n.user?.userId || n.user?.user_id),
        likes: s(like.likedCount ?? like.liked_count),
        collects: s(like.collectedCount ?? like.collected_count),
        comments: s(like.commentCount ?? like.comment_count),
        shares: s(like.shareCount ?? like.share_count),
        time: s(n.time || n.lastUpdateTime),
        ip: s(n.ipLocation || n.ip_location),
        images: (n.imageList || n.image_list || []).map((x) => s(x?.urlDefault || x?.url_default || x?.url)).filter(Boolean).slice(0, 12),
        hasVideo: Boolean(n.video),
        type: s(n.type),
      }
    }, noteId || '')
    if (!raw || (!raw.title && !raw.desc)) return null
    return {
      title: clean(raw.title),
      desc: clean(raw.desc),
      tags: raw.tags.filter(Boolean).slice(0, 20),
      author: clean(raw.author),
      authorId: clean(raw.authorId),
      likes: num(raw.likes),
      collects: num(raw.collects),
      comments: num(raw.comments),
      shares: num(raw.shares),
      time: num(raw.time),
      ip: clean(raw.ip),
      images: raw.images,
      video: raw.hasVideo ? { present: true } : null,
      type: clean(raw.type),
    }
  } catch { return null }
}

/** 从接口卡片对象里取一条笔记（蛇形/驼峰都试） */
function cardBody(card) {
  return {
    title: clean(card.title || card.display_title || ''),
    desc: clean(card.desc || ''),
    tags: pickList(card, ['tag_list', 'tagList']).map((t) => clean(t.name || t.tag_name || t)).filter(Boolean).slice(0, 20),
    author: clean(card.user?.nickname || card.user?.nickName || ''),
    authorId: clean(card.user?.user_id || card.user?.userId || ''),
    likes: num(card.interact_info?.liked_count ?? card.interactInfo?.likedCount ?? card.liked_count),
    collects: num(card.interact_info?.collected_count ?? card.interactInfo?.collectedCount ?? card.collected_count),
    comments: num(card.interact_info?.comment_count ?? card.interactInfo?.commentCount ?? card.comment_count),
    shares: num(card.interact_info?.share_count ?? card.interactInfo?.shareCount ?? card.share_count),
    time: num(card.time || card.last_update_time || card.lastUpdateTime),
    ip: clean(card.ip_location || card.ipLocation || ''),
    images: pickList(card, ['image_list', 'imageList']).map((x) => x.url_default || x.urlDefault || x.url || '').filter(Boolean).slice(0, 12),
    video: card.video ? { duration: card.video.capa?.duration || 0, url: card.video.media?.stream?.h264?.[0]?.master_url || card.video.media?.stream?.h264?.[0]?.masterUrl || '' } : null,
    type: clean(card.type || ''),
  }
}

/* ────────────────────────────── 评论 ────────────────────────────── */

async function noteComments({ url, id, limit = 20 } = {}) {
  let noteId = clean(id)
  let xsec = ''
  if (!noteId && url) {
    const m = String(url).match(ID_RE)
    noteId = m ? m[1] : ''
    const tm = String(url).match(/xsec_token=([^&]+)/)
    xsec = tm ? decodeURIComponent(tm[1]) : ''
  }
  if (!noteId) throw new Error('没认出笔记 id')
  /**
   * 🔴 不在缺 xsec_token 时去打开详情页。
   *    2026-10-19 实测：裸 `explore/<id>` 会落到小红书的「安全限制 / 当前笔记暂时无法浏览」页 ——
   *    那不是封号，但**是一次毫无必要的可疑请求**，而且会让人误以为账号被风控。
   *    宁可直接报错，让调用方改用搜索结果的完整链接。
   */
  if (!xsec) throw new Error('缺 xsec_token：请传 xhs_search 返回的完整 url（裸 noteId 打不开，还会触发"安全限制"页）')

  const c = await handle({ visible: false })
  const page = await workPage(c)
  const cap = capture(page, COMMENT_API)
  await go(page, noteUrl(noteId, xsec))
  await jitter(1500, 2400)

  const out = []
  for (let i = 0; i < 4; i++) {
    const hits = await cap.waitFor(4000)
    for (const h of hits) {
      const cs = h.json?.data?.comments || h.json?.comments || []
      for (const cm of cs) {
        out.push({
          author: clean(cm.user_info?.nickname || cm.user?.nickname || ''),
          content: clean(cm.content || ''),
          likes: num(cm.like_count ?? cm.liked_count),
          time: num(cm.create_time || 0),
          replies: num(cm.sub_comment_count ?? (cm.sub_comments?.length || 0)),
          ip: clean(cm.ip_location || ''),
        })
      }
    }
    if (out.length >= limit) break
    await page.mouse.wheel(0, 1500)
    await jitter(800, 1400)
  }
  cap.stop()
  const clean_out = dedupeComments(out).slice(0, Math.max(1, Number(limit) || 20))
  log(`读到 ${clean_out.length} 条评论（${noteId}）`)
  await sweepRisk(page)
  return { ok: true, id: noteId, count: clean_out.length, comments: clean_out }
}

function dedupeComments(list) {
  const seen = new Set()
  const out = []
  for (const c of list) {
    const k = c.author + '|' + c.content.slice(0, 40)
    if (seen.has(k) || !c.content) continue
    seen.add(k)
    out.push(c)
  }
  return out
}

/* ────────────────────────────── MCP 协议 ────────────────────────────── */

const TOOLS = [
  {
    name: 'xhs_status',
    description: '看小红书那边的状态：有没有登录、浏览器用哪个、家目录在哪。第一次用先看这个。',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      let st = { loggedIn: false }
      try {
        const c = await handle({ visible: false })
        const page = await workPage(c)
        const v = await verifyLogin(page)
        st = {
          loggedIn: v.loggedIn,
          known: v.known,
          guest: v.guest,
          nickname: v.nickname,
          hasQr: v.hasQr,
          loginWall: v.loginWall,
          verdict: v.loggedIn ? '已登录' : (v.known ? '未登录（接口显示游客）' : '状态不明'),
        }
      } catch (e) { st = { loggedIn: false, error: clean(e?.message ?? e) } }
      return { ok: true, version: VERSION, home: HOME, profile: PROFILE_DIR, channel: ctxChannel || '(未启动)', ...st }
    },
  },
  {
    name: 'xhs_login_start',
    description: '打开登录页并截下二维码（返回 data:image/png;base64）。把图给本人扫，然后轮询 xhs_login_poll。',
    inputSchema: { type: 'object', properties: {} },
    run: async () => loginStart(),
  },
  {
    name: 'xhs_login_poll',
    description: '查扫码结果：ok=已登录 / waiting=还没确认 / no-browser=登录窗口关了。',
    inputSchema: { type: 'object', properties: {} },
    run: async () => loginPoll(),
  },
  {
    name: 'xhs_search',
    description: '按关键词搜小红书笔记，返回 id / 链接 / 标题 / 作者 / 点赞·收藏·评论数。\n'
      + '⚠️ 刷一轮的用法：每个方向搜一次（20 条左右），再挑其中值得的读正文（xhs_note）。',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '关键词（一个方向一个词，别写一长句）' },
        limit: { type: 'number', description: '返回几条（默认 20，最大 50）' },
        sort: { type: 'string', description: '综合 general / 最新 latest / 最热 popular' },
      },
      required: ['keyword'],
    },
    run: async (a) => searchNotes({ keyword: a.keyword, limit: a.limit, sort: a.sort }),
  },
  {
    name: 'xhs_note',
    description: '读一条笔记的正文：标题 / 正文全文 / 标签 / 作者 / 赞藏评 / 发布时间 / 图片数。判断内容**看正文**，别看标题下结论。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '笔记链接（搜索结果的 url 直接传）' },
        id: { type: 'string', description: '或者直接给 noteId' },
      },
    },
    run: async (a) => noteDetail({ url: a.url, id: a.id }),
  },
  {
    name: 'xhs_comments',
    description: '读一条笔记的评论（作者 / 内容 / 点赞 / 时间）。评论区常常是"热点事件"的第一手现场。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '笔记链接' },
        id: { type: 'string', description: '或者直接给 noteId' },
        limit: { type: 'number', description: '取几条（默认 20）' },
      },
    },
    run: async (a) => noteComments({ url: a.url, id: a.id, limit: a.limit }),
  },
]

const WHITELIST = (() => {
  const raw = String(process.env.XHS_TOOLS || '').trim()
  if (!raw) return null
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))
})()

const usable = () => TOOLS.filter((t) => !WHITELIST || WHITELIST.has(t.name))

/* 一次只跑一个浏览器动作（浏览器是独享资源） */
let chain = Promise.resolve()
const serialize = (fn) => {
  const run = chain.then(fn, fn)
  chain = run.catch(() => { /* 别让链子断掉 */ })
  return run
}

function send(obj) {
  try { process.stdout.write(JSON.stringify(obj) + '\n') } catch { /* stdout 断了 */ }
}

async function onMessage(msg) {
  const { id, method, params } = msg || {}
  if (method === 'initialize') {
    return send({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'xhs-duty', version: VERSION },
      },
    })
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} })
  if (method === 'tools/list') {
    return send({ jsonrpc: '2.0', id, result: { tools: usable().map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } })
  }
  if (method === 'tools/call') {
    const tool = usable().find((t) => t.name === params?.name)
    if (!tool) return send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: `没有这个工具：${params?.name}` }] } })
    try {
      const value = await serialize(() => tool.run(params?.arguments || {}))
      log(`工具 ${tool.name} 完成`)
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(value) }] } })
    } catch (e) {
      log(`工具 ${tool.name} 出错：${e?.message ?? e}`)
      return send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: `出错了：${clean(e?.message ?? e)}` }] } })
    }
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `不支持的方法：${method}` } })
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    onMessage(msg).catch((e) => log(`处理消息出错：${e?.message ?? e}`))
  }
})
process.stdin.on('end', () => { closeBrowser().finally(() => process.exit(0)) })
process.on('SIGTERM', () => { closeBrowser().finally(() => process.exit(0)) })
process.on('uncaughtException', (e) => log(`未捕获异常：${e?.stack ?? e}`))
process.on('unhandledRejection', (e) => log(`未处理的 rejection：${e?.stack ?? e}`))

log(`刷小红书 MCP 起来了（v${VERSION}，家=${HOME}，channel=${process.env.XHS_CHANNEL || 'msedge'}，可见工具=${usable().map((t) => t.name).join(',')}）`)
