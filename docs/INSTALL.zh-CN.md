# 安装、检查与回滚

## 支持范围

- Windows，DSH **0.2.1-rc.2** 桌面版；安装器严格检查版本。
- 外部 Node.js **22.13+**；推荐 24。安装器使用桌面端自带的 Node 运行时读取配置和依赖，**不会打开新的 DSH 窗口**。
- 第一次打开 DSH 后关闭，让 `~/.dsh/profiles/desktop/package.json` 初始化完毕。
- Standard、PTC、Cordis 三个预设需存在，使用官方 BasicCompactionEngine。自定义插件和参数会保留，其他 compaction backend 会被拒绝。
- 不支持自动覆盖此前手工安装的同名插件；先用旧安装方式回滚，或由维护者检查后迁移。`--check` 遇到旧目录停止是保护行为。

安装不改模型设置。想复现实测，应先在 DSH 配置自己的 OpenCode provider 并选中 DeepSeek v4.1 Flash；插件自动继承当前会话的 provider/model。仓库不包含账号、订阅或 API Key。辅助整理请求会消耗该路由额度。

## 下载与安装

1. 当前源码版本为 **0.4.2-cachefix.5**。下载 [main 源码 ZIP](https://github.com/ad64001/dsh-conversation-memory/archive/refs/heads/main.zip) 或克隆本仓库，解压到自己能写入的位置。旧 [Releases](https://github.com/ad64001/dsh-conversation-memory/releases) 中的 0.4.2 包不含缓存修复。
2. 进入源码根目录，校验内置 `SOURCE_MANIFEST.json` 并检查安装条件：

```powershell
node --version
node scripts/verify.cjs
node scripts/install.cjs --check
```

`--check` 只读取文件，验证源文件哈希、版本、预设和补丁合成结果，不安装。若 DSH 不在常见位置，使用真实安装目录（含 exe 和 resources）：

```powershell
node scripts/install.cjs --check --dsh-dir "D:\Apps\DeepSeek Harness"
```

3. 完全退出 DSH，包括托盘图标，再安装：

```powershell
node scripts/install.cjs --dsh-dir "D:\Apps\DeepSeek Harness"
```

自动找到安装目录时可以省略 `--dsh-dir`。自定义 DSH home 时，在检查、安装、回滚三条命令中一致加上 `--home "D:\DSH-Data"`；默认使用 `DSH_HOME`，否则当前用户的 `.dsh`。

4. 保存命令输出中的 `backup` 路径。这是当前电脑的回滚目录，不要分享其中的配置备份。
5. 重启 DSH，新建 Standard / PTC / Cordis 会话。

源码安装也一样：`git clone https://github.com/ad64001/dsh-conversation-memory.git`，进入目录后运行同样的命令。不需要 `npm install`。不要直接使用源码里的 `cordis.patch.yml` 快照覆盖自己的配置；安装器会从当前配置生成补丁并证明仅有预期的变化。

## 如何确认生效

在新会话让模型执行：

> 调用 memory_status 查看本会话记忆库状态。然后记住本轮任务约束“demo_batch=128，暂时只读”，继续一个小任务，再用 memory_search 搜索 demo_batch，按返回引用调用 memory_read 核对原文。

应看到 `memory_status`、`memory_search`、`memory_read` 等工具可用；`[n]` 是该会话内的稳定引用。很短的对话不一定立即产生去重调用，自动压力摘要也只有达到原生阈值后发生。

- `memory_search({query:"demo_batch",limit:6,maxChars:6000})`：有界搜索。
- `memory_read({ref:1,start:0,maxChars:4000})`：按实际返回的引用读原文。检查 `nextStart`、`hasMore` 和 `totalChars`；分页长度不是总长。
- `memory_index({maxCalls:2,query:"demo_batch"})`：按需调用当前模型建立语义索引。`incomplete` / `remainingTargeted` 不代表已查完。
- `memory_status({})`：检查归档、索引、去重和覆盖状态。

每个会话库默认在 `~/.dsh/conversation-memory/`，会话 ID 做 SHA-256 路径隔离。它不是加密库，原始内容仍是敏感本地数据。

## 安装器修改哪些文件

- 复制 `plugin/` 到 `~/.dsh/plugins/dsh-conversation-memory/`。
- 复制 `semantic-pruner/` 到 `~/.dsh/plugins/dsh-semantic-tool-pruner/`，生成绑定当前桌面端 Basic 实现的 `runtime-binding.mjs`。
- 备份并追加 desktop 的 `cordis.patch.yml`：三预设的 Basic 实现改成语义筛选插件，旧固定截取器禁用；加入记忆 bridge。现有预设配置逐字段保留。
- 将原文件、安装状态和哈希写入 `~/.dsh/backups/dsh-memory-public-.../`。

不会修改 DSH 的 ASAR、模型路由或账户配置。不会增加 profile 依赖、修改 profile package.json，也不需要全局 npm 安装。移动或升级 DSH 后原绑定可能失效：先回滚，版本受支持时重新检查安装。

## 卸载 / 回滚

完全退出 DSH，用安装时输出的真实 backup 路径运行：

```powershell
node scripts/install.cjs --rollback "C:\Users\YOUR_NAME\.dsh\backups\dsh-memory-public-YOUR_ID" --dsh-dir "D:\Apps\DeepSeek Harness"
```

然后重启 DSH。回滚核对哈希，恢复安装前的配置原始字节，把两个安装目录移入备份目录；**保留会话记忆数据库**。若安装后又编辑了 profile 或插件文件，会停止自动回滚，避免覆盖新修改。此时保留备份、查看配置差异，再手动移除 `BEGIN DSH CONVERSATION MEMORY PUBLIC` 至 `END` 的安装块，确认没有别处引用两个插件后移动其目录。不要删除原有会话数据库。

安装若中断，会打印 Recovery backup 路径；先保留现场。`prepared` 状态且已有文件哈希可核验时同一回滚命令可以恢复；若文件未写完整或被修改，自动回滚会拒绝，需根据该目录的 receipt 和原配置处理。

## 常见情况

- **desktop not found**：传 `--dsh-dir`，不要传 exe 文件或 resources 子目录。
- **version unsupported**：该版本未验证，安装器不强行改配置。请在 Issues 报告版本。
- **Existing plugin destination / custom backend**：已有别的安装，不直接覆盖。先用原方式回滚。
- **later patch overrides installation**：home 层等后置补丁覆盖了改动。先检查配置顺序，别盲目删自定义项。
- **需要几分钟**：去重单次 180 秒、整轮 300 秒；工具语义筛选保留原有单次 60 秒、整轮 180 秒。失败会保留原文或复用已批准记忆，并报告状态。
- **超大工具结果只有预览**：DSH 默认 spill 可能早于归档发生，需按临时文件指针及时回读，不承诺永久全文保留。

不要把本地备份、数据库、完整会话轨迹和 API Key 上传到 Issues。
