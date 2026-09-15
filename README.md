# deepseek-harness-termux

让 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）在 **Android / Termux** 上跑起来的兼容补丁 + 一键启动脚本。

dsh 官方支持 Linux / macOS / Windows。安卓（Termux，bionic libc）缺了几个它默认依赖的前提，所以官方 README 里的 `npx @deepseek-ai/dsh web` 在手机上**起不来**。本仓库把实测可行的八处修补收敛到一个幂等脚本里，并给出可直接复制的启动步骤（其中第 7 处是 Web UI 的手机竖屏布局，性质与其余不同）。

## 目录

- [环境要求](#环境要求)
- [快速开始](#快速开始)
- [做成桌面一键启动](#做成桌面一键启动)
- [安全提示（务必读）](#安全提示务必读)
- [补丁清单](#补丁清单)
- [重装或升级之后](#重装或升级之后)
- [验证与已知限制](#验证与已知限制)

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

`install.sh` 会依次完成：检查 Node 版本与编译工具链 → 把 dsh 装到 `~/dsh` → 补上 `@img/sharp-wasm32` → 打四处补丁 → 装好 `~/.shortcuts/start_dsh.sh`。**可重复运行**：跑失败、修好原因后直接重跑，已完成的步骤会跳过。

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

> 想复现本文档验证过的版本：`npm install @deepseek-ai/dsh@0.1.5-rc.1`

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
mkdir -p ~/.shortcuts
curl -fsSL -o ~/.shortcuts/start_dsh.sh \
  https://raw.githubusercontent.com/mermergi/deepseek-harness-termux/main/start_dsh.sh
chmod +x ~/.shortcuts/start_dsh.sh
```

然后在桌面上添加 **Termux:Widget** 小组件，点 `start_dsh.sh` 即可。

- 脚本文件名必须是 **ASCII**。中文文件名在 Termux:Widget 下会直接失败：`env: '<path>': No such file or directory`。
- 脚本会在启动前自动重跑补丁，所以升级/重装 dsh 后照样能一键起。
- 再次点按时：端口已被占用就只打开浏览器。首次启动后浏览器会持有 30 天的登录 cookie，所以不需要再管 token；脚本本身也不会重复启动第二个实例。
- 安装目录不在 `~/dsh` 时：改脚本顶部的 `DSH_DIR`，或用 `DSH_DIR=/your/path` 覆盖。

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

除第 7 处（Web UI 本身就缺手机竖屏布局）外，其余都是「安卓缺前提 / 缺平台条目」，不是 dsh 的 bug：

| # | 现象 | 根因 | 处理 |
|---|---|---|---|
| 1 | 启动即崩：`--expose-internals is required for HMR service` | web profile 默认 `patchReload: live`，启动时会动态加载 HMR 插件；该插件需要 `--expose-internals`，或 `node-addon-require-builtin`——而后者**没有安卓预编译** | 把 profile 的 `patchReload` 由 `live` 改为 `startup`，不再加载 HMR |
| 2 | 会话无法写入：`ERR_FLOCK_UNSUPPORTED_PLATFORM` | `@deepseek-ai/node-addon-system` 的 flock 绑定只有 linux/darwin 预编译；它用作会话文件的跨进程写锁 | 在安卓上直接放行（dsh 自己给浏览器 worker 就是这么做的）。flock 只防多进程同写一个会话，这里退化为单进程语义 |
| 3 | 建文件/会话落盘 `EACCES: permission denied, link ...`；发图片时提示词被拒 | **安卓禁止在 app 目录创建硬链接**（SELinux；`ln` 在本仓库实测的家目录、`$PREFIX`、外置存储下全部 EACCES）。而 dsh 的会话落盘、写文件工具、附件存储都用「硬链接发布」做原子提交 | 按「源文件是否要保留」分两种回退：源是可丢弃临时文件的地方用 `rename`（并复查目标以保留「不覆盖」语义）；源必须存活的地方（附件别名发布、发布后还要 `unlink(源)`）用 `copyFile(..., COPYFILE_EXCL)` 独占复制。**只在硬链接真的被拒时回退**，Linux/macOS 行为不变 |
| 4 | 启动即崩：`Could not load the "sharp" module using the android-arm64 runtime` | `sharp` 没有 android-arm64 预编译 | 安装官方 WebAssembly 回退版 `@img/sharp-wasm32` |
| 5 | 发图片时提示词被拒：`prompt rejected (session/agent-busy)` | 附件落盘前会把**每一级祖先目录**都 fsync 到文件系统根 `/`，以保证崩溃后目录项不丢。安卓的 `/data/data` 权限是 `0771`——app 可穿越但**不可 `open()`**，于是整条发图链路抛 `EACCES: permission denied, open '/data/data'`。被拒的提示词不留痕，界面只显示那个空洞的外壳错误码 | 祖先目录打不开（`EACCES`/`EPERM`）时跳过：打不开的系统目录本就不是 app 该同步的（它是系统早就建好并落盘的），而附件自己创建的每一级目录仍照常同步。Linux/macOS 行为不变（那边 `open()` 本来就成功） |
| 6 | `glob`/`grep` 工具报 `SearchError: SEARCH_FAILED`，附 `ripgrep launch failed` | `dsh-tool-fs-search` 直接 spawn `@vscode/ripgrep` 选出的**平台构建**，而该包只发布 macOS / Linux / Windows——没有 `@vscode/ripgrep-android-arm64`，导入即抛 `Could not find ...`，于是每次搜索都启动失败 | 先照旧尝试随包二进制；不可用时回退到 PATH 里的 `rg`（Termux 的 `pkg install ripgrep` 就是安卓原生构建）。有平台构建的环境完全不受影响 |
| 7 | 手机上**设置页面右侧被挤扁** | 设置外壳是桌面弹窗：`width:800px`（被 `calc(100vw - 48px)` 兜住）+ 固定 `188px` 的导航列并排，**且该包没有任何媒体查询**。412px 手机上弹窗仅约 364px，内容区只剩约 176px | 注入一段 `@media (max-width: 720px)` 覆盖：导航列改为**顶部横向可滚动条**、标题隐藏、内容区占满宽度，弹窗边距收紧并用 `100dvh` 以便软键盘弹出时仍可达。类名是 CSS Module 哈希，脚本每次**从已安装的 bundle 里现读**并就地重写该样式块；选择器双写类名以稳压插件运行时注入的规则 |
| 8 | 设置里点"打开配置文件"没反应，或选择器里的应用都打不开 | `dsh-native-command` 只声明了 darwin / win32 / linux 三个平台的启动器，安卓上按钮被判定不可用；就算调起 `termux-open`，`.yaml` 这类扩展名没有 MIME 条目，意图会退化成通配类型 | android 分支改用 Termux 的 `termux-open`，并按扩展名传 `--content-type`（文本类 → `text/plain`，图片 / PDF / HTML 给各自类型）。只能只读分享，无法原位保存；"在文件管理器里显示"保持不支持 |

`android-fix.mjs` 触及的文件：

```
node_modules/@deepseek-ai/node-addon-system/lib/flock.js                  # 2
node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js      # 2、3
node_modules/@deepseek-ai/dsh-fs-local/lib/index.js                       # 3
node_modules/@deepseek-ai/dsh-attachment-local/lib/index.js               # 3、5
node_modules/@deepseek-ai/dsh-tool-fs-search/lib/index.js                 # 6
node_modules/@deepseek-ai/dsh-native-command/lib/index.js                 # 8
node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html                # 7（写入）
node_modules/@deepseek-ai/dsh-client-ui-settings-general/lib/client.js    # 7（只读，取类名）
~/.dsh/profiles/<name>/package.json                                       # 1
```

判断补丁是否在位：在安装目录里 `grep -rl ANDROID_STUB node_modules`（flock）、`grep -rl ANDROID_PATCH node_modules`（硬链接回退）、`grep -rl ANDROID_PATCH_WALK node_modules`（目录同步）。

## 重装或升级之后

`npm install` 会覆盖 `node_modules` 里的一切改动，**补丁会丢**。解决办法就是重跑一次：

```sh
node ~/dsh/android-fix.mjs
```

用本仓库的 `start_dsh.sh` 启动时这步会自动完成。

dsh 目前处于 developer preview，升级可能带来破坏性变更。如果脚本报 `missing ...` 之类，说明新版代码里的锚点字符串变了，需要对照新版调整补丁；脚本不会静默跳过，而是明确报出哪个文件没匹配上。

## 验证与已知限制

**已验证**（Android + Termux，aarch64，Node v26.4.0，dsh 0.1.5-rc.1，2026-09-15）：

- Web UI 在 `127.0.0.1:3080` 正常返回并可用；
- 端到端跑通一次真实任务：模型调用 → `write` 工具创建文件 → `bash` 工具执行 `cat` → 中文汇报，磁盘内容与预期一致；
- **真机发图跑通**：一张 `jpeg 1156x2510` 经 `sharp` 规范化后落盘，附件库里生成了内容寻址的原图对象（文件名与其内容 sha256 一致）与给模型用的缩放版（`543x1178`）；
- **`glob`/`grep` 工具跑通**：搜索结果的匹配数与系统 `rg` 逐个文件一致（不是"没报错"，而是结果对得上）；
- 原生模块 `koffi`（官方 `@koromix/koffi-android-arm64` 预编译）与 `node-pty`（本机现编出 `pty.node`，能开出真 PTY）均加载正常。

**已知限制**：

- **附件/图片链路**：发图已跑通（见上）。注意走 WASM 的 `sharp` 比原生慢；补丁 5 会让"祖先目录 fsync"在安卓上止步于 app 无法打开的那一层，因此极端掉电场景下，`~/.dsh` 以上系统目录的目录项同步由系统负责。
- **flock 退化为单进程放行**：不要同时运行两个 dsh 实例写同一个会话。
- **手机竖屏只修了设置弹窗**（补丁 7）。主界面仍有 56px 的折叠侧栏轨道，右侧面板、对话区在窄屏下未做适配；上游文档自己把"窗口极窄时中间栏可能不足 400px"列为已知限制。补丁 7 的断点是脚本里的 `max-width: 720px`，觉得该换宽度就改这个值（改完重跑脚本即可，样式块会就地重写）。
- **"用外部应用打开"在安卓上只能只读分享**，第三方应用无法原位保存；"在文件管理器里显示"没有安卓对应语义，保持不支持。要编辑配置请用界面里的设置页，或 Termux 里的 `nano ~/.dsh/settings.yaml`。
- 会话数据在 `~/.dsh/sessions/`，注意其中的对话内容会落盘。
- 本仓库以 [MIT 许可](LICENSE) 发布（与 dsh 上游一致）。

### 排障：`prompt rejected (session/agent-busy)`

界面上的这个错误是**外壳错误**：dsh 把提示词准入阶段的一切非预期异常都裹成这个码，真正的原因（`reason` 字段）只在**运行 dsh 的那个终端**里打印，界面不显示；被拒的提示词也不写入会话日志，事后无从追溯。

排查办法：在 `node_modules/@deepseek-ai/dsh-api-session-controller/lib/index.js` 里找到抛出 `"session/agent-busy"` 的那一行，在它前面插一句 `console.error(error)` 重启服务即可看到真实原因（补丁 5 就是这样定位出来的）。

上游文档：<https://deepseek-harness.github.io/deepseek-harness/> ·
<https://github.com/deepseek-ai/deepseek-harness>（MIT）
