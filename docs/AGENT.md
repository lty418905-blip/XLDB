# Agent 直接接口

## 初始伴侣预设

安装包内置六份中文 JSON。每份包含从出生到相遇前的人生时间线、当前生活、性格、表达习惯及三项可补充的生活细节；“姐系／妹系／哥系／弟系”表示人物风格，内置模板不设定血缘关系。

| 风格 | 人物 | 相遇时年龄 | `presets/companion/` 中的文件 |
| --- | --- | --- | --- |
| 温柔姐系 | 沈知微 | 32 | `gentle-older-sister-shen-zhiwei.json` |
| 傲娇妹系 | 唐映禾 | 24 | `tsundere-younger-sister-tang-yinghe.json` |
| 元气少女 | 夏明橙 | 23 | `energetic-young-woman-xia-mingcheng.json` |
| 霸气总裁 | 程砚舟 | 34 | `decisive-executive-cheng-yanzhou.json` |
| 冷峻哥哥 | 顾沉 | 31 | `reserved-older-brother-gu-chen.json` |
| 黏人弟系 | 陆听澜 | 25 | `affectionate-younger-brother-lu-tinglan.json` |

选定角色后，Agent 将 JSON 内容作为 `document` 传给 `previewCompanionPreset`，再以预览的版本、`previewId` 和唯一 `operationId` 调用 `importCompanionPreset`。仅支持尚未配置角色或接受经历的新 scope，不能覆盖已有伴侣。`companionPreset` 查看持久化状态；`initializeCompanionPreset` 显式初始化，首次 `turn`／`recall` 也会自动完成初始化后再继续。

`completion.mode: bounded_details_once` 只允许新原生子代理填写 `completion.slots` 指定的生活细节，成功后与角色资料一起保存；重启复用该结果。失败保留待初始化状态，可在原因排除后重试。`completion.mode: preserve` 原样保存用户背景，不调用模型补写。这里的“补全”不会擅自添加与用户的共同经历、感情承诺或经济关系。

支持用户自行导入同格式 JSON。身份年龄允许未知，既有亲属关系、故人资料与共同经历均可作为用户提供的初始背景；`lifeBeforeMeeting` 可省略，资料可放在 `background`。背景与模型创作细节分段标明来源，不写入已接受聊天历史、可执行债务、承诺或真实用户画像。模拟角色不代表故人本人，也不提供对其真实意愿或未提供经历的认证。

收到交付 ZIP 的 Agent 应先读取根目录 `INSTALL_AGENT.md`，解压到独立安装目录后运行 `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File tools/setup.ps1 -Mode Agent`（仅当前安装进程，不改机器策略）。脚本自动补齐本地运行时并实际检查CLI；无需酒馆、HTTP服务或模型API密钥。安装后遵循 `.agents/skills/xldb-agent/SKILL.md` 派发后台推理。若安装使用便携Node，应采用安装回执中的可执行文件路径，不能假设系统PATH已修改。安装检查不等于宿主原生子代理能力已通过；宿主不支持该能力时须明确报告。

## 虚拟角色生理状态

`physiologyStatus(scope, readerId)` 查看指定读取者可知状态；`configurePhysiology(scope, config, expectedRevision)` 配置跟踪角色、需求和总开关；`correctPhysiology(scope, correction, expectedRevision)` 与 `clearPhysiologyCorrection(scope, characterId, id, expectedRevision)` 纠正和撤销。CLI 的 `operation` 使用相同名称和字段，`readerId` 默认 `player`。

配置字段为 `enabled`、`dailyNeeds`（`hydration/nutrition/bladder/bowel/sleep/energy`）、`sustainedEffects`、`reproductive`、`sexualArousal`、`trackedCharacterIds`。Agent 只运行伴侣模式，后两项固定关闭。模块默认关闭，跟踪对象仅为虚拟角色；已启用的 `physiology` 推理由宿主独立子代理执行。召回包包含该角色自己的可知归一化状态，正文未接受不产生新身体经历。

工作台、进度、跨进程迁入预览与恢复版本参数见[资料管理说明](SPDB_FEATURES.md)。

Agent 模式无需 SillyTavern，也无需启动 `src/server.ts`。`src/agent/runtime.ts` 复用相同的 SQLite 权威、角色视角、记忆、情绪和来源失效规则。文本推理由宿主的独立子代理完成；可显式配置独立嵌入/重排服务，不自动读取酒馆 API 密钥。

