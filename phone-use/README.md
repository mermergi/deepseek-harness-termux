# PhoneUse — 让 agent 直接操作这台安卓手机

8 个 `phone_*` 工具，底层是本机已配对的 `adb`（跑在 `uid=2000(shell)` 上，带 `INJECT_EVENTS` 权限），装成一个**可持久化的 agent preset**：重启不丢，新建会话时可选。

> 为什么不做成动态插件：动态插件只活在当前进程的内存里，`dsh` 进程一重启（或被杀）就整套消失。手机控制这种能力不该有这种寿命。

## 工具

| 工具 | 做什么 |
|---|---|
| `phone_status` | adb 是否可达、机型、屏幕尺寸、屏幕亮/灭、前台窗口 |
| `phone_screenshot` | 截屏并**作为图像**返回给模型 —— shell 做不到这件事，这也是它必须是插件而非脚本的原因 |
| `phone_ui` | 无障碍树 → 带**真实像素坐标**的可点元素清单；点击坐标的唯一权威来源 |
| `phone_tap` | 按坐标点，或**按文字**点（自动 dump 后取该元素中心） |
| `phone_swipe` | 滑动 / 甩动 |
| `phone_key` | 按键（`BACK` `HOME` `APP_SWITCH` `ENTER` `DEL` `VOLUME_*` `DPAD_*` …） |
| `phone_text` | 输入文本：ASCII 走 `input text`；非 ASCII 走剪贴板 + `PASTE`（需 Termux:API） |
| `phone_app` | 前台应用 / 包列表 / 启动 / 停止 |

另有一条**状态通知通道**（不是工具）：agent 每次调用 `phone_*`，就把 `运行中 · phone_xxx` 推到同一条通知上（固定 `--id`，原地更新不堆叠）；一轮结束变成 `已结束 · HH:MM:SS · 等你指令`，并带一个「打开会话」按钮一跳到 GUI。它解决的正是"agent 在别的 app 里操作时，你不知道它跑完没有、还得自己切回来"。

## 前置条件

```sh
pkg install android-tools
```

手机打开「无线调试」，在 Termux 里配对并连上本机：

```sh
adb pair 127.0.0.1:<配对端口>      # 只需一次
adb connect 127.0.0.1:<调试端口>
```

**端口在重启手机或重开无线调试后会变**，要重新 `connect`。链路断了不会静默失败：`phone_status` 报 `connected=false`，其它工具给出重连方法而不是瞎猜。

## 安装

```sh
bash phone-use/install.sh
```

它做四件事，幂等、可重复运行：

1. 把 shipped 的 `standard` preset 复制成 `~/.dsh/.agent-presets/phone-use/`（已存在则保留，不覆盖你的改动）；
2. 在组成末尾补上 `tool-phone-use` 那一行（已存在则跳过）；
3. 跑 `build.mjs` 生成 `plugin/index.js`；
4. 跑 `smoke.mjs` 自检，不过就中止。

装完在 DSH 里**新建会话、preset 选「标准模式 + PhoneUse」**，工具即生效。

> 基底是 `standard`，不是 `cordis`（创造模式）：`tool-cordis` 把 Host inspect provider 注册到**进程全局**，所以 cordis 家族的第二个 preset 在同一进程里会和 shipped `cordis` 撞车。想要 Cordis 那套自省工具就用创造模式，想要手机控制就用这个 —— 一个进程里选一个。

## 改代码

`host.js` 是**唯一源头**：它同时也是一份能直接在 Cordis 动态插件里跑的函数体。`build.mjs` 只做一处机械替换（沙箱的 `harness.registerTool(ctx, harness.defineTool(…))` → 真插件的 `ctx.tools.register(defineTool(…))`），匹配数为 0 就拒绝生成 —— 源头形状变了会立刻暴露，而不是生成一个没有工具的插件。

```sh
node phone-use/build.mjs --out ~/.dsh/.agent-presets/phone-use/plugin
node phone-use/smoke.mjs ~/.dsh/.agent-presets/phone-use/plugin/index.js
```

`smoke.mjs` 在离线环境里真正加载模块、跑一遍 `apply`、断言 8 个工具和 2 个监听器都注册了，并用 `bash -n` 校验它将要发出的通知命令。**挂载时才报错**是最糟的时机（那正是人要开新会话的时候），这里提前挡掉。

> 生成物放在 preset 自己目录里（行名 `./plugin/index.js` 相对 preset 解析），preset 因此是自包含的、不怕重装 dsh。但生成物里的 `defineTool` 是**构建时探测到的绝对路径** —— 换了 dsh 安装目录要重新构建（`DSH_DIR=... node build.mjs`）。

## 安全提示（务必读）

这个 preset 让 agent 通过 `adb shell` 调用 `input` / `screencap` / `uiautomator` / `am` / `pm`，**等同于把屏幕读取和输入注入交给 agent**：它能看你的屏幕、点任何位置、输入文本、启动与停止应用。

- 最彻底的关闭方式是断开链路：关掉手机的「无线调试」，或在 Termux 里 `adb disconnect`。链路一断，8 个工具全部只会报错。
- `phone_screenshot` 在安全界面（锁屏、支付、密码框）上会拿到黑屏 —— 那是系统行为，**不是插件在保护你**，别把它当安全边界。
- 它不访问网络，只与本机 `127.0.0.1` 上的 adb 通信。

## 已知限制

- `uiautomator` 在部分界面（动画中、系统保护界面、WebView 深层内容）dump 不出来。工具会明确报「没有层次结构」，而不是回一个空列表让你以为屏幕上什么都没有。
- 非 ASCII 输入依赖 Termux:API；没装就明确报错，不静默丢字。
- 屏幕熄灭或处于安全界面时，截图/UI 工具需要先 `phone_key WAKEUP`。

## 验证到什么程度

在真机上逐项验过：

- `phone_status`、`phone_ui`（读到了真实的前台界面与元素坐标）、`phone_app start`；
- `phone_screenshot` —— 图像确实进入了模型上下文（不是写了个文件就算数）；
- `phone_tap` —— 按 UI 树坐标点 `WLAN` 之后，活动栈里出现 `com.android.settings/.Settings$WifiSettingsActivity` 且 `Resumed`，这是与"谁在前台"无关的持久证据；
- `phone_text` 的转义 —— 用「假 adb + 假 input」把宿主 shell → adb → 设备 shell 两层完整模拟出来：含空格、引号、`$`、`;`、制表符的输入，设备端始终收到恰好两个 argv，没有被拆分或注入；
- 组成用 `standingKeyFor()` 真实挂载校验过（`mounted OK`）。

**没验的**：装进 preset 之后，在一个真实会话里逐个调用。第一次用时跑一下 `phone_status` 看 `connected` 即可。
