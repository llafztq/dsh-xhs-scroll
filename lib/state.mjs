/**
 * lib/state.mjs —— 插件的"家"与配置
 * ============================================================================
 * 规矩：**配置、浏览器 profile、报告、日志都放插件自己的家** —— `$DSH_HOME/xhs-duty/`，
 * 绝不写进插件包目录（装进 node_modules 后可能只读，升级也会被覆盖）。
 *
 * 目录长这样：
 *   xhs-duty/
 *     config.json          用户配置（与 DSH 原生设置页逐字段对账）
 *     browser-profile/     Playwright 持久化 profile（Cookie 在里头，整个目录都算敏感）
 *     out/<日期>.md         日报
 *     digest/<年-月>.md     一条一条的归档（给"回头翻"用）
 *     seen.md              判重表（哪条笔记已经看过了）
 *     duty.md              值班章程（可改；升级规矩见 ensureCharter）
 *     browser.log          MCP/浏览器的日志
 *     duty.log             跑一轮的日志
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { homedir } from 'node:os'

/**
 * ⚠️ 坑（dsh-bili-scroll 也踩过）：`ctx.get('dshHomePath')` 返回的是**函数**，不是字符串。
 *    形状 `dshHomePath(...segments) => join(resolveDshHome(), ...segments)`。
 *    当字符串用会把函数源码拼进路径 ⇒ mkdir ENOENT ⇒ apply 抛错 ⇒ 整条插件不激活。
 */
export function stateDirOf(ctx) {
  let dir = ''
  try {
    const p = ctx?.get?.('dshHomePath')
    if (typeof p === 'function') {
      const v = p('xhs-duty')
      if (v) dir = String(v)
    } else if (typeof p === 'string' && p) {
      dir = join(p, 'xhs-duty')
    }
  } catch { /* 拿不到就用兜底 */ }
  if (!dir) dir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'xhs-duty')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
}

export function writeJson(file, value) {
  writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
}

/**
 * 值班章程怎么升级（抄的 dsh-bili-scroll 的记账制，理由一模一样）：
 *   家里那份 === 上次铺的（sha256 对得上）⇒ 他没动过 ⇒ 用新版覆盖；
 *   变了 ⇒ 他改过 ⇒ 一个字不动，新版另存 duty.md.new。
 */
export function ensureCharter(pluginDir, stateDir, log = () => {}) {
  const shipped = join(pluginDir, 'prompts', 'duty.md')
  const home = join(stateDir, 'duty.md')
  const ledger = join(stateDir, 'charter.sha256')
  const fresh = join(stateDir, 'duty.md.new')
  const readIf = (f) => { try { return readFileSync(f, 'utf8') } catch { return '' } }
  const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex')
  try {
    if (!existsSync(shipped)) return
    const newText = readFileSync(shipped, 'utf8')
    const hShip = sha(newText)
    const hLast = readIf(ledger).trim()
    if (!existsSync(home)) {
      writeFileSync(home, newText, 'utf8'); writeFileSync(ledger, hShip, 'utf8')
      log('已铺好值班章程')
      return
    }
    const hHome = sha(readFileSync(home, 'utf8'))
    if (hHome === hShip) { if (hLast !== hShip) writeFileSync(ledger, hShip, 'utf8'); return }
    if (!hLast || hHome !== hLast) {
      if (hShip !== hLast && readIf(fresh) !== newText) {
        writeFileSync(fresh, newText, 'utf8')
        log('章程有新版、但家里那份你改过 ⇒ 新版另存 duty.md.new')
      }
      return
    }
    writeFileSync(home, newText, 'utf8'); writeFileSync(ledger, hShip, 'utf8')
    log('值班章程已更新')
  } catch (e) { log(`铺章程失败：${e?.message ?? e}`) }
}

export function charterPath(pluginDir, stateDir) {
  const home = join(stateDir, 'duty.md')
  return existsSync(home) ? home : join(pluginDir, 'prompts', 'duty.md')
}

/** 'HH:MM' → 当天分钟数 */
export function minutesOf(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim())
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

/** 本地日期 YYYY-MM-DD */
export function dayKey(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

/** YYYY-MM（归档按月一个文件） */
export function monthKey(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}`
}
