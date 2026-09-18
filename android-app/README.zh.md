# DSH 安卓 App

把 [deepseek-harness-termux](../README.zh.md) 那套「让 dsh 在 Android/Termux 上跑起来」的补丁
再往上一层：把它的 Web GUI 包成一个**真正的安卓应用**——桌面图标、全屏无地址栏、点开即用，
并且能自己把 Termux 里的后台服务拉起来。

整套东西**在这台手机本地编译**（aapt2 + javac + d8 + apksigner），不需要电脑、不需要
Android Studio、不需要联网下载 SDK。

---

## 它解决什么

原来的用法是：点 Termux:Widget 小组件 → 后台起 `dsh web` → 自动打开**浏览器** → 在浏览器里用。

痛点：浏览器有标签页和地址栏；返回手势会退出页面；切走再回来经常被重新加载；图标也不是它自己的。

现在：

| | 之前 | 现在 |
|---|---|---|
| 入口 | Termux:Widget 小组件 | 桌面图标 **DSH** |
| 界面 | 浏览器标签页 | 全屏 WebView，无地址栏 |
| 登录 | 每次带 `?token=` 的链接 | 一次换 cookie，30 天免登录 |
| 服务 | 小组件脚本负责起 | App 自己按需起 |
| 返回键 | 退出浏览器 | 先在页面内后退，退无可退才退出 App |
| 卡住时 | 切标签页/刷新 | 页面顶部下拉刷新（不依赖任何第三方库） |
| 切到别的 App | 不知道还在不在跑 | 悬浮球显示 `工作中 / 空闲 / 服务已停止`；**点一下展开展示文字，双击回 App** |

