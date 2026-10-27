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
```

1. `appName`：通知守护显示的应用名。本机 quickshell 的免打扰模式只放行 `notify-send`，
   想让通知穿透免打扰就把这里改成 `notify-send`。
2. `icon`：空串用包内 `icon.svg`（DeepSeek 品牌图标），也可以给图标主题名（本机有
   `deepseek-harness`）或不支持 SVG 时指向包内 `icon.png`。
3. `expireTimeoutMs`：`-1` 交给通知守护决定（本机 quickshell 回落到 5s）。
4. `previewChars`：`0` 则只显示标题。
5. `notifyOnAbort`：自己取消的那一轮是否也通知。

## 已知限制

1. Host 不知道浏览器当前聚焦在哪个会话，所以正在看的会话跑完也会通知。
2. 通知没有 default action，点击只是关掉卡片；要「点击跳到对应会话」需要再加
   `ActionInvoked` 信号处理 + 窗口聚焦。
