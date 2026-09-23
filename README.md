# XLDB Agent

让 Agent 拥有连续的记忆、情绪与角色经历。独立于 SillyTavern，支持长期伴侣，以及单角色、多角色跑团／角色扮演。

**当前处于 MVP 测试阶段，功能可能存在实际应用问题。**

## 开始使用

从 [最新 Release](https://github.com/lty418905-blip/XLDB/releases/latest) 下载 `XLDB-Agent.zip`，解压到 Windows x64 工作区。把文件夹交给支持本地命令和独立子代理的 Agent，并告诉它：

> 按 INSTALL_AGENT.md 安装 XLDB，然后引导我完成配置。

安装器自动补齐本地依赖，并从清单固定的资源版本下载、校验和组装内置 AgentJev 模型及便携运行时。无需逐个下载资源或手动合并文件。

Agent 随后会请你在工作区新建 `.local/agent/retrieval-api.txt`，填写 embedding 和 reranker 的 API 地址、密钥、模型名。模板见 [配置与安装](INSTALL_AGENT.md)。正文、导演和其他文本推理使用当前 Agent 的子代理，无需另外填写聊天模型 API。

## 可以做什么

- **伴侣**：选择六份预设之一或导入自己的角色背景；延续记忆、OpenHer 情绪、承诺、用户习惯与可纠正的关系理解。
- **跑团与角色扮演**：告诉 Agent 世界设定、角色和开场；Agent 补齐必要资料，用独立子代理担任导演和各推理角色，保持人物知情范围与剧情状态。
- **自然记忆**：文本模糊与向量精度调整共同参与选择性遗忘，并支持有依据的语义再激活。
- **相处变化**：情绪和关系影响表达与称呼；支持主动联系判断和本地个人学习。
- **资料管理**：支持来源纠正、保存点、分支、撤销、备份与恢复。伴侣经历与跑团经历分别保存。

主动联系需要宿主能持续运行并投递消息；个人训练在驻留运行时连续空闲 10 分钟后启动，新活动到来时暂停。短命令结束后不会继续后台运行。

[Agent 接口](docs/AGENT.md) · [恢复](docs/RECOVERY.md) · [检索](docs/RETRIEVAL.md) · [许可](LICENSE.md) · [第三方声明](THIRD_PARTY_NOTICES.md)
