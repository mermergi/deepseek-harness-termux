# deepseek-harness-termux

[English](README.md) | 中文

让 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）在 **Android / Termux** 上跑起来的兼容补丁 + 一键启动脚本。

dsh 官方支持 Linux / macOS / Windows。安卓（Termux，bionic libc）缺了几个它默认依赖的前提，所以官方 README 里的 `npx @deepseek-ai/dsh web` 在手机上**起不来**。本仓库把实测可行的 **26 处**修补收敛到一个幂等脚本（`android-fix.mjs`）里，给出了可直接复制的启动步骤，另外附带一个**本地自编译的 Android 外壳 App**——有启动服务、悬浮状态气泡、通知岛、文件选择器，以及设置页里的重启按钮。

其中大多数补丁是安卓平台差异；第 9 条是性能优化；第 10–15 条是 `0.1.6-alpha.2` 和它的新插件页带来的；第 16 条修的是全局 `node-gyp`，只有装需要现场编译的原生插件时才会用到；第 17 条修的是插件引用了此版 dsh 已不再提供的图标；第 18、19 条是 `0.1.7-alpha.1` 带来的——它不再自己建 `link` 模式的模块农场，也把运行时解析拦截装进了启动必经路径，而那个拦截在安卓上加载不了；第 20 条让第 19 条留下的「内部模块加载器不可用」不再拖垮插件元信息；第 21 条回收被杀进程遗留的写锁——否则它会把之后**每一次**插件安装都冻住；第 22 条教插件市场自己的校验器认识 `0.1.7` 引入的**列表式** bundle patch，否则市场会把每一次安装都回滚掉；第 23 条把 Node 在 Termux 上报的 `android` 平台映射到 Linux 进程检查器，不补则右侧边栏的终端根本打不开；第 24 条给通用设置页加上「新会话初始化提示词」编辑器、默认预设选择和重启按钮，新会话从哪段指令开始不再需要改文件或敲命令；第 25 条让被裁掉的文件路径点一下就能展开看全（触屏没有 hover）；第 26 条在安卓上把「显示文件位置」换成「复制完整路径」——安卓根本没有可用的文件管理器去定位文件。

## 目录