## TypeScript 宿主

Agent 只提供伴侣模式。`interaction(scope)` 返回当前模式绑定与 revision；`clock(scope)` 返回当前系统UTC毫秒及显示时区。`setTimeZone(scope, 'Asia/Shanghai', expectedRevision)` 保存时区，传 `null` 跟随系统。CLI 对应 `interaction`、`clock`、`timeZone` 操作。首次打开旧剧情范围时，原剧情数据保留在原范围，伴侣使用独立绑定，不复制旧经历。

```ts
import {AgentRuntime} from './src/agent/runtime.ts';
const runtime = new AgentRuntime({
  databasePath: 'D:/XLDB/.local/agent/data/authority.sqlite',
  indexPath: 'D:/XLDB/.local/agent/data/indexes',
  delegate: async task => host.runFreshSubagent(task),
});
```

`host.runFreshSubagent` 是宿主实现的接口占位符，不能直接运行。`delegate` 接收 `id`、`stage`、`kind`、`messages`、`responseFormat`、`isolation: fresh-context`，返回模型原始字符串。宿主必须每项任务创建独立上下文；不能把调用方完整历史、其它角色任务或原始世界记录加入子代理输入。后台任务仅提出候选，最终由本地脚本校验和事务写入。

`configure(scope, roster)` 保存名单；`sync(scope, messages, {expectedVersion, operationId})` 对当前完整已接受来源列表做编辑/删除同步；`recall(scope, characterId, query)` 返回该角色有权访问的上下文；`prepare(scope, envelope, input, userSubmission?)` 先接受并完整处理用户正文，再返回候选 ID、正文和 userMessageId；`accept(scope, draftId)` 接受候选并等待后台处理完成；`acceptBackground(scope, draftId)` 在确认候选并同步持久接受后立即返回，再由 `waitForBackground(scope)` 观察记忆、情绪和偏好处理完成或失败；`reject` 丢弃未接受候选；`setAccess` 调整角色记忆粒度；`editSource(scope, messageId, text)` 纠正来源，text 为 null 时删除；`retry(scope)` 重试未完成的已接受来源；`close` 关闭存储。候选仅在当前实例内有效，重启后须重新生成。`sync` 的列表是替换语义，不能把单条增量当作完整列表。

需要缩短交互等待时，宿主可以先展示 `prepare` 返回的 `answer`，在用户明确接受后调用 `acceptBackground`。用户正文已由 prepare 同步处理；该方法只有在助手正文也以确切版本写入 SQLite 权威后才返回 `{status:"accepted", processing:"pending"}`；这不表示后台分析已经完成。随后必须等待 `waitForBackground` 返回 `ready`，才能调用 `recall` 或开始依赖新记忆的下一轮。返回 `failed` 时原文仍保持已接受，修正宿主子代理后调用 `retry`。后台任务未完成时 `close` 会抛出 `agent_background_pending`，宿主应先等待；不能用关闭运行时来取消已经持久接受的来源。

`acceptBackground` 是长驻 SDK 宿主的可选低等待入口。文件 CLI 仍使用 `await runtime.accept(...)`，短进程会等后台任务完成后才写结果并退出，不会把仅已持久接受但尚未处理的状态报告成完成。

角色设定或情绪参数变化会使受影响的旧分析待重算；`configure` 返回 `needsProcessing:true` 时调用 `retry` 或完整 `sync`，成功后再召回。酒馆保存名单后已有同步步骤。早期来源被纠正或删除时，后续依赖其事前情感的分析也重新计算；已生成正文的显式依赖仍进入 needs_review，不自动改写用户已接受的正文。

每个角色使用持久化 OpenHer 神经学习。接受事务保存权重、递归状态、驱力与完整随机状态；召回只读，未接受助手候选不训练；prepare 提交的用户正文会训练。`recall.emotion` 是当前数值摘要及学习计数，不输出完整权重或随机轨迹。`roster.characters[].emotion` 另支持 `hebbianLearningRate`、`phaseThreshold`、`temperatureCoefficient`、`temperatureFloor` 与 `randomizedBaseline`，默认与范围见 OpenHer 说明。旧库升级从已记录有效候选初始化新神经状态，不声称恢复过去未执行的训练。

