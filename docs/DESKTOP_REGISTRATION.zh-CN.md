# 桌面端插件列表登记

原安装器把两个插件复制到 DSH home 的 plugins 目录，再通过 profile 补丁中的绝对文件 URL 加载。插件可以运行，但原安装器没有写入 profile 的 dependencies 和 bundles，因此桌面端“已安装插件”列表没有卡片。

本地新增登记命令，将已安装的两个组件登记为真正的可管理 bundle：

- `dsh-conversation-memory`：对话归档、搜索、引用回读和语义索引。
- `dsh-semantic-tool-pruner`：原生 Basic 压缩前的工具结果语义筛选。

登记命令从已验证的安装块生成各 bundle 的补丁，移除重复的 profile 安装块，在 profile manifest 加入本地 link 依赖和 bundle 选择，创建对应 node_modules junction，并只向已有 pnpm lockfile 的当前 importer 追加两条本地 link。不会运行 pnpm 或下载额外依赖。迁移前后完整有效配置必须逐字段、按顺序相同，否则拒绝登记。

先进行只读检查，BACKUP 使用原安装命令输出的真实备份目录：

```powershell
node scripts/register-desktop.cjs --check --backup "BACKUP"
```

完全退出 DSH（包括托盘进程），再登记：

```powershell
node scripts/register-desktop.cjs --backup "BACKUP"
```

保存输出中的新 `backup` 路径；这是独立的 `dsh-memory-registration-...` 登记备份，原来的 `dsh-memory-public-...` 安装备份仍保留。重启 DSH 后，两张卡片应出现在“插件 → 已安装插件”并处于启用状态。开关移除相应 bundle，分别控制记忆桥和语义筛选；已有会话可能需要重启或新建会话才能按新的配置运行。

如需完全卸载，完全退出 DSH 后先撤销登记，再撤销原安装：

```powershell
node scripts/register-desktop.cjs --rollback "REGISTRATION_BACKUP"
node scripts/install.cjs --rollback "ORIGINAL_INSTALL_BACKUP"
```

登记备份精确保存 manifest、lockfile、profile 和两个组件原补丁的字节。回滚核对当前文件哈希及 junction 目标，拒绝覆盖后来的修改；移除的是本次创建的 junction，原始记忆数据库保留。

2026-10-26 验证：本机 DSH rc.3 的真实 PluginManager.listBundles 能识别两个组件，installed/enabled 均为 true、error 为空；配置中仅出现一个记忆桥；关闭两个 bundle 后，记忆桥消失且原生 Basic 与固定裁剪器恢复；登记与原安装的两阶段回滚恢复原文件。新增测试通过后，完整串行回归 371/371 通过、无跳过。首次并发回归的两处失败为上游测试临时目录清理时遇到 Windows EPERM，串行复核无失败。
