/**
 * dsh-xhs-scroll —— 浏览器半端（「设置」里的一页：刷小红书）
 * ============================================================================
 * client bundle 不是 ESM，是**自注册脚本**（跟 dsh-bili-scroll 一样）：
 *   window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => ({ inject, apply }) })
 *
 * 进设置页的写法（抄官方 + dsh-meme）：
 *   const slots = ctx.get('slots')
 *   slots.inject('settings.section', () => slots.register({ name, id, order, label }, () => h(Panel)))
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-xhs-scroll',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API = '/api/xhs-duty'
    /* ⚠️ 不要直接 .json()：HTTP 500 的 {ok:false,error} 会被当成"保存成功" */
    const asJson = async (res) => {
      if (res.ok) return res.json()
      const why = res.status === 401 ? '（未登录 / 没权限）' : res.status === 403 ? '（被宿主拦了）' : ''
      throw new Error('HTTP ' + res.status + why)
    }
    const jget = async (p) => asJson(await fetch(API + p, { credentials: 'same-origin' }))
    const jpost = async (p, body) => asJson(await fetch(API + p, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }))

    const CSS = `
[data-xhs-page]{display:flex;flex-direction:column;gap:14px;padding:2px 2px 12px;max-width:680px;}

/* 每一块是一张卡片：标题 + 内容，边界清楚，不再靠留白猜 */
[data-xhs-sec]{display:flex;flex-direction:column;gap:10px;padding:12px 14px;border-radius:12px;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.10));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.06));}
[data-xhs-h]{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:600;letter-spacing:.02em;
  color:var(--dsw-alias-label-secondary,#c9ccd1);}
[data-xhs-h]::before{content:attr(data-dot);font-size:11px;opacity:.55;}

/* 行：标签在左、控件在右；**换行兜底**，绝不互相压住 */
[data-xhs-row]{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-width:0;}
[data-xhs-grow]{flex:1 1 160px;min-width:0;}
[data-xhs-label]{font-size:13px;line-height:20px;min-width:0;overflow-wrap:anywhere;}
[data-xhs-note]{font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary,#9aa0a6);overflow-wrap:anywhere;}
[data-xhs-echo]{font-size:11px;line-height:16px;color:#22c55e;opacity:.9;}

[data-xhs-sw]{flex:none;width:38px;height:22px;border-radius:11px;border:0;cursor:pointer;position:relative;
  background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.35));transition:background .15s;padding:0;}
[data-xhs-sw][data-on]{background:#3b82f6;}
[data-xhs-sw] i{position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;
  transition:left .15s;display:block;}
[data-xhs-sw][data-on] i{left:19px;}
[data-xhs-sw][disabled]{opacity:.45;cursor:default;}

/* 输入框：默认撑满自己那一行；**在 row 里就不许抢满整行**（原来 width:100% 会把标签挤没） */
[data-xhs-input]{width:100%;box-sizing:border-box;padding:7px 9px;border-radius:8px;font-size:12px;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));color:inherit;font-family:inherit;}
[data-xhs-input]:focus{outline:none;border-color:#3b82f6;}
[data-xhs-row] > [data-xhs-input]{flex:1 1 190px;width:auto;min-width:0;}
[data-xhs-row] > [data-xhs-input][data-xhs-num]{flex:0 0 96px;width:96px;text-align:center;margin-left:auto;}
[data-xhs-row] > [data-xhs-btn]{flex:none;}
[data-xhs-wrap]{flex:1 0 100%;display:flex;flex-direction:column;gap:6px;min-width:0;}
[data-xhs-area]{min-height:92px;resize:vertical;line-height:19px;}
[data-xhs-num]{width:96px;text-align:center;}

[data-xhs-btn]{padding:7px 12px;border-radius:8px;font-size:12px;cursor:pointer;font-family:inherit;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.14));color:inherit;transition:background .15s;}
[data-xhs-btn]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.24));}
[data-xhs-btn][data-primary]{background:#3b82f6;border-color:#3b82f6;color:#fff;}
[data-xhs-btn][disabled]{opacity:.5;cursor:default;}
[data-xhs-msg]{flex:1 1 100%;font-size:11px;line-height:16px;padding:7px 9px;border-radius:8px;
  overflow-wrap:anywhere;background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));
  color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-xhs-msg][data-warn]{color:#f59e0b;}
[data-xhs-msg][data-good]{color:#22c55e;}
[data-xhs-msg][data-bad]{color:#ef4444;}
[data-xhs-qr]{display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap;}
[data-xhs-qr] img{width:160px;height:160px;border-radius:8px;background:#fff;padding:6px;flex:none;}
[data-xhs-pre]{margin:6px 0 0;padding:8px 9px;border-radius:8px;max-height:260px;overflow:auto;font-size:11px;
  line-height:15px;white-space:pre-wrap;overflow-wrap:anywhere;
  background:var(--dsw-alias-bg-overlay,rgba(0,0,0,.25));color:var(--dsw-alias-label-secondary,#c9ccd1);}
[data-xhs-kv]{font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary,#9aa0a6);overflow-wrap:anywhere;}
[data-xhs-badge]{font-size:11px;padding:2px 8px;border-radius:999px;white-space:nowrap;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.14));color:var(--dsw-alias-label-secondary,#c9ccd1);}
[data-xhs-badge][data-on]{background:rgba(59,130,246,.18);color:#60a5fa;}
[data-xhs-badge][data-good]{background:rgba(34,197,94,.16);color:#4ade80;}

/* 子块：缩进 + 左侧竖线，表示"这是上面那个开关展开的" */
[data-xhs-sub]{display:flex;flex-direction:column;gap:10px;margin-left:4px;padding-left:12px;
  border-left:2px solid var(--dsw-alias-border-l2,rgba(128,128,128,.22));}

/* 保存反馈：右下角浮一层，不管滚到哪儿都看得见 */
[data-xhs-toast]{position:fixed;right:22px;bottom:22px;z-index:60;max-width:340px;
  padding:9px 12px;border-radius:10px;font-size:12px;line-height:17px;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));
  background:var(--dsw-alias-bg-overlay,#2a2d31);color:var(--dsw-alias-label-secondary,#c9ccd1);
  box-shadow:0 8px 24px rgba(0,0,0,.35);overflow-wrap:anywhere;}
[data-xhs-toast][data-good]{border-color:rgba(34,197,94,.5);color:#4ade80;}
[data-xhs-toast][data-warn]{border-color:rgba(245,158,11,.5);color:#fbbf24;}
[data-xhs-toast][data-bad]{border-color:rgba(239,68,68,.5);color:#f87171;}

/* 风控冷却卡片：红边，一眼看见 */
[data-xhs-sec][data-risk]{border-color:rgba(239,68,68,.45);
  background:linear-gradient(0deg,rgba(239,68,68,.08),rgba(239,68,68,.08));
  border-left:3px solid #ef4444;}
`

    function Switch({ on, onChange, disabled }) {
      return h('button', {
        'data-xhs-sw': '',
        'data-on': on ? '' : undefined,
        disabled: Boolean(disabled),
        title: on ? '已开' : '已关',
        onClick: () => { if (!disabled) onChange(!on) },
      }, h('i'))
    }

    function ToggleRow({ label, note, on, onChange, disabled }) {
      return h('div', { 'data-xhs-row': '' },
        h('div', { 'data-xhs-grow': '' },
          h('div', { 'data-xhs-label': '' }, label),
          note ? h('div', { 'data-xhs-note': '' }, note) : null),
        h(Switch, { on, onChange, disabled }))
    }

    function useStatus(intervalMs) {
      const [st, setSt] = React.useState(null)
      React.useEffect(() => {
        let alive = true
        const tick = async () => {
          try {
            const d = await jget('/status')
            if (alive && d?.ok) setSt(d)
          } catch { /* 网络抖一下就下次再问 */ }
        }
        tick()
        const t = setInterval(tick, intervalMs || 6000)
        return () => { alive = false; clearInterval(t) }
      }, [intervalMs])
      return [st, setSt]
    }

    function Panel() {
      const [st, setSt] = useStatus(6000)
      const [busy, setBusy] = React.useState('')
      const [msg, setMsg] = React.useState('')
      const [msgTone, setMsgTone] = React.useState('')

      // 输入框一律绑"本地草稿"：页面每 6 秒轮询 /status，直接绑 cfg 会把用户正在打的字冲掉
      const [dirs, setDirs] = React.useState(null)
      const [runAt, setRunAt] = React.useState(null)
      const [mirror, setMirror] = React.useState(null)
      const [ws, setWs] = React.useState(null)
      const [perDir, setPerDir] = React.useState(null)
      const [deepRead, setDeepRead] = React.useState(null)
      const [dshBin, setDshBin] = React.useState(null)

      const [login, setLogin] = React.useState(null)
      const [loginState, setLoginState] = React.useState('')
      const [loginTone, setLoginTone] = React.useState('')
      const [runNote, setRunNote] = React.useState(null)
      const [report, setReport] = React.useState(null)
      const [installTail, setInstallTail] = React.useState('')

      // 投递（会话 / 邮件 / 通知）
      const [sessionId, setSessionId] = React.useState(null)
      const [smtpHost, setSmtpHost] = React.useState(null)
      const [smtpPort, setSmtpPort] = React.useState(null)
      const [smtpUser, setSmtpUser] = React.useState(null)
      const [mailTo, setMailTo] = React.useState(null)
      const [smtpPass, setSmtpPass] = React.useState('')
      const [deliverMsg, setDeliverMsg] = React.useState('')
      const [deliverTone, setDeliverTone] = React.useState('')

      const loginTimer = React.useRef(null)
      const alive = React.useRef(true)
      React.useEffect(() => () => {
        alive.current = false
        if (loginTimer.current) { clearInterval(loginTimer.current); loginTimer.current = null }
      }, [])

      const cfg = st?.config
      React.useEffect(() => {
        if (!cfg) return
        if (dirs === null) setDirs(cfg.directions || '')
        if (runAt === null) setRunAt(cfg.runAt || '21:00')
        if (mirror === null) setMirror(cfg.mirrorDir || '')
        if (ws === null) setWs(cfg.workspace || '')
        if (perDir === null) setPerDir(String(cfg.perDirection ?? 20))
        if (deepRead === null) setDeepRead(String(cfg.deepRead ?? 8))
        if (dshBin === null) setDshBin(cfg.dshBin || '')
        if (sessionId === null) setSessionId(cfg.sessionId || '')
        if (smtpHost === null) setSmtpHost(cfg.smtpHost || 'smtp.qq.com')
        if (smtpPort === null) setSmtpPort(String(cfg.smtpPort ?? 465))
        if (smtpUser === null) setSmtpUser(cfg.smtpUser || '')
        if (mailTo === null) setMailTo(cfg.mailTo || '')
      }, [cfg, dirs, runAt, mirror, ws, perDir, deepRead, dshBin, sessionId, smtpHost, smtpPort, smtpUser, mailTo])

      const flash = (text, tone) => { setMsg(text); setMsgTone(tone || '') }
      const patch = async (p, what) => {
        try {
          const d = await jpost('/config', { patch: p })
          if (d?.ok) { setSt(d); flash(`已保存：${what}`, 'good') } else flash('保存失败：' + (d?.error || '未知原因'), 'bad')
        } catch (e) { flash('保存失败：' + String(e?.message || e), 'bad') }
      }

      /**
       * ⭐ 自动保存：**改动即落盘**，不再依赖"记得点保存"。
       * 起因（2026-10-19 使用者反馈"控制面板里改的东西没保存"）：原来方向 / 镜像目录 / SMTP 账号 /
       * 收件人 / 会话 ID 都只在点按钮时才写 —— 看完就走，等于白填。
       * 现在：文本类 onBlur 立即存、输入类 350ms 防抖存；按钮保留当"兜底 + 心里踏实"。
       */
      const autoTimer = React.useRef(null)
      const pending = React.useRef({})
      const autoSave = (p, what) => {
        pending.current = { ...pending.current, ...p }
        if (autoTimer.current) clearTimeout(autoTimer.current)
        autoTimer.current = setTimeout(async () => {
          const body = pending.current
          pending.current = {}
          try {
            const d = await jpost('/config', { patch: body })
            if (!alive.current) return
            if (d?.ok) { setSt(d); flash(`已自动保存 · ${what || Object.keys(body).join('/')}`, 'good') }
            else flash('保存失败：' + (d?.error || '未知原因'), 'bad')
          } catch (e) { flash('保存失败：' + String(e?.message || e), 'bad') }
        }, 350)
      }
      React.useEffect(() => () => { if (autoTimer.current) clearTimeout(autoTimer.current) }, [])

      /** 立刻把待保存的草稿刷盘（点按钮前必须调它，否则会读到旧配置） */
      const flushSave = async () => {
        if (!autoTimer.current) return
        clearTimeout(autoTimer.current)
        autoTimer.current = null
        const body = pending.current
        pending.current = {}
        if (!Object.keys(body).length) return
        try { const d = await jpost('/config', { patch: body }); if (d?.ok) setSt(d) } catch { /* 下面还会再报 */ }
      }

      // 反馈浮层 3 秒后自己消失，不占地方
      React.useEffect(() => {
        if (!msg) return
        const t = setTimeout(() => { if (alive.current) setMsg('') }, 3200)
        return () => clearTimeout(t)
      }, [msg, msgTone])

      const onRun = async () => {
        setBusy('run'); setRunNote(null)
        try {
          const d = await jpost('/run', { why: 'manual' })
          if (d?.started) setRunNote({ tone: 'good', text: '已经开跑（后台跑，大概 5-15 分钟），跑完日报会写到 ' + (d.report || '') })
          else setRunNote({ tone: 'warn', text: '没跑起来：' + (d?.error || '未知原因') })
          if (d?.ok) setSt(d)
        } catch (e) { setRunNote({ tone: 'warn', text: '没跑起来：' + String(e?.message || e) }) }
        setBusy('')
      }

      /** 解除风控冷却（只有使用者自己确认账号恢复后才该点） */
      const onClearRisk = async () => {
        setBusy('risk')
        try {
          const d = await jpost('/risk/clear', { note: '设置页手动解除（使用者确认账号已恢复）' })
          if (d?.ok) {
            flash('冷却已解除。建议先把量降下来（每方向 20 / 精读 8）再跑', 'good')
            try { setSt(await jget('/status')) } catch { /* 下次轮询会刷新 */ }
          } else flash('解除失败：' + (d?.error || ''), 'bad')
        } catch (e) { flash('解除失败：' + String(e?.message || e), 'bad') }
        setBusy('')
      }

      const onLoginStart = async () => {
        setBusy('login'); setLoginState('正在打开浏览器…'); setLoginTone('')
        try {
          const d = await jpost('/login/start', {})
          if (!d?.ok) { setLoginState('出码失败：' + (d?.error || '')); setLoginTone('warn'); return }
          if (d.loggedIn) { setLoginState('已经是登录状态，不用扫码。'); setLoginTone('good'); return }
          setLogin({ png: d.png || '' })
          setLoginState('二维码出来了 —— 用小红书 App（我 → 左上角扫一扫）扫一下，扫完在这里等结果。')
          // 轮询登录结果
          if (loginTimer.current) clearInterval(loginTimer.current)
          loginTimer.current = setInterval(async () => {
            try {
              const r = await jpost('/login/poll', {})
              if (!alive.current) return
              if (r?.state === 'ok') {
                clearInterval(loginTimer.current); loginTimer.current = null
                setLoginState('登录成功' + (r.nickname ? `（${r.nickname}）` : '') + ' —— Cookie 已存好，以后不用再扫。')
                setLoginTone('good')
                setLogin(null)
                setBusy('')
              } else if (r?.state === 'no-browser') {
                clearInterval(loginTimer.current); loginTimer.current = null
                setLoginState('登录窗口被关掉了 —— 重新点一次「扫码登录」。'); setLoginTone('warn'); setBusy('')
              }
            } catch { /* 下次再问 */ }
          }, 3000)
        } catch (e) { setLoginState('出码失败：' + String(e?.message || e)); setLoginTone('warn') }
        setBusy('')
      }

      const onDoctor = async () => {
        setBusy('check'); flash('正在自检（会开一次浏览器，十几秒）…', '')
        try {
          const d = await jpost('/doctor', {})
          if (d?.ok) flash(`能用：已登录${d.nickname ? '（' + d.nickname + '）' : ''}，浏览器 ${d.channel || 'ok'}`, 'good')
          else flash('还不能用：' + (d?.error || (d?.loggedIn ? '' : '没登录')) + ' —— 先点「扫码登录」', 'warn')
        } catch (e) { flash('自检失败：' + String(e?.message || e), 'bad') }
        setBusy('')
      }

      const onShowReport = async () => {
        setBusy('report')
        try {
          const d = await jget('/report')
          if (d?.exists) setReport(d.text)
          else { setReport(null); flash('今天还没有日报 —— 点「现在跑一轮」', 'warn') }
        } catch (e) { flash('读日报失败：' + String(e?.message || e), 'bad') }
        setBusy('')
      }

      const onOpen = async (what) => {
        try {
          const d = await jpost('/open', { what })
          if (!d?.ok) flash('打不开：' + (d?.error || ''), 'warn')
        } catch { /* 无所谓 */ }
      }

      const onInstall = async () => {
        setBusy('install')
        try {
          const d = await jpost('/install', {})
          flash(d?.started ? '正在补依赖（几十秒），进度见下面；装完重启一次 dsh' : ('没起来：' + (d?.error || '')), d?.started ? 'good' : 'warn')
        } catch (e) { flash('失败：' + String(e?.message || e), 'bad') }
        setBusy('')
      }

      React.useEffect(() => {
        if (busy !== 'install') return
        const t = setInterval(async () => {
          try {
            const d = await jget('/logs')
            if (d?.tail) setInstallTail(d.tail)
          } catch { /* 无所谓 */ }
        }, 2500)
        return () => clearInterval(t)
      }, [busy])

      const onSaveTexts = async () => {
        await patch({
          directions: String(dirs || ''),
          runAt: String(runAt || '21:00'),
          mirrorDir: String(mirror || '').trim(),
          workspace: String(ws || '').trim(),
          dshBin: String(dshBin || '').trim(),
          perDirection: Math.max(5, Math.min(Number(perDir) || 20, 50)),
          deepRead: Math.max(1, Math.min(Number(deepRead) || 8, 30)),
        }, '方向 / 时间 / 目录')
      }

      /* ── 投递相关 ── */
      const dflash = (text, tone) => { setDeliverMsg(text); setDeliverTone(tone || '') }

      const onSaveDelivery = async () => {
        await patch({
          sessionId: String(sessionId || '').trim(),
          smtpHost: String(smtpHost || '').trim(),
          smtpPort: Math.max(1, Math.min(Number(smtpPort) || 465, 65535)),
          smtpUser: String(smtpUser || '').trim(),
          mailTo: String(mailTo || '').trim(),
        }, '投递设置')
        dflash('已保存', 'good')
      }

      const onSavePass = async () => {
        if (!String(smtpPass || '').trim()) { dflash('授权码是空的', 'warn'); return }
        await flushSave()
        try {
          const d = await jpost('/smtp-pass', { pass: String(smtpPass).trim() })
          if (d?.ok) { dflash(d.note || '授权码已保存', 'good'); setSmtpPass('') }
          else dflash('保存失败：' + (d?.error || ''), 'bad')
        } catch (e) { dflash('保存失败：' + String(e?.message || e), 'bad') }
      }

      const onClearPass = async () => {
        try {
          const d = await jpost('/smtp-pass/clear', {})
          if (d?.ok) dflash('授权码已清除', 'good')
          else dflash('清除失败：' + (d?.error || ''), 'bad')
        } catch (e) { dflash('清除失败：' + String(e?.message || e), 'bad') }
      }

      const onTest = async (what) => {
        setBusy('test:' + what)
        await flushSave()               // 先把刚改的账号/收件人存进去，否则测的是旧配置
        dflash(what === 'mail' ? '正在发测试邮件…' : what === 'session' ? '正在往会话里投一条…' : '正在弹通知…', '')
        try {
          const d = await jpost('/deliver/test', { what })
          const ch = d?.channels?.[what]
          if (ch?.ok) dflash(what === 'mail' ? `邮件发出去了（${(ch.accepted || []).join(',') || '已接受'}）` : '成功', 'good')
          else dflash('失败：' + (ch?.why || d?.error || '未知原因'), 'warn')
        } catch (e) { dflash('失败：' + String(e?.message || e), 'bad') }
        setBusy('')
      }

      const onDeliverNow = async () => {
        setBusy('deliver')
        await flushSave()
        try {
          const d = await jpost('/deliver/now', { what: 'all' })
          const chs = d?.channels || {}
          const desc = Object.entries(chs).map(([k, v]) => `${k}=${v?.ok ? 'ok' : '失败'}`).join(' · ')
          dflash(desc ? `已投递：${desc}` : (d?.skipped || '没有通道开启'), d?.ok ? 'good' : 'warn')
          if (d?.ok) setSt(d)
        } catch (e) { dflash('失败：' + String(e?.message || e), 'bad') }
        setBusy('')
      }

      const PRESETS = {
        'smtp.qq.com': { port: 465, note: 'QQ 邮箱：设置 → 账户 → 开启 SMTP 服务，拿到「授权码」' },
        'smtp.163.com': { port: 465, note: '163 邮箱：设置 → POP3/SMTP → 开启，拿到「授权码」' },
        'smtp.gmail.com': { port: 465, note: 'Gmail：需要开启两步验证后生成「应用专用密码」' },
        'smtp-mail.outlook.com': { port: 587, note: 'Outlook：端口 587（STARTTLS）' },
      }
      const presetNote = PRESETS[String(smtpHost || '')]?.note || ''

      if (!st) return h('div', { 'data-xhs-page': '' }, h('div', { 'data-xhs-note': '' }, '读设置中…'))

      const sw = (k) => Boolean(cfg?.[k])
      const dirCount = String(dirs || '').split(/\r?\n/).filter((s) => s.trim()).length

      return h('div', { 'data-xhs-page': '' },

        /* ── 顶部状态 ── */
        h('div', { 'data-xhs-row': '' },
          h('span', { 'data-xhs-badge': '' }, st.running ? '正在跑' : (st.reportExists ? `今天已跑（${st.pickedToday} 条）` : '今天还没跑')),
          h('span', { 'data-xhs-badge': '' }, st.profileExists ? '登录过' : '没登录'),
          h('span', { 'data-xhs-badge': '' }, `每天 ${cfg?.runAt || '21:00'}`),
          h('span', { 'data-xhs-badge': '' }, 'v' + (st.version || '?')),
          h('div', { 'data-xhs-grow': '' }),
          h('button', { 'data-xhs-btn': '', disabled: Boolean(busy) || st.running, onClick: onRun }, st.running ? '正在跑…' : '现在跑一轮')),
        runNote ? h('div', { 'data-xhs-msg': '', 'data-good': runNote.tone === 'good' ? '' : undefined, 'data-warn': runNote.tone === 'warn' ? '' : undefined }, runNote.text) : null,
        (st.lastRunAt ? h('div', { 'data-xhs-note': '' }, `上次跑：${new Date(st.lastRunAt).toLocaleString('zh-CN')}`) : null),

        /* ── 风控冷却：撞了墙就别再撞 ── */
        st.risk?.inCooldown ? h('div', { 'data-xhs-sec': '', 'data-risk': '' },
          h('div', { 'data-xhs-row': '' },
            h('div', { 'data-xhs-grow': '' },
              h('div', { 'data-xhs-label': '', style: { color: '#f87171' } },
                `⛔ 风控冷却中 · 还剩 ${st.risk.cooldownLeftText || ''}`),
              h('div', { 'data-xhs-note': '' },
                (st.risk.reason ? `原因：${st.risk.reason}。` : '')
                + '冷却期内**连手动也不会跑**。撞到「安全限制 / 异常操作 / 验证码」之后继续跑，最容易把"提醒"升级成"封号"。')),
            h('button', { 'data-xhs-btn': '', disabled: Boolean(busy), onClick: onClearRisk }, '解除冷却')),
          st.risk.lastSignal ? h('div', { 'data-xhs-note': '' },
            `最后信号：${st.risk.lastSignal.kind} · ${String(st.risk.lastSignal.detail || '').slice(0, 80)}`) : null)
          : null,

        /* ── 什么时候跑 ── */
        h('div', { 'data-xhs-sec': '' },
          h('div', { 'data-xhs-h': '', 'data-dot': '⏰' }, '什么时候自己跑'),
          h(ToggleRow, {
            label: '每天自动刷一轮',
            note: '关掉之后只会手动跑；开着的话到点由 DSH 自己起一轮（不用你在场）',
            on: sw('enabled'),
            onChange: (v) => patch({ enabled: v }, '每天自动跑'),
          }),
          h('div', { 'data-xhs-row': '' },
            h('div', { 'data-xhs-grow': '' },
              h('div', { 'data-xhs-label': '' }, '每天几点'),
              h('div', { 'data-xhs-note': '' }, '到点那一分钟内 DSH 活着就会跑；错过的话下次打开 DSH 会补跑')),
            h('input', {
              'data-xhs-input': '', 'data-xhs-num': '', type: 'time', value: runAt || '21:00',
              onChange: (e) => { setRunAt(e.target.value); autoSave({ runAt: e.target.value }, '每天几点') },
            })),
          h(ToggleRow, {
            label: '错过也补跑',
            note: '那天 21:00 时电脑关着 / DSH 没开，下次打开时补上这一轮',
            on: sw('catchUp'),
            onChange: (v) => patch({ catchUp: v }, '错过补跑'),
          })),

        /* ── 关注什么 ── */
        h('div', { 'data-xhs-sec': '' },
          h('div', { 'data-xhs-h': '', 'data-dot': '🎯' }, '关注什么'),
          h('div', { 'data-xhs-label': '' }, `方向（一行一个，现在 ${dirCount} 个）`),
          h('textarea', {
            'data-xhs-input': '', 'data-xhs-area': '', value: dirs || '',
            placeholder: 'AI 工具 / 效率\n消费 / 品牌\n职场 / 副业',
            onChange: (e) => { setDirs(e.target.value); autoSave({ directions: e.target.value }, '关注方向') },
            onBlur: (e) => autoSave({ directions: e.target.value }, '关注方向'),
          }),
          h('div', { 'data-xhs-note': '' }, '写"方向"而不是"关键词堆"：每个方向会被当成一次搜索词，也会决定它怎么归类热点。'),
          h('div', { 'data-xhs-row': '' },
            h('div', { 'data-xhs-grow': '' }, h('div', { 'data-xhs-label': '' }, '每个方向抓几条候选')),
            h('input', {
              'data-xhs-input': '', 'data-xhs-num': '', value: perDir || '',
              onChange: (e) => setPerDir(e.target.value.replace(/[^\d]/g, '')),
              onBlur: () => autoSave({ perDirection: Math.max(5, Math.min(Number(perDir) || 20, 50)) }, '每个方向抓几条'),
            })),
          h('div', { 'data-xhs-row': '' },
            h('div', { 'data-xhs-grow': '' }, h('div', { 'data-xhs-label': '' }, '全部方向一共精读几条（读正文）')),
            h('input', {
              'data-xhs-input': '', 'data-xhs-num': '', value: deepRead || '',
              onChange: (e) => setDeepRead(e.target.value.replace(/[^\d]/g, '')),
              onBlur: () => autoSave({ deepRead: Math.max(1, Math.min(Number(deepRead) || 8, 30)) }, '精读几条'),
            })),
          ((Number(perDir) || 0) > 25 || (Number(deepRead) || 0) > 12)
            ? h('div', { 'data-xhs-note': '', style: { color: '#fbbf24' } },
              `⚠️ 现在的量偏大（每方向 ${perDir || '?'} 条 × ${dirCount} 个方向 = ${(Number(perDir) || 0) * dirCount} 条候选，精读 ${deepRead || '?'} 篇）。`
              + '实测值 20 / 8 更稳；2026-10-19 那次「异常操作」提醒就发生在 50 / 20 的配置下。')
            : null,
          h('div', { 'data-xhs-row': '' },
            h('div', { 'data-xhs-grow': '' }, h('div', { 'data-xhs-label': '' }, '排序')),
            h('select', {
              'data-xhs-input': '', value: cfg?.sort || 'general',
              onChange: (e) => patch({ sort: e.target.value }, '搜索排序'),
            },
            h('option', { value: 'general' }, '综合'),
            h('option', { value: 'latest' }, '最新'),
            h('option', { value: 'popular' }, '最热'))),
          h(ToggleRow, {
            label: '读评论区',
            note: '热点/争议的挑几条看评论 —— 评论常比正文更能说明"大家在争什么"',
            on: sw('readComments'),
            onChange: (v) => patch({ readComments: v }, '读评论区'),
          }),
          h('div', { 'data-xhs-row': '' },
            h('div', { 'data-xhs-grow': '' }, h('div', { 'data-xhs-label': '' }, '日报写多细')),
            h('select', {
              'data-xhs-input': '', value: cfg?.reportLevel || 'full',
              onChange: (e) => patch({ reportLevel: e.target.value }, '日报形态'),
            },
            h('option', { value: 'full' }, '完整（主题 + 事件 + 细看清单）'),
            h('option', { value: 'brief' }, '薄版（一屏看完）'))),
          h('div', { 'data-xhs-label': '' }, '工作区镜像目录（写一份到这里，方便 git / 别的工具用；留空 = 不镜像）'),
          h('input', {
            'data-xhs-input': '', value: mirror || '',
            onChange: (e) => setMirror(e.target.value),
            onBlur: (e) => autoSave({ mirrorDir: String(e.target.value || '').trim() }, '工作区镜像目录'),
            placeholder: 'D:\\reports\\xhs-daily',
          }),
          h('div', { 'data-xhs-row': '' },
            h('button', { 'data-xhs-btn': '', disabled: Boolean(busy), onClick: onSaveTexts }, '再保存一次（其实已经自动存了）'))),

        /* ── 怎么把结果给你 ── */
        h('div', { 'data-xhs-sec': '' },
          h('div', { 'data-xhs-h': '', 'data-dot': '📮' }, '怎么把结果给你'),
          h('div', { 'data-xhs-note': '' }, '跑完一轮后自动投递；三个通道各自独立，可以只开一个。'),

          // ① 会话
          h('div', { 'data-xhs-row': '' },
            h('div', { 'data-xhs-grow': '' },
              h('div', { 'data-xhs-label': '' }, '投到 DSH 会话'),
              h('div', { 'data-xhs-note': '' }, '往聊天里推一条摘要，那个会话的 AI 会当场把要点说给你听')),
            h('select', {
              'data-xhs-input': '', value: cfg?.sessionTarget || 'off',
              onChange: (e) => patch({ sessionTarget: e.target.value }, '会话投递'),
            },
            h('option', { value: 'off' }, '不投'),
            h('option', { value: 'latest' }, '最近活跃的会话'),
            h('option', { value: 'fixed' }, '指定会话'))),
          (cfg?.sessionTarget === 'fixed')
            ? h('div', { 'data-xhs-row': '' },
              h('div', { 'data-xhs-grow': '' }, h('div', { 'data-xhs-note': '' }, '会话 ID（session-…）')),
              h('input', {
                'data-xhs-input': '', value: sessionId || '', placeholder: 'session-xxxxxxxx-...',
                onChange: (e) => setSessionId(e.target.value),
                onBlur: (e) => autoSave({ sessionId: String(e.target.value || '').trim() }, '日报会话 ID'),
              }))
            : null,
          h('div', { 'data-xhs-note': '' }, '💡 想固定投到某个会话：打开那个会话（比如新建一个「小红书日报」），在里面说一句「把刷小红书日报投到这个会话」—— AI 会调 xhs_bind_session 自动绑好，不用手抄 ID。'),
          cfg?.sessionTarget !== 'off' ? h('div', { 'data-xhs-note': '' }, '⚠️ 投进去的消息来源是「你」，所以那个会话会真的跑一轮模型（有成本）。') : null,

          // ② 邮件
          h(ToggleRow, {
            label: '发到邮箱',
            note: '摘要 + 完整日报（.md 附件）',
            on: sw('deliverMail'),
            onChange: (v) => patch({ deliverMail: v }, '邮件通知'),
          }),
          sw('deliverMail') ? h('div', { 'data-xhs-sub': '' },
            // 服务器/账号/收件人一律「标签在上、输入框在下」—— 行内并排会被长输入框挤没
            h('div', { 'data-xhs-wrap': '' },
              h('div', { 'data-xhs-label': '' }, 'SMTP 服务器'),
              h('input', {
                'data-xhs-input': '', value: smtpHost || '', placeholder: 'smtp.qq.com',
                onChange: (e) => setSmtpHost(e.target.value),
                onBlur: (e) => {
                  const host = String(e.target.value || '').trim()
                  const p = PRESETS[host]
                  if (p) { setSmtpPort(String(p.port)); autoSave({ smtpHost: host, smtpPort: p.port }, 'SMTP 服务器') } else autoSave({ smtpHost: host }, 'SMTP 服务器')
                },
              })),
            presetNote ? h('div', { 'data-xhs-note': '' }, presetNote) : null,
            h('div', { 'data-xhs-row': '' },
              h('div', { 'data-xhs-grow': '' }, h('div', { 'data-xhs-label': '' }, '端口')),
              h('input', {
                'data-xhs-input': '', 'data-xhs-num': '', value: smtpPort || '',
                onChange: (e) => setSmtpPort(e.target.value.replace(/[^\d]/g, '')),
                onBlur: () => autoSave({ smtpPort: Math.max(1, Math.min(Number(smtpPort) || 465, 65535)) }, 'SMTP 端口'),
              })),
            h('div', { 'data-xhs-wrap': '' },
              h('div', { 'data-xhs-label': '' }, '邮箱账号'),
              h('input', {
                'data-xhs-input': '', value: smtpUser || '', placeholder: 'you@qq.com',
                onChange: (e) => setSmtpUser(e.target.value),
                onBlur: (e) => autoSave({ smtpUser: String(e.target.value || '').trim() }, '邮箱账号'),
              })),
            h('div', { 'data-xhs-wrap': '' },
              h('div', { 'data-xhs-label': '' }, st.smtpPassConfigured ? '授权码（已配置；重填会覆盖）' : '授权码（不是登录密码）'),
              h('div', { 'data-xhs-row': '' },
                h('input', {
                  'data-xhs-input': '', type: 'password', value: smtpPass, placeholder: st.smtpPassConfigured ? '••••••••（已保存）' : '邮箱设置里开 SMTP 后拿到的授权码',
                  onChange: (e) => setSmtpPass(e.target.value),
                }),
                h('button', { 'data-xhs-btn': '', disabled: Boolean(busy), onClick: onSavePass }, '保存授权码'))),
            h('div', { 'data-xhs-note': '' }, '授权码交给 DSH 的 credentials 服务托管，不写进 config.json。'),
            st.smtpPassConfigured ? h('div', { 'data-xhs-row': '' }, h('button', { 'data-xhs-btn': '', onClick: onClearPass }, '清除授权码')) : null,
            h('div', { 'data-xhs-wrap': '' },
              h('div', { 'data-xhs-label': '' }, '发给谁（多个用逗号隔开）'),
              h('input', {
                'data-xhs-input': '', value: mailTo || '', placeholder: 'you@qq.com',
                onChange: (e) => setMailTo(e.target.value),
                onBlur: (e) => autoSave({ mailTo: String(e.target.value || '').trim() }, '收件人'),
              }))) : null,

          // ③ 桌面通知
          h(ToggleRow, {
            label: '弹 Windows 通知',
            note: '窗口没开、会话不可投时至少响一下（点不开文件，只是提醒）',
            on: sw('deliverToast'),
            onChange: (v) => patch({ deliverToast: v }, '桌面通知'),
          }),

          h('div', { 'data-xhs-row': '' },
            h('button', { 'data-xhs-btn': '', 'data-primary': '', disabled: Boolean(busy), onClick: onSaveDelivery }, '保存投递设置'),
            h('button', { 'data-xhs-btn': '', disabled: Boolean(busy), onClick: () => onTest('mail') }, '发测试邮件'),
            h('button', { 'data-xhs-btn': '', disabled: Boolean(busy), onClick: () => onTest('session') }, '测试会话投递'),
            h('button', { 'data-xhs-btn': '', disabled: Boolean(busy), onClick: onDeliverNow }, '把今天的日报发一遍')),
          deliverMsg ? h('div', { 'data-xhs-msg': '', 'data-good': deliverTone === 'good' ? '' : undefined, 'data-warn': deliverTone === 'warn' ? '' : undefined, 'data-bad': deliverTone === 'bad' ? '' : undefined }, deliverMsg) : null,
          st.lastDelivery ? h('div', { 'data-xhs-kv': '' },
            `上次投递：${new Date(st.lastDelivery.at).toLocaleString('zh-CN')} · ${Object.entries(st.lastDelivery.channels || {}).map(([k, v]) => `${k}=${v?.ok ? 'ok' : '失败'}`).join(' · ') || (st.lastDelivery.skipped || '无通道')}`) : null),

        /* ── 账号 ── */
        h('div', { 'data-xhs-sec': '' },
          h('div', { 'data-xhs-h': '', 'data-dot': '🔐' }, '账号与浏览器'),
          h('div', { 'data-xhs-row': '' },
            h('button', { 'data-xhs-btn': '', disabled: Boolean(busy), onClick: onLoginStart }, '扫码登录'),
            h('button', { 'data-xhs-btn': '', disabled: Boolean(busy), onClick: onDoctor }, '测一下'),
            h('div', { 'data-xhs-note': '' }, '小红书不扫码不给搜（搜索页会显示"登录后查看搜索结果"）')),
          loginState ? h('div', { 'data-xhs-msg': '', 'data-good': loginTone === 'good' ? '' : undefined, 'data-warn': loginTone === 'warn' ? '' : undefined }, loginState) : null,
          login?.png ? h('div', { 'data-xhs-qr': '' },
            h('img', { src: login.png, alt: '小红书登录二维码' }),
            h('div', { 'data-xhs-note': '' },
              '手机小红书 → 我 → 左上角「扫一扫」',
              h('br'),
              '扫完在手机上点确认；这里会自动刷新结果。',
              h('br'),
              '⚠️ 二维码约 2 分钟有效，过期就再点一次。')) : null),

        /* ── 高级 ── */
        h('div', { 'data-xhs-sec': '' },
          h('div', { 'data-xhs-h': '', 'data-dot': '⚙️' }, '高级'),
          h('div', { 'data-xhs-row': '' },
            h('div', { 'data-xhs-grow': '' }, h('div', { 'data-xhs-label': '' }, '浏览器')),
            h('select', {
              'data-xhs-input': '', value: cfg?.channel || 'msedge',
              onChange: (e) => patch({ channel: e.target.value }, '浏览器'),
            },
            h('option', { value: 'msedge' }, 'Edge（系统自带）'),
            h('option', { value: 'chrome' }, 'Chrome'),
            h('option', { value: 'chromium' }, 'Playwright 自带 Chromium'))),
          h('div', { 'data-xhs-wrap': '' },
            h('div', { 'data-xhs-label': '' }, '工作区（按那儿的 AGENTS.md 说话；留空 = 中性说话）'),
            h('input', {
              'data-xhs-input': '', value: ws || '', placeholder: 'D:\\your-workspace',
              onChange: (e) => setWs(e.target.value),
              onBlur: (e) => autoSave({ workspace: String(e.target.value || '').trim() }, '工作区'),
            })),
          h('div', { 'data-xhs-wrap': '' },
            h('div', { 'data-xhs-label': '' }, 'dsh 路径（留空自动找）'),
            h('input', {
              'data-xhs-input': '', value: dshBin || '', placeholder: '…\\@deepseek-ai\\dsh\\lib\\bin.js',
              onChange: (e) => setDshBin(e.target.value),
              onBlur: (e) => autoSave({ dshBin: String(e.target.value || '').trim() }, 'dsh 路径'),
            })),
          h('div', { 'data-xhs-label': '' }, '跑一轮用哪个 profile'),
          h('input', { 'data-xhs-input': '', value: cfg?.headlessProfile || 'headless', disabled: true }),
          h('div', { 'data-xhs-row': '' },
            h('button', { 'data-xhs-btn': '', disabled: Boolean(busy), onClick: onInstall }, '补浏览器依赖'),
            h('div', { 'data-xhs-note': '' }, '一般用不到；只有把插件目录挪走 / node_modules 丢了才需要')),
          installTail ? h('pre', { 'data-xhs-pre': '' }, installTail) : null),

        /* ── 它的地盘 ── */
        h('div', { 'data-xhs-sec': '' },
          h('div', { 'data-xhs-h': '', 'data-dot': '📁' }, '它的地盘'),
          h('div', { 'data-xhs-kv': '' },
            '家目录：' + (st.home || ''),
            h('br'),
            '今日日报：' + (st.report || ''),
            st.mirror ? h('br') : null,
            st.mirror ? '工作区镜像：' + st.mirror : null),
          h('div', { 'data-xhs-row': '' },
            h('button', { 'data-xhs-btn': '', disabled: busy === 'report', onClick: onShowReport }, '看今日日报'),
            h('button', { 'data-xhs-btn': '', onClick: () => onOpen('out') }, '打开报告文件夹'),
            h('button', { 'data-xhs-btn': '', onClick: () => onOpen('home') }, '打开家目录'),
            h('button', { 'data-xhs-btn': '', onClick: () => { if (st.report) { try { navigator.clipboard?.writeText(st.report) } catch { /* 无所谓 */ } } } }, '复制路径')),
          report !== null ? h('pre', { 'data-xhs-pre': '' }, report) : null),

        /* 保存反馈浮层（右下角，3 秒后自己消失） */
        msg ? h('div', {
          'data-xhs-toast': '',
          'data-good': msgTone === 'good' ? '' : undefined,
          'data-warn': msgTone === 'warn' ? '' : undefined,
          'data-bad': msgTone === 'bad' ? '' : undefined,
        }, msg) : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-xhs-scroll')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-xhs-scroll: 设置页样式')

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'xhs-scroll', order: 31, label: '刷小红书' },
          () => h(Panel),
        ))
      },
    }
  },
})