前台调用只读取 `recall` 或 `prepare` 的筛选结果，不直接读数据库或后台任务文件。`recall` 的 `query` 应是发给该角色的问题，世界叙述应通过 `prepare` 的场景预处理。`prepare` 在用户处理失败时返回 status:failed、phase:user-sync 和固定错误码，不调用前台；不返回其它角色的观察片段。

默认检索使用 ICU 中文分词与本地 LanceDB BM25。SDK 可传 `retrieval: {reranker: {baseUrl, key, model}}` 启用重排，也可另传 `embedding` 开启混合检索。当前固定中文场景中 BM25 加 BGE 重排同时通过质量与延迟门槛；没有配置则保持本地模式，不隐式调用供应商。具体比较及限制见 `docs/RETRIEVAL.md`。

`recall` 同时返回 `facts`、`episodes` 和 `legacy` 数组：事实记录与主观情景分开，旧数据不会被无依据重新分类；`memories` 保留为兼容的合并视图。情景含当时场景、人物、感官线索、评价与显式/推断感受依据。模糊层级不会带出完整嵌套情景。数字计算排除情景感受，只依据可访问事实与本轮输入。所有后台推理仍由宿主子代理执行，检索服务仅接收当前角色可访问的查询与记忆文本。

## Codex 本地技能与 CLI

### 同步版本与用户控制（2026-09-20 协议更新）

SDK 的完整同步现在使用 `sync(scope, messages, {expectedVersion, operationId})`；CLI 的 `sync` 请求在顶层提供这两个字段。`syncState(scope)`／CLI `syncState` 返回当前版本与来源修订。基准必须对应已经读取并核对的正文；同步成功后保存返回的 `version` 和 `bindings`，下一次编辑携带权威revision。同一逻辑操作结果不明时，使用原正文、原基准、原operationId重试。遇到 `context_changed_retry` 先核对冲突，不能只获取新版本来重发旧完整列表。

对 `needs_review` 正文，用户核对后可调用 `reconfirmSource(scope, sourceId, {expectedVersion, operationId})`，CLI 使用 `reconfirm`。它按当前有效父来源重新确认；父来源已删除时应编辑或删除相关正文，不能自动确认。后代正文仍需分别核对。

SDK `setPreference(scope, characterId, id, enabled, text?)`／CLI `preference` 可停用或改正所选角色持有的偏好，参数为 `characterId/id/enabled/text`。控制随来源身份保存，重新提取、修订、重排、重启和分支恢复不自动解除它；省略text保留已有纠正。

完成的宿主作业只保留无正文的done回执，request/result正文会清理。有回执的迟到文件在下次任务扫描时清理；未完成的未知文件仍保留。数据库、请求入口文件和最终召回结果可能含私密内容，不包含在产品包中。

项目技能位于 `.agents/skills/xldb-agent/SKILL.md`。可在支持项目技能的 Codex 中使用 `$xldb-agent`，或让当前 Agent 读取该文件并执行其宿主流程。只安装在项目目录；不注册系统服务或全局插件。

请求例：

```json
{
  "operation": "turn",
  "scope": {"worldId":"demo","sessionId":"chat","branchId":"main","characterId":"card"},
  "envelope": {"targetId":"alice","mode":"direct","presentIds":["alice"]},
  "input": "你还记得我们的约定吗？",
  "accept": false
}
```

运行 `node adapters/agent/cli.mjs run REQUEST_JSON`。CLI 返回运行目录，并等待宿主执行任务；仅在终端运行此命令不会自动创造子代理，必须由上述技能或宿主 `delegate` 实现驱动。`jobs RUN_DIRECTORY` 只输出待处理任务的路径和阶段，不输出原文。完成后读取该目录 `result.json`。

操作包括 `configure`（`roster`）、`sync`（完整 `messages`）、`recall`（`characterId/query`）、`turn`（`envelope/input/accept`）、`access`（`characterId/memoryId/access`）、`edit`（`messageId/text`）、`delete`（`messageId`）、`retry`（当前范围的失败来源）。`turn` 会先保存并处理用户正文；`accept:false` 只丢弃助手候选，`true` 接受最终回复。可在 userSubmission 提供稳定 userMessageId、operationId、expectedVersion、acceptedAtMs；同一用户事件重试保留这些值。后台候选、分析和日志不变成正文。`dataDirectory` 可指定工作区 `.local/` 内独立目录，默认 `.local/agent/data`。