- [演示素材](#演示素材)
- [环境要求](#环境要求)
- [快速开始](#快速开始)
- [做成桌面一键启动](#做成桌面一键启动)
- [做成安卓 App](#做成安卓-app可选)
- [PhoneUse 插件（可选）](#phoneuse-插件可选)
- [安全提示（务必读）](#安全提示务必读)
- [仓库结构](#仓库结构)
- [补丁清单](#补丁清单)
- [新会话的默认提示词](#新会话的默认提示词)
- [装插件](#装插件)
- [重启](#重启)
- [安全升级（推荐）](#安全升级推荐)
- [重装或升级之后](#重装或升级之后)
- [验证与说明](#验证与说明)

## 演示素材

![一只河马骑自行车的循环动画插画](hippo-bicycle.webp)

同一张插画的三种渲染产物，是测试 dsh 在这台设备上实际跑起来的效果时留下的。它们不是截图：仓库里的 PNG 与本机 `sharp` 从该 SVG 渲出来的结果**逐字节相同**，而这正是 dsh 在安卓上处理附件用的那个 WebAssembly `sharp`（补丁 4），所以这组文件同时也是一条"图片链路真的通了"的旁证。

| 文件 | 格式 | 大小 | 尺寸 | 帧数 |
|---|---|---|---|---|
| [`hippo-bicycle.svg`](hippo-bicycle.svg) | SVG，SMIL 动画（18 个 `<animate>`） | 13 KB | 800×600 | — |
| [`hippo-bicycle.png`](hippo-bicycle.png) | PNG | 58 KB | 800×600 | 1 |
| [`hippo-bicycle.webp`](hippo-bicycle.webp) | 动画 WebP | 279 KB | 480×360 | 24 |

动画 WebP 覆盖的像素比静态 PNG 少，体积却是它的 5 倍，因为它装了 24 帧**互不相同**的画面。可以自己数：在装 dsh 的目录（第 2 步那个，`sharp` 在里面）执行，文件路径指向你 clone 下来的位置：

```sh
cd ~/dsh
node -e "require('sharp')(process.argv[1]).metadata().then(m => console.log(m.pages))" \
  ~/deepseek-harness-termux/hippo-bicycle.webp
```

## 环境要求

| 项 | 要求 |
|---|---|
| 系统 | Android + Termux（aarch64 实测通过） |
| Node.js | `^22.19.0 \|\| >=24.0.0`（dsh 的 engines 要求，实测 v26.4.0） |
| 编译工具链 | `clang` + `make` + `python`（node-pty 在安卓上没有预编译，要靠 node-gyp 现编） |
| 搜索工具 | `ripgrep`（`pkg install ripgrep`）：`@vscode/ripgrep` 没有安卓构建，见补丁 6；PATH 里没有 `rg` 时 `glob`/`grep` 工具不可用 |
| 磁盘 | 约 320 MB（dsh 会拉约 600 个 npm 包；`0.2.1-rc.2` 实测 608 个） |
| 网络 | 能访问 npm registry 和你选的模型 API（DeepSeek 官方或兼容网关） |

## 快速开始

### 方式 A：一条命令

```sh
curl -fsSL -o install.sh \
  https://raw.githubusercontent.com/mermergi/deepseek-harness-termux/main/install.sh
bash install.sh --deps
```

`install.sh` 会依次完成：检查 Node 版本与编译工具链 → 把 dsh 装到 `~/dsh` → 补上 `@img/sharp-wasm32` → 打兼容补丁 → 把静默启动脚本装到 `~/.shortcuts/tasks/start_dsh.sh`（另存一份可见终端版 `~/dsh/start_dsh-terminal.sh`）。**可重复运行**：跑失败、修好原因后直接重跑，已完成的步骤会跳过。

| 参数 | 作用 |
|---|---|
| `--deps` | 顺带用 `pkg install` 安装 Termux 依赖（nodejs python clang make） |
| `--dir ~/foo` | 换安装目录（会自动写进启动脚本的 `DSH_DIR`） |
| `--version 0.2.1-rc.2` | 固定 dsh 版本，便于复现 |

### 方式 B：手动逐步

不想跑脚本就照下面走，和方式 A 做的事完全一样——也顺便能看清每一步到底在做什么。

#### 1. 装依赖

```sh
pkg update && pkg install -y nodejs python clang make
node -v   # 需要 >= 24（或 22.19+）
```

#### 2. 把 dsh 装到一个固定目录

```sh
mkdir -p ~/dsh && cd ~/dsh
npm install --ignore-scripts @deepseek-ai/dsh
npm install @img/sharp-wasm32 sharp
```

三个要点：

- **不要用 `npx`。** `npx` 会把包塞进临时目录，补丁没有稳定的落位点。装到 `~/dsh` 这类固定目录。
- **必须补 `@img/sharp-wasm32`。** `sharp` 没有 android-arm64 预编译，缺了它附件插件会在**启动阶段**直接让 dsh 崩掉，所以这条不是可选项。
- **装 dsh 时必须加 `--ignore-scripts`。** dsh 的依赖 `koffi` 会在 postinstall 里跑 CMake 编译，在 Termux 上必然失败，而 npm 一旦遇到脚本失败就会放弃整次安装。这台机器上没有任何东西会加载 koffi 绑定——能正常运行的安装里也没有 koffi 的二进制产物。

> 想复现本文档验证过的版本：`0.2.1-rc.2`（`next` 标签；`latest` 仍停在 `0.2.0-rc.2`）。见[装哪个版本](#装哪个版本)。

#### 3. 打补丁

```sh
curl -fsSL -o ~/dsh/android-fix.mjs \
  https://raw.githubusercontent.com/mermergi/deepseek-harness-termux/main/android-fix.mjs
node ~/dsh/android-fix.mjs
```

脚本是**幂等**的：已经打过就跳过，没问题就安静退出。它改动了什么会逐条打印。

#### 4. 启动

```sh
node ~/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js web
```

它会打印一个带 token 的地址（默认 `http://127.0.0.1:3080`，同时自动打开浏览器）。首次进入请在 **Settings → Models** 里填一次 DeepSeek API key —— 写入 `~/.dsh/.credentials.yaml`，之后不用再填。

> **为什么不用 `node_modules/.bin/dsh`：** 那个 shim 的 shebang 是 `#!/usr/bin/env node`，而 Termux 上没有 `/usr/bin/env`。在交互式 shell 里，`termux-exec` 的 `LD_PRELOAD` 会改写 shebang，所以直接执行它**能跑通**——但 Termux:Widget 拉起的新会话没有这个预加载，会直接失败：
>
> ```
> .../node_modules/.bin/dsh: /usr/bin/env: bad interpreter: No such file or directory
> ```
>
> 所以脚本里一律显式用 `node` 启动 JS 入口。

## 做成桌面一键启动

用方式 A 装的已经自带这一步了；手动装的话补上：

```sh
mkdir -p ~/.shortcuts/tasks
curl -fsSL -o ~/.shortcuts/tasks/start_dsh.sh \
  https://raw.githubusercontent.com/mermergi/deepseek-harness-termux/main/start_dsh.sh
chmod +x ~/.shortcuts/tasks/start_dsh.sh
```

然后在桌面上添加 **Termux:Widget** 小组件，点 `start_dsh` 即可。

**为什么放在 `tasks/` 子目录**：Termux:Widget 对 `~/.shortcuts/` **顶层**的脚本会新开一个终端会话（点一次弹一个窗口），只有 `~/.shortcuts/tasks/` 下的脚本才在后台执行。想要「点了不出终端窗口」就必须放 `tasks/`。

- 启动是**静默**的：点一下只见 Termux:API 提示条（`⏳ DSH 启动中` → `✅ DSH 已启动`），随后浏览器自动打开。要看实时输出就在终端里跑 `~/dsh/start_dsh-terminal.sh`。
- 提示条依赖 Termux:API 应用；没装也不报错，只是没有回执。
- 脚本文件名必须是 **ASCII**。中文文件名在 Termux:Widget 下会直接失败：`env: '<path>': No such file or directory`。
- 脚本会在启动前自动重跑补丁，所以升级/重装 dsh 后照样能一键起。
- 再次点按时：端口已被占用就只打开浏览器。首次启动后浏览器会持有 30 天的登录 cookie，所以不需要再管 token；脚本本身也不会重复启动第二个实例。
- 安装目录不在 `~/dsh` 时：改脚本顶部的 `DSH_DIR`，或用 `DSH_DIR=/your/path` 覆盖。

## 做成安卓 App（可选）

不想在浏览器里用了就装 [`android-app/`](android-app/README.zh.md)——一个自签名 APK，
在这台手机上用 `aapt2` + `javac` + `d8` 本地编译，不需要电脑和 Android Studio：

```sh
bash android-app/install.sh                    # Termux 那一半（bridge 脚本 + allow-external-apps）
termux-open android-app/prebuilt/dsh.apk       # 装现成的 APK，不需要构建工具链
# 想自己改代码重编才需要：pkg install aapt2 apksigner d8 openjdk-17
# bash android-app/tools/build.sh --install
```

**APK 只是客户端（87 KB），DSH 本体在 Termux 里（约 313 MB）**，所以一台新手机是
「先装 Termux 侧、再装 APK」，完整顺序见 [android-app/README.zh.md](android-app/README.zh.md#在一台新手机上装)。

- **桌面图标、全屏、没有地址栏**：WebView 壳，返回键先在页面内后退。
- **点图标自动起服务**：通过 Termux 的 `RUN_COMMAND` 调 `~/.dsh-app/bridge.sh`，
  需要把 `termux.properties` 里的 `allow-external-apps` 打开（`install.sh` 会做）。
- **免登录**：握手拿到 `?token=` 地址后换成 30 天 cookie，之后走快路径完全不碰 Termux。
- **顺手的两个小功能**：页面顶部下拉刷新；切到别的 App 时有悬浮球显示 `工作中 / 空闲 / 服务已停止`，
  手柄永远贴在左或右边缘（20×52dp 半椭圆，贴右边像 `(`、贴左边像 `)`），用颜色区分状态；
  上下拖动移动位置，拖过屏幕中线翻到另一边。
  状态不是猜的——它读会话日志里最后一个 `turn/start` / `turn/end`，所以等模型和长工具调用都不会误判。
- **它会自己把服务救回来**：前台常驻保活服务每 10 秒探一次 `http://127.0.0.1:3080/`，端口不响应就通过
  `RUN_COMMAND` 调 bridge 重新拉起。这同时解决两件事：Android 把 Termux 冻结（socket 还在但完全
  不应答），以及从最近任务划掉 Termux 导致进程被强杀；通知里带「停止保活」动作。探测跑在独立的
  HandlerThread 上——放主线程会触发 `NetworkOnMainThreadException` 并被吞掉，早先那版就栽在这。
- **新会话设置搬进了 App**：通用设置页有「新会话初始化提示词」（`$DSH_HOME/AGENTS.md`）、默认预设
  选择和重启按钮（补丁 24）。提示词就是普通文件，Termux 里同样能改。
- **和这个脚本共用日志**：都在 `~/.dsh-app/`。`start_dsh.sh` 的日志路径已从 `$TMPDIR`
  改到这里——`$TMPDIR` 会被 Termux 清空，而正在跑的 dsh 还在往那个已删除的 inode 里写，
  token 会凭空消失（详见 [android-app/README.zh.md](android-app/README.zh.md) 里那节）。

## PhoneUse 插件（可选）

一个 agent preset：让单个会话拿到八个 `phone_*` 工具，直接操作这台手机 —— `phone_screenshot`（截屏**作为图像**交给模型）、`phone_ui`（无障碍树 + 真实像素坐标）、`phone_tap` / `phone_swipe` / `phone_key` / `phone_text`、`phone_app`、`phone_status`。全部经由 Termux 里连到 `127.0.0.1` 的 `adb`。

```sh
bash phone-use/install.sh
```

它把 shipped 的 `standard` preset 与额外的 PhoneUse 行打成 bundle，构建插件模块、自检，然后用插件市场内部同一条 pnpm 通道装进 web profile。**重启一次**后新建会话选 **「标准模式 + PhoneUse」**，工具即生效。（preset 不再是 `~/.dsh/.agent-presets/` 目录——`0.1.7` 起已不再读取。）

同一个 preset 还会把运行状态镜像到一条安卓通知上 —— 干活时是 `运行中 · phone_tap`，一轮结束变成 `已结束 · 等你指令`，并带一个跳回本 GUI 的按钮。这样"跑完没有"不用盯着浏览器。

前置条件、重建方式与安全提示见 [`phone-use/README.md`](phone-use/README.md)。

## 安全提示（务必读）

`start_dsh.sh` 里有一行：

```sh
export DSH_PERMISSION_MODE=danger-full-access
```

它**同时关闭沙箱和审批询问**。原因是安卓上 `bwrap`（bubblewrap）和 Landlock **都不存在**，而在受限模式（`workspace-write`）下 dsh 会直接拒绝执行任何命令：

```
sandbox mode "workspace-write" is requested but no sandbox backend is usable on
this host; refusing to run the command unconfined.
```

也就是说，这台设备上只有「无沙箱」和「不能跑命令」两种状态，没有中间选项。

**代价**：agent 执行的命令拥有 Termux 的完整权限，能读写你的家目录、SSH 密钥、以及其他 app 配置文件里的 API key。

**想收回**：删掉那一行 `export`（或改为 `read-only` / `workspace-write`）。代价是 shell / 终端类工具会重新变成不可用，只剩读写文件、搜索、网页等能力。

## 仓库结构

| 路径 | 是什么 |
|---|---|
| [`android-fix.mjs`](android-fix.mjs) | 26 条幂等兼容补丁；所有启动入口都会先跑它 |
| [`install.sh`](install.sh) | 一条命令安装：依赖 → dsh → 补丁 → 启动器 |
| [`start_dsh.sh`](start_dsh.sh)、[`start_dsh-terminal.sh`](start_dsh-terminal.sh) | Termux:Widget 静默启动器，及其带终端的孪生版 |
| [`app-scripts/`](app-scripts/README.md) | App 驱动的那几个脚本，外加带护栏的升级器（`upgrade.mjs`）和它的两道保险 |
| [`android-app/`](android-app/README.zh.md) | 本机自编译的 WebView 外壳 APK 与 Termux 侧 bridge |
| [`startup-prompt/`](startup-prompt/) | 可选 bundle：把 `$DSH_HOME/AGENTS.md` 注册成 system-prompt 段 |
| [`phone-use/`](phone-use/README.md)、[`phone-use-preset/`](phone-use-preset/README.md) | 可选的手机操作工具，以及承载它们的 preset bundle |
| [`env-probe.sh`](env-probe.sh)、[`probes/`](probes/) | 按「假设 → 实验 → 对照」写的环境探测 |
| [`shizuku-up.sh`](shizuku-up.sh) | 重启后恢复无线 ADB / Shizuku 通道 |

## 补丁清单

共 26 条，编号与 `android-fix.mjs` 里的注释一致。

**Android 平台差异**（1–8）：

| # | 现象 | 处理 |
|---|---|---|
| 1 | 会话写不进：`ERR_FLOCK_UNSUPPORTED_PLATFORM` | 安卓上放行 flock（退化为单进程；dsh 给浏览器 worker 也是这么做的） |
| 2 | 建文件 / 落盘 `EACCES ... link` | 硬链接发布改回退：源可丢弃用 `rename`，源要留存用 `COPYFILE_EXCL` 复制 |
| 3 | 启动崩：`Could not load the "sharp" module` | 装 `@img/sharp-wasm32` |
| 4 | 启动崩：HMR 服务加载失败 | profile 的 `patchReload` 由 `live` 改 `startup` |
| 5 | 发图被拒（外壳码 `session/agent-busy`） | 祖先目录 fsync 遇 `EACCES`/`EPERM` 就跳过 |
| 6 | `glob`/`grep` 报 `SEARCH_FAILED`（`ripgrep launch failed`） | 补上缺失的 `@vscode/ripgrep-android-arm64`，转发到系统 `rg` |
| 7 | 设置页右侧被挤扁（手机竖屏） | 注入 `<720px` 的一小段 CSS，把导航挪到顶部 |
| 8 | 点"打开配置文件"没反应 | android 分支改用 `termux-open`，并按扩展名传 `--content-type` |

**性能**（9）：

| # | 现象 | 处理 |
|---|---|---|
| 9 | 冷启动慢 | 给客户端 bundle 组合加缓存（约 10.6 s → 8 s；尽力而为，失配只警告） |

**`0.1.6-alpha.2` 上新增**（10–11，不补则**启动即崩**）：

| # | 现象 | 处理 |
|---|---|---|
| 10 | 启动崩：`host preparation failed: No usable native binding found for node-addon-require-builtin-android-arm64` | `profile-boot-<hash>.js` 的 `resolutionMode` 默认值由 `runtime` 改回 `link` |
| 11 | 启动崩：`--expose-internals is required for HMR service` | 从 `dsh-base/cordis.patch.yml` 移除硬编码的 `dsh-hmr` 条目 |

**界面、插件与工具链**（12–26）：

| # | 现象 | 处理 |
|---|---|---|
| 12 | 侧栏面板图标再点一次不收起（页面被挤成竖条） | 面板行改为 toggle：已选中时 `selectPanel(null)` 回到对话 |
| 13 | 图标 tooltip 点完不消失（要点别处才没） | 侧栏 5 处 Tooltip 设为 `disabled`（触摸屏没有悬停，气泡只会滞留） |
| 14 | 想重启得靠命令行 | 通用设置页底部加「重启 DSH 服务」按钮（原生 ↔ Web 桥接，带二次确认） |
| 15 | 装了插件后启动崩：`Cannot find package '<plugin>'` | 把 profile 里装的插件链进安装目录；顺带清理悬空链接 |
| 16 | 插件装不上：`node-pty install … exited with exit status: 127` | 修全局 `node-gyp`：shebang 指向 Termux 的 `env`，并把 PATH 入口从"副本"改回符号链接 |
| 17 | 打开侧边对话崩：`Minified React error #130` | 插件引用了此版 dsh 已不提供的图标（`IconSendOutline16`）；改用它实际提供的同名尺寸变体。扫描要覆盖插件真正打包的每个目录——`0.1.7` 把整套图标改了名（`IconX16` → `IconXMedium`），而插件市场的 bundle 放在 `client/client.js` |
| 18 | 插件从 `$DSH_HOME` 之外的目录加载 | 按安装树重建 `$DSH_HOME/profiles/node_modules`：把指向别处的软链重指回来，删掉这版已不再安装的条目 |
| 19 | 启动崩：`host preparation failed: No usable native binding found for node-addon-require-builtin-android-arm64`（0.1.7） | 跳过 `PluginPackages` 构造函数里装的运行时解析拦截；启动路径上没人需要它，`link` 语义随之恢复 |
| 20 | 插件列表里**每个**插件（含官方内置）都显示 `Plugin metadata for <插件>: Error: Plugin metadata requires the Node module resolver` | 第 19 条抽掉了内部模块加载器，而 `readPluginMeta` 正是靠它解析各插件的 locale 与 `package.json`；改为降级到 `import-meta-resolve` 的 `moduleResolve`（882 次实测与内部解析器完全一致；公开的 `resolve` 不行——它不做文件存在性校验） |
| 21 | 插件装不上/市场更新一直转「安装中」并最终报 `atomic-write: timed out waiting for the writer lock` | 重启（或被取消的安装）会把持有 `<文件>.lock` 的写进程杀掉，而没人清理它——上游是刻意的（「孤儿锁只能人工恢复」）。改为每次启动时只回收**pid 确实已消失**的锁；活着的持有者和无法识别的文件一概不碰 |
| 22 | 市场每次安装/更新都回滚：`trial validation failed — bundle declares no dsh.bundle.patch`；而回滚会把市场从 npm 重写一遍，于是第 17 条打的图标补丁被覆盖、React #130 又回来了 | `0.1.7` 的 `@deepseek-ai/dsh-web-app` 把 `dsh.bundle.patch` 声明成**五个文件的列表**（App + 四个 shipped preset）。boot 明确接受「路径或路径列表」（`bundlePatchFiles()`），但市场自己的 `buildBundleLayers()` 仍按字符串读，于是官方层被判「起不来」。把它改成两种形状都认——层构建和组装行列表两处都改——试启动校验才会和 boot 回放同一份组合。`1.55.0` 里这段代码一模一样，所以升级市场本身并不能解决 |
| 23 | 右侧边栏新建终端打不开：`subprocess-local: terminal inspection is unsupported on platform android` | Termux 上 Node 报的平台名是 `android` 而不是 `linux`，而进程检查器的工厂只认 linux/darwin/win32——它在分配 pty **之前**就抛了。Android 对它随后要用的东西就是 Linux：`/proc` 布局标准、对自家子进程可读（`stat`、`fd/0`、`task/<tid>/syscall` 均已实测），bionic 用的也是检查器里那套 arm64 系统调用号，node-pty 在本机也能正常开 pty。把 `android` 映射到 Linux 检查器（连同复用同一张进程表的「已退出 shell」判定）。进程**围栏**刻意保留在 fallback 路径：linux-scope 探测需要 user systemd 或私有 bootstrap，那条路只会告警 |
| 24 | 不编辑文件就没办法指定「新会话从哪段提示词开始」，也改不了默认预设 | 通用设置页加了初始化提示词编辑器（通过 3098 的状态守护进程读写 `$DSH_HOME/AGENTS.md`——App 与 Termux 不是同一个 UID，碰不到 Termux 的家目录）、默认预设选择（走普通 settings RPC 改 `agent-preset-registry`）和重启按钮。提示词仍然是普通文件，编辑器只是便利入口，不引入新的存储格式 |
| 25 | 文件预览头里的长路径永远看不全：左侧被裁掉并渐隐，完整路径只存在于 `title` 属性里——而触屏没有 hover | 点一下路径就地展开（头部跟着变高、路径换行显示完整），再点一下收回。壳里用的是预编译的那份 label，所以补丁改的是文件预览插件自己的两个调用点（它的 bundle 从磁盘现读，改完即生效） |
| 26 | 「显示文件位置」只会失败：`无法显示文件位置，请重试` | 安卓没有可用的文件管理器去定位文件——`nativeFileManager()` 对 `android` 返回 null，这个按钮从构造上就是死的。改成：同样的控件在安卓上把**绝对路径复制到剪贴板**，并用 toast 确认；文字与图标改成「复制完整路径」。用原生应用打开文件的那条路不受影响 |

原因、取舍与踩过的坑都写在 `android-fix.mjs` 的注释里。判断补丁在不在：`grep -rl ANDROID_ node_modules`。

**第 10、11 条值得单独记住**：它们是 `0.1.6-alpha.2` 相对 `alpha.1` 引入的，不补就完全起不来。第 10 条的根因是上游把一个**平台特定的原生依赖**接进了所有平台的启动必经路径，而那个包从没发布过 `android-arm64`。第 15 条是第 10 条的副作用：`link` 模式同时关掉了 profile 插件的解析路由。

## 新会话的默认提示词

通用设置页（补丁 24）可以直接编辑 `$DSH_HOME/AGENTS.md`——也就是 agent loader 的**用户全局**指令
文件——并选择默认预设。这两项决定新会话怎么开始，都不需要再回 Termux 改文件。

`$DSH_HOME/AGENTS.md` 默认是以「每轮附在用户消息后的 `<system-reminder>`」形式到达模型的，所以
会话中途改动会立刻生效。如果你要的是让它进**初始系统提示词**（第一条用户消息之前、system 角色），
可以装可选的 [`startup-prompt/`](startup-prompt/) bundle；两条路径并存，怎么只留一条写在它的
README 里。

## 装插件

在界面的插件市场里装即可。**装完重启一次**（设置 → 通用设置 → 底部按钮），补丁会把插件链进安装目录——不链的话加载器找不到它，插件树整棵加载失败、服务起不来。

从 **npm 装**（如 `pnpm add dshmarket`），不要用市场里给的 **git 链接**：git 路径会触发 `pnpm` 的构建脚本授权（`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`），授权后还要在手机上跑 `tsc`，而 git 依赖不带 `devDependencies`，结果是 `tsc: not found`。npm 上的包已经构建好了，不需要编译。

**有些插件带原生依赖**（`node-pty` 最常见），它们没有安卓预编译包，只能在手机上现场编译。这需要三件事齐备：

1. 编译工具：`pkg install python clang make`（一般早已装好）
2. `pnpm` 允许该依赖执行构建脚本 —— 写进 profile 的 `pnpm-workspace.yaml`：
   ```yaml
   allowBuilds:
     node-pty: true
   ```
   否则报 `ERR_PNPM_IGNORED_BUILDS`。
3. 可用的 `node-gyp` —— **补丁 16 会自动修**。

三样都齐了之后，编译会直接在手机上跑（本机实测 `node-pty@1.1.0` 约 2.4 秒），无需任何预编译包。

## 重启

三种方式，任选：

- 设置 → 通用设置 → 底部「重启 DSH 服务」（**App 内，最快**）
- App 启动页的「重新登录」（连接失败时出现）
- Termux：`bash ~/.dsh-app/bridge.sh --restart`

别用 `~/.shortcuts/tasks/start_dsh.sh` 重启——它见 3080 端口被占用就只开浏览器，不会重启服务。

重启会中断正在进行的对话。

## 安全升级（推荐）

手动升级正是本机连坏两次的原因：进程还在服务，而它脚下的安装树被换掉了，于是浏览器拿到「新版本的客户端 + 旧版本的 API」（`web boot: N entries did not activate`、插件加载失败页）。改用带护栏的升级器：

```sh
node ~/.dsh-app/upgrade.mjs            # 升到 next dist-tag
node ~/.dsh-app/upgrade.mjs 0.2.1-rc.2 # 指定版本
node ~/.dsh-app/upgrade.mjs --dry-run  # 只看计划
```

它会先把新版本装到暂存目录、打好补丁，并用**一份复制的 profile** 在备用端口试启动——演练不过就退出码 `10`，正在跑的服务和你当前的会话完全不受影响。只有演练通过才会接管「停服务 → 原子换树 → 打补丁 → 启动 → 健康检查」这一串，任何一步失败都会自动回滚（退出码 `20`）。上一棵树会保持已打补丁的状态留在 `~/dsh.prev`，随时可以两条 `mv` 手动回滚。`ensure-server.mjs` 里还有两道保险（安装代际校验、连续两次启动失败自动回滚），见 [app-scripts/README.md](app-scripts/README.md)。

## 重装或升级之后

`npm install` 会覆盖 `node_modules` 里的一切改动，**补丁会丢**。解决办法就是重跑一次：

```sh
node ~/dsh/android-fix.mjs
```

用本仓库的 `start_dsh.sh` 启动时这步会自动完成；走 App 的 bridge 时也会（每次拉起服务前都会重跑一次）。

但这一步只重打补丁。**换版本**请走[带护栏的升级器](#安全升级推荐)：它是原子替换整棵树，而不是在正在运行的树上面再装一层。

### 装哪个版本

**推荐 `0.2.1-rc.2`** —— 本机端到端验证过的版本（2026-10）：

```sh
cd ~/dsh
npm install --ignore-scripts \
  @deepseek-ai/dsh@0.2.1-rc.2 @deepseek-ai/dsh-client-ui-primitives@0.2.1-rc.2
npm install @img/sharp-wasm32 sharp
node ~/dsh/android-fix.mjs
```

npm 的 `next` 标签指向 `0.2.1-rc.2`；`latest` 仍停在 `0.2.0-rc.2`，那个也能跑。所以直接
`npm install @deepseek-ai/dsh` 装到的是 `latest`，不是本文验证的版本。

升级已有安装请走[带护栏的升级器](#安全升级推荐)，不要往正在运行的树上面直接装：它会在停服务
**之前**就把有问题的版本拒掉，新树健康检查不过还会自动回滚。

### 关于版本固定

早期版本的 `@deepseek-ai/dsh` 会把兄弟包声明成 `^0.1.6-alpha.1`，普通安装会解析到 `alpha.2` 的那批，而其中一些删掉了核心仍在 import 的导出（`watchUserPatches`），于是连回滚后的安装都起不来。

如果遇到这种"整棵树版本对不齐"的情况，用时间切点一次装完：

```sh
npm install --before=2026-09-16T23:59:00Z @deepseek-ai/dsh@0.1.6-alpha.1 @img/sharp-wasm32 sharp
node ~/dsh/android-fix.mjs
```

保留 `package-lock.json`：是它把整棵树钉住的。真出问题就用 `npm ci` 恢复。

当前 `~/dsh/package.json` 里 `@deepseek-ai/dsh` 写的是**精确版本**（没有脱字符），所以不会在你没操作时被升上去。

### 依赖树布局

如果装完出现 `Cannot find package '@deepseek-ai/dsh-plugin-manager'` 之类，多半是**依赖树嵌套**了——通常是 `package.json` 里多了一条与 `dsh` 内部要求冲突的顶层依赖。

排查：

```sh
ls ~/dsh/node_modules/@deepseek-ai/dsh/node_modules/   # 有东西 = 嵌套了
```

修法是**彻底重装**（增量 `npm install` 改不了布局）：

```sh
cd ~/dsh
mv node_modules ~/nm-broken        # 先移走，别急着删
rm -f package-lock.json
npm install
node ~/dsh/android-fix.mjs
```

### 升级前先冒烟测试

升级或改配置后，**先用别的端口起一个实例**，别直接重启生产：

```sh
cd ~/dsh
timeout 45 node node_modules/@deepseek-ai/dsh/lib/bin.js web --no-open --port 3599
```

看到 `dsh web: http://127.0.0.1:3599/?token=...` 就是成的（超时被杀是正常的）。报错就先修，别重启。

这条救过两次：一次是发现插件包没装上，一次是依赖树嵌套。

dsh 目前处于 developer preview，升级可能带来破坏性变更。如果脚本报 `missing ...` 之类，说明新版代码里的锚点字符串变了，需要对照新版调整补丁；必需补丁不会静默跳过，而是明确报出哪个文件没匹配上。

## 验证与说明

**已验证**（Android + Termux，aarch64，Node v26.4.0，2026-09-15 → 2026-10-18）：

- dsh `0.1.5-rc.1` 到 `0.2.1-rc.2` 各版都装得上、补得齐、跑得通；本文档当前针对 `0.2.0-rc.2` 与 `0.2.1-rc.2`；
- `0.2.1-rc.2` 在本机：200 个插件条目、0 失败 0 挂起，右侧边栏终端能开，`startup-prompt` 段确实进了初始系统提示词；
- 升级护栏在沙箱里逐个跑过：演练失败的版本被拒且**正在跑的服务完全没停**、换树后健康检查失败自动回滚、连续两次启动失败自动恢复上一版、换树前启动的老进程能被识别并替换；
- Web UI 在 `127.0.0.1:3080` 正常返回并可用；
- 端到端跑通一次真实任务：模型调用 → `write` 工具创建文件 → `bash` 工具执行 `cat` → 中文汇报，磁盘内容与预期一致；
- 插件安装：`dshmarket` 从 npm 装入 profile，补丁自动链进安装目录，加载器可解析；
- App 内重启按钮：点击后 `bridge.log` 记录到 `SIGTERM` 旧进程、重启、签发新 token，新进程接续服务。

**说明**：

- 要编辑配置请用界面里的设置页，或 Termux 里的 `nano ~/.dsh/settings.yaml`。
- 会话数据在 `~/.dsh/sessions/`，注意其中的对话内容会落盘。
- 本仓库以 [MIT 许可](LICENSE) 发布（与 dsh 上游一致）。

上游文档：<https://deepseek-harness.github.io/deepseek-harness/> ·
<https://github.com/deepseek-ai/deepseek-harness>（MIT）
