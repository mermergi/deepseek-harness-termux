# deepseek-harness-termux

让 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）在 **Android / Termux** 上跑起来的兼容补丁 + 一键启动脚本。

dsh 官方支持 Linux / macOS / Windows。安卓（Termux，bionic libc）缺了几个它默认依赖的前提，所以官方 README 里的 `npx @deepseek-ai/dsh web` 在手机上**起不来**。本仓库把实测可行的四处修补收敛到一个幂等脚本里，并给出可直接复制的启动步骤。

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
~/dsh/node_modules/.bin/dsh web
```

它会打印一个带 token 的地址（默认 `http://127.0.0.1:3080`，同时自动打开浏览器）。首次进入请在 **Settings → Models** 里填一次 DeepSeek API key —— 写入 `~/.dsh/.credentials.yaml`，之后不用再填。

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

四处都是「安卓缺前提」，不是 dsh 的 bug：

| # | 现象 | 根因 | 处理 |
|---|---|---|---|
| 1 | 启动即崩：`--expose-internals is required for HMR service` | web profile 默认 `patchReload: live`，启动时会动态加载 HMR 插件；该插件需要 `--expose-internals`，或 `node-addon-require-builtin`——而后者**没有安卓预编译** | 把 profile 的 `patchReload` 由 `live` 改为 `startup`，不再加载 HMR |
| 2 | 会话无法写入：`ERR_FLOCK_UNSUPPORTED_PLATFORM` | `@deepseek-ai/node-addon-system` 的 flock 绑定只有 linux/darwin 预编译；它用作会话文件的跨进程写锁 | 在安卓上直接放行（dsh 自己给浏览器 worker 就是这么做的）。flock 只防多进程同写一个会话，这里退化为单进程语义 |
| 3 | 建文件/会话落盘 `EACCES: permission denied, link ...` | **安卓禁止在 app 目录创建硬链接**（SELinux；`ln` 在本仓库实测的家目录、`$PREFIX`、外置存储下全部 EACCES）。而 dsh 的会话落盘、写文件工具、附件存储都用「写临时文件 + 硬链接发布」做原子提交 | 硬链接被拒时改用 `rename` 发布，并先复查目标是否存在以保留「不覆盖」语义。**只在硬链接真的被拒时回退**，Linux/macOS 行为不变 |
| 4 | 启动即崩：`Could not load the "sharp" module using the android-arm64 runtime` | `sharp` 没有 android-arm64 预编译 | 安装官方 WebAssembly 回退版 `@img/sharp-wasm32` |

`android-fix.mjs` 触及的文件：

```
node_modules/@deepseek-ai/node-addon-system/lib/flock.js                  # 1
node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js      # 2、3
node_modules/@deepseek-ai/dsh-fs-local/lib/index.js                       # 3
node_modules/@deepseek-ai/dsh-attachment-local/lib/index.js               # 3
~/.dsh/profiles/<name>/package.json                                       # 1 的补丁层
```

判断补丁是否在位：在安装目录里 `grep -r ANDROID_STUB node_modules`（flock）与 `grep -r ANDROID_PATCH node_modules`（硬链接回退）。

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
- 原生模块 `koffi`（官方 `@koromix/koffi-android-arm64` 预编译）与 `node-pty`（本机现编出 `pty.node`，能开出真 PTY）均加载正常。

**已知限制**：

- **附件/图片链路未实测**。补丁已打、模块能正常加载，但没有实际传过图片；走 WASM 的 `sharp` 也会比原生慢。
- **flock 退化为单进程放行**：不要同时运行两个 dsh 实例写同一个会话。
- 会话数据在 `~/.dsh/sessions/`，注意其中的对话内容会落盘。
- 本仓库以 [MIT 许可](LICENSE) 发布（与 dsh 上游一致）。

上游文档：<https://deepseek-harness.github.io/deepseek-harness/> ·
<https://github.com/deepseek-ai/deepseek-harness>（MIT）