CLI 请求可增加 `retrievalConfigPath: "D:/XLDB-private/agent-retrieval.json"`。该私有 JSON 可独立配置 `embedding`、`reranker` 或同时配置两项，格式同 SDK；路径由用户显式指定，每次运行读取。密钥保存在该私有文件，不能写进请求、任务文件或源码。不要把完整酒馆推理配置当作 Agent 配置；CLI 只采用这两个检索字段，文本推理不变。

### 检索配置引导

安装成功后，宿主 Agent 主动引导一次；已有配置或用户明确跳过时复用选择。没有已知选择的首次使用也执行此引导。

1. 说明当前默认使用本地 LanceDB BM25。embedding 增加语义向量检索；reranker 对候选重新排序。两者独立，支持仅 embedding、仅 reranker、两者都用或均跳过。询问用户的选择；跳过后继续本地模式，不阻塞安装和使用。
2. 对用户选择的服务，获取 API 地址、模型名和认证方式；推荐用户直接在本地私有文件填写密钥，或使用宿主安全凭据输入，不要求把密钥粘贴到聊天。请求可能把查询及当前允许访问的记忆文本发送到所选服务，并产生费用；先让用户明确该服务可用于这项用途，不能从机器上其他凭据推定授权。
3. 在安装根相邻的私有目录保存 UTF-8 JSON，例如 `D:/XLDB-private/agent-retrieval.json`。下方模板全部空白即禁用；启用某项至少填写其 `baseUrl` 和 `model`，无需认证的本地服务可保留空 `key`。使用兼容 embeddings 或 rerank 协议的端点，不能用普通聊天模型地址代替。已有文件仅修改用户选择的字段，不覆盖其它有效设置。
4. 在宿主现有偏好/配置中记录选择和绝对路径，不记录密钥。后续 CLI 请求显式加入 `retrievalConfigPath`；SDK 构造 `AgentRuntime` 时经 `options.retrieval` 传入。仅创建文件不会自动启用服务，宿主子代理不会代替 embedding/reranker API。
5. 用户授权后，用隔离的非敏感样例和非空召回查询检查实际模式及返回结果。分别报告“已保存”“已实际调用通过”或失败/降级；空库、空查询、安装检查或接口HTTP成功不足以证明向量检索质量。发生 `bm25-fallback` / `hybrid-fallback` 时如实报告，不把降级当原模式通过。未授权调用时只报告已配置、未测试。

```json
{
  "embedding": { "baseUrl": "", "key": "", "model": "" },
  "reranker": { "baseUrl": "", "key": "", "model": "" }
}
```

预期模式：均不配置为 `bm25`；仅 embedding 为 `hybrid`；仅 reranker 为 `bm25+rerank`；两者均配置为 `hybrid+rerank`。API 根路径或完整 `/embeddings`、`/rerank` 地址均可，字段及降级约束见 [检索说明](RETRIEVAL.md)。

### 后台任务与取消

后台任务默认有界等待；失败不改成模型成功。已接受来源的分析失败会保留原文、阻止生成，修正原因后调用 `runtime.retry(scope)` 或 CLI `operation: retry`，直接重新处理已持久化来源，无须向前台导出世界原文。结果保留 `host_timeout`、`host_closed`、`host_worker_failed`、`host_invalid_result` 等固定错误码。

取消等待中的 CLI 运行，使用 `node adapters/agent/cli.mjs cancel RUN_DIRECTORY`；宿主停止派发该目录的任务，CLI 记录 cancelled，迟到结果不能提交。SIGINT/SIGTERM 也会尝试关闭等待。取消不会撤销此前已完成的事务；系统强制杀进程无法执行清理，应明确终止旧运行后用 retry 恢复。保留 `.local/agent/data` 下数据库即可恢复；索引可重新生成，运行队列不是状态权威。不要把 `.local/agent` 打包或分享，其中可能有私密世界原文。

## 世界状态与生命周期

`configureWorld(scope, settings)` 配置伴侣世界与初始账本；CLI 使用 `operation: "configureWorld"` 和 `settings`。设为 `null` 可停用。设置含 `mode`（只能为 `companion`，`story` 被拒绝）、`startTimeMs`、`actorLabels`（NPC ID 到姓名/别名数组）、`playerName`、`publicTime`、`balances` 和 `inventory`。余额项为 `{ownerId, unit, value:"100.00", readerIds:[...]}`，库存项为 `{ownerId, item, count:3, readerIds:[...]}`；玩家 ID 为 `player`，未指定读者默认仅玩家。配置须与已有角色名单一致。

