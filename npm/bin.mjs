#!/usr/bin/env node
/**
 * dsh-termux — get DeepSeek Harness running on Android/Termux with one command.
 *
 * `npx dsh-termux` installs dsh into a fixed directory (so the Android patches
 * have somewhere stable to live), installs the sharp WebAssembly fallback,
 * applies the patches, and starts the Web UI.
 *
 * Everything this does is also documented step by step at
 * https://github.com/mermergi/deepseek-harness-termux — this just runs it.
 */
import { spawnSync } from 'node:child_process'
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const PATCHER = join(here, 'android-fix.mjs')
const REPO = 'https://github.com/mermergi/deepseek-harness-termux'

const say = (msg) => console.log(`\u001b[32m==>\u001b[0m ${msg}`)
const warn = (msg) => console.log(`\u001b[33m[警告]\u001b[0m ${msg}`)
const die = (msg) => {
  console.error(`\u001b[31m[错误]\u001b[0m ${msg}`)
  process.exit(1)
}

const USAGE = `用法: dsh-termux [选项] [-- <传给 dsh web 的参数>]

一条命令在 Android/Termux 上装好并启动 DeepSeek Harness。

选项:
  --dir <路径>        安装目录（默认 ~/dsh，也可用环境变量 DSH_DIR）
  --version <版本>    指定 dsh 版本；默认取 latest
  --update            强制重装 dsh 并重新打补丁
  --check             只安装/打补丁并报告状态，不启动
  --sandboxed         不关闭沙箱（安卓上 shell 工具会因此不可用）
  -h, --help          显示本帮助

示例:
  npx dsh-termux                     装好并启动 Web UI
  npx dsh-termux --port 3081         透传参数给 dsh web（用 -- 更明确）
  npx dsh-termux --update --check    升级并体检，不启动
`

// ── 参数 ────────────────────────────────────────────────────────────
let dir = process.env.DSH_DIR ?? join(homedir(), 'dsh')
let version = ''
let update = false
let check = false
let sandboxed = false
const passthrough = []
for (let i = 0; i < process.argv.length - 2; i += 1) {
  const arg = process.argv[i + 2]
  if (arg === '--') continue
  if (arg === '-h' || arg === '--help') {
    console.log(USAGE)
    process.exit(0)
  }
  if (arg === '--dir') {
    dir = process.argv[i + 3] ?? die('--dir 需要一个路径参数')
    i += 1
    continue
  }
  if (arg === '--version') {
    version = process.argv[i + 3] ?? die('--version 需要一个版本号')
    i += 1
    continue
  }
  if (arg === '--update') {
    update = true
    continue
  }
  if (arg === '--check') {
    check = true
    continue
  }
  if (arg === '--sandboxed') {
    sandboxed = true
    continue
  }
  passthrough.push(arg)
}

// ── 前提 ────────────────────────────────────────────────────────────
if (Number(process.versions.node.split('.')[0]) < 22) {
  die(`Node ${process.versions.node} 版本过低，dsh 需要 22.19+ 或 24+（pkg install nodejs）`)
}
const onAndroid = process.platform === 'android'
const missingTools = []
if (onAndroid) {
  for (const tool of ['clang', 'make', 'python3', 'rg']) {
    const found = (process.env.PATH ?? '')
      .split(':')
      .filter((part) => part !== '')
      .map((part) => join(part, tool))
      .some((candidate) => {
        try {
          accessSync(candidate, constants.X_OK)
          return true
        } catch {
          return false
        }
      })
    if (!found) missingTools.push(tool)
  }
  if (missingTools.length > 0) {
    warn(`缺少 ${missingTools.join(' / ')}，请先执行：pkg install nodejs python clang make ripgrep`)
    warn('（clang/make/python 用于 node-pty 现编；rg 用于 glob/grep 工具）')
  }
}

// ── 安装 ────────────────────────────────────────────────────────────
const dshManifest = join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
const installed = existsSync(dshManifest) ? JSON.parse(readFileSync(dshManifest, 'utf8')).version : undefined
const wanted = version === '' ? 'latest' : version

const npm = (args) => {
  const result = spawnSync('npm', args, { cwd: dir, stdio: 'inherit', env: process.env })
  if (result.status !== 0) die(`npm ${args.join(' ')} 失败`)
}

if (installed === undefined || update || (version !== '' && installed !== version)) {
  say(installed === undefined
    ? `安装 dsh 到 ${dir}（515 个包，约 300MB，首次较慢）`
    : `更新 dsh：${installed} → ${wanted}`)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  npm(installed === undefined
    ? ['install', version === '' ? '@deepseek-ai/dsh' : `@deepseek-ai/dsh@${version}`]
    : ['install', version === '' ? '@deepseek-ai/dsh@latest' : `@deepseek-ai/dsh@${version}`])
  say('安装 sharp 的 WebAssembly 回退版')
  npm(['install', '@img/sharp-wasm32', 'sharp'])
} else {
  say(`已安装 dsh ${installed}（${dir}）`)
}

// ── 打补丁 ──────────────────────────────────────────────────────────
say('执行安卓兼容补丁')
copyFileSync(PATCHER, join(dir, 'android-fix.mjs'))
const patch = spawnSync(process.execPath, [join(dir, 'android-fix.mjs')], { stdio: 'inherit' })
if (patch.status !== 0) {
  die(`补丁脚本报错，见上方 unresolved 列表。多半是这个 dsh 版本改了代码锚点，请到 ${REPO} 反馈。`)
}

if (check) {
  say('体检完成（--check，未启动）')
  process.exit(0)
}

// ── 启动 ────────────────────────────────────────────────────────────
const env = { ...process.env }
if (onAndroid && !sandboxed && env.DSH_PERMISSION_MODE === undefined) {
  env.DSH_PERMISSION_MODE = 'danger-full-access'
  warn('安卓上没有任何可用沙箱后端（bwrap / Landlock 都不存在），因此本次以「无沙箱」启动，')
  warn('即 agent 执行的命令拥有 Termux 的完整权限。想改回受控模式请加 --sandboxed，')
  warn('代价是 shell / 终端类工具会一律拒绝执行。')
}

const dshBin = join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const result = spawnSync(process.execPath, [dshBin, 'web', ...passthrough], { stdio: 'inherit', env })
process.exit(result.status ?? 1)
