# Windows DSH rc.3 本地兼容适配

本地版本：`0.4.2-cachefix.5.rc3local.1`。上游基线为 `ad64001/dsh-conversation-memory` main，已观察到的提交为 `91421da4df8bf8dd0180c69cc662e254b7cf3dd1`。下载的原始源码包先通过上游清单的 128 个文件校验，再保存为本地 Git 原始提交。

这次修改扩大安装器的精确版本白名单到 `0.2.1-rc.2` 和 `0.2.1-rc.3`，更新语义裁剪插件的 peer dependency，增加版本拒绝测试和本机安装后的原文归档、搜索、回读测试。首次本机隔离安装遇到 Windows 暂时文件锁，因此给安装与回滚的重命名加入最多 770 毫秒的有界重试；永久锁和其他错误仍明确失败，不删除旧目标。插件运行逻辑、压缩参数、模型路由与账户配置保持原样。

兼容依据：将本机 rc.3 ASAR 中以下六个官方包的全部 JavaScript 运行文件，与 npm 官方 registry 下载的同名 `0.2.1-rc.2` 包逐字节比较，结果全部相同；各包共有的 YAML 文件也逐字节相同。桌面发行包省略的 TypeScript 声明文件不计入运行文件比较。具体哈希见 `validation/local-rc3-runtime-comparison.json`。

- `@deepseek-ai/dsh-compaction-basic`
- `@deepseek-ai/dsh-session`
- `@deepseek-ai/dsh-llm-pi-ai`
- `@deepseek-ai/dsh-app-boot`
- `@deepseek-ai/dsh-agent-preset`
- `@deepseek-ai/dsh-base`

验证使用本机 rc.3 桌面端的 Electron/Node 运行时。启用 `DSH_RUNTIME_NATIVE_TEST=1` 执行完整测试，涵盖隔离安装、官方配置合成、继承原生 Basic 压缩实现、四个记忆工具、SQLite 归档、搜索和逐字回读、缓存前缀稳定性、压缩后维护以及配置逐字节回滚。测试使用合成数据和模型桩，不调用真实服务商 API；不能替代真实长程模型对话的验收。

2026-10-26 本机结果：370 项测试全部通过，失败 0，跳过 0；原文归档、搜索和完整回读断言均通过。实际 desktop profile 的安装预检通过，确认保留已有预设配置及原生阈值。结构化结果见 `validation/local-rc3-test-summary.json`。

安装仍要求完全退出 DSH，并保留安装器原有的配置备份、并发修改检查、第三方压缩后端拒绝及回滚哈希校验。未添加绕过开关。DSH 升级到其他版本后需要重新验证。
