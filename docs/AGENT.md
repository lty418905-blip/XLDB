# Agent 使用接口

当前处于 MVP 测试阶段，功能可能存在实际应用问题。

本包直接由宿主 Agent 驱动。宿主需要本地文件、命令执行及独立子代理能力。先按 [安装说明](../INSTALL_AGENT.md) 安装，再执行 [.agents/skills/xldb-agent/SKILL.md](../.agents/skills/xldb-agent/SKILL.md) 的任务循环。

## 检索配置引导

安装后首先请用户在工作区新建 `.local/agent/retrieval-api.txt`，内容为 UTF-8 JSON：

```json
{
  "embedding": {"baseUrl":"", "key":"", "model":""},
  "reranker": {"baseUrl":"", "key":"", "model":""}
}
```

用户填写 API 地址、密钥、模型名后，CLI 自动读取。`retrievalConfigPath` 可覆盖默认路径。不要读取并转述密钥，不传给子代理。正文及其他文本推理均由宿主子代理处理。

## 文件命令与子代理

将请求 JSON 写到 `.local/agent/requests/`，运行：

```powershell
node adapters/agent/cli.mjs run REQUEST_JSON
node adapters/agent/cli.mjs jobs RUN_DIRECTORY
```

采用安装回执中的 `nodePath`。第一条命令返回运行目录并等待模型作业；第二条读取待处理作业元数据。为每项作业创建新上下文子代理，只让它读取指定 request 文件，并把原始模型输出写入指定 result 文件。所有阶段按各自的 `messages` 和 `responseFormat` 执行，不能固定套同一个响应格式。包括导演、角色正文、记忆、情绪、世界、画像等任务。主 Agent 只读取最终筛选结果；循环规则详见技能文件。

取消使用 `node adapters/agent/cli.mjs cancel RUN_DIRECTORY`。取消不撤销已经提交的用户正文。结果文件中的 `failed` 需要处理原因后重试；不得把失败当作已接受。

## 伴侣

范围格式为 `{"worldId":"companion","sessionId":"chat","branchId":"main","characterId":"card"}`。用稳定 ID 保存同一伴侣，不随昵称变化新建身份。

新角色可选择 `presets/companion/` 的沈知微、唐映禾、夏明橙、程砚舟、顾沉或陆听澜，也可导入相同格式的自定义背景。先 `previewCompanionPreset`，再以相同 `document` 和返回的 `expectedVersion`、`previewId`、新 `operationId` 调用 `importCompanionPreset`；首次 `turn` 会补齐预设允许的生活细节。不要先 configure 一个将要导入预设的范围。

常用请求：

```json
{
  "operation":"turn",
  "scope":{"worldId":"companion","sessionId":"chat","branchId":"main","characterId":"card"},
  "envelope":{"targetId":"alice","mode":"direct","presentIds":["alice"]},
  "input":"今天想和你聊聊。",
  "accept":true
}
```

将 `alice` 替换成导入的角色 ID。`accept:true` 表示授权接受这一生成结果；预览使用 false。用户正文同步处理后才生成，助手候选接受后才学习。按用户意愿接受，不为演示自动接受。

`bindSubject` 绑定真实用户 ID；`profile` 查看习惯、偏好和心理侧写；`profileControls` 设置学习、应用和主动性；`profileCorrect`/`profileDelete` 纠正或删除。`relationshipAssessment` 查看双向关系建议，`relationshipCorrect` 纠正。主动联系通过 `contactSettings`、`companionPoll`、`companionClaim`、实际宿主投递及 `companionReceipt` 完成；投递成功前不得记作已发送。所有用户控制按返回的 revision 更新。

## 跑团与角色扮演

按用户给出的世界、人物和开场补齐必要资料，先创建任务：

```json
{"operation":"roleplayOpen","roster":{"characters":[{"id":"alice","name":"艾琳","aliases":[],"persona":"王都图书馆的馆员，谨慎而好奇。"}]}}
```

保存返回的 `scope`，后续使用：

```json
{"operation":"roleplayTurn","scope":{"worldId":"返回的值","sessionId":"返回的值","branchId":"返回的值","characterId":"返回的值"},"input":"我走进图书馆，向馆员询问旧地图。","accept":true}
```

多角色使用 `envelope` 指明 `targetId`、`mode` 和 `presentIds`。导演默认开启，由宿主独立子代理担当；用户明确要求时，在创建任务时传 `directorEnabled:false`。每次 turn 也会派发其他必要模型职责。伴侣 scope 与任务 scope 分开保存，跑团不会进入真实用户画像。

## 驻留 SDK

需要主动联系与空闲训练时，宿主保持一个 `AgentRuntime` 实例运行：

```ts
import {AgentRuntime} from './src/agent/runtime.ts';
const runtime = new AgentRuntime({
  databasePath: '/安装目录/.local/agent/data/authority.sqlite',
  indexPath: '/安装目录/.local/agent/data/indexes',
  delegate: task => host.runFreshSubagent(task),
  retrieval: privateRetrievalConfig,
});
```

`host.runFreshSubagent` 和 `privateRetrievalConfig` 由宿主提供。原生子代理使用每个任务的隔离输入。CLI 为一次命令运行，退出后不继续训练或发送消息。SDK 中聊天只收集训练材料，连续空闲 10 分钟才启动后台训练；新活动会取消未完成作业。后台工作结束后再 `close()`。

SDK 提供 `openRoleplayTask`、`prepareRoleplay`、`acceptRoleplay`、`rejectRoleplay`，可在同一驻留实例内预览再确认候选。普通 `prepare`、`accept`、`recall` 为伴侣接口。

## 修订与恢复

`sync` 是完整已接受消息列表的替换，先读取 `syncState`，携带 `expectedVersion`、稳定来源修订和唯一 `operationId`。不把单条增量当完整列表。`edit`、`delete`、`retry` 处理来源更改及失败恢复；`checkpoint`、`restore`、`undo`、`fork` 管理伴侣保存点和分支。角色视角只接收筛选后的 recall／生成结果，不能把管理视图当作角色知识。

数据默认保存于 `.local/agent/data`；备份与停机迁移见 [恢复说明](RECOVERY.md)。
