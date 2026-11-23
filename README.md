# opencode-manage

在会话标签行加一页「Go 余额」：一个账号一张卡片，同时看多个 OpenCode Go 账号的 5 小时 / 本周 / 本月额度。

## 安装

发布在 npm：`opencode-manage`；源码：<https://github.com/pcysanji/opencode-manage>。

装进某个 DSH profile 的两种方式（都要重启桌面端才生效）：

- 插件管理面板里装 `opencode-manage`。
- 手动：在该 profile 的 `package.json` 里加依赖 `"opencode-manage": "link:<本仓库绝对路径>"`（或版本号），把它加进 `dsh.profile.bundles`，再 `pnpm install`。

插件自带 `cordis.patch.yml`，客户端半边由 `package.json` 的 `dsh.client` 自动装载，不需要另外配置。

## 怎么看

- 位置：会话标签行（对话 · 轨迹 · 上下文 · 编队 · 记忆系统 · **Go 余额**），点开才拉数据，不常驻轮询。
- 每张卡三个环形表盘：窗口名 + 百分比 + 重置时间（本机时区）。蓝色正常、琥珀 ≥70%、红色 ≥90%。
- 卡片头部：账号名、来源（DSH 配置 / 凭据库 / 手填）、key 末四位、状态。
- 「刷新全部」重新拉；页头可设自动刷新间隔（0=关）。手填的卡可以删除（两步确认）；右上「添加账号」就地出表单卡。
- 每张卡底部都有「编辑」：改名字、换 key。名字只影响这一页显示；换 key 会写回 DSH 凭据库的同一个 ref，模型那边同时生效。手填卡的 key 只改本机 `accounts.json`。留空保存=只改名。

## 账号从哪来

1. DSH 模型配置里 baseURL 指向 `opencode.ai` 的 provider（`llm-pi-ai` 里的 `opencode-go-free`、`go163`）。
2. `.credentials.yaml` 的 refs 里名字含 opencode、值以 `oc_` 开头的 key。
3. 页面里手填的 key，存 `$DSH_HOME/opencode-usage/accounts.json`（0600）。

同一个 key 出现多次只显示一行。key 只留在宿主进程，浏览器只拿到末四位。

## 数据来源

`GET https://opencode.ai/zen/go/v1/usage`（备用 `/inference/go/v1/usage`），Bearer key，返回三个窗口的 percent + resetsAt。宿主注册 `/opencode-usage/api/*` 做同源代理。

## 自动刷新与提醒

- 页头「自动刷新 [N] 分钟」，`0` = 关闭（默认 0）。设了 N 就每 N 分钟在后台拉一次，切到别的标签页也照跑。
- 用量跨过 85% / 90% / 98% 各弹一次桌面通知，标题写窗口名与档位，正文带账号、百分比和重置时间。同一条线只报一次，掉回 85% 以下重新武装。
- 通知走浏览器 Notification：第一次设置时弹授权；拒了就一直只在页面顶部显示提示条，卡片颜色照常变。
- 间隔存在浏览器 localStorage（`opencode-manage:auto-minutes`）；插件改名前的旧键 `dsh-opencode-usage:auto-minutes` 会在第一次读取时自动搬过来并删掉，不用重设。DSH 窗口最小化仍会通知，整个应用退出就不再拉。

## 自动切号（OpenCode Go Auto）

模型列表里多一个 `OpenCode Go Auto`（provider id `opencode-go`，凭据 ref `OPENCODE_GO_AUTO`）。它用的 key 由宿主在后台换，不用手动改配置。

这条路由故意不写 `api` 和 `models`：pi-ai 自带目录给 `opencode-go` 的每个模型带自己的协议（openai-completions / openai-responses / anthropic-messages / google-generative-ai），写死任何一种协议都会把其余模型挡在外面。",1)

- 每 5 分钟（`TICK_MS`）看一眼所有账号的 5 小时 / 周 / 月额度，三个窗口都参与判断。
- 选号：按月额度重置日最早优先（同一天再比周用量、5 小时用量）；5 小时或周额度到 99.9% 换下一个；月额度到 100% 停用到下个重置日；全部出局就保持当前号不动。
- 换号 = `credentials.set('OPENCODE_GO_AUTO', <新 key>)`。模型请求每次都按凭据 ref 现取 key，所以下一次请求就生效，不用重启。
- 换号会弹一条桌面通知（标题「Go 自动切号：<账号>」，`from → to` + 原因）；页面顶部的状态条同步显示队列、当前用谁、上次换号时间。
- 状态条上的「关闭」只停换号（照常刷新数字），存在 `$DSH_HOME/opencode-usage/router.json`。
- 队列顺序 = 使用顺序：能用的在前，出局的灰掉排后面，chips 上的 1 / 2 / 3 就是下一次会用的先后。

### 手动指定某个号

状态条上的队列 chip 可以直接点：

- 点某个号 → 立刻切到它（`POST /router/manual`），状态行显示「手动指定中」，那个 chip 带虚线边和「手动」标记。
- 手动期间自动逻辑不再抢（它只负责刷数字、盯着这个号有没有爆额度）。
- 手动指定的号一旦月额度满 / 周或 5 小时到 99.9%，自动退回按规则选号，并在页面顶部提示「手动指定的号不可用了，已回到自动」。
- 再点一次当前手动的号，或点动作区的「回到自动」，就交回自动。

```bash
node scripts/selftest-router.mjs   # 19 项：选号/不来回跳/周满换号/5 小时满换号/月满停用/全停用不动/开关生效/手动切到指定号/手动期间自动不抢/手动号爆额度回到自动/空 id 回自动/不存在的号报 404/不泄露完整 key
```

## 自测

```bash
node scripts/selftest.mjs        # 宿主路由 + 真实接口
node scripts/selftest-edit.mjs   # 改名/换 key 的 12 项断言（临时 DSH_HOME，不碰真数据）
```

改完哪半边要生效：只动 `client.js` → 刷新页面即可；动了 `index.js`（宿主）→ **必须重启一次 DSH 桌面端**，只刷新页面会一直 404。

## 看版式（不用重启桌面端）

```bash
python build_preview.py          # 生成 preview/index.html
```

预览页内联了 client.js、亮暗两套令牌、假数据与最小 React shim，可直接用浏览器打开截图；`preview/task-all.mjs` 是 ego-browser 截图脚本（亮/暗/窄屏/添加表单/加载骨架五态）。

## 已知

- `OPENCODE_API_KEY` 与 `OPENCODE_API_KEY_GO163` 目前是同一个 key，界面合成一张卡显示（名字后面 `+1`）。
- 接口只给三个窗口的百分比与重置时间，不给美元金额；官方没有稳定的用量 API，这里用的是 `zen/go/v1/usage`。
- 改名对配置来源的卡只存在本机 `accounts.json` 的 `aliases` 里（按 ref 记账），不动 DSH 的 provider 配置。
