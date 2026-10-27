# dsh-notify

会话回答完成时发一条桌面通知。dsh 自身只在侧边栏给非当前会话标一个「已完成」状态点，
这个插件把它变成真正的系统通知。

## 行为

1. 只在一轮 **running → idle** 转场时发通知。goal 续跑、steering 消息会连续开新 turn 但不
   会让 Agent 掉出 running，所以按 turn 发会刷屏，按转场发只有一次。
2. 同一会话的通知用 `replaces_id` 原地更新，不叠加。
3. 通知标题是会话标题（没有标题时用工作目录名），正文是最后一条回复的前
   `previewChars` 个字符（空白折叠成一行）。
4. `turn/end` 的原因会体现在标题前缀上：`⚠` 出错或 blocked，`⏹` 被中断/取消，`…` 撞到
   token 上限；fork 不发通知。
5. 子代理会话默认不发通知。
6. urgency 固定为 normal：quickshell 的 critical 通知不会自动消失，对「回答好了」这种日常提示
   不合适。
7. 通知带一个 `default` action，所以整张卡片可点。点一下 = 切到那条会话（见下面「点击跳转」）。
8. 如果你正看着那条会话（页面可见、窗口有焦点、主视图就是它），**不发通知** —— 答案已经在你眼前了。

## 什么时候不该打扰

Host 知道「谁跑完了」，但「你在看哪条」只有浏览器知道，所以由客户端上报：

1. 客户端每轮轮询前先 `POST /api/dsh-notify/presence`，内容是 `{ sessionId, active }`；
   `sessionId` 取「主视图 retain 的那条」（`retainedBy.mainView > 0`，侧边栏标当前行用的是同一个事实），
   `active` 是「页面可见 且 窗口有焦点」。
2. `visibilitychange` 与 `blur` 时立刻再报一次：用户一停止观看，Host 就该立刻恢复通知，不用等下一个 tick。
3. Host 只在 running→idle 那一刻读最新报告，三个条件全满才静默：报告未过期（8s）、`active`、会话就是它。
   任一未知都照常通知 —— 多弹一条的代价远小于该弹没弹。

TTL 存在的原因：关掉的标签页会把它最后一条报告留在 Host 里，如果一直当真，之后所有通知都会被吞掉。

配置 `skipWhenFocused: false` 可以关掉这个行为。


## 点击跳转

点击发生在 Host（D-Bus `ActionInvoked`），但「切到哪条会话」只有已连接的 UI 能改。所以分成两半：

1. Host 收到 `ActionInvoked` 后记下会话 id，挂在一次性的 `POST /api/dsh-notify/claim` 后面，
   同时尝试把 DSH 窗口抬到最前（`focusCommand`）。
2. 浏览器那一半（`src/client.tsx`）轮询这个路由，拿到 id 就调
   `uiWorkspace.openSession(sessionId)`，并重试几次以覆盖会话列表还没加载的情况。

几个由此而来的事实：

1. 任何已打开的 DSH 客户端都会响应，谁先 claim 谁跳转；同一个点击只会被消费一次。
2. claim 有 60 秒有效期：一分钟后再打开的客户端不会莫名其妙跳到一条旧会话。
3. 用轮询而不是事件推送，是因为 Remote Event 需要在 Host 侧做 typert 代码生成，普通 JS bundle
   声明不了；轮询一个几字节的本地路由代价可以忽略，路由不存在时退避到 15s。
4. 抬窗口在 Wayland 上是合成器权限，后台进程无法自己做到，所以交给 `focusCommand`。
   留空表示自动探测：Hyprland 与 Sway 有默认可用的命令，其它桌面只切会话不抬窗口。

## 传输

不走 `notify-send`，直接连 D-Bus session bus 调
`org.freedesktop.Notifications.Notify`：`src/marshal.ts` 是够用的一小份线格式编解码，
`src/dbus.ts` 做 EXTERNAL 认证、一条常驻连接和按 serial 匹配的回复，`src/notifier.ts` 组装
Notify 的参数。只实现了 Linux/unix socket；`process.platform` 不是 `linux` 时插件静默待机。

- 图标走 `app_icon` 参数（绝对路径），不是 `image-path` hint：quickshell 把 `appIcon` 画在卡片
  左侧的应用图标位，`image` 是右侧的附件缩略图。
