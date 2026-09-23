# 备份与恢复

日常数据保存在 `.local/agent/data/authority.sqlite`，检索索引位于同目录 `indexes/`。另有自定义 `dataDirectory` 时以实际配置为准。

迁移前结束所有 Agent 操作并关闭驻留实例。使用随包的 `tools/backup.mjs`，按 `node tools/backup.mjs` 显示的命令说明创建一致备份。不要在写入期间仅复制一个 SQLite 文件。

恢复到独立安装目录，保留原备份。先安装依赖，再按工具的 restore 操作恢复数据库。检索索引可以重建。将私有检索配置 `.local/agent/retrieval-api.txt` 单独复制到新目录，不发送给其他人。

Agent 的 `checkpoint`、`restore`、`undo` 和 `fork` 用于伴侣作用域内的保存点和分支，不替代离线备份。恢复操作携带当前版本；遇到来源冲突先核对，再重试。`cleanupPending:true` 表示权威数据已恢复，调用 `retry` 完成索引清理，不重复撤销。

模型与便携运行时可由安装器重新获取；个人学习与聊天数据库应保留。旧实例完全退出后再启动新实例，避免同时写同一数据库。
