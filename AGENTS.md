# 给 AI 助手看的（本仓库 = 一个 DSH 插件）

`dsh-xhs-scroll`（中文名「**刷小红书**」）：每天替用户刷一轮小红书 —— 按他填的方向搜、读正文和评论，
提炼当日**热点主题 / 热点事件**，写一份日报；可选复制到工作区。

## 帮用户装 / 排查时的顺序

1. `dsh plugin --profile desktop add "link:<插件目录>"`，然后**提醒重启一次 dsh**（bundle 层要重启）。
2. 设置 → **刷小红书** → 「**扫码登录**」（手机小红书 → 我 → 扫码）。不登录**搜不了**（搜索页会显示"登录后查看搜索结果"）。
3. 「**测一下**」= 真起一次浏览器 + 查登录态，直接回答"能不能用"。
4. 「**现在跑一轮**」= 立刻跑（不等 21:00）；进度看 `$DSH_HOME/xhs-duty/duty.log`。

## ⚠️ 几条硬约束（都是实测撞出来的，别改回去）

- **不能 headless**。无头模式下小红书直接返回 `安全限制 / IP存在风险 / error_code=300012`。
  现在是 headful + `--window-position=-2400,-2400`（窗口在屏幕外）。
- **搜索必须登录**。未登录时 `/search_result` 只有登录墙，没有笔记。
- **登录态唯一判据 = `/api/sns/web/v2/user/me` 的 `data.guest`**。
  游客也有 `web_session` cookie（38 字符）—— 2026-10-18 就是因为只看 cookie 假阳性，
  误报"登录成功"后跑了一轮、被登录墙挡住、白烧一轮。**别再改回看 cookie 判断**。
- **搜索接口在 `so.xiaohongshu.com/api/sns/web/v2/search/notes`**（2026-10 实测；
  早先是 `edith…/v1/search/notes`）。item 顶层带 `id` 和 `xsec_token`；
  **笔记链接必须带 `xsec_token`**，否则详情页只显示「当前笔记暂时无法浏览」。
  DOM 里的 `href` 是裸 id、没有 token —— 所以**不能靠 DOM 兜底拿链接**。
- **详情页不调 feed 接口**。正文 SSR 在 `window.__INITIAL_STATE__.note.noteDetailMap[<id>].note`，
  字段是**驼峰**：`title / desc / tagList / interactInfo{likedCount,collectedCount,commentCount} / imageList / user`。
  ⚠️ 不要 `JSON.parse(JSON.stringify(__INITIAL_STATE__))` —— Vue 响应式对象有循环引用会抛，
  要在页面里**按字段手工取**（见 `readStateNote`）。
- **导航统一用 `go()`（`waitUntil: 'commit'`）**。`domcontentloaded` 在小红书上经常 45 秒不触发。
- **评论接口**：`/api/sns/web/v2/comment/page?note_id=…`。
- **登录二维码是页面里的 `.qrcode img`**（128×128）—— 对它截图就是可扫的码。
- **只读**。所有工具都没有写能力。要加写入能力请先问用户。
- **一个 profile 只能一个进程**：`browser-profile/` 被占用时第二个浏览器起不来
  （报 `Target page, context or browser has been closed`，多半是并发调用）。
- **跑一轮 = `dsh --profile headless --patch <overlay> <prompt>`**，overlay 把 `server/mcp_server.mjs`
  挂成 stdio MCP（`@deepseek-ai/dsh-mcp-client`），并把工具白名单塞进 `XHS_TOOLS`。
  桌面版 spawn 出去必须带 `ELECTRON_RUN_AS_NODE=1`，否则"再开一个 Electron 应用、0 秒退出"。
- **没登录不许跑那一轮**（`runDuty` 里的 `login.json` 门禁）：否则只会换来一份"失败日报"。
- **定时器 / 子进程回调里绝不让异常外冒**：未捕获异常会杀掉整个 DSH 宿主（bili 那边血的教训）。

## 仓库结构

- `index.js` —— host 半端：10 个工具 + 每天定时器 + `/api/xhs-duty/*` + 配置（`config.json`）+ 跑一轮 + 工作区镜像 + 投递
- `client.js` —— 浏览器半端：设置页（`settings.section`，label「刷小红书」）
- `server/mcp_server.mjs` —— 内置 MCP：登录 / 搜索 / 详情 / 评论；Playwright 驱动本机浏览器，截接口 JSON
- `lib/` —— `state.mjs`（家目录、章程升级记账、日期）/ `mcp.mjs`（100 行 stdio JSON-RPC 客户端）/ `hostdeps.mjs`（从宿主树取 `defineTool`，拿不到用本地等价实现）/ **`deliver.mjs`（会话投递 + 邮件 + 通知 + 日报摘要抽取）**
- `prompts/duty.md` —— 一轮要做的事 + 日报格式（用户可改）

## 风控冷却（2026-10-19 加，**别削弱它**）

**起因**：有使用者反馈在小红书 App 内收到「异常操作」提醒。当时的配置是每方向 50 条 × 4 方向、精读 20 篇、每天 12:00
（≈ 200 条候选/天），是建议值（20 / 8）的 2.5–5 倍。**量级才是主因**，不是"像不像人"。

- 抓取端（`mcp_server.mjs`）看到 `安全限制 / 300012 / 异常操作 / 滑动验证` 就写 `risk-signals.jsonl`；
  宿主消费后写 `risk.json{pauseUntil}`，**冷却期内连手动 `xhs_run` 也拒绝**。
- 解除只有一个入口：`xhs_clear_risk` 或设置页「解除冷却」——**故意不做自动化绕过**。
- 明确不做：指纹伪装、UA 轮换、代理池、模拟人类轨迹、验证码打码。
  这既是平台规则问题，也会把"提醒"升级成"封号"；要做的是**降量 + 停手**，不是骗过检测。
- 另外：缺 `xsec_token` 时直接报错，**不再去打开 `explore/<id>`**（那会落到「安全限制」页，白送一次可疑请求）。

## 投递（2026-10-19 加）

- 会话投递 = `ctx.get('agents').get(sessionId).followup({ role:'user', source:{ kind:'user' }, ... })`。
  **必须 `kind:'user'` + `followup()`**（dsh-selfwake 实测：换成 send/steer 消息不进界面）。
  副作用：消息来源是 user ⇒ 那个会话会**真的跑一轮模型**，所以只投摘要 + "说两句"，不投全文。
- SMTP 授权码存 **DSH credentials**（`ref = 'XHS_SMTP_PASS'`），不写 config.json；拿不到服务才退明文并警告。
- nodemailer 是**按需 import**，没装不影响别的通道。
- 计数口径又修了一次：`countPickedToday` 只认 `### <16–32 位十六进制 ID>`，
  因为「热点主题 / 热点事件」也用 `###`（曾经把 4 篇数成 8 篇，直接骗了模型）。

## 约定

- 配置与运行数据都在 `$DSH_HOME/xhs-duty/`，**不写进插件包目录**（包目录可能只读、升级会被覆盖）。
- `duty.md` 升级走**记账制**（`charter.sha256`）：用户改过就一个字不动，新版另存 `duty.md.new`。
- 日报里的 `### <笔记ID>` 标题行是**计数依据**（宿主数这些行算"今天挑了几条"），改格式要同步改 `countPickedToday`。