- 正文做 `& < >` 转义：quickshell 用 `Text.StyledText` 渲染正文，回复里出现 `<T>`、`a < b`
  这类文本时不会被当成标签吃掉。

## 图标

`icon.svg` / `icon.png` 是 DeepSeek 的品牌图标（白色圆角方块里的鲸鱼），取自本机安装的
`/usr/share/icons/hicolor/scalable/apps/deepseek-harness.svg`，去掉投影滤镜、收紧 `viewBox`
到方块本身后重新导出；商标归 DeepSeek，这里只用于给自家的 dsh 标识通知来源。

两份格式各有用途：默认两边都用矢量 `icon.svg`（Plugins 页的插件清单由浏览器缩放，通知卡片由
通知守护按需要的逻辑尺寸直接栅格化）。`icon.png`（256×256）是给不支持 SVG 图像的通知守护
备用的，那种环境把配置里的 `icon` 指到它。

选 SVG 的原因是可量化的：同一个 40px 图标槽，quickshell 用 SVG 渲染的边沿锐度（Laplacian
方差）是 2544，用 256px PNG 是 1768；固定尺寸的位图要被重采样到槽位大小，细节在这一步丢掉了。

### 备选：无底鲸鱼

`icon-whale.svg` 是同一只鲸鱼去掉白色圆角方块、只留深色鲸鱼的版本，默认不用。它在浅色卡片上
能让鲸鱼撑满槽位（80px 槽位里 72×53，白底版是 56×44），代价是鲸鱼填充近黑，**在深色卡片上会
看不见**，所以只在通知卡片是浅色主题时适用。要换就把配置指过去：

```yaml
- id: dsh-notify
  name: dsh-notify
  config:
    icon: /path/to/dsh-notify/icon-whale.svg
```

它和 `icon.svg` 一样被 `files` 收录，安装后就在包目录里，用 `node_modules` 下的绝对路径即可。

## 配置

```yaml
- id: dsh-notify
  name: dsh-notify
  config:
    enabled: true
    appName: DSH
    icon: ''
    previewChars: 160
    expireTimeoutMs: -1
    notifySubagents: false
    notifyOnAbort: false
    revealOnClick: true
    focusCommand: ''
    skipWhenFocused: true
```

1. `appName`：通知守护显示的应用名。本机 quickshell 的免打扰模式只放行 `notify-send`，
   想让通知穿透免打扰就把这里改成 `notify-send`。
2. `icon`：空串用包内 `icon.svg`（DeepSeek 品牌图标），也可以给图标主题名（本机有
   `deepseek-harness`）或不支持 SVG 时指向包内 `icon.png`。
3. `expireTimeoutMs`：`-1` 交给通知守护决定（本机 quickshell 回落到 5s）。
4. `previewChars`：`0` 则只显示标题。
5. `notifyOnAbort`：自己取消的那一轮是否也通知。
6. `revealOnClick`：`false` 时不挂 action，卡片点了只消失，也不会有 claim 路由被消费。
7. `skipWhenFocused`：`false` 时即使你正看着那条会话也弹通知。
8. `focusCommand`：点击后先执行的抬窗口命令。空串 = 按桌面自动选：
   Hyprland `hyprctl dispatch focuswindow class:deepseek-harness`（同时试 0.56 起的 Lua 形式），
   Sway `swaymsg [app_id="deepseek-harness"] focus`，其它为空。举个手写的例子：
   `focusCommand: 'hyprctl dispatch focuswindow class:google-chrome'`。

## 启动安全

两侧的 `apply` 都包了兜底：内部出错只记一条 warning，不会让插件行停在 `failed`/`pending`。

这不是防御性编程的洁癖 —— 桌面端的 `web boot` 检查会遍历浏览器 loader 的每个 entry，只要有一个没到
`active` 就抛 `web boot: N entries did not activate`，Electron 主进程视之为致命错误、窗口直接起不来。
曾经的触发方式：client 半边写 `ctx.sessions`，而 `inject` 只声明了 `uiWorkspace`，Cordis 对未 inject 的
服务访问立即抛 `cannot get property "sessions" without inject`。**可选服务必须走 `ctx.get(name)`。**

## 已知限制

1. Host 不知道浏览器当前聚焦在哪个会话，所以正在看的会话跑完也会通知。
2. 通知没有 default action，点击只是关掉卡片；要「点击跳到对应会话」需要再加
   `ActionInvoked` 信号处理 + 窗口聚焦。
