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
| `phone_text` | 输入文本：走剪贴板 + `PASTE` 绕过输入法（需 Termux:API；**会替换你的剪贴板**），没装 API 时才退回 `input text` |
| `phone_app` | 前台应用 / 带显示名的应用列表 / 启动（**包名、应用名或昵称**）/ 教会一个新叫法 / 停止 |

`phone_app action=start` 直接收人话里的名字：`target="微信"`、`target="QQ"`、`target="设置"` 都能一次调用拉起，不需要先 `list` 再对照包名。

另有一条**状态通知通道**（不是工具）：agent 每次调用 `phone_*`，就把 `运行中 · phone_xxx` 推到同一条通知上（固定 `--id`，原地更新不堆叠）；一轮结束变成 `已结束 · HH:MM:SS · 等你指令`，并带一个「打开会话」按钮一跳到 GUI。它解决的正是"agent 在别的 app 里操作时，你不知道它跑完没有、还得自己切回来"。

## 按名称启动：应用名索引

`pm list packages` 只有包名，`微信` 对应 `com.tencent.mm` 这件事无法从包名推出来；显示名只存在于每个 APK 的资源表里。所以 `phone_app` 在第一次需要时读一遍全部 APK 的 `aapt2 dump badging`，把 **包名 ⇄ 显示名（含 `application-label-zh*`）** 落到缓存：

```
~/.cache/dsh-phone-use/apps.json      # 索引（包名 → 显示名 / APK 路径 / 大小 / mtime）
~/.cache/dsh-phone-use/labels.raw.tsv # 后台预热扫描的原始结果
```

实测（本机 489 个包，含系统应用，8 路并行）：**冷启动约 21–24 s，热查 <0.4 s，单个应用变更后增量刷新约 1.8 s**。为此：

- 每次会话第一个 `phone_*` 调用会**后台预热**（`nohup`，不阻塞任何工具调用）；等你要开某个应用时，索引通常已经好了。
- 索引按 **APK 路径 + 大小 + mtime** 增量校验，装/更新一个应用只重新读那一个 APK，不是每次全扫。
- 索引 5 分钟内视为新鲜，直接命中。
- 名字解析顺序：包名 → 内置常用别名表（设置/相册/相机这类系统应用的中文名，MIUI 把它们的翻译放在单独的 RRO overlay 里，基础 APK 只有英文）→ 包名子串 → APK 显示名。
- 需要 `aapt2`（`pkg install aapt` 提供）。没装就明确降级为"只能按包名/别名"，并在报错里说明，不会静默乱猜。

APK 里的标签也不是人嘴里的名字：`com.twitter.android` 的标签是 `X`（人叫**推特**）、`com.tencent.wework` 是 `WeCom`（**企业微信**）、`com.alibaba.android.rimet` 是 `DingDing`（**钉钉**）、`com.sankuai.meituan` 是 `Meituan`（**美团**）。所以还有一层**叫法表**：

- 内置一张常用中英对照表（推特/Twitter、油管/YouTube、B 站/bilibili、剪映/CapCut、微信/WeChat、钉钉/DingTalk、微博/Weibo、云闪付/UnionPay、大众点评/Dianping…），加上 MIUI 自带应用的中文名（它们的翻译在 RRO overlay 里，基础 APK 只有英文）。
- 查不到的名字**教一次就永久生效**，存在 `~/.cache/dsh-phone-use/aliases.json`，并且优先于内置表：

  ```
  phone_app action=alias target="推特" package="com.twitter.android"
  phone_app action=alias                    # 列出已学到的 + 内置的
  ```

- `phone_app action=list filter=推特` 会用叫法匹配，并在结果里回显 `aka`，让人看得出为什么命中这个包。
- 教会不存在的包会直接报错，不会悄悄存一条无效别名。

## 前置条件

```sh
pkg install android-tools
pkg install aapt          # 可选：按应用显示名启动需要 aapt2
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
node phone-use/smoke.mjs ~/.dsh/.agent-presets/phone-use/plugin/index.js     # 离线
node phone-use/live-test.mjs ~/.dsh/.agent-presets/phone-use/plugin/index.js # 真机（需已连 adb）
```