正文同步后 `world` 阶段与其它分析一样由宿主独立子代理执行；只提取候选，核心校验并确定性计算。`recall` 只返回该角色可知的时钟、余额、库存和事件，不能给角色直接读管理接口。当前支持明确阿拉伯数字购买、消耗、时间线索，以及关联已接受购买的部分退款。退款候选只能以原购买的 `sourceId`、`revision`、`effectId` 及本轮阿拉伯数字退回量表示；核心按原单价处理，拒绝超出原购买剩余量、库存不足或无共同观察权限的候选。不支持自由填写退款金额、换汇或中文数字转换。

SDK 提供 `checkpoint(scope, reason)`、`checkpoints(scope)`、`restore(scope, checkpointId)`、`undo(scope)`、`fork(scope, branchId, checkpointId?)`。CLI 同名操作接收对应 `reason`、`checkpointId`、`branchId` 字段。分支返回新 scope，后续请求必须明确使用它。恢复/撤销会使未接受候选及旧后台结果失效；已有后台任务须结束后再关闭运行时。

`restore`、`undo` 返回Promise，SDK调用须 `await`。返回 `cleanupPending:true` 时，正文与权威状态已经恢复，只剩检索清理待重试；不要再次调用undo来重试清理。调用 `clearPendingIndexes()` 或 `retry(scope)` 继续，CLI启动也会先恢复未完成的清理。检索前必须完成清理，不会带着旧索引继续生成。

`regenerate(scope)` 为最后一条已接受助手正文生成替代候选，生成时使用旧回复之前的状态。`accept` 接受后替换原回复修订，`reject` 保持原回复与状态。CLI 的 `operation: "regenerate"` 必须明确 `accept: true/false`，与 `turn` 相同。不要把预览当作已接受历史。

一致数据库备份、停机恢复和初始化中断限制见 [恢复说明](RECOVERY.md)。

## 承诺、画像与主动陪伴

`commitments(scope, query?)` 查询独立承诺；有期限的提醒依据现实时间，无限期一般约束进入适用角色每轮系统输入。未知期限不会变成永久。正文中的履行、取消和修订在本轮处理事务中生效。

后台 `confirm` 操作以 `targetId` 引用既有提议，仅携带本轮逐字确认及说话人证据。脚本保留原条款、范围与期限，累计必要参与者同意后才建立约定；不要求确认句复述旧条款。

`bindSubject(scope, subjectId)` 将伴侣范围绑定到明确的真实用户；不按昵称自动合并身份。`profile(scope)` 查看条目和控制；`setProfileControls(scope, patch, expectedRevision)` 分别开关画像学习、策略应用、主动陪伴及定时唤醒，并限定允许的分类。默认关闭。`correctProfile` 与 `deleteProfile` 可纠正或删除条目。角色扮演及引述不会自动形成真实用户画像。

`setContactSettings(scope, settings, expectedRevision)` 配置 IANA 时区、星期和可联系时间窗、最小间隔与未回复次数上限；`setBusyUntil` 保存忙碌截止时间。`pollCompanion(scope, characterId, trigger)` 只产生待发送候选；`dispatchCompanion(scope, characterId, deliver)` 调用宿主投递回调一次，并用宿主消息 ID 确认接受。消息必须以 assistant 身份写入，不能伪造用户事件。`watchCompanion` 是长驻宿主定时检查入口，返回停止函数；关闭宿主后不会自行在系统后台运行。

投递结果 `unknown` 会停止盲目重试。宿主核对现有消息后调用 `reconcileCompanion(scope, characterId, deliveryId, outcome)`：确认已发送使用 `{status:'sent',hostMessageId}`，只将现有消息作为接受来源学习；确认未发送使用 `{status:'failed',code:'confirmed_absent'}`，释放后续机会，旧消息不会重发。CLI 同名操作支持以上字段。不能以网络超时作为“确认未发送”的证据。

## 验收范围

SDK/队列组件测试、原生宿主子代理测试和长期体验分别报告。真实 Codex 结果见工作区 `PROJECT_STATUS.md` 所引用的运行目录；接口代码与此说明本身不代表任何宿主已验收。
