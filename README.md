# dsh-xhs-scroll（刷小红书）

每天替你刷一轮小红书：**按你填的方向搜 → 读正文和评论 → 提炼当日热点主题与事件 → 写一份日报**，
写到 `$DSH_HOME/xhs-duty/out/<日期>.md`，并可按配置再复制一份到你指定的目录（默认不镜像）。

> 只读。这个插件**没有**点赞 / 收藏 / 评论 / 关注 / 发布的能力 —— 工具层就没有。

## 它怎么工作

```
设置页（client.js）──/api/xhs-duty/*──▶ host 插件（index.js）
                                        │  ·每天 21:00 定时器
                                        │  ·注册 xhs_* 工具（给会话里的 AI 用）
                                        │  ·到点起一轮：dsh --profile headless --patch <overlay> <prompt>
                                        ▼
                          server/mcp_server.mjs（内置 MCP，stdio）
                                        │  Playwright 驱动本机 Edge/Chrome
                                        ▼
                     小红书网页（真实登录态，Cookie 存在 browser-profile/）
```

- **抓取方式**：让页面自己走一遍搜索/打开笔记，然后把小红书前端自己请求的那几个接口的 JSON 截下来
  （2026-10 实测：搜索在 `so.xiaohongshu.com/api/sns/web/v2/search/notes`，评论在 `edith…/v2/comment/page`；
  **笔记正文不在接口里**，是 SSR 直接塞进 `window.__INITIAL_STATE__.note.noteDetailMap[<id>].note` 的）。
  比逐条点开抄 DOM 稳得多（改版不影响）、也快得多。三级兜底：接口 JSON → `__INITIAL_STATE__` → DOM 文本。
- **必须 headful**：无头浏览器会被小红书判成风险环境，直接回「安全限制 / IP存在风险 / 300012」。
  所以默认开一个**挪到屏幕外**的真实窗口（`--window-position=-2400,-2400`），你看不到但它是真窗口。
- **搜索必须登录**：没登录时搜索页只有一句「登录后查看搜索结果」。登录一次（扫码），Cookie 存在
  `$DSH_HOME/xhs-duty/browser-profile/`，之后长期有效（账号被动退出才需要再扫）。

## 装

```powershell
git clone <本仓库> dsh-xhs-scroll
cd dsh-xhs-scroll
npm install --omit=dev        # 装 playwright-core + nodemailer（不下载浏览器）
dsh plugin --profile desktop add "link:<克隆下来的绝对路径>"
# 然后重启一次 dsh（bundle 层要重启才组装）
```

> 依赖里**不含浏览器**：用的是你系统里的 Edge / Chrome（`playwright-core` 只负责驱动），
> 所以不需要 `npx playwright install`，不会额外下 100+ MB。

首次用：设置 → **刷小红书** → 点「**扫码登录**」→ 手机小红书扫页面上的二维码。
扫完可以点「**测一下**」自检；再点「**现在跑一轮**」看第一份日报。

## 设置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 每天自动跑的总开关（关掉只手动跑） |
| `runAt` | `21:00` | 每天几点跑（那一分钟内 DSH 活着就开跑） |
| `catchUp` | `true` | 到点时 DSH 没开 ⇒ 下次打开补跑这一轮 |
| `directions` | AI 工具 / 效率、消费 / 品牌、职场 / 副业 | **一行一个方向**，每个方向一次搜索 |
| `perDirection` | `20` | 每个方向抓多少条候选（5–50） |
| `deepRead` | `8` | 全部方向加起来精读（读正文）几条（1–30） |
| `sort` | `general` | `general` 综合 / `latest` 最新 / `popular` 最热 |
| `readComments` | `true` | 热点/争议的挑几条读评论 |
| `reportLevel` | `full` | `full` 完整 / `brief` 薄版 |
| `mirrorDir` | 空（不镜像） | 日报副本写到哪 |
| `workspace` | 空 | 指到某个目录就按那儿的 `AGENTS.md` 说话（留空 = 中性说话） |
| `channel` | `msedge` | `msedge` / `chrome` / `chromium` |
| `sessionTarget` | `latest` | 会话投递：`off` / `latest`（最近活跃）/ `fixed`（指定的 `sessionId`） |
| `sessionId` | 空 | `sessionTarget=fixed` 时投给哪个会话 |
| `deliverMail` | `false` | 邮件投递（SMTP，见下） |
| `smtpHost` / `smtpPort` | `smtp.qq.com` / `465` | SMTP 服务器 |
| `smtpUser` / `smtpFrom` | 空 | 发件账号 / 发件人（留空用账号） |
| `mailTo` | 空 | 收件人（多个用逗号） |
| `deliverToast` | `false` | Windows 通知兜底 |

## 怎么把结果送到你手上

跑完一轮后自动投递，**三个通道各自独立**：

1. **投到 DSH 会话**（抄 `dsh-selfwake` 的机制）：`agents.get(sessionId).followup(...)` 把一条摘要推进聊天，
   那个会话的 AI 会当场用几句人话把要点说出来。⚠️ 消息来源是「user」，所以**会真的跑一轮模型**（有成本），
   默认只推摘要 + "说两句"，不塞全文。
