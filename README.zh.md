# deepseek-harness-termux

[English](README.md) | 中文

让 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）在 **Android / Termux** 上跑起来的兼容补丁 + 一键启动脚本。

dsh 官方支持 Linux / macOS / Windows。安卓（Termux，bionic libc）缺了几个它默认依赖的前提，所以官方 README 里的 `npx @deepseek-ai/dsh web` 在手机上**起不来**。本仓库把实测可行的八处修补收敛到一个幂等脚本里，并给出可直接复制的启动步骤（其中第 7 处是 Web UI 的手机竖屏布局，性质与其余不同）。

## 目录

- [演示素材](#演示素材)
- [环境要求](#环境要求)
- [快速开始](#快速开始)
- [做成桌面一键启动](#做成桌面一键启动)
- [做成安卓 App](#做成安卓-app可选)
- [PhoneUse 插件（可选）](#phoneuse-插件可选)
- [安全提示（务必读）](#安全提示务必读)
- [补丁清单](#补丁清单)
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
| 磁盘 | 约 300 MB（dsh 会拉 515 个 npm 包） |
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
| `--version 0.1.5-rc.1` | 固定 dsh 版本，便于复现 |

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
npm install @deepseek-ai/dsh
npm install @img/sharp-wasm32 sharp
```

两个要点：

- **不要用 `npx`。** `npx` 会把包塞进临时目录，补丁没有稳定的落位点。装到 `~/dsh` 这类固定目录。
- **必须补 `@img/sharp-wasm32`。** `sharp` 没有 android-arm64 预编译，缺了它附件插件会在**启动阶段**直接让 dsh 崩掉，所以这条不是可选项。

> 想复现本文档验证过的版本：`0.1.5-rc.1`（写本文时的 `latest`）或 `0.1.6-alpha.1`（`alpha` 标签，需显式指定版本才装得到）。

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

**APK 只是客户端（75 KB），DSH 本体在 Termux 里（约 271 MB）**，所以一台新手机是
「先装 Termux 侧、再装 APK」，完整顺序见 [android-app/README.zh.md](android-app/README.zh.md#在一台新手机上装)。

- **桌面图标、全屏、没有地址栏**：WebView 壳，返回键先在页面内后退。
- **点图标自动起服务**：通过 Termux 的 `RUN_COMMAND` 调 `~/.dsh-app/bridge.sh`，
  需要把 `termux.properties` 里的 `allow-external-apps` 打开（`install.sh` 会做）。
- **免登录**：握手拿到 `?token=` 地址后换成 30 天 cookie，之后走快路径完全不碰 Termux。
- **顺手的两个小功能**：页面顶部下拉刷新；切到别的 App 时有悬浮球显示 `工作中 / 空闲 / 服务已停止`，
  手柄永远贴在左或右边缘（20×52dp 半椭圆，贴右边像 `(`、贴左边像 `)`），用颜色区分状态；
  上下拖动移动位置，拖过屏幕中线翻到另一边。
  状态不是猜的——它读会话日志里最后一个 `turn/start` / `turn/end`，所以等模型和长工具调用都不会误判。
- **和这个脚本共用日志**：都在 `~/.dsh-app/`。`start_dsh.sh` 的日志路径已从 `$TMPDIR`
  改到这里——`$TMPDIR` 会被 Termux 清空，而正在跑的 dsh 还在往那个已删除的 inode 里写，
  token 会凭空消失（详见 [android-app/README.zh.md](android-app/README.zh.md) 里那节）。

## PhoneUse 插件（可选）

一个 agent preset：让单个会话拿到八个 `phone_*` 工具，直接操作这台手机 —— `phone_screenshot`（截屏**作为图像**交给模型）、`phone_ui`（无障碍树 + 真实像素坐标）、`phone_tap` / `phone_swipe` / `phone_key` / `phone_text`、`phone_app`、`phone_status`。全部经由 Termux 里连到 `127.0.0.1` 的 `adb`。

```sh
bash phone-use/install.sh
```

它把 shipped 的 `standard` preset 复制到 `~/.dsh/.agent-presets/phone-use/`，补上那一行组成，构建插件模块，最后自检。新建会话时选 **「标准模式 + PhoneUse」**，工具即生效。

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

## 补丁清单

| 现象 | 处理 |
|---|---|
| 启动崩：`--expose-internals is required for HMR service` | profile 的 `patchReload` 由 `live` 改 `startup` |
| 会话写不进：`ERR_FLOCK_UNSUPPORTED_PLATFORM` | 安卓上放行 flock（退化为单进程；dsh 给浏览器 worker 也是这么做的） |
| 建文件 / 落盘 `EACCES ... link` | 硬链接发布改回退：源可丢弃用 `rename`，源要留存用 `COPYFILE_EXCL` 复制 |
| 启动崩：`Could not load the "sharp" module` | 装 `@img/sharp-wasm32` |
| 发图被拒（外壳码 `session/agent-busy`） | 祖先目录 fsync 遇 `EACCES`/`EPERM` 就跳过 |
| `glob`/`grep` 报 `SEARCH_FAILED`（`ripgrep launch failed`） | 补上缺失的 `@vscode/ripgrep-android-arm64`，转发到系统 `rg` |
| 设置页右侧被挤扁（手机竖屏） | 注入 `<720px` 的一小段 CSS，把导航挪到顶部 |
| 点"打开配置文件"没反应 | android 分支改用 `termux-open`，并按扩展名传 `--content-type` |

原因、取舍与踩过的坑都写在 `android-fix.mjs` 的注释里。判断补丁在不在：`grep -rl ANDROID_ node_modules`。

## 重装或升级之后

`npm install` 会覆盖 `node_modules` 里的一切改动，**补丁会丢**。解决办法就是重跑一次：

```sh
node ~/dsh/android-fix.mjs
```

用本仓库的 `start_dsh.sh` 启动时这步会自动完成。

补丁里有一个**客户端 bundle 组合缓存**：dsh 启动时每注册一批插件就会重新组装一次全部客户端 bundle（本机实测 435 次调用、约占启动 10 秒），缓存把冷启动从约 10.6 秒压到约 8 秒。它只影响速度、不影响正确性，因此是尽力而为的：新版代码锚点变了只打印一行警告，不会拦住启动。

dsh 目前处于 developer preview，升级可能带来破坏性变更。如果脚本报 `missing ...` 之类，说明新版代码里的锚点字符串变了，需要对照新版调整补丁；必需补丁不会静默跳过，而是明确报出哪个文件没匹配上。

## 验证与说明

**已验证**（Android + Termux，aarch64，Node v26.4.0，2026-09-15 至 16）：

- dsh `0.1.5-rc.1` 与 `0.1.6-alpha.1` 两版都装得上、补得齐、跑得通（升级到后者后逐项复验）；
- Web UI 在 `127.0.0.1:3080` 正常返回并可用；
- 端到端跑通一次真实任务：模型调用 → `write` 工具创建文件 → `bash` 工具执行 `cat` → 中文汇报，磁盘内容与预期一致。

**说明**：

- 要编辑配置请用界面里的设置页，或 Termux 里的 `nano ~/.dsh/settings.yaml`。
- 会话数据在 `~/.dsh/sessions/`，注意其中的对话内容会落盘。
- 本仓库以 [MIT 许可](LICENSE) 发布（与 dsh 上游一致）。

上游文档：<https://deepseek-harness.github.io/deepseek-harness/> ·
<https://github.com/deepseek-ai/deepseek-harness>（MIT）
