# phone-use-preset

PhoneUse 的 **agent preset bundle**：`standard` 组合 + 一行 `./plugin/index.js`，
给单个会话 8 个 `phone_*` 工具。

## 为什么是 bundle，而不是 `.agent-presets/` 目录

0.1.7 起 `$DSH_HOME/.agent-presets/<id>/`（`preset.yml` + `agent.cordis.yml`）**不再被读取**。
preset 现在是普通 Cordis 补丁里的一个 `@deepseek-ai/dsh-agent-preset` 声明，只能由 bundle 携带。
本目录就是那份 bundle，`cordis.patch.yml` 里的 `plugins:` 是原 `agent.cordis.yml` 的逐字内容。

旧目录（`~/.dsh/.agent-presets/phone-use/`）在迁移验证通过后即可删除。

## 安装

```bash
# 1) 作为本地链接依赖装进 web profile（与插件市场内部走的是同一条 pnpm 通道）
node ~/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js plugin --profile web add "$(pwd)/phone-use-preset"

# 2) 把 bundle 选进 profile 层（等价于界面里的「启用」）
#    在 ~/.dsh/profiles/web/package.json 的 dsh.profile.bundles 里加上
#    "@local/dsh-phone-use-preset"

# 3) 重启一次，preset 才会挂载
```

安装后新建会话时选 **「标准模式 + PhoneUse」**；旧会话只要名字对得上同一个 preset id
（`phone-use`）也能继续。

## 重建插件模块

`plugin/index.js` 是**生成物**，不要手改：

```bash
node phone-use/build.mjs --out phone-use-preset/plugin
node phone-use/smoke.mjs phone-use-preset/plugin/index.js      # 离线自检
```

`build.mjs` 会把 dsh 安装目录的绝对路径烘进生成物——换了 dsh 安装位置要重新构建
（`DSH_DIR=... node phone-use/build.mjs --out phone-use-preset/plugin`）。

## 约束

基底是 `standard` 而不是 `cordis`（创造模式）：`tool-cordis` 把 Host inspect provider 注册到
进程全局，同一进程里再挂一个 cordis 家族 preset 会和 shipped `cordis` 撞车。想要自省工具用
创造模式，想要手机控制用这个 preset——一个进程里二选一。