2. **邮件**：摘要正文 + 完整日报作为 `.md` 附件。**授权码不写进 config.json** ——
   存在 DSH 的 `credentials` 服务里（引用名 `XHS_SMTP_PASS`），拿不到那个服务才退到明文并明确警告。
   | 邮箱 | 服务器 | 端口 | 授权码在哪拿 |
   |---|---|---|---|
   | QQ | `smtp.qq.com` | 465 | 设置 → 账户 → 开启 SMTP，拿「授权码」 |
   | 163 | `smtp.163.com` | 465 | 设置 → POP3/SMTP → 开启 |
   | Gmail | `smtp.gmail.com` | 465 | 两步验证 → 应用专用密码 |
   | Outlook | `smtp-mail.outlook.com` | 587 | —— |
3. **Windows 通知**：窗口没开 / 会话不可投时至少响一下（只提醒，点不开文件）。

设置页里有「**发测试邮件**」「**测试会话投递**」「**把今天的日报发一遍**」三个按钮，配完点一下就知道通没通。
也能在会话里让 AI 调 `xhs_deliver`。

## 工具（会话里的 AI 可以直接用）

| 工具 | 干什么 |
|---|---|
| `xhs_status` | 今天跑没跑、登录没登录、报告在哪、上次投递成没成 |
| `xhs_login_start` / `xhs_login_poll` | 出二维码 / 查扫码结果 |
| `xhs_search` | 关键词搜笔记（id / 链接 / 标题 / 作者 / 赞藏评） |
| `xhs_note` | 读一条笔记的正文全文（标题/正文/标签/作者/赞藏评/时间） |
| `xhs_comments` | 读一条笔记的评论 |
| `xhs_run` | 立刻跑一轮（不等 21:00） |
| `xhs_deliver` | 把日报主动送出去：`all` / `session` / `mail` / `toast` |
| `xhs_config` | 读/改设置（字段同上表） |
| `xhs_doctor` | 自检：浏览器能不能起来、登录态还在不在 |
| `xhs_install` | 补 `playwright-core` 依赖（挪过目录才需要） |

## 目录

```
$DSH_HOME/xhs-duty/
├── config.json            用户配置（设置页写的就是它）
├── browser-profile/       Playwright 持久化 profile —— **Cookie 在里面，整个目录都算敏感**
├── duty.md                值班章程（可改；新版会另存 duty.md.new，不覆盖你的）
├── out/<日期>.md           日报
├── digest/<年-月>.md       归档：看过的每一条（一行一条，给以后检索）
├── seen.md                判重表
├── qrcode_login.png       最近一次的登录二维码
├── browser.log            MCP / 浏览器日志
├── duty.log               跑一轮的日志
└── install.log            补依赖的日志
```

## 排错（症状 → 原因）

| 症状 | 原因 / 怎么办 |
|---|---|
| 搜到 0 条，提示「还没登录（或登录态过期）」 | 登录态失效。去设置页重新扫码。**判定以 `user/me` 的 `guest` 为准**，不是看 cookie |
| 详情页只显示「当前笔记暂时无法浏览」 | 链接缺 `xsec_token`。必须用 `xhs_search` 返回的 `url`，别自己拼 |
| 报「Target page, context or browser has been closed」 | 同一个 profile 被另一个进程占着（并发调用）。等那一轮结束再试 |
| 页面卡住 / 45 秒超时 | 小红书前端某些脚本会拖住 `domcontentloaded`。插件已统一用 `waitUntil: 'commit'`，若仍卡多半是网络 |
| 出现「安全限制 / IP存在风险 / 300012」 | 无头模式或 IP 被风控。确认用的是真窗口；连续触发就停一天、换个网络 |
| 报告里一条 `### 笔记ID` 都没有 | 那一轮没读到正文（多半登录/风控）。看 `duty.log` 尾部 |
| 设置页里没有「刷小红书」 | 没重启 dsh（bundle 层要重启才组装） |

## 已知风险（诚实说）

1. **小红书反自动化**。headful + 人手速 + 只读能把风险压到很低，但不是零：频繁搜可能撞验证码 / 限流，
   严重会临时限制账号。建议**每天一轮、别调太大**（`perDirection` 20、`deepRead` 8 是保守值）。
2. **接口结构会变**。截的是小红书自家前端接口（2026-10 实测：搜索在 `so.xiaohongshu.com/v2/search/notes`，
   正文在页面 SSR 的 `__INITIAL_STATE__.note.noteDetailMap` 里，评论在 `v2/comment/page`）。
   它改字段时递归查找大多能兜住，但不能保证。真挂了看 `browser.log`。
3. **必须 headful** ⇒ 跑的时候任务栏/桌面会有一个窗口（默认移到屏幕外）。别在跑的时候手动关它。
4. **一个 profile 同时只能一个进程用**。21:00 那轮跑的时候，别同时点「现在跑一轮」。
5. **日报质量取决于模型**。它会不会"看出热点"跟模型能力、给你的方向写得多具体直接相关 ——
   方向写「AI」不如写「AI 剪辑工具 / 国产大模型应用」。

## 参考

- 抓取思路参考 [iFurySt/RedNote-MCP](https://github.com/iFurySt/RedNote-MCP)（MIT）—— 但这边换成了截接口 JSON，不逐条抄 DOM。
- 插件骨架（host 半端 + 内置 MCP + headless 值班轮 + 设置页 + 章程升级记账）来自 [dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll)（MIT）。