`smoke.mjs` 在离线环境里加载模块、跑一遍 `apply`、断言 8 个工具和 2 个监听器都注册了，**并且把 8 个工具各执行一次**（喂固定的 shell 输出），再用 `bash -n` 校验它将要发出的通知命令。

**注册成功不等于能跑**：一个指向已删变量的残留引用语法合法、`node --check` 通过、注册也没问题，只在你真去调用时才炸。这一遍执行就是为了挡住它。

`live-test.mjs` 加载**同一份生成模块**，但把 `shell` 接成真的 bash —— 于是可以直接驱动手机跑完整流程（状态 → UI 树 → 按文字点击 → 打字并读回 → 截屏 → 还原浏览器），并逐项断言。

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

两条自动化测试，都可以重跑：

```sh
node phone-use/smoke.mjs     <preset>/plugin/index.js   # 离线：加载 + 执行全部工具
node phone-use/live-test.mjs <preset>/plugin/index.js   # 真机：驱动手机跑完整流程
```

`live-test.mjs` 最近一次的结果（16/16）：

- `phone_status` —— 真实机型 / 屏幕 / 前台窗口；断链后自己扫端口重连（约 5 s）；
- `phone_ui` —— 列出带真实像素坐标的元素；
- `phone_app start` —— 拉起设置；
- `phone_app start 微信` —— **按显示名**一次拉起 `com.tencent.mm`（`matched_by=label`；冷索引 23.9 s，热 0.34 s，单个应用变更后 1.8 s）；
- `phone_app start QQ` —— 按短包名拉起 `com.tencent.mobileqq`（0.2 s，完全不碰索引）；
- `phone_app list filter=微信` —— 按显示名过滤，回显 `{"package":"com.tencent.mm","label":"WeChat","aka":["微信","wechat"]}`；
- `phone_app start 推特` —— 内置叫法命中 `com.twitter.android`（它的 APK 标签是 `X`）；
- `phone_app action=alias` 教一个名字 → 立刻能用（`matched_by=alias`），且会真的写进 `aliases.json`；对未安装的包则拒绝；
- 整轮真机操作**没有一次**写 `accelerometer_rotation`（用 `logcat -s SettingsProvider:W` 盯着看，0 次写入）；
- `phone_tap` 按文字 —— 自己在树里找到「搜索系统设置项」并点中 (643,563)；
- `phone_text` —— `route=clipboard + PASTE`，读回字段里确实出现了输入串（`#1 tap=(561,220) "phoneuse-ok" [EditText]`）；
- `phone_screenshot` —— 生成 600x1302 的合法 PNG；
- 结束后自动把浏览器带回前台。

组成另外用 `standingKeyFor()` 做过真实挂载校验（`mounted OK`）。

**三个只有真机才暴露的坑**，都已写进实现：

1. **`input text` 在中文输入法下会静默丢字。** 实测 `input text 'phoneuse-ok'` 之后字段里只剩一个 `－`：字母被当成拼音合成丢掉了，`-` 被转成全角。所以 `phone_text` 的主路径改成剪贴板 + `PASTE`（绕开输入法），并做一次**读回校验**，把"敲了"和"落地了"分开报告。
2. **`monkey` 会顺手改系统设置。** 原来用 `monkey -p <pkg> -c LAUNCHER 1` 启动应用；在 MIUI/HyperOS 上 Monkey 启动时会写 `Settings.System.ACCELEROMETER_ROTATION=1`（实测：`Events injected: 1` 之后 **5 ms** 就出现该设置的写入），也就是**每次"打开应用"都会把用户的方向锁定关掉**。`am start` 不会。现在启动改走 `cmd package resolve-activity --brief` + `am start -n`，`host.js` 里不再出现 monkey 启动路径。
3. **注册成功 ≠ 能跑。** 一次重构删掉了某个变量的定义却漏删引用：语法合法、`node --check` 通过、注册也正常，只有真调用 `phone_ui` 时才抛 `ReferenceError`。现在 `smoke.mjs` 会执行每个工具，这类 bug 在提交前就会被挡下。
