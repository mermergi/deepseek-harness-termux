# dsh-termux

一条命令在 **Android / Termux** 上装好并启动 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）：

```sh
npx dsh-termux
```

它会：把 dsh 装到 `~/dsh`（固定目录，补丁才有稳定落位点）→ 补上 `@img/sharp-wasm32` → 打上安卓兼容补丁 → 启动 Web UI。

> **前提**：Termux 里先装好工具链 —— `pkg install nodejs python clang make ripgrep`。缺哪样脚本会提示（`clang`/`make`/`python` 用于 node-pty 现编，`rg` 用于 `glob`/`grep` 工具）。

## 选项

| 选项 | 作用 |
|---|---|
| `--dir <路径>` | 安装目录（默认 `~/dsh`，也可用 `DSH_DIR`） |
| `--version <版本>` | 指定 dsh 版本；默认 `latest`。已验证 `0.1.5-rc.1` 与 `0.1.6-alpha.1` |
| `--update` | 强制重装并重新打补丁（升级 dsh 后必用，或直接再跑一次） |
| `--check` | 只安装 + 打补丁并报告状态，不启动 |
| `--sandboxed` | 不关闭沙箱（见下） |

透传给 `dsh web` 的参数直接写在后面，例如 `npx dsh-termux --port 3081`。

## 关于沙箱（务必读）

安卓上 `bwrap` 和 Landlock **都不存在**，受限模式下 dsh 会拒绝执行任何命令。所以在安卓上本包默认以 **无沙箱** 启动（`DSH_PERMISSION_MODE=danger-full-access`），并在启动前打印警告：**agent 执行的命令拥有 Termux 的完整权限**，能读写你的家目录、SSH 密钥和其它配置里的凭据。

不想这样就用 `--sandboxed`，代价是 shell / 终端类工具不可用。

## 这条命令背后到底改了什么

补丁脚本 `android-fix.mjs` 会随包一起装上并留在 `~/dsh/`，随时可重跑（幂等）。八处修补的完整说明、逐条现象/根因/处理，见仓库：

**<https://github.com/mermergi/deepseek-harness-termux>**

## 已知限制

- 升级 dsh 后必须重跑本命令（或 `node ~/dsh/android-fix.mjs`），否则补丁会被 npm 覆盖。
- 若 dsh 新版改了代码锚点，补丁脚本会明确报出 `unresolved` 而不会静默跳过——那时请到仓库反馈，我会更新锚点。
- 手机竖屏目前只适配了设置弹窗；主界面仍是桌面布局。
