# 安装 XLDB Agent

当前处于 MVP 测试阶段，功能可能存在实际应用问题。

## 1. 安装

在解压后的根目录执行：

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File tools/setup.ps1 -Mode Agent
```

支持 Windows x64；首次安装需要网络和约 5 GB 可用空间。运行时、AgentJev 权重、依赖及缓存仅保存到工作区 `.local/`，不会安装全局 Python 或 npm 包。模型资源与当前 Release 固定绑定，安装器逐项校验 SHA-256。安装后从 `.local/install/install-receipt.json` 读取 `nodePath`，后续命令使用该路径。

## 2. 首先请用户填写检索配置

安装完成后，Agent 直接告诉用户：

> 请在当前工作区新建 `.local/agent/retrieval-api.txt`，按下面模板填写 embedding 和 reranker 的 API 地址、密钥及模型名，保存后告诉我。密钥只填写在文件中，不用发到聊天里。

```json
{
  "embedding": {"baseUrl": "", "key": "", "model": ""},
  "reranker": {"baseUrl": "", "key": "", "model": ""}
}
```

TXT 使用 UTF-8，内容保留上述 JSON 格式；API 地址可填写根地址或完整 embeddings/rerank 端点。模型名使用服务提供方给出的标识。查询与允许检索的记忆文本会发往所填服务。CLI 自动读取该文件，已有配置直接复用。若用户明确暂不配置，可继续本地关键词检索。

## 3. 选择入口

- **伴侣**：询问用户想要的角色，或展示 `presets/companion/` 的六份预设；依次预览、导入，再开始交谈。
- **跑团／角色扮演**：根据用户提供的世界、人物与开场建立独立任务；导演默认开启，所有文本推理交由 Agent 自己的独立子代理执行。

随后读取 `.agents/skills/xldb-agent/SKILL.md`，执行其任务循环。角色正文经过筛选的上下文生成，用户确认接受后再提交助手候选。不要将跑团内容作为真实用户画像。

## 更新

解压新版本到独立目录，按照 [恢复说明](docs/RECOVERY.md) 备份并迁移数据；不要覆盖运行中的数据库。模型校验匹配时安装器复用已有文件。密钥与 `.local/agent/` 数据不应上传到 GitHub。