悬浮球那块值得单独说，因为「怎么知道 agent 在不在工作」是这里唯一有难度的部分：
详见 [悬浮球：怎么知道 agent「在不在工作」](#悬浮球怎么知道-agent在不在工作)。

---

## 启动流程（这是整个设计的核心）

```
        ┌──────────────── 点桌面图标 ────────────────┐
        ▼                                            │
  已有有效 cookie 且 3080 有响应？ ──是──► 直接 load /  （快路径，完全不碰 Termux）
        │否
        ▼
  App 发 RUN_COMMAND intent 给 Termux
        │
        ▼
  Termux 跑 ~/.dsh-app/bridge.sh
        ├─ 3080 没在跑？ → 先跑 android-fix.mjs，再 detached 起 dsh web --no-open
        ├─ 从 $TMPDIR/dsh_web.log 读出带 token 的地址，并**实际请求一次**验证它还活着
        └─ 在 127.0.0.1:3099 上开一个一次性端点，用共享密钥把地址交出去
        │
        ▼
  App 轮询到地址 → WebView 打开 → dsh 把 token 换成 cookie 并 302 到 /
        │
        ▼
  端点交接完成即自杀（或 90 秒超时），不留常驻端口
```

两个方向都验证过：

- **App → Termux**：Termux 0.118+ 的 `RUN_COMMAND` 由 `com.termux.app.RunCommandService`
  处理（不是老的 `TermuxService`），并且 `com.termux.permission.RUN_COMMAND` 是
  **dangerous** 级权限，必须在 App 里运行时申请。需要 `allow-external-apps = true`。
- **Termux → App**：这台设备（API 37）上 `/system/bin/am` 已经不允许非 shell uid 调用
  （`SecurityException: package=com.android.shell does not belong to uid=...`），所以
  「脚本用 `am start` 回传」这条路是死的。改用 **loopback 一次性 HTTP 端点**，不依赖任何 intent。

---

## 悬浮球：怎么知道 agent「在不在工作」

切到别的 App 时屏幕边上会有一个悬浮球，显示 `DSH 工作中 / 空闲 / 服务已停止`。
难点从来不是画那个球，而是**判断依据**。三个候选信号，两个被实验否掉了：

### 候选 1：会话日志的 mtime 新鲜度 —— 否掉

看着很自然：agent 干活就写日志，不干活就不写。实测直接反例：

```
03:04:03  CHANGED           ← 工具调用开始
03:04:05  CHANGED
03:04:06  -                 ┐
...                         │ 一个 sleep 25 的工具调用，
03:04:30  -                 │ 日志整整 25 秒没有任何写入
03:04:31  CHANGED           ┘
03:04:32  CHANGED
```

长工具调用期间日志是**完全静默**的。更糟的是等模型返回时同样静默（几十秒），
所以 mtime 会把「正在跑」误报成「空闲」。

### 候选 2：dsh 进程有没有子进程 —— 能用但不精确

实测 dsh **没有常驻子进程**，每跑一个工具就 spawn 一个，结束就没了：

```
03:05:06 kids=[5332]        ← 5332 是我自己那个采样工具的 bash
03:05:08 kids=[5332,5359]   ← 5359 出现了：sleep 18 的工具进程
03:05:25 kids=[5332,5359]
03:05:26 kids=[5332]        ← 工具结束，子进程消失
```

能准确反映「有工具在跑」，但反映不了「正在等模型 / 正在流式输出」。

### 候选 3（最终采用）：会话日志里的 `turn/start` / `turn/end`

会话日志是一串**拼接的 zstd 帧**（实测这个文件有 668 帧、915 KB），每帧装着若干 jsonl 记录。
记录类型里有 `turn/start`、`turn/end`、`step/start`、`step/end`、`tool/call`、`tool/result`。

于是判据变成一句话：**最后一个 turn 标记是 `turn/start` 且没有配对的 `turn/end` ⇒ 正在工作。**
它同时覆盖了等模型、流式输出和长工具调用三个场景。

代价是要解 zstd。全量解 668 帧太贵，所以只从**最后一个 zstd magic 往回**逐帧解，
通常一帧就能命中标记；解不开的候选（压缩数据里恰好长得像 magic）会校验失败，跳过即可。

**对照验证**（这是敢用它的原因）：跑遍本机 34 个历史会话——

```
统计: {"idle":30, "working":1, "unknown":3}
  working  1018435B  ...agent/inbox/spliced,turn/start,agent/inbox/spliced   ← 当前会话，确实在跑
  idle      2633936B  ...assistant/message,step/end,turn/end
  idle       386407B  ...tool/result,step/end,turn/end
  idle        25443B  ...assistant/message,step/end,turn/end
  unknown       427B  （空会话存根，还没有任何 turn）
```

30 个已完成会话全部正确判为 `idle`，尾部都是 `step/end,turn/end`；当前会话判为 `working`。

端点 `GET 127.0.0.1:3098/status`（需要 `X-Dsh-Key`）在每次被问时**现算**，所以没有后台轮询开销；
App 每 2 秒问一次，停止问 15 分钟后端点自己退出。

### 成本：三次优化，每次都是被实测数据逼出来的

| 做法 | 单次开销 | 结论 |
|---|---|---|
| 全量解压 668 帧 | 几十到上百 ms | 不可接受 |
| 定长 64KB 尾读 | **1.24MB 的会话里读不到 turn 标记，误报 `unknown`** | 错 |
| 窗口倍增回退 | 命中要读到 **1MB 窗口、94ms**，每 2 秒一次约 4.7% 单核 | 太贵 |
| **只扫新增字节** | **0.81ms**（每次追加约 13KB） | 采用 |

最后一条的关键细节：`scannedUpTo` 要**回退到最后一个帧起点**再前进。
否则如果某次读取正好落在「日志写了一半」的位置，那个不完整的帧会解压失败被跳过，
里面的记录就**永久丢失**——一个漏掉的 `turn/end` 会让悬浮球一直卡在「工作中」。

这条逻辑不靠肉眼审，跑 `node tools/test-status.mjs`：

```
重放 34 个会话，共 238 次比对，不一致 0 次
```

它把每个真实会话日志**按增长切片重放**到同一个临时文件（故意切在 zstd 帧中间），
外加一次截断，每一步都跟「全量读」的结果对比。第一次写这个测试时，
定长 64KB 窗口版本正是在这里暴露的。

### 两种形态：贴边空心弧 / 离开边是药丸

形态只由**一件事**决定：是否贴边。

| 状态 | 外观 |
|---|---|
| **贴边** | **一小段圆弧**（张角 90°、半径 19dp、描边 3dp、圆头端点），窗口 12×34dp。贴右边像 `(`、贴左边像 `)` |
| **离开边** | 药丸 `● DSH 工作中`，有地方把状态写全 |

颜色一路表示状态——蓝 工作中 / 绿 空闲 / 红 服务已停止 / 灰 未知；「工作中」时整体缓慢呼吸
（透明度 1.0 ↔ 0.45），因为小形状放不下字，而纯颜色在强光下和色觉障碍面前都会失效，
呼吸是那条不依赖颜色的冗余通道。

弧的几何是**一段圆弧**，不是半圆：以最内侧那个点为中心、左右各张 45°，所以墨迹横向只占
`半径 × (1 − cos45°) + 描边 ≈ 8.6dp`。圆弧在窗口里居中，窗口整体贴着屏幕边——
这样两个端头离边缘只剩约 3dp，看着是「吸附在边上」，又不会像半圆那样笨重。
张角是从几个候选渲染图里挑的（180° / 140° / 110° / **90°** / 70°）。

#### 交互

| 操作 | 效果 |
|---|---|
| **拖动** | 自由拖动；松手时**窗口的边**离屏幕边 1/6 屏宽内就吸附成空心弧，否则停在原地当药丸 |
| **点一下** | 两种形态互切（贴边 ⇄ 药丸） |
| **双击** | 回 App |

- 药丸飘着 **5 秒**没动作会自动吸附回边上——贴边才是它的常态，药丸只是你要看状态时的临时形态。
- 位置 / 是否贴边 / 贴哪一边都存进 SharedPreferences。

#### 吸附判定的参照物：窗口，不是手指

之前「拖到右边不吸附」查了很多轮，根因是判定用了**手指**到屏幕边的距离。
窄形状（圆点、小手柄）手指基本压在窗口边缘上，两种参照物结果一样，所以看起来是对的；
而药丸宽约 350px，把它的**右边缘**推到屏幕边时，**手指还停在屏幕里面一百多像素处**，
按手指判定永远够不到阈值。改成量**窗口自己的边**离屏幕边的距离就对了。

屏幕边缘本身也不是靠估算的：贴边时窗口管理器已经把它放在边上了，于是用
`getLocationOnScreen()` 反过来量出真实坐标（`loc[0] + width`），判定全用实测值。
而且特意挑**按下那一刻**去量——窗口静止时读到的位置才可靠，刚改完 `gravity` 就立刻读会拿到
布局前的旧值。

#### 一条从 App 回传数据的诊断通道（临时保留）

这个 bug 之所以拖了好几轮，根因是**我看不到 App 内部状态**：`logcat` 只能读到 Termux 自己的
进程，`/sdcard/Android/data` 从 Termux 访问不了。最后是在状态守护上加了一个 `POST /diag`
（同样要 `X-Dsh-Key`），悬浮球把吸附判定用的数字发过去、落进 `~/.dsh-app/status.log`。
真机数据一到手，问题当场就定位了：

```
up x=1019 w=349 L=0 R=1156 measured=true zone=192 leftGap=1019 rightGap=-212 raw=1138 => snapped=true side=1 sw=1156
```

（`sw` 是估算的屏幕宽，`R` 是实测的——两者一致，说明我当时怀疑「宽度算错」的方向是错的。）

代价是每次触摸多一个 loopback 请求，所以守护进程启动时会把日志截到最近 64KB。
等这个悬浮球彻底稳定下来，这条通道可以摘掉。

### 灵动岛 / 小米超级岛（部分可用）

设备实测：`persist.sys.feature.island=1`、`notification_focus_protocol=3`、
`canShowFocus=true`——**权限层面全绿，而且没有走小米的邮件申请流程**。

接入方式（官方「客户端接入」）：普通通知 + 一个 extra，不需要 MiPush、不需要 root：

```java
notification.extras.putString("miui.focus.param", islandJson);
notificationManager.notify(id, notification);
```

**实际结果**：状态栏出现「DSH 工作中」，**但岛上始终没有内容**。

排查过的、可以排除的原因：

| 怀疑 | 验证结果 |
|---|---|
| 通知权限没给 | 给了，`notifEnabled=true`，`island-send` 有投递记录 |
| JSON 字段写错 | 逐字段对照公开组件模型修正后**仍不上岛**（见下） |
| 岛区域内容为空 | 图标改 Bitmap、文字槽位冗余后**仍不上岛** |
| 有用户侧开关没开 | 长按图标 → 通知管理里**没有**「焦点通知/超级岛」开关 |

字段参考（来自第三方 HyperIsland ToolKit 的组件文档，与官方开发指南能对上；官方
《模板库》PDF 只有设计稿、不含字段名）：

- `param_island.islandPriority` **必填**，`2`=高优先级弹窗
- `TextInfo` = `title`（必填）/ `content` / `showHighlightColor`；**没有** `frontTitle`、`useHighLight`
- `BaseInfo.type`：`1`=标准（图标左）、`2`=横幅（图标右）
- `SmallIslandArea` = `picInfo` 或 `combinePicInfo`
- `BigIslandArea` = `imageTextInfoLeft` / `imageTextInfoRight` / `sameWidthDigitInfo` / `progressTextInfo` / `textInfo` / `picInfo` / `actions`

**结论**：状态栏 ticker 生效说明**焦点通知通道本身是被接受的**（普通通知不会把文字放进状态栏），
但**岛的渲染**这一层拿不到。最合理的解释是小米 FAQ 里那句「平台会配置权限，权限开通之后才能正常
发送焦点通知」——`canShowFocus` 很可能只反映用户可见的通知开关，而岛渲染需要小米在平台侧为这个
包名单独开通，侧载 app 没走过那个流程。旁证：网上能找到的第三方岛工具（HyperBridge、
xiaoaiisland、课程表超级岛）**清一色是 LSPosed 模块**，靠 hook SystemUI 而非 API 实现。

**当前保留的行为**：后台工作时投递一条焦点通知，顶栏显示「DSH 工作中」；转为空闲/服务停止时撤销。
这已经实现了「切到别的 App 也能在屏幕顶部看到 agent 在工作」，只是没落在挖孔那一块。

### 关于悬浮球窗口本身

它是 `TYPE_APPLICATION_OVERLAY` 窗口。这带来两个副作用，正好都用上了：进程不算普通后台缓存进程
（不会被冻结，所以状态能持续刷新），而且**持有悬浮窗的 App 可以从后台启动 Activity**，
所以点球能直接切回 App。实测切到微信后系统没有冻结我们的轮询（日志里有持续心跳）。

---

## 踩到的两个坑（都是实测出来的，不是猜的）

### 1. `$TMPDIR` 会被清空，而服务还在往里面写

原来服务日志写在 `$TMPDIR/dsh_web.log`。Termux 重启 App 进程时会**清空 `$PREFIX/tmp`**，
但已经跑起来的 dsh 还持有那个 inode：

```
l-wx------ 1 -> /data/data/com.termux/files/usr/tmp/dsh_web.log (deleted)
```

于是**进程还活着、token 却从磁盘上消失了**——而那份日志是 token 的唯一外部副本。
Cookie 正常时看不出来，等 30 天 cookie 过期就会卡死。

修法：App 启动的服务日志写到持久目录 `~/.dsh-app/server.log`；同时仍然读
`$TMPDIR/dsh_web.log`，这样 widget 起的服务也能被复用。万一两边都读不到，App 的
「重新登录」按钮会显式重启服务换一个新 token（只在用户点了才做，不会偷偷打断正在进行的对话）。

### 2. `/system/bin/am` 不是谁都能调

```
$ am start -a android.intent.action.VIEW -d https://example.com
java.lang.SecurityException: Permission Denial: package=com.android.shell does not belong to uid=10436
```

新版 Android 把 `am` 锁给了 shell uid。这也是为什么回传通道必须走 HTTP 而不是 intent。

### 顺带验证的两条

- `?token=` 换 cookie 会 **303 到 `/`**；cookie 签名密钥存在 credentials 里，所以
  **服务重启后旧 cookie 依然有效**（实测 `HTTP=200`）——重启不会把 App 踢下线。
- `termux-open-url` 对任意 scheme 都会发 `ACTION_VIEW`（实测报文：
  `unable to resolve Intent { ... dat=dshapp://open/... }`），所以 `dshapp://` 这条路是通的，
  只是最终没用到。

---

## 目录

```
AndroidManifest.xml          权限、intent-filter（含 dshapp:// 回传 scheme）
res/                         图标（mipmap + 自适应图标）、主题、network security config
src/com/mermergi/dsh/
    MainActivity.java        全部逻辑：WebView 壳 + 启动编排
termux/
    bridge.sh                RUN_COMMAND 的入口，装到 ~/.dsh-app/bridge.sh
    ensure-server.mjs        确保 dsh web 在跑，输出可用的 token URL
    handoff.mjs              一次性端点，把 URL 交给 App
tools/
    build.sh                 编译 + 签名，一条命令
    make-icon.mjs            用 sharp 从 SVG 渲染整套图标
    android.jar              API 35 platform（从 Google 官方 zip 里取的）
install.sh                   装 Termux 那一半，并打开 allow-external-apps
```

## 编译

```sh
cd ~/deepseek-harness-termux/android-app/tools
bash build.sh              # → ../out/dsh.apk
bash build.sh --install    # 顺便把 APK 交给系统安装器
```

依赖（已装）：`pkg install aapt2 apksigner d8 openjdk-17`。
`android.jar` 已经放在 `tools/` 里了；要重新拿的话：

```sh
curl -fsSL -o "$TMPDIR/p.zip" https://dl.google.com/android/repository/platform-35_r02.zip
unzip -o -j "$TMPDIR/p.zip" android-35/android.jar -d tools/
```

签名用 `keystore.jks`（口令 `dshlocal`，自签名，有效期 30 年；**没进仓库**，见 `.gitignore`）。
**本机这份别删**——签名变了就没法覆盖安装，只能先卸载，而卸载会丢掉登录 cookie。
所以在别处 clone 下来第一次构建时会自动生成一把新钥匙，那把钥匙签出来的包**不能**覆盖本机已装的这个。

## 安装

```sh
bash ~/deepseek-harness-termux/android-app/install.sh          # Termux 那一半
# 然后
bash ~/deepseek-harness-termux/android-app/tools/build.sh --install
```

`install.sh` 做两件事，都是幂等的：

1. 把 `bridge.sh` / `ensure-server.mjs` / `handoff.mjs` 装到 `~/.dsh-app/`，
   并把握手密钥从 `MainActivity.java` 里同步过去（单一事实来源）。
2. 把 `~/.termux/termux.properties` 里的 `allow-external-apps` 打开，
   然后 `termux-reload-settings`。

> `~/.dsh-app/env` 里放的是**给 dsh 服务的环境变量**，默认 `DSH_PERMISSION_MODE=danger-full-access`，
> 和 `start_dsh.sh` 保持一致。想收回权限就改这里——代价是 shell 类工具会全部拒绝执行。

### 在一台新手机上装

**APK 只是客户端（75 KB），DSH 本体在 Termux 里（约 271 MB），所以新手机不能只装 APK。**
完整顺序：

```sh
# 1. 装 Termux（F-Droid 版）和 Termux:API
# 2. 拿到仓库
pkg install -y git
git clone https://github.com/mermergi/deepseek-harness-termux
cd deepseek-harness-termux

# 3. Termux 那一半：node/python/clang/ripgrep + dsh + 安卓补丁
bash install.sh --deps

# 4. App 那一半：bridge 脚本 + allow-external-apps
bash android-app/install.sh

# 5. 装 APK —— 用仓库里现成的，**不需要**构建工具链
termux-open android-app/prebuilt/dsh.apk
```

然后打开 App，授权两个权限：RUN_COMMAND 的运行时弹窗、悬浮球的「显示在其他应用上层」。

各部分体积，方便估算：

| | 体积 |
|---|---|
| dsh 本体 + node_modules | 271 MB |
| Node.js | 49 MB |
| clang + python（node-pty 要现场编译） | 208 MB |
| **`prebuilt/dsh.apk`** | **75 KB** |

所以**不用**装 openjdk/d8/aapt2（237 MB）——只有想自己改代码重编时才需要：

```sh
pkg install -y aapt2 apksigner d8 openjdk-17
bash android-app/tools/build.sh --install
```

`prebuilt/dsh.apk` 每次成功编译后由 `build.sh` 自动同步，所以它出现在 `git status` 里 =
源码改过、预编译包已经跟上。仓库里**没有** `keystore.jks`（见 `.gitignore`），
所以在别处 clone 出来第一次构建会生成一把新钥匙，那把钥匙签的包**不能**覆盖本机已装的这个。


## 安全边界

多出来的攻击面有两个，都是本机的：

1. **`allow-external-apps = true`**：任何声明了 `com.termux.permission.RUN_COMMAND` 的
   App 都能在 Termux 里执行任意命令。这是「一键启动」的代价，没有它就只能手动先去 Termux 里跑脚本。
   想关掉：把 `termux.properties` 改回 `false` + `termux-reload-settings`，App 会退化成
   「显示提示 + 让你自己开 Termux」。
2. **握手端点**：`127.0.0.1:3099`，只在点击图标后存活几十秒，且要求
   `X-Dsh-Key` 匹配。密钥硬编码在 APK 里（本地自签名、不发布），
   对同机恶意 App 只是提高门槛，不是密码学保证。
   **交接完成后端点立即退出**，不常驻。
3. **「重新登录」会重启服务**：这是唯一会打断正在进行对话的操作，所以只在 App 明确
   拿不到 token（服务在跑但日志被清）时，作为需要你亲手点的按钮出现。

dsh 本身仍然只监听 `127.0.0.1`，没有对局域网暴露。

## 升级 dsh 之后

`ensure-server.mjs` 在启动服务前会重跑 `android-fix.mjs`，所以重装 dsh 后**直接点图标就行**，
不需要先去点小组件。如果 `android-fix.mjs` 本身变了，重跑一次 `install.sh`。

## 排障

日志都在持久目录，不会被 `$TMPDIR` 清理带走：

| 现象 | 看什么 |
|---|---|
| App 停在「DSH 没起来」 | `tail -30 ~/.dsh-app/bridge.log` |
| 服务起没起 / token 是什么 | `tail -20 ~/.dsh-app/server.log` |
| App 有没有真的触发 bridge | `bridge.log` 里找 `bridge invoked` |
| 握手端点有没有被交接 | `bridge.log` 里不该出现 `expiring without a hand-off` |
| 服务在跑但拿不到 token | `bridge.log` 里 `no usable token in any log` |
| 权限给了没 | 系统设置 → 应用 → DSH → 权限；或点「重试」会再弹一次 |
| 手动重启服务换 token | `bash ~/.dsh-app/bridge.sh --restart` |

## 实测记录（本机，Android 17 / API 37 / aarch64）

| 场景 | 结果 |
|---|---|
| 冷启动（3080 无服务） | ✅ `02:53:58` bridge 被 App 触发 → 端口空 → 起 dsh（pid 29118）→ 跑 android-fix → 拿到新 token → 交接成功 |
| 冷启动（换了持久日志后） | ✅ `02:58:32` 用户重启 App → 端口空 → 起 dsh（pid 31958）→ 日志写入 `~/.dsh-app/server.log` → 交接成功 |
| 热启动（3080 已在跑） | ✅ `02:52:21` bridge 复用已有服务，读出旧 token 并**实际请求校验**后交接 |
| 「服务在跑但日志被 TMPDIR 清掉」 | ✅ `02:57:19` 立即判定 `token candidates found in logs: 0` → 交 `NO_TOKEN`，而不是递一个死 token |
| `--restart` 恢复 | ✅ `02:57:27` SIGTERM 掉 pid 29118 并准备重启（该次测试被中断，功能本身见下一行） |
| `?token=` → cookie | ✅ `HTTP=303 location=http://127.0.0.1:3080/` |
| cookie 跨服务重启 | ✅ 重启前铸的 cookie 对重启后的服务仍返回 `HTTP=200` |
| 握手端点防火墙 | ✅ 正确密钥 200 / 错误密钥 403 / 错误路径 404；交接后端口自动关闭 |
| App 内看到界面 | ✅ 实测为 DSH 对话界面 |
