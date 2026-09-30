# Agent 直接介面

## 伴侶個人學習與表達

同時開啟 `profileLearningEnabled` 和 `personalizationEnabled` 後, 正常聊天只收集明確聯絡反饋, 重複關係行為證據及評分糾正. 執行時連續空閒10分鐘後, 由獨立執行器採集訓練特徵並更新個人評分頭; 新活動會取消未完成訓練並重新計時. 無需額外訓練命令, 但執行時必須保持執行; 重啟後重新等待10分鐘, 持久佇列仍在. 這只對長駐的 SDK 宿主成立: 檔案 CLI 的短程序從不空閒到10分鐘, 常駐 daemon(見「常駐 daemon」)在 D1 以 `idleLearning:false` 開啟執行時, 暫不執行空閒學習, D2 起才在 daemon 內真實計時. 參數按使用者, 角色, 世界, 會話, 分支和模型隔離; 關閉學習或修訂/刪除來源會使相應學習失效.`AgentRuntime.personalLearningStatus(scope, characterId)` 可讀取樣本數, 活躍頭版本, 損失及 `idle` 狀態, 當前為 SDK 方法.

關係評分只調整話術傾向; 有效低使用者親密或低依賴可加入避免索取及排他的負面提示, 未知不算低分. 普通正文不主動自述 AI 身份; 被直接詢問時簡短如實回答. 核心會檢查其生成及接受入口的正文, 宿主僅呼叫 recall 後自行生成的輸出無法強制過濾.

當前訓練只更新凍結模型之上的個人末層增量, 合成測試已驗證參數變化, 未證明長期判斷質量提升. 編輯舊反饋會清除相關捕獲, 後續新聯絡重新積累; 正反饋不保證增加聯絡次數.

## 初始伴侶預設

正式啟用新伴侶前, 宿主把目標 `scope` 寫入請求檔案, 然後執行 `node companion-agent/adapters/cli.mjs onboard REQUEST_JSON`, 保持程序執行. 使用者在本地彈窗中選擇預設或上傳自訂 JSON, 檢視資料並確認. 宿主讀取最終 `selected` 結果中的角色 ID, 再通過原有作業迴圈初始化;`cancelled` 停止啟用,`existing` 沿用已儲存角色. 自動開啟瀏覽器失敗時, 使用命令輸出的本地 URL. 同一資料目錄的常駐 daemon 存活時, `onboard` 本身不開庫: 它讀取現有預設, 每次預覽與最終匯入都作為 daemon run(`origin:"onboard"`, 各有 run 目錄, `executor:"daemon"`)執行, 瀏覽器頁仍由 `onboard` 程序提供; daemon 不存活時在本程序內開庫, 規則同 `run`(見「常駐 daemon」). 路由逐次決定: 會話中途 daemon 停止或消失後, 下一次呼叫(或它從未認領的那一次)改在本程序內開庫執行; daemon 在匯入執行中消失時該次確認報錯, 頁面提示重新預覽. 匯入進行中逾時或宿主關閉(SIGINT)會等匯入結束: 已提交則結果為 `selected`, 失敗才是 `cancelled`. 程序內的 `onboard` 在等待選擇期間(最長 30 分鐘)一直持有資料庫, 這期間 `daemon ensure` 會得到 `database_busy`, 所以宿主應先 `daemon ensure` 再 `onboard`. 彈窗提供 [創作指南](CHARACTER_CREATION_GUIDE.md),[Markdown 模板](CHARACTER_TEMPLATE.md) 與 JSON 模板的本地位置.

安裝包內建六份中文 JSON. 每份包含從出生到相遇前的人生時間線, 當前生活, 性格, 表達習慣及三項可補充的生活細節;"姐系/妹系/哥系/弟系"表示人物風格, 內建模板不設定血緣關係.

| 風格 | 人物 | 相遇時年齡 | `companion-agent/presets/companion/` 中的檔案 |
| --- | --- | --- | --- |
| 溫柔姐系 | 沈知微 | 32 | `gentle-older-sister-shen-zhiwei.json` |
| 傲嬌妹系 | 唐映禾 | 24 | `tsundere-younger-sister-tang-yinghe.json` |
| 元氣少女 | 夏明橙 | 23 | `energetic-young-woman-xia-mingcheng.json` |
| 霸氣總裁 | 程硯舟 | 34 | `decisive-executive-cheng-yanzhou.json` |
| 冷峻哥哥 | 顧沉 | 31 | `reserved-older-brother-gu-chen.json` |
| 黏人弟系 | 陸聽瀾 | 25 | `affectionate-younger-brother-lu-tinglan.json` |

選定角色後,Agent 將 JSON 內容作為 `document` 傳給 `previewCompanionPreset`, 再以預覽的版本,`previewId` 和唯一 `operationId` 呼叫 `importCompanionPreset`; 請求可另帶 `location`(`{status:"granted",latitude,longitude,accuracyMeters,observedAtMs}`,`{status:"denied"}` 或 `{status:"unavailable"}`)和 `subjectId`, 與引導頁確認時相同, 結果只回報位置狀態, 不回傳座標. 僅支援尚未設定角色或接受經歷的新 scope, 不能覆蓋已有伴侶.`companionPreset` 檢視持久化狀態;`initializeCompanionPreset` 顯式初始化, 首次 `turn`/`recall` 也會自動完成初始化後再繼續.

`completion.mode: bounded_details_once` 只允許新原生子代理填寫 `completion.slots` 指定的生活細節, 成功後與角色資料一起儲存; 重啟複用該結果. 失敗保留待初始化狀態, 可在原因排除後重試.`completion.mode: preserve` 原樣儲存使用者背景, 不呼叫模型補寫. 這裡的"補全"不會擅自新增與使用者的共同經歷, 感情承諾或經濟關係.

支援使用者自行匯入同格式 JSON. 身份年齡允許未知, 既有親屬關係, 故人資料與共同經歷均可作為使用者提供的初始背景;`lifeBeforeMeeting` 可省略, 資料可放在 `background`. 背景與模型創作細節分段標明來源, 不寫入已接受聊天曆史, 可執行債務, 承諾或真實使用者畫像. 模擬角色不代表故人本人, 也不提供對其真實意願或未提供經歷的認證.

收到交付 ZIP 的 Agent 應先讀取根目錄 `INSTALL_AGENT.md`, 解壓到獨立安裝目錄後執行 `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File tools/setup.ps1 -Mode Agent`(僅當前安裝程序, 不改機器策略). 腳本自動補齊本地執行時並實際檢查CLI; 無需酒館,HTTP服務或模型API金鑰, 使用者也不必設定或開放任何 HTTP 服務(`onboard` 只在本機 127.0.0.1 臨時開一個帶 token 的頁面). 安裝不註冊系統服務, 不設開機自啟; 常駐 daemon 由宿主按需啟動(`cli daemon ensure`), 隨會話結束(閒置逾時或 `cli daemon stop`)退出, 不註冊系統服務. 安裝後遵循 `.agents/skills/xldb-agent/SKILL.md` 派發後臺推理. 若安裝使用便攜Node, 應採用安裝回執中的執行檔路徑, 不能假設系統PATH已修改. 安裝檢查不等於宿主原生子代理能力已通過; 宿主不支援該能力時須明確報告.

## 地圖與本輪地點資料

Agent 伴侶直接使用與酒館跑團相同的地圖權威和讀者篩選, 但儲存在獨立伴侶作用域.`geographyStatus(scope, readerId)` 返回授權狀態, 設定和該讀者可見的地圖;`configureGeography(scope, config, {expectedRevision, operationId})` 設定 `enabled`,`showMode`(`map`/`hidden`),`followAcceptedProse`,`backgroundSeed`. 首次人設確認時的定位選擇與預設匯入在同一事務儲存; 允許後預設啟用伴侶地圖, 拒絕後地圖保持關閉, 取消不儲存座標. 可用 `setCompanionLocation(scope, location)` 顯式更改選擇. 許可權只屬於伴侶作用域, 不影響跑團. 座標不出現在狀態回執.

`previewGeographyImport(scope, document)` 返回標準化檔案,`expectedVersion` 和 `documentHash`; 確認後呼叫 `importGeography(scope, document, {expectedVersion, documentHash, operationId})`.`previewGeographyBackground(scope, input)` 需先把 `backgroundSeed` 設為 `enabled`,`input` 含 `sources`,`mapId`,`revision`,`basis`,`allowedReaders`, 返回的檔案仍須由使用者核對並通過匯入方法提交. 另可呼叫 `exportGeography(scope, readerId)`,`correctGeography(scope, correction, {expectedVersion, operationId})`,`clearGeographyCorrection(scope, id, {expectedVersion, operationId})`,`saveGeographyLayout(scope, readerId, layout, {expectedRevision, operationId})`.CLI `operation` 使用相同名稱, 欄位放在請求頂層; 背景預覽參數放在 `input`. 跟隨正文的 `geography` 提取交給宿主獨立子代理,`recall` 僅向目標角色提供已授權地理資料. 欄位, 知情範圍與 JSON 示例見 [共用地圖狀態](MAP.md).

`recall` 和伴侶 `turn` 可選傳 `placeQuery`, 必須是本次 `query` 或 `input` 中出現的地點文字. 僅本輪委派宿主獨立子代理查詢有來源 URL 的公開地點資料; 查不到時如實說明. 結果只加入本輪目標角色的前臺上下文, 不寫入地圖或歷史, 不從 IP 猜測位置. 使用者未給 `placeQuery` 時不觸發搜尋. 當前沒有內建地圖服務.

## 虛擬角色生理狀態

`physiologyStatus(scope, readerId)` 檢視指定讀取者可知狀態;`configurePhysiology(scope, config, expectedRevision)` 設定跟蹤角色, 需求和總開關;`correctPhysiology(scope, correction, expectedRevision)` 與 `clearPhysiologyCorrection(scope, characterId, id, expectedRevision)` 糾正和撤銷.CLI 的 `operation` 使用相同名稱和欄位,`readerId` 預設 `player`.

設定欄位為 `enabled`,`dailyNeeds`(`hydration/nutrition/bladder/bowel/sleep/energy`),`sustainedEffects`,`reproductive`,`sexualArousal`,`trackedCharacterIds`.Agent 伴侶按使用者設定啟用相應虛擬角色狀態, 預設關閉; 不據此推斷真實使用者身體狀況. 已啟用的 `physiology` 推理由宿主獨立子代理執行. 召回包包含該角色自己的可知歸一化狀態, 正文未接受不產生新身體經歷.

工作臺, 進度, 跨程序遷入預覽與恢復版本參數見[資料管理說明](SPDB_FEATURES.md).

Agent 模式無需 SillyTavern, 也無需啟動 `sillytavern/src/server.ts`.`companion-agent/src/agent/runtime.ts` 複用相同的 SQLite 權威, 角色視角, 記憶, 情緒和來源失效規則. 文本推理由宿主的獨立子代理完成; 可顯式設定獨立嵌入/重排服務, 不自動讀取酒館 API 金鑰.

## TypeScript 宿主

Agent 預設使用伴侶模式; 明確的跑團任務通過 `roleplayOpen` 建立獨立作用域.`interaction(scope)` 返回當前模式綁定與 revision;`clock(scope)` 返回當前系統UTC毫秒及顯示時區.`setTimeZone(scope, 'Asia/Shanghai', expectedRevision)` 儲存時區, 傳 `null` 跟隨系統.CLI 對應 `interaction`,`clock`,`timeZone` 操作. 首次開啟舊劇情範圍時, 原劇情資料保留在原範圍, 伴侶使用獨立綁定, 不復制舊經歷.

跑團導演只存在於 `roleplayOpen` 建立的跑團作用域: 伴侶作用域不規劃, 導演計畫表 `scene_director_plans` 在第一次跑團使用時才建立. 跑團的 NPC 情緒排序(超過 4 名待更新時)與日程撞期判斷使用本執行時自己的 AgentJev worker, 與關係評分共用; 每個執行時只有一個 worker, 由 `close()` 關閉, 不另啟酒館的排序器單例. 以 `relationshipProvider:false` 或自訂 provider 建立的執行時沒有本地判斷器: 即使模型已安裝, 跑團撞期也固定為確定性結果(`decline:"undecided"`, `method:"deterministic"`, `reason:"agentjev_unavailable"`), 不改走導演 LLM 複核, 情緒排序同樣退回確定性順序.

```ts
import {AgentRuntime} from './src/agent/runtime.ts';
const runtime = new AgentRuntime({
  databasePath: '<安裝根>/.local/agent/data/authority.sqlite',
  indexPath: '<安裝根>/.local/agent/data/indexes',
  delegate: async task => host.runFreshSubagent(task),
});
```

`host.runFreshSubagent` 是宿主實現的介面占位符, 不能直接執行.`delegate` 接收 `id`,`stage`,`kind`,`messages`,`responseFormat`,`isolation: fresh-context`, 返回模型原始字串. 宿主必須每項任務建立獨立上下文; 不能把呼叫方完整歷史, 其它角色任務或原始世界記錄加入子代理輸入. 後臺任務僅提出候選, 最終由本地腳本校驗和事務寫入.

Agent 伴侶把同一來源的獨立後臺提取合併為 `stage: "companionObservation"` 作業(`kind: background`,`responseFormat: json`). 使用者正文最多兩個: 作業 A 含 `absenceExplanation`,`commitment`, 開啟畫像分類時的 `profile`, 以及已啟用的 `physiology`/`geography`; 作業 B 含 `memory`,`emotion`,`preference`, 在 A 完成後派發, 因為本輪情緒讀取同一來源的返場說明. 助手正文一個作業, 含 `contactResponseExpectation`,`commitment`,`memory`,`emotion`, 以及已啟用的 `physiology`/`geography`. 加上前臺 `front`, 每輪 4 個宿主作業; 啟用 AgentJev 時生成前另有 `relationshipEvidence`, 共 5 個. 開啟畫像分類時, 接受後另有一個不阻塞的 `profileReflection`. 作業 messages 的使用者訊息是 `{"tasks":[{"part","messages"}]}`; worker 必須返回一個 JSON 物件字串, 頂層鍵與各 `part` 一一對應, 每個值遵守該 part 自身 messages 的原合同, 空候選也返回合法物件. 多名角色同時觀察同一來源時 part 帶 `:角色ID` 字尾. 合併作業的輸出上限為 part 數 × 50,000 字元, 超出報 `model_output_too_large`; 時限: 單一作業 10 分鐘, 合併觀測作業按 part 數放大(part 數 × 10 分鐘), 至多 40 分鐘, 以 request 檔的 `timeoutMs` 為準; 時限從作業建立時刻起算, `timeoutMs` 只供宿主參考, 宿主或 worker 改寫它不影響期限, `jobs` 列出的中繼資料同樣帶 `timeoutMs`. 各 part 由原解碼器獨立校驗和快取; 單個 part 缺失或無效只令該 part 失敗, 其它 part 保留結果, `retry` 只重派失敗部分, 只剩一個 part 時以該階段名單獨派發. 整個回應不是合法 JSON 物件, 超長, 逾時或宿主失敗時, 本批全部 part 一起失敗, `retry` 仍合併派發. 酒館跑團不使用此作業.

`configure(scope, roster)` 儲存名單;`sync(scope, messages, {expectedVersion, operationId})` 對當前完整已接受來源列表做編輯/刪除同步;`recall(scope, characterId, query)` 返回該角色有權訪問的上下文;`prepare(scope, envelope, input, userSubmission?)` 先接受並完整處理使用者正文, 再返回候選 ID, 正文和 userMessageId;`accept(scope, draftId)` 接受候選並等待記憶, 情緒, 偏好與承諾處理完成, 返回 `status` 與 `processing`(處理未完成時為 `committed` + `pending`, 見「接受階段部分失敗」), 畫像反思另行在後臺繼續;`acceptBackground(scope, draftId)` 在確認候選並同步持久接受後立即返回, 再由 `waitForBackground(scope)` 觀察記憶, 情緒和偏好處理完成或失敗;`reject` 丟棄未接受候選;`setAccess` 調整角色記憶粒度;`editSource(scope, messageId, text)` 糾正來源,text 為 null 時刪除;`retry(scope)` 重試未完成的已接受來源;`close` 關閉儲存. 候選僅在當前例項內有效, 重啟後須重新生成; 候選(含已接受者, 供重複 `accept` 返回 `duplicate`)在生成 30 分鐘後到期, 與場景草稿同壽, 到期後 `accept` 報 `invalid_scene_draft`; 每個例項最多保留 100 份, 超出時先淘汰最舊者.`sync` 的列表是替換語義, 不能把單條增量當作完整列表.

需要縮短互動等待時, 宿主可以先展示 `prepare` 返回的 `answer`, 在使用者明確接受後呼叫 `acceptBackground`. 使用者正文已由 prepare 同步處理; 該方法只有在助手正文也以確切版本寫入 SQLite 權威後才返回 `{status:"accepted", processing:"pending"}`; 這不表示後臺分析已經完成. 隨後必須等待 `waitForBackground` 返回 `ready`, 才能呼叫 `recall` 或開始依賴新記憶的下一輪. 返回 `failed` 時原文仍保持已接受, 修正宿主子代理後呼叫 `retry`. 後臺任務未完成時 `close` 會丟擲 `agent_background_pending`, 宿主應先等待; 不能用關閉執行時來取消已經持久接受的來源.

`acceptBackground` 是長駐 SDK 宿主的可選低等待入口. 檔案 CLI 不論在本程序內執行還是經常駐 daemon 執行, 每個 run 仍使用 `await runtime.accept(...)`, 並等本 run 發起的後臺作業完成後才寫結果, 不會把僅已持久接受但尚未處理的狀態報告成完成.

### 接受階段部分失敗

伴侶 `accept` 的回執用 `status` 與 `processing` 兩個欄位區分「訊息是否入庫」與「分析是否完成」:

| 回執 | 含義 | 宿主動作 |
|---|---|---|
| `status:"committed"`, `processing:"ready"` | 使用者與助手正文均已入庫, 分析完成 | 正常展示, 可開始下一輪 |
| `status:"committed"`, `processing:"pending"`, `pendingReason`, `retryable:true` | 兩條正文均已入庫; 某個分析 part(例如助手正文的 `emotion` 被判 `invalid_emotion_delta`)未完成, 原因為固定錯誤碼 `pendingReason` | 助手回覆已屬於歷史, 照常展示, 不要重發或重新生成; 下一輪 `prepare`/`turn` 會先重跑待處理 part, 或立即送 `operation: retry` |
| `status:"failed"` | 回覆沒有全部以確切版本入庫 | 不把該回覆當作已接受歷史 |

CLI `turn`/`regenerate` 在 `accept:true` 時把 committed/duplicate 回執報告為 `status:"accepted"`, 並附 `processing` 與 `receipt`; `processing:"pending"` 時另帶 `pendingReason` 與 `retryable:true`, 執行清單為 `completed`. 已成功的 part 由處理快取保留, 重試只重新派發失敗的 part. 待處理來源仍阻止 `recall` 與依賴新記憶的生成(`invalid_scene_processing`).

下一輪 `prepare`(CLI `turn`)在寫入新使用者正文前先處理未完成的已接受來源. 成功時照常繼續, 呼叫方以讀取時的版本為 `expectedVersion` 即可, 這次處理提交不算衝突. 仍失敗時返回 `status:"failed"`,`phase:"pending-sync"`,`userAccepted:false`,`retryable:true` 和固定錯誤碼: 新使用者正文沒有入庫. 修正宿主 worker 後直接用同一 `userSubmission`(含原 `expectedVersion`)重送, `prepare` 會先完成待處理部分再寫入. 若已先呼叫 `retry`, 那次處理是獨立寫入, 舊 `expectedVersion` 會得到 `context_changed_retry`; 必須重新讀取版本(`syncState`), 用新的 `expectedVersion` 重送. `prepare` 的其它失敗(`user-sync`,`generation-input`,`generation-output`,`assistant-plan`)帶 `userAccepted:true`, 表示使用者正文已入庫; `user-sync` 另帶 `retryable:true`. 「先處理再寫入」只適用於接受階段遺留: 未完成的來源必須全部是最後一次被接受的助手回覆. `user-sync` 遺留的是使用者正文本身, 它還沒有回覆; 此時改送另一條新正文會被 `invalid_scene_processing` 擋下(新正文不入庫), 以免舊正文被靜默處理而永遠沒有回覆. 宿主必須用同一 `userSubmission`(同一 `userMessageId` 與正文)重送, `prepare` 會重跑該正文的分析並繼續生成回覆; 或先呼叫 `retry` 再重送同一正文. 既有 `retry` 操作保留, 任何時候都可用來單獨恢復已接受來源.

### 回覆路徑的宿主輸出降級

回覆前的個性化充實只在宿主輸出未通過本地校驗時降級; 回覆本身不因此中斷. 「宿主輸出無效」僅指 `hostOutputInvalid` 白名單內, 解碼宿主或本地模型輸出時丟出的固定錯誤碼: `invalid_profile_strategy`,`invalid_profile_strategy_reference`,`invalid_profile_output`,`invalid_profile_json`,`invalid_profile_theme`,`profile_evidence_not_in_source`,`invalid_relationship_evidence`(及 `_role`,`_ref`,`_receipt`),`invalid_relationship_support`,`invalid_relationship_retraction`,`invalid_relationship_assessment`,`invalid_relationship_selection`,`relationship_evidence_invalid_response`,`relationship_evidence_input_incomplete`(關係證據輸入超過長度上限, 屬確定性的歷史增長, 降級並在診斷中保留此碼),`model_invalid_json`,`model_invalid_response`,`model_output_truncated`,`model_output_too_large`. 串流結束卻沒有 `finish_reason` 的 `model_output_incomplete` 屬傳輸基礎設施, 不在白名單內, 照常傳播. 同前綴的設定, 輸入或內部錯誤(例如 `invalid_relationship_clock`,`invalid_relationship_input`,`invalid_relationship_diagnostics`,`invalid_relationship_fold`,`invalid_profile_controls`)不算宿主輸出. `context_changed_retry`,`host_*`,`agent*`(含 AgentJev),模型連線/設定錯誤等基礎設施或版本錯誤照常傳播.

- 溝通策略(`strategy` 作業)無效時, 以同一作業重試一次; 仍無效則本輪不帶個性化建議繼續生成回覆.
- 關係證據(`relationshipEvidence`)無效時不重試, 只改用權威儲存中對應當前來源的評估(`relationshipAssessments.read`), 沒有時不帶關係參考繼續. 不使用程序內快取: 來源被刪除或改寫後, 舊評估的引文不會回到回覆.
- 每次降級或重試都寫入 `prepare` 結果(CLI `turn` 結果)及 `recall` 結果的 `diagnostics` 陣列, 元素為 `{stage:"strategy"|"relationship"|"profile",code,attempts,outcome}`; `outcome` 為 `recovered`(重試成功),`omitted`(本輪不使用),`cached`(使用當前來源的已儲存評估),`reextracted`(權威庫中已儲存的關係證據提取無法解碼, 視為不可重用並重新提取; 本輪個性化照常, 不算降級) 或 `dropped_counter`(僅 `stage:"profile"`: 本輪畫像提取的 counter 候選被丟棄, `code` 為 `profile_counter_target_missing` 或 `profile_counter_user_corrected`, 見下方畫像段; 不影響回覆). `profile` 診斷只出現在該使用者正文所屬的 `prepare` 結果(CLI `turn` 結果)中, `recall` 結果不含. 無降級時為空陣列. 宿主應記錄這些診斷, 不能把降級回覆報告成個性化成功. 已儲存的 extraction 解碼失敗時, 所有呼叫方(含主動聯絡路徑與顯式 `relationshipAssessment`)都改為視為不可重用並重新提取, 不再丟錯; 新的宿主輸出無效時的行為不變.
- 主動聯絡路徑與顯式 `relationshipAssessment` 操作維持原行為, 宿主輸出無效時仍報錯.

角色設定或情緒參數變化會使受影響的舊分析待重算;`configure` 返回 `needsProcessing:true` 時呼叫 `retry` 或完整 `sync`, 成功後再召回. 酒館儲存名單後已有同步步驟. 早期來源被糾正或刪除時, 後續依賴其事前情感的分析也重新計算; 已生成正文的顯式依賴仍進入 needs_review, 不自動改寫使用者已接受的正文.

每個角色使用持久化 OpenHer 神經學習. 接受事務儲存權重, 遞迴狀態, 驅力與完整隨機狀態; 召回只讀, 未接受助手候選不訓練;prepare 提交的使用者正文會訓練.`recall.emotion` 是當前數值摘要及學習計數, 不輸出完整權重或隨機軌跡.`roster.characters[].emotion` 另支援 `hebbianLearningRate`,`phaseThreshold`,`temperatureCoefficient`,`temperatureFloor` 與 `randomizedBaseline`, 預設與範圍見 OpenHer 說明. 舊庫升級從已記錄有效候選初始化新神經狀態, 不聲稱恢復過去未執行的訓練.

前臺呼叫只讀取 `recall` 或 `prepare` 的篩選結果, 不直接讀資料庫或後臺任務檔案.`recall` 的 `query` 應是發給該角色的問題, 世界敘述應通過 `prepare` 的場景預處理.`prepare` 在使用者處理失敗時返回 status:failed,phase:user-sync 和固定錯誤碼, 不呼叫前臺; 先前已接受來源仍無法完成時返回 phase:pending-sync(新正文未入庫, 見上方「接受階段部分失敗」); 不返回其它角色的觀察片段.

預設檢索使用 ICU 中文分詞與本地 LanceDB BM25.SDK 可傳 `retrieval: {reranker: {baseUrl, key, model}}` 啟用重排, 也可另傳 `embedding` 開啟混合檢索. 當前固定中文場景中 BM25 加 BGE 重排同時通過質量與延遲門檻; 沒有設定則保持本地模式, 不隱式呼叫供應商. 具體比較及限制見 `shared/docs/RETRIEVAL.md`.

`recall` 同時返回 `facts`,`episodes` 和 `legacy` 陣列: 事實記錄與主觀情景分開, 舊資料不會被無依據重新分類;`memories` 保留為相容的合併檢視. 情景含當時場景, 人物, 感官線索, 評價與顯式/推斷感受依據. 模糊層級不會帶出完整巢狀情景. 數字計算排除情景感受, 只依據可訪問事實與本輪輸入. 所有後臺推理仍由宿主子代理執行, 檢索服務僅接收當前角色可訪問的查詢與記憶文本.

## 本地技能與 CLI

### 同步版本與使用者控制(2026-09-20 協議更新)

SDK 的完整同步現在使用 `sync(scope, messages, {expectedVersion, operationId})`;CLI 的 `sync` 請求在頂層提供這兩個欄位.`syncState(scope)`/CLI `syncState` 返回當前版本與來源修訂. 基準必須對應已經讀取並核對的正文; 同步成功後儲存返回的 `version` 和 `bindings`, 下一次編輯攜帶權威revision. 同一邏輯操作結果不明時, 使用原正文, 原基準, 原operationId重試. 遇到 `context_changed_retry` 先核對衝突, 不能只獲取新版本來重發舊完整列表.

對 `needs_review` 正文, 使用者核對後可呼叫 `reconfirmSource(scope, sourceId, {expectedVersion, operationId})`,CLI 使用 `reconfirm`. 它按當前有效父來源重新確認; 父來源已刪除時應編輯或刪除相關正文, 不能自動確認. 後代正文仍需分別核對.

SDK `setPreference(scope, characterId, id, enabled, text?)`/CLI `preference` 可停用或改正所選角色持有的偏好, 參數為 `characterId/id/enabled/text`. 控制隨來源身份儲存, 重新提取, 修訂, 重排, 重啟和分支恢復不自動解除它; 省略text保留已有糾正.

完成的宿主作業只保留無正文的done回執,request/result正文會清理. 有回執的遲到檔案在下次任務掃描時清理; 未完成的未知檔案仍保留. 資料庫, 請求入口檔案和最終召回結果可能含私密內容, 不包含在產品包中.

專案技能位於 `.agents/skills/xldb-agent/SKILL.md`, 採通用技能格式, 與宿主無關: 支援專案技能的宿主可直接載入, 其它宿主讓當前 Agent 讀取該檔案並執行其宿主流程. 宿主只需三種能力: 執行命令, 派發 fresh-context 子代理, 讀寫檔案; 不假定某一家 harness. 只安裝在專案目錄; 不註冊系統服務或全域外掛. 常駐 daemon 也不例外: 它由宿主在會話開始時 `daemon ensure` 按需啟動, 會話結束時 `daemon stop` 或閒置逾時退出(見「常駐 daemon」).

請求例:

```json
{
  "operation": "turn",
  "scope": {"worldId":"demo","sessionId":"chat","branchId":"main","characterId":"card"},
  "envelope": {"targetId":"alice","mode":"direct","presentIds":["alice"]},
  "input": "你還記得我們的約定嗎?",
  "accept": false
}
```

執行 `node companion-agent/adapters/cli.mjs run REQUEST_JSON`.CLI 返回執行目錄, 並等待宿主執行任務; 僅在終端執行此命令不會自動創造子代理, 必須由上述技能或宿主 `delegate` 實現驅動.`jobs RUN_DIRECTORY` 只輸出待處理任務的路徑和階段, 不輸出原文. 完成後讀取該目錄 `result.json`.

同一資料目錄有常駐 daemon 存活時(`node companion-agent/adapters/cli.mjs daemon ensure|start|stop|status [--data-directory DIR]`), `run` 是薄客戶端: 把請求放進 daemon 收件匣, 輸出同樣兩行和退出碼, run.json 的 `executor` 為 `daemon`; 否則在本程序內執行(`executor:"in-process"`), 行為與以前相同. 經 daemon 時寫入類操作全 daemon 同時只執行一個, 按到達順序排隊, 取代「第二個 run 立即失敗」: 排隊中 run.json 為 `status:"running"`, `queued:true`, `queuedAt`, 出隊時改為 `queued:false`, `dequeuedAt`; 排隊期間 `jobs` 返回空陣列, 被取消時 result 為 `{"error":"run_not_started"}`. 讀取類操作(syncState, progress, workbench, interaction, clock, checkpoints, restorePreview, profile, profileExport, commitments, resources, initializationProvenance, previewInitializationRefresh, companionStatus, companionPreset, previewCompanionPreset, physiologyStatus, geographyStatus, exportGeography, previewGeographyImport, previewTransfer, exportTemplate, guardSettings, guardEvents, contactTendency 以及未知操作)和投遞類操作(companionClaim, companionReceipt, reconcileCompanion)不排隊, 立即並發執行. 本程序內的兩個並發 run 仍立即失敗(`backup_database_active`). 曾為該資料目錄啟動過 daemon 時, 遇到資料庫被佔用的程序內 run 先看租約持有者: 是本安裝為該目錄啟動的 daemon(可能仍在開庫)就最多等 30 秒, daemon 存活即改投; 是另一個程序內 run 或 `onboard` 就立即失敗; 等滿 30 秒仍無 daemon 也以 `backup_database_active` 失敗. 從未被任何執行器接受的 run(`backup_database_active`, `daemon_unresponsive`, `daemon_lost`, daemon 拒絕, 接受前的 SIGINT)仍有 run 目錄與兩行輸出, `executor` 為 `none`. `retrievalConfigPath` 不是字串時同樣以兩行 failed 結束(`invalid_retrieval_config`). daemon 內 `profile().reflection` 的失敗會跨請求保留, 直到下一次反思成功. 常駐 daemon 的命令, 檔案, 生命週期與 `wait` 見下文「常駐 daemon」.

操作包括 `configure`(`roster`),`sync`(完整 `messages`),`recall`(`characterId/query`),`turn`(`envelope/input/accept`),`access`(`characterId/memoryId/access`),`edit`(`messageId/text`),`delete`(`messageId`),`retry`(當前範圍的失敗來源). 畫像操作: `profile`(`characterId?`),`profileControls`(`patch/expectedRevision`),`profileCorrect`(`id/correction`),`profileDelete`(`id`),`profileFeedback`(`characterId/purpose/feedback`, `feedback` 為 `{feedbackId,expectedProfileRevision,change,strategyId?,detail?}`),`profileExport`(無額外欄位, 結果含 `json` 與 `markdown`).`turn` 會先儲存並處理使用者正文;`accept:false` 只丟棄助手候選,`true` 接受最終回覆. 可在 userSubmission 提供穩定 userMessageId,operationId,expectedVersion,acceptedAtMs; 同一使用者事件重試保留這些值. 後臺候選, 分析和紀錄不變成正文.`dataDirectory` 可指定工作區 `.local/` 內獨立目錄, 預設 `.local/agent/data`.

CLI 請求可增加 `retrievalConfigPath: "<安裝根>-private/agent-retrieval.json"`. 該私有 JSON 可獨立設定 `embedding`,`reranker` 或同時設定兩項, 格式同 SDK; 路徑由使用者顯式指定, 每個請求都重新讀取(經常駐 daemon 時也是, 由 daemon 為該 run 讀取; 未指定時讀預設檔 `.local/agent/retrieval-api.txt`); 相對路徑與 `dataDirectory` 一樣按客戶端當前目錄解析, 薄客戶端在投遞前轉為絕對路徑. 金鑰儲存在該私有檔案, 不能寫進請求, 任務檔案或原始碼. 不要把完整酒館推理設定當作 Agent 設定;CLI 只採用這兩個檢索欄位, 文本推理不變.

### 檢索設定引導

安裝成功後, 宿主 Agent 主動引導一次; 已有設定或使用者明確跳過時複用選擇. 沒有已知選擇的首次使用也執行此引導.

1. 說明當前預設使用本地 LanceDB BM25.embedding 增加語義向量檢索;reranker 對候選重新排序. 兩者獨立, 支援僅 embedding, 僅 reranker, 兩者都用或均跳過. 詢問使用者的選擇; 跳過後繼續本地模式, 不阻塞安裝和使用.
2. 對使用者選擇的服務, 獲取 API 地址, 模型名和認證方式; 推薦使用者直接在本地私有檔案填寫金鑰, 或使用宿主安全憑據輸入, 不要求把金鑰貼上到聊天. 請求可能把查詢及當前允許訪問的記憶文本傳送到所選服務, 併產生費用; 先讓使用者明確該服務可用於這項用途, 不能從機器上其他憑據推定授權.
3. 在安裝根相鄰的私有目錄儲存 UTF-8 JSON, 例如 `<安裝根>-private/agent-retrieval.json`. 下方模板全部空白即停用; 啟用某項至少填寫其 `baseUrl` 和 `model`, 無需認證的本地服務可保留空 `key`. 使用相容 embeddings 或 rerank 協議的端點, 不能用普通聊天模型地址代替. 已有檔案僅修改使用者選擇的欄位, 不覆蓋其它有效設定.
4. 在宿主現有偏好/設定中記錄選擇和絕對路徑, 不記錄金鑰. 後續 CLI 請求顯式加入 `retrievalConfigPath`;SDK 構造 `AgentRuntime` 時經 `options.retrieval` 傳入. 僅建立檔案不會自動啟用服務, 宿主子代理不會代替 embedding/reranker API.
5. 使用者授權後, 用隔離的非敏感樣例和非空召回查詢檢查實際模式及返回結果. 分別報告"已儲存""已實際呼叫通過"或失敗/降級; 空庫, 空查詢, 安裝檢查或介面HTTP成功不足以證明向量檢索質量. 發生 `bm25-fallback` / `hybrid-fallback` 時如實報告, 不把降級當原模式通過. 未授權呼叫時只報告已設定, 未測試.

```json
{
  "embedding": { "baseUrl": "", "key": "", "model": "" },
  "reranker": { "baseUrl": "", "key": "", "model": "" }
}
```

預期模式: 均不設定為 `bm25`; 僅 embedding 為 `hybrid`; 僅 reranker 為 `bm25+rerank`; 兩者均設定為 `hybrid+rerank`.API 根路徑或完整 `/embeddings`,`/rerank` 地址均可, 欄位及降級約束見 [檢索說明](RETRIEVAL.md).

### 後臺任務與取消

後臺任務預設有界等待; 失敗不改成模型成功. 已接受來源的分析失敗會保留原文, 阻止召回和依賴新記憶的生成, 修正原因後呼叫 `runtime.retry(scope)` 或 CLI `operation: retry`, 直接重新處理已持久化來源, 無須向前臺匯出世界原文; 伴侶下一輪 `turn` 只會先重跑接受階段遺留的助手回覆(最後一條已接受的助手回覆處理未完成); user-sync 遺留的使用者正文須用同一 `userSubmission` 重送(harness 為 `turn N --retry`)或先送 `operation: retry`, 改送新正文會得到 `invalid_scene_processing`. 結果保留 `host_timeout`,`host_closed`,`host_worker_failed`,`host_invalid_result` 等固定錯誤碼.

取消等待中的 CLI 執行, 使用 `node companion-agent/adapters/cli.mjs cancel RUN_DIRECTORY`; 宿主停止派發該目錄的任務,CLI 記錄 cancelled, 遲到結果不能提交. run.json 以 `cancelReason` 區分取消原因: `user`(`cli cancel`, 或客戶端收到 SIGINT/SIGTERM), `client_lost`(經 daemon 時等待的客戶端程序已結束), `daemon_shutdown`(`daemon stop` 等到上限後取消). daemon 崩潰後重啟時, 它已接受但未結束的 run 標為 failed 並帶 `failureReason:"daemon_restarted"`, result 為 `{"error":"daemon_restarted"}`. cancelled 的 run 仍須讀 result.json 判斷資料狀態, 見下表.

SIGINT/SIGTERM: 程序內執行時第一次會關閉等待, run 記為 cancelled(`user`); 經 daemon 時, 請求被接受前撤回它, 仍建立一個從未執行的 run 目錄(`status:"cancelled"`, `cancelReason:"user"`, `executor:"none"`, result `{"error":"run_not_started"}`)並照常輸出兩行, 退出碼 1; 已接受則寫 `cancel.json` 並繼續等到結束. 第二次直接退出(可能沒有第二行). 經 daemon 的 run 若在執行中 daemon 消失, 客戶端輸出結束行 `{"status":"failed","resultPath":"<run>/result.json","error":"daemon_lost"}`, 退出碼 1; 這時 `resultPath` 還不存在, 下一次 daemon 啟動才把該 run 標為 failed/`daemon_restarted` 並寫出它.

| 被取消或中斷的階段 | 資料狀態 | 恢復方式 |
|---|---|---|
| accept 階段(助手回覆已入庫, 處理未完成) | receipt committed, processing pending, `pendingReason:"host_closed"` | `retry`, 或下一輪 `turn` 自動先完成 |
| user-sync 階段(使用者正文已入庫未處理) | `phase:"user-sync"`, `userAccepted:true` | 同一 `userSubmission` 重送, 或先 `retry` |
| 生成階段(使用者正文 ready, 回覆不存在) | 沒有回覆 | 同一 `userSubmission` 重送 `turn`; `retry` 無效 |
| 人設初始化, relationshipAssessment, 預覽等非 scene 操作 | 依操作 | 重送原請求; `retry` 無效 |
| 從未開始(`run_not_started`) | 沒有任何寫入 | 需要時原樣重送 |

不冪等的操作(`turn` 不帶 `userSubmission`, `roleplayOpen`, `roleplayTurn`, `checkpoint`, `regenerate`, `edit`, `delete`)在 `daemon_restarted` 或 `daemon_lost` 之後不得自動重放; 帶 expectedVersion/operationId/userSubmission 的請求可以原樣重送. 取消不會撤銷此前已完成的事務; 系統強制殺程序無法執行清理, 應明確終止舊執行後用 retry 恢復. 保留 `.local/agent/data` 下資料庫即可恢復; 索引可重新生成, 執行佇列不是狀態權威. 不要把 `.local/agent` 打包或分享, 其中可能有私密世界原文.

### 常駐 daemon

每個資料目錄至多一個常駐 daemon. 它是唯一持有 Authority 租約並開庫的程序, 跨請求保留同一個執行時(檢索, 反思狀態, 候選); 不註冊系統服務, 不開機自啟, 由宿主按需啟動, 隨會話結束. 所有命令都接受 `--data-directory DIR`(預設 `.local/agent/data`), 輸出一行 JSON.

| 命令 | 作用 | 輸出與退出碼 |
|---|---|---|
| `cli daemon ensure [--stay] [--session-idle-ms N] [--stop-grace-ms N] [--conversation-window-ms N]` | 冪等: 已存活就刷新會話並沿用, 否則以 detached 子程序啟動 `daemon serve`(日誌在 `.local/logs/agent-daemon/`)並等它寫出回執, 上限 60 秒. 正在停止或不回應的 daemon 會等它退出後換新的 | `{"status":"running","started",pid,dataDirectory,daemonDirectory,stay,startedAt}`, 0; 失敗 `{"status":"failed","error":"database_busy|daemon_start_timeout|daemon_start_failed|daemon_stopping|daemon_unresponsive",logPath?}`, 1 |
| `cli daemon start ...` | 同 ensure, 但已存活時失敗 | `daemon_already_running`, 1 |
| `cli daemon stop [--force]` | 有序關閉(下述), 等到回執變 stopped, 上限為 stop grace 加 240 秒; `--force` 只在使用者明確要求時用, 核對所有權後直接終止程序 | `{"status":"stopped",pid,stopReason,shutdown}` 或 `{"status":"not_running"}`, 0; 逾時 `daemon_stop_timeout`, 1 |
| `cli daemon status` | 經收件匣查詢, 同時刷新會話 | `{status,pid,startedAt,stay,session,conversation,runs:{running,queued},waiters,agentJev,learning,runtime,rssBytes,heartbeatAgeMs}`; 未存活時 `{"status":"not_running",reason,receipt}` |
| `cli wait [--timeout MS] [--cursor CURSOR]` | 阻塞到 daemon 有事件或逾時(見下) | 一行事件 JSON, 0 |

預設值: 會話閒置 30 分鐘(`--session-idle-ms 1800000`)後自行退出, `--stay` 停用這條; stop grace 60 秒; 對話視窗 10 分鐘(`--conversation-window-ms 600000`); `wait` 逾時 540000 毫秒(9 分鐘), 可設 1000 到 3600000.

檔案位於 `<root>/.local/agent/daemon/<key>/`, `key` 為資料目錄實際路徑(小寫)的 SHA-256 前 16 位: `receipt.json`(pid, 程序建立時間, 安裝根, node 與入口路徑, 資料目錄, 設定, `status:"running|stopped"`, `stopReason:"requested|session_idle|forced|crashed"`, `shutdown` 步驟), `ownership.json`(客戶端核對所有權成功後的快取), `session.json`(最後一次請求), `heartbeat.json`(每 5 秒, 含執行中, 排隊與等待者數), `inbox/`(請求與回覆, 全部原子寫; 認領後的請求檔在 run 結束時刪除, 其間可能含正文或座標), `active-runs/`, `notices/`(D2 寫入的通知). run 目錄仍在 `.local/agent/runs/`, run.json 另有 `executor`, `requestId`, `clientPid`, `queued`, `queuedAt`, `dequeuedAt`, `cancelReason`, `failureReason`.

存活判定: 回執為 running 且屬於本安裝和本資料目錄, 租約 `owner.json` 的 pid 等於回執 pid, 該程序存在, 並且它確是本安裝的 `daemon serve`(先看 `ownership.json` 快取, 否則經 PowerShell CIM 核對執行檔, 命令列與建立時間, 單次約 0.6 秒(pwsh)到 2.4 秒(Windows PowerShell), 上限 15 秒). 四項全部成立才投遞收件匣; 否則 `run`/`onboard` 在本程序內執行. 回執只在取得租約之後寫出, 兩個 ensure 並發時敗方的 serve 以退出碼 3 結束, 其 ensure 沿用勝方.

生命週期: 啟動時取租約, 開庫, 完成未完成的索引清理, 重放崩潰遺留(上一個例項已接受但未結束的 run 標 failed/`daemon_restarted`; 收件匣中未接受的請求只在客戶端仍存活且未過 30 秒期限時接受, 其餘拒絕為 `request_expired`), 然後寫回執. 任何請求(含 `status`, `wait`)都刷新會話, `wait` 在得到回覆時(以及客戶端消失而被丟棄時)再刷新一次, 所以逾時長於閒置時限的 `wait` 回來後宿主仍有完整的閒置時限發下一次 `wait`; 沒有執行中或排隊的 run, 沒有等待中的 `wait`, 且超過閒置時限時自行退出(`session_idle`). 每 2 秒巡檢客戶端: 執行中 run 的客戶端已死則取消(`client_lost`), 排隊中的直接取消. 關閉順序依次記入回執 `shutdown`(每步在動作完成後記錄): `stop_accepting`(新請求得到 `daemon_stopping`, 等待中的 `wait` 收到 `daemon_stopped`) → `cancel_queued` → `grace_wait`(最多 stop grace) → `cancel_running`(`daemon_shutdown`, 關閉其宿主作業) → `drain`(等後臺計數歸零, 最多 240 秒, 逾時記 `unclean:true`, 程序以退出碼 1 結束) → `close_emotion_ranker` → `learning_worker`(D1 帶 `note:"idle_learning_disabled"`) → `runtime_close`(釋放租約) → `receipt_stopped`. 未攔截的例外寫 `stopReason:"crashed"` 後以退出碼 1 結束. `stop` 與 `--force` 只在回執仍指向被停止的 pid 時改寫它, 不覆蓋之後啟動的 daemon.

`cli wait` 只需執行命令的能力. 輸出恰為一行:

```json
{"cursor":"i:17","conversation":{"active":false,"reason":null,"lastUserActivityAt":"ISO","windowMs":600000},"timedOut":false,"events":[
{"type":"user_active","seq":12,"at":"ISO","operation":"turn","runDirectory":"…"},
{"type":"jobs_pending","seq":13,"at":"ISO","runDirectory":"…","operation":"retry","jobs":[{"id":"…","stage":"companionObservation","kind":"background"}]},
{"type":"run_finished","seq":14,"at":"ISO","runDirectory":"…","operation":"turn","status":"completed"},
{"type":"processing_pending","seq":15,"at":"ISO","scope":{},"sourceIds":["…"],"runDirectory":"…"},
{"type":"notice","seq":16,"at":"ISO","noticeId":"…","kind":"…","scope":{},"characterId":"…","opportunityId":"…","expiresAt":"ISO"},
{"type":"daemon_stopped","at":"ISO","reason":"requested|session_idle|not_running|crashed|forced"}]}
```

- 事件來源: 接受對話操作(`turn`, `roleplayTurn`, `regenerate`, `recall`)時 `user_active`; 每 250 毫秒掃描執行中 run 的新宿主作業, 發 `jobs_pending`; run 結束(含排隊中被取消)時 `run_finished`; 寫入類或投遞類 run 結束後該 scope 仍有已接受但未處理完的來源, 且這組來源與上次報告時不同時 `processing_pending`(同一原因失敗的 `retry` 不再觸發, 因此宿主不會陷入重試迴圈); 每秒掃描 `notices/*.json`(`{"schema":"xldb-daemon-notice-v1",noticeId,kind,scope,characterId,opportunityId,createdAt,expiresAt}`, 不含正文), 未過期的新檔發 `notice`; 關閉時對所有等待者發 `daemon_stopped`. 有事件立即回覆, 同一時刻產生的事件一起回覆; 否則到 `--timeout` 時回 `timedOut:true` 和空 `events`(逾時那一刻剛產生的事件隨逾時回覆一起送出, 此時 `timedOut` 為 false, cursor 不會跳過任何事件).
- cursor 為 `<例項>:<seq>`, 下一次 `wait` 帶上它就只收到之後的事件, 不重複. 不帶 cursor, cursor 屬於另一個 daemon 例項或已超出緩衝(256 筆)時, 先回快照: 各執行中 run 目前待處理的作業(`jobs_pending`, 帶 `snapshot:true`), 此前報告過且重新查詢後仍未處理完的 scope(`processing_pending`, 帶 `snapshot:true`, 來源組為當前值), 以及對話未進行時所有未過期的 notice; 快照為空則照常等待. 快照不重放此前的 `run_finished` 與 `user_active`: 宿主以各 run 的 `result.json` 為準. scope 以 `worldId`, `sessionId`, `branchId`, `characterId` 四欄比對, 事件中的 `scope` 也只含這四欄. 快照列出的作業與 notice 在回覆前已記為已報告, 帶其 cursor 的下一次 `wait` 不會再以事件收到它們; 但每次不帶 cursor 的 `wait` 都會再列出仍待處理的作業與仍有效的 notice, 所以 `jobs` 可重複執行, notice 的領取流程(`companionClaim`)也須容忍重複.
- 對話進行中: 有 run 在執行, 或距最後一次對話操作不到 `conversationWindowMs`. 此時 notice 暫不發出, 對話結束後才發(期間過期的就不發). `conversation` 欄位隨每次回覆提供.
- 沒有存活的 daemon 時立即回 `{"cursor":null,"conversation":null,"timedOut":false,"events":[{"type":"daemon_stopped","at":"ISO","reason":"not_running"}]}`. 等待中 daemon 消失時回 `daemon_stopped`, `reason` 取回執的 `stopReason`, 沒有則為 `crashed`. 請求 30 秒內未被認領(或逾期後才被認領)而 daemon 仍存活時回 `timedOut:true`, `conversation:null`, cursor 不變; daemon 因關閉而拒絕時 `reason` 為它的關閉原因. 以上退出碼都是 0. 存活的 daemon 因其他原因拒絕(資料目錄不符, 請求格式錯誤)時回一個 `{"type":"wait_failed","at":"ISO","error":"<拒絕碼>"}` 事件, `conversation:null`, cursor 不變, 退出碼 1.
- D1 的 daemon 不物化主動聯絡, 不寫 notice(D2 起寫), 所以 D1 只會出現其餘五種事件.

恢復表:

| 情況 | 表現 | 宿主動作 |
|---|---|---|
| `daemon ensure` 得到 `database_busy` | 另一個程序內 `run` 或 `onboard` 持有資料庫 | 等它結束再 ensure; 會話開始先 ensure 再 onboard |
| `run` 結束行帶 `error:"daemon_lost"` | daemon 在 run 執行中消失 | `daemon ensure`(重啟時該 run 標為 failed/`daemon_restarted`), 讀 result.json 後按上方恢復表處理 |
| run failed, `failureReason:"daemon_restarted"` | 上一個 daemon 崩潰前接受了它 | 只重送帶 expectedVersion/operationId/userSubmission 的請求 |
| run failed, result `daemon_stopping` | 請求到達時 daemon 正在關閉 | `daemon ensure` 後重送 |
| run failed, result `daemon_unresponsive` | daemon 存活但 30 秒內未認領請求 | `daemon status`; 仍無回應時請使用者決定是否 `daemon stop --force` |
| run cancelled, `cancelReason:"daemon_shutdown"` 或 `client_lost` | 關閉或客戶端消失時取消 | 讀 result.json, 按上方恢復表處理 |
| `wait` 收到 `daemon_stopped` | daemon 已停止 | 會話仍在時重新 `daemon ensure` |
| `wait` 收到 `wait_failed`(退出碼 1) | 存活的 daemon 拒絕了等待請求, `error` 為原因 | 不要重試迴圈; 核對 `--data-directory` 與安裝後報告使用者 |
| `tools/backup.mjs restore/recover` 報 `agent_daemon_active` | daemon 仍持有資料庫 | 先 `daemon stop --data-directory DIR` |

已知限制:

- PID 重用: 租約只以 pid 是否存在判定, 不記錄程序建立時間. daemon 未寫出 stopped 回執就消失且其 pid 被別的程序重用時: 新的 `run` 先投遞, 在請求 30 秒未被認領或心跳超過 120 秒時(以先到者為準)經 CIM 識破並撤回, 回退時租約仍顯示被佔用而立即以 `backup_database_active` 失敗(最多約 30 秒加一至兩次 CIM 查詢); 正在等待結束的 `run` 與 `wait` 在心跳超過 120 秒後經 CIM 識破(最多約 120 秒加 2 秒巡檢加一次 CIM), 分別得到 `daemon_lost` 與 `daemon_stopped`/`crashed`; `daemon stop` 同樣在心跳過期後識破並把回執標為 crashed; `ensure` 在 30 秒無回應後識破並改為重新啟動, 新 daemon 取不到租約時回 `database_busy`. 在重用該 pid 的程序結束之前, 這個資料目錄都無法開庫; 修正需要在共用租約中記錄程序建立時間, 另列.
- 啟動用 Node 的 detached 子程序. 若宿主在命令結束時終止整個程序樹, daemon 會隨之消失; 下一次 ensure 會如實重新啟動.
- 投遞類旁路(`companionClaim`, `companionReceipt`, `reconcileCompanion`)可能寫入並派作業, 與同 scope 並發的 turn 可能得到 `context_changed_retry`, 語義與 SDK 宿主相同.
- daemon 內各 run 不單獨檢查 `agent_background_pending`, 殘留的後臺作業在關閉時排空; 遺留情緒恢復在發起它的 run 結束後即停止(與程序內 CLI 相同), 下一次處理時再排入.
- 場景草稿上限 100 份包含已完成的草稿. run 目錄不會自動刪除. `onboard` 的位置座標會在收件匣請求檔中短暫存在, 匯入 run 結束時刪除.

## 世界狀態與生命週期

`configureWorld(scope, settings)` 設定伴侶世界與初始賬本;CLI 使用 `operation: "configureWorld"` 和 `settings`. 設為 `null` 可停用. 設定含 `mode`(只能為 `companion`,`story` 被拒絕),`startTimeMs`,`actorLabels`(NPC ID 到姓名/別名陣列),`playerName`,`publicTime`,`balances` 和 `inventory`. 餘額項為 `{ownerId, unit, value:"100.00", readerIds:[...]}`, 庫存項為 `{ownerId, item, count:3, readerIds:[...]}`; 玩家 ID 為 `player`, 未指定讀者預設僅玩家. 設定須與已有角色名單一致.

正文同步後 `world` 階段與其它分析一樣由宿主獨立子代理執行; 只提取候選, 核心校驗並確定性計算.`recall` 只返回該角色可知的時鐘, 餘額, 庫存和事件, 不能給角色直接讀管理介面. 當前支援明確阿拉伯數字購買, 消耗, 時間線索, 以及關聯已接受購買的部分退款. 退款候選只能以原購買的 `sourceId`,`revision`,`effectId` 及本輪阿拉伯數字退回量表示; 核心按原單價處理, 拒絕超出原購買剩餘量, 庫存不足或無共同觀察許可權的候選. 不支援自由填寫退款金額, 換匯或中文數字轉換.

SDK 提供 `checkpoint(scope, reason)`,`checkpoints(scope)`,`restore(scope, checkpointId)`,`undo(scope)`,`fork(scope, branchId, checkpointId?)`.CLI 同名操作接收對應 `reason`,`checkpointId`,`branchId` 欄位. 分支返回新 scope, 後續請求必須明確使用它. 恢復/撤銷會使未接受候選及舊後臺結果失效; 已有後臺任務須結束後再關閉執行時.

`restore`,`undo` 返回Promise,SDK呼叫須 `await`. 返回 `cleanupPending:true` 時, 正文與權威狀態已經恢復, 只剩檢索清理待重試; 不要再次呼叫undo來重試清理. 呼叫 `clearPendingIndexes()` 或 `retry(scope)` 繼續; 檔案 CLI 在每個寫入 run 開始前也會先恢復未完成的清理(程序內執行時每個 run 都做, 常駐 daemon 在啟動時及每個寫入類 run 開始前做). 檢索前必須完成清理, 不會帶著舊索引繼續生成.

`regenerate(scope)` 為最後一條已接受助手正文生成替代候選, 生成時使用舊回覆之前的狀態.`accept` 接受後替換原回覆修訂,`reject` 保持原回覆與狀態.CLI 的 `operation: "regenerate"` 必須明確 `accept: true/false`, 與 `turn` 相同. 不要把預覽當作已接受歷史.

一致資料庫備份, 停機恢復和初始化中斷限制見 [恢復說明](RECOVERY.md).

## 承諾, 畫像與主動陪伴

`commitments(scope, query?)` 查詢獨立承諾; 有期限的提醒依據現即時間, 無限期一般約束進入適用角色每輪系統輸入. 未知期限不會變成永久. 正文中的履行, 取消和修訂在本輪處理事務中生效.

後臺 `confirm` 操作以 `targetId` 引用既有提議, 僅攜帶本輪逐字確認及說話人證據. 腳本保留原條款, 範圍與期限, 累計必要參與者同意後才建立約定; 不要求確認句複述舊條款.

`bindSubject(scope, subjectId)` 將伴侶範圍綁定到明確的真實使用者; 不按暱稱自動合併身份.`profile(scope)` 檢視條目和控制;`setProfileControls(scope, patch, expectedRevision)` 分別開關畫像學習, 策略應用, 主動陪伴及定時喚醒, 並限定允許的分類. 開關預設關閉.`correctProfile` 與 `deleteProfile` 可糾正或刪除條目. 角色扮演及引述不會自動形成真實使用者畫像.

分類預設與時區(U1): 四個分類清單(`learningCategories`,`readCategories`,`strategyCategories`,`proactiveCategories`)未選過時即為全部七類, 只開 `profileLearningEnabled`/`personalizationEnabled` 就會學習與套用; 寫入時預填七類, 舊資料列存的 `[]` 讀取時也視為七類. patch 中明確傳 `[]` 表示該清單「一類都不要」, 儲存為 `"none"`, 讀回為 `[]`; 省略該欄位保留現值. `readCategories` 只篩選使用者自己在 `profile(scope).entries` 看到的條目, 不限制學習, 回覆策略或主動路徑, 也不影響匯出. `patch.timeZone` 設定使用者時區(IANA 名稱如 `Asia/Shanghai`, 或固定偏移如 `+08:00`), `null` 表示改用本機程序時區; 它是畫像的主體層設定, 與 `setTimeZone` 的對話顯示時區分開儲存. habit 與 hypothesis 在沒有明確自述支援時, 需要最近一次反例之後至少三則支援落在使用者時區的三個不同日曆日才生效. 修改 `timeZone` 或 `readCategories` 目前仍與其它控制變更相同: 遞增控制修訂, 清除反思證據, 重算條目並作廢已存溝通策略(U3 將改為標記重算). 行為變更: 舊版本存下的空清單 `[]` 現在讀作七類; 新寫入的 `"none"` 標記舊版本讀不懂, 在舊版本上回滾或還原含此標記的資料庫會丟出 `invalid_profile_controls`. 自 U1 起, 由 `strategyCategories` 與 `proactiveCategories` 交集決定的關係評分輔助上下文也用同一套讀取規則(不再收 `uncertain` 歸屬條目), 且以同一條件標記 `uncertain`.

同一套讀取規則: 回覆策略與主動聯絡判斷讀取畫像時都只用 `real_user` 且已過同一證據門檻的有效條目, 範圍, 有效期與用途規則相同, 差別只在各自的分類清單與開關. hypothesis 條目與 `inferred`/`planned` 依據的條目, 在回覆策略中一律歸入 `uncertainFacts`, 在主動聯絡上下文 `user.habits`/`user.profile` 中標為 `uncertain:true`.

`feedbackProfile(scope, characterId, purpose, {feedbackId, expectedProfileRevision, change, strategyId?, detail?})` 記錄對某一溝通策略的反饋(CLI `profileFeedback`); `feedbackId` 由呼叫方提供, 重送同一內容冪等, 內容不同報 `profile_feedback_conflict`; 沒有 `strategyId` 時只接受 `wait`/`resume`. `exportProfile(scope)`(CLI `profileExport`)匯出使用者畫像, 返回 `{status:"exported", json, markdown}`: `json` 為 `xldb-profile-export-v1`, 每條只含 `id`,`claim`,`category`,`theme`,`status`(`active`/`invalid`),`kind`(依據: explicit/observed/inferred/planned),`corrected`,`firstSeenAtMs`,`lastConfirmedAtMs` 與逐字引用 `quotes`(`text`,`polarity`,`sourceId`,`sourceRevision`,`acceptedAtMs`); `markdown` 按主題分組, 以可讀名稱顯示類別, 依據與狀態, 日期按畫像時區顯示, 不含類別代碼與任何數值信心. 匯出不受 `readCategories` 限制; 已刪除的條目, 角色扮演與第三方引述的條目, 以及支援證據已消失(來源被刪除或修訂, 或該分類不再學習)且未經使用者糾正的條目都不匯出.

本輪畫像提取(`profile`)的輸入含 `existingEntries`: 核心按最近更新優先取本角色本 session 可見, 屬於學習分類的 `real_user` 有效條目(範圍規則同 `profileReflection`), 按 `(key, category, claim)` 去重後最多列 40 筆, 只列 `key`/`category`/`claim`, 序列化不超過 8000 字元, 不含證據原文, 範圍欄位或使用者糾正標記. 同一事實可能因 `purposes`/`characterIds`/`sessionIds` 不同而存成多筆條目(例如先以空 `purposes` 記下, 後又以 `purposes:["reply"]` 重述); 提示中它們只出現一次. `polarity: "counter"` 候選只在 `(key, category)` 命中提示中列出的事實時生效: 核心把它展開到該 `(key, category)` 的全部可見條目(含未列入 40 筆取樣的較舊範圍), 每筆各產生一個 `purposes`,`characterIds`,`sessionIds` 對齊該條目的 counter(條目的 `characterIds` 或 `sessionIds` 為空時改用本輪角色或 session), 按範圍去重並排序, 使同一事實的每個範圍都被撤回. 未命中任何條目的 counter 直接丟棄, 記 `code:"profile_counter_target_missing"`; 命中使用者已用 `correctProfile` 糾正的條目時, 該條目的 counter 也丟棄(counter 不能撤回使用者糾正), 記 `code:"profile_counter_user_corrected"`, 同一候選的其它未糾正條目照常撤回. 被丟棄的 counter 不寫入條目或證據, 本身不改變畫像修訂; 每個候選按碼只在該使用者正文所屬 `prepare` 結果(CLI `turn` 結果)的 `diagnostics` 中各記一筆 `{stage:"profile",code,attempts:1,outcome:"dropped_counter"}`, 不含條目內容. `support` 候選的 `purposes` 保持宿主給出的值.

畫像增量擴充由 `profileReflection` 獨立後臺任務整理已接受的近期使用者經歷, 按生活背景, 日常習慣, 溝通方式, 支援需求, 目標和其它主題提出新增, 更新或不變候選. 主題只用於組織, 不能代替"明確表達/觀察/推斷"的證據性質. 模型只能引用任務提供的來源與條目修訂; 使用者糾正優先, 控制, 來源或畫像在任務期間改變時, 舊結果不能提交. 本輪記憶和情緒仍同步處理, 跨輪反思不替代本輪一致性要求. 宿主須像其它後臺任務一樣使用獨立上下文, 不把反思任務原文展示為角色回覆. 反思在 `accept`,`acceptBackground`,`sync`,`retry` 或 `editSource` 成功後排入後臺, 不阻塞返回, `recall` 不再觸發; 反思期間已接受來源又有變化而作廢時, 自動按新狀態重排一次, 使用者修改畫像或控制造成的作廢不重排. 使用 `accept` 的宿主若要保證反思在下一輪前提交, 應先呼叫 `waitForBackground`. 檔案 CLI 在寫出結果前等待本 run 發起的這些後臺作業完成;`waitForBackground(scope)` 會一併等待它, 失敗記入 `profile().reflection`. 這項失敗狀態只在記憶體中: 程序內執行的 CLI 每次都是新程序, 總是回報 ready; 經常駐 daemon 時它跨請求保留, 後續 `profile` 如實回報 failed, 直到下一次反思成功或 daemon 重啟. 反思未完成時 `close` 丟擲 `agent_background_pending`.

### 本地關係評分

當前活動分佈與跨輪反思以單個已授權會話, 單個伴侶為範圍; 同一會話可積累多日觀察, 尚未彙總使用者在其它會話的活動. 舊版沒有明確使用範圍的模型畫像仍供使用者檢視, 但在重新建立來源範圍或使用者明確授權前, 不送入其它角色/會話的前臺與後臺模型. 只糾正文字不會擴大範圍; 顯式設定角色或會話範圍後才按該範圍使用.

AgentJev 擴充安裝包自帶固定模型和專案內 CPU 執行時, 無需另填 API. 僅在 Agent 伴侶開啟畫像學習與個性化後按需使用; 酒館和臨時跑團不呼叫. 模型輸出是 0-4 檔的近期行為估計, 未知為 `null`, 不是心理診斷或經過校準的機率. 包含 Agent 對使用者親近, 使用者對 Agent 親近, 資訊可靠性信任, 情緒披露, 任務委託及依賴跡象; 六項各自有行為判據, 不能把聊天次數或普通稱呼直接當成依賴.

正式權重已出現"中性確認也被賦關係/依賴分值"的明確反例, 當前語義質量未通過, 不能把分值作為已確認事實. 執行效能和原始失敗見 [AgentJev 實測](AGENTJEV_ACCEPTANCE.md).

CLI 請求 `operation: "relationshipAssessment"`, 傳入現有 `scope`,`characterId`, 返回狀態, 修訂, 各項依據與估計.`disabled` 表示控制未開啟;`unavailable` 表示未安裝本地模型; 無足夠來源時保持未知. 使用者糾正使用 `operation: "relationshipCorrect"`, 附 `expectedRevision` 與 `correction`, 例如 `{"metrics":{"informationReliability":{"score":2,"note":"只在程式設計方面信任建議"}},"contactChoice":"wait","note":"暫時不要主動聯絡"}`. 只修改使用者指定項; 模型不能覆蓋糾正.

評分輸入僅取當前授權的單伴侶直接對話; 使用者與 Agent 的原話分別評分, 不用 Agent 自稱親密替使用者背書. 新版先委派宿主 `relationshipEvidence` 後臺階段, 在獨立上下文中提取行為, 說話人, 領域, 時間, 否定及精確引用; 宿主須支援該階段, 仍無需新增 API 設定. 提供給該階段的來源正文不再按每段 120 字截斷; 序列化輸入超過 48,000 字元時明確報 `relationship_evidence_input_incomplete`, 不靜默丟棄尾部.

TypeScript 核驗來源及偏移, 再將唯一支援的行為檔位轉換為分值. 同一片段存在多種支援檔位時,AgentJev 只在這些檔位與未知之間排序; 不同領域或互相沖突的證據分別保留, 總分可能為 `null`.`origin` 區分規則, 約束排序與使用者糾正,`domains` 保留領域依據及限定語, 其 `status` 區分 `current`,`historical` 與 `conflicted`. 僅有過去經歷不能形成當前分值; 普通後續否定不刪除歷史, 明確撤回必須用 `retracts` 精確指向同一較早命題. 當前依據不會混入僅描述過去的引用. 原始排序與提取診斷不作為前臺關係事實.SDK `relationshipDiagnostics(scope, characterId)` 可在相同授權範圍檢視當前診斷; 這不是新增 CLI 操作.

提取器仍可能誤解原文, 引用存在只證明文字來自來源, 不證明分類正確. 演算法, 提示詞或模型身份變化會使舊模型評分失效, 使用者糾正保留. 聯絡硬約束和使用者暫停優先, 主動聯絡輸入排除依賴分值及其領域證據; 依賴程度不能提高聯絡頻率. 停止學習或個性化後不再生成或消費評分.

本地推理程序僅通過父程序管道交換資料, 不啟動 HTTP 服務, 不請求遠端模型; 缺依賴, 上下文超限或推理失敗顯式報錯. 其它後臺提取和正文繼續使用宿主能力. 分維度判據參考方法見 `companion-agent/docs/CRUSH_MONITOR_REUSE_REVIEW.md`, 固定來源與部署邊界見 `companion-agent/docs/AGENT_JEV_REUSE_REVIEW.md`.

模型身份 `agentjev-v2:<sha256>` 的格式與值不變; 其中 `model.safetensors` 的 SHA-256 以 `{path,size,mtimeMs,ctimeMs,ino}` 為鍵快取在 `.local/agentjev/identity-cache.json`(臨時檔改名的原子寫入), stat 相符且快取記錄時間晚於檔案最後 mtime/ctime 至少 2 秒時不重讀模型檔(檔案時間戳來自粗粒度時鐘, 近期改動的記錄一律重算), 其它小檔每次重新雜湊. 雜湊期間檔案變化不寫入快取; 快取損壞, 缺失或不可寫時退回全量雜湊, 不報錯. 替換模型檔請寫入新檔或改名替換, 不要原地改寫並保留原時間戳: 快取以 stat 為鍵並依 2 秒 racy 規則判斷, 保留時間戳的原地改寫可能沿用舊雜湊. 推理逾時, 啟動逾時, 輸出無效, 管道失敗或程序退出只丟棄當前程序並拒絕進行中的請求, 隨後按連續失敗次數退避 30 秒, 2 分鐘, 10 分鐘, 之後每次 30 分鐘; 退避期內呼叫報 `agentjev_backoff`, 期滿後下次呼叫重新啟動程序, 一次通過校驗的回答使失敗計數歸零. runner 以 `error` 回報的單筆失敗不觸發退避. 被替換程序的延遲輸出, 錯誤或退出事件被忽略. 只有 `close()` 是永久關閉, 之後報 `agentjev_closed`. 用戶端 `availability()` 返回 `available`,`backoff`(附 `retryAtMs`),`closed` 或 `not_installed`, 並附最近錯誤碼 `lastError`; 執行時的決策提供者原樣轉出, 只作狀態報告, 不改變主動聯絡與回覆路徑在本地模型不可用時的既有行為.

`profile` 中的活動摘要按當前時區顯示近期真實入站訊息的工作日/週末小時計數, 獨立日期和樣本量. 它是訊息時間觀察, 不代表使用者作息, 可聯絡視窗或心理特點; 不會修改 `setContactSettings`. 同一來源重複同步不增加樣本, 來源刪除或修訂後按現行記錄重算. 前臺只獲得適用的溝通策略; 完整管理畫像不是角色的公共提示詞. 主動聯絡的張力模型只以乘法使用這份摘要(S5, 使用者節律): 取同類日(工作日或週末; 該類少於 10 筆時合併), 以 ±1 小時 1:2:1 權重平滑, 係數 ρ=clamp(0.5+0.5r, 0.5, 1.5), 其中 r=(該時段平滑計數+0.5)/(總數/24+0.5); 樣本少於 20 或傾向表關閉 `receptivity` 時 ρ=1. 它不禁止任何時刻, 並在 epoch 起點讀取, 整個 epoch 用同一節律. 同一批訊息也提供使用者自身相鄰對話間隔(超過 10 分鐘者)的分位數 g50/g90, 供缺席來源縮放; 間隔少於 20 個時用 12/36 小時.

主動聯絡以聊天中有效的時段承諾為約束. 舊 `setContactSettings` 的固定視窗, 最小間隔和未回覆次數字段保留讀取相容, 不再作為傳送硬門, 防護欄也不讀取它們. 明確暫停與關閉仍有效;`setBusyUntil` 是宿主提供的忙碌截止控制, 不替代對聊天原文中提前說明的識別.`pollCompanion(scope, characterId, trigger)` 只產生待發送候選;`dispatchCompanion(scope, characterId, deliver)` 呼叫宿主投遞迴調一次, 並用宿主訊息 ID 確認接受. 訊息必須以 assistant 身份寫入, 不能偽造使用者事件.`watchCompanion` 是長駐 SDK 宿主的定時檢查入口, 每 60 秒以 `scheduled` 觸發一次, 返回停止函式; 檔案 CLI 的常駐 daemon 在 D1 不執行定時檢查(D2 起由 daemon 的 tick 物化並寫 notice, 送達仍由宿主完成). 一次檢查可拆成兩半: `materializeCompanion(scope, characterId, trigger)` 是同步前半(閘門與物化, 不呼叫模型, 不跑宿主作業, 不判斷), 返回 `{terminal:true,result}`(`result` 與 `pollCompanion` 此刻的結果相同; 物化後才結束時另附 `pressure`)或 `{terminal:false,due,materialized,pressure}`: `due` 依判斷順序列出到期機會(`opportunityId`, `occurrenceId`, `kind`, `seedKind`, `exempt`, `checkAtMs`), `materialized` 是本次新物化的張力發生, `pressure` 是本次讀到的張力記錄(觸發點, 或此刻的狀態); `evaluateCompanion(scope, characterId, trigger)` 是後半, 判斷前半留下的到期機會並返回與 `pollCompanion` 相同的結果, 從不建立機會列. 依序呼叫兩者與一次 `pollCompanion` 等價; materialize 可重複呼叫. CLI 操作與 daemon notice 屬 D2.

使用者的邊界與邀請不對稱. 關閉主動陪伴, 使用者暫停, 關係糾正為 `wait`/`skip`, 硬時段, 忙碌截止, 投遞不確定和語義處理未完成都在建立或評估機會之前擋下. 關係糾正為 `send`/`initiate` 只是邀請: 它以 `contactState:{invitation:true}` 隨判斷上下文交給 AgentJev 參考, 只提高許可, 不構成義務, 也不直接批准; 軟時段內外都仍由 AgentJev 判斷, 回答 `wait` 時延後, 回答 `skip` 時放棄本次機會, 回答 `send`(且體驗 positive, 情緒 aligned)才入列.

時段語義(使用者 2026-09-28 裁定):

| 類別 | 例子 | 判定 | 行為 |
| --- | --- | --- | --- |
| 硬時段 | 「晚上十點到早上七點別找我」「十點到七點別找我」「今晚十點到明早七點別找我」「開會這兩小時別發」 | 使用者原話給出可解析的時間範圍(一次性區間或每日視窗)並要求不要聯絡: 兩種來源同一規則, 使用者的原話(使用者自己來源為該訊息本身; 她的答應為她所回覆的使用者訊息)同時含起訖兩端原文(她的答應也可換一種說法: 她的起訖解析出的時段與使用者訊息中某個「X到Y」範圍解析出的相同即可, 例如使用者「十點到七點別找我。」, 她「好，晚上十點到早上七點我不找你。」; 每個範圍只比較兩側最長且能一起解析的時間短語, 起點取最長尾綴, 終點取最長前綴, 因此「上午十點到七點別找我」(10-19)不會經由其中的「十點」配上她的晚上十點/早上七點, 她的答應仍是她的軟時段), 帶不要聯絡的用語(`noContactRequest`)且不是放行聯絡(`contactLiftRequest`)時, 才是使用者的硬時段. 使用者說出時段卻沒有要求不要聯絡(「我十一點到七點睡覺」「我明天三點到五點開會」)時, 即使出自使用者自己的訊息也不是硬時段: 「我很忙」不代表收到訊息不會開心(使用者 2026-09-28 決定); 模型若仍提取, 存為她的軟時段(`soft`/`origin:"self"`), 可判斷一次思念, 時段結束不觸發 `window_end`. 用語判定為一個寬鬆模式 `noContactRequest`: 禁止詞(別, 不要, 不許, 不準, 先別, 請勿, 勿, 免, 不想, 不希望, 簡繁皆可)後四字內接聯絡動詞或對象(找, (被)打擾, 打攪, 發, 聯繫, 聯絡, 煩, 吵, 理, 叫, 消息, 信息, 私信, 私聊, 打給, 打電話, @, 戳, call), 以及 免打擾/勿擾/請勿打擾/不接電話; 邀請聯絡的否定式不算(「別忘了給我發消息」「醒了別忘了找我」「不想錯過你的消息」「不要錯過」; 「記得找我」本來就沒有禁止詞), 雙重否定與「別讓我等」也不算(「別不理我」「不要不理我」「醒了別不找我」「別讓我等你消息」「別再忘了找我」: 禁止詞後緊接不, 再忘, 讓我等); 寧可誤判為硬, 不可把使用者的邊界靜默變軟. 模型只在使用者要求不要聯絡時從使用者訊息提取時段; 只提到行程(開會, 加班, 睡覺, 例如「我明天三點到五點開會」)是狀態, 不是時段; 她自己接著說「那三點到五點我不打擾你」是她的軟時段(`origin:"self"`), 屬於她可判斷一次的狀態. 她(非使用者來源)改約或替代提議重述目標為使用者硬時段的時段時, 等級與來源不變(硬/`user`); 依序判定: (a) 兩端原文都出現在她所回覆的使用者訊息中, 且該訊息要求不要聯絡(`noContactRequest`)而不是放行聯絡(`contactLiftRequest`)時, 採用新起訖, 即使她的回覆沒有重複這兩個時間(使用者「以後改成下午一點到三點別找我，晚上隨便。」, 她「好的，聽你的。」→ 13-15); 「九點到十點隨時找我」「九點到十點可以找我」「九點到十點隨便找我」「我十一點到七點睡覺」「今天加班到十一點，明早七點起」都不算; (b) 否則新時段完整涵蓋舊時段(每日/區間意義上的超集)時採用; (c) 其餘(起訖引文與目標相同, 或既不在她本輪原話中也不在使用者訊息中, 或只是她自己的新時間)原樣沿用舊時段並帶宿主標記, 都不報錯, 以免來源停滯. 因此使用者只說「改成十一點到七點吧」而由她答應時, 需要使用者訊息帶不要聯絡的用語才會改; 使用者自己來源的改約不受此限(目標為使用者硬時段, 等級與來源不變). 例如每日 22-07 的使用者時段, 使用者說「今天加班到十一點」: 她說「那以後改成一點到五點我不找你」或「那以後改成十一點到七點我不找你」(使用者訊息沒有「七點」)都仍是 22-07; 使用者訊息同時有「十一點」「七點」時才是 23-07; 她說「那改成九點到八點」是涵蓋舊時段的 21-08. 使用者自己來源的改約(「改成十一點到七點吧」)照新起訖, 仍為硬/`user`. 經負面反饋 harden 的時段(硬/`origin:"hardened"`)同樣屬於使用者的邊界: 重述它的改約或替代提議(任一來源)沒有要求不要聯絡時仍為硬/`hardened`(不觸發 `window_end`), 帶用語時為硬/`user`; 未重述時段時像使用者硬時段一樣繼承(`inheritedFrom`); 她自己的新時間同樣不能移動或縮小它. 邊界分兩句說出時(先「我十一點到七點睡覺」存為她的軟時段, 再「睡覺那段時間別找我」): 使用者來源的替代提議綁定目標為軟時段的承諾, 使用者原話要求不要聯絡且不是放行聯絡, 且未以新起訖重述(省略時段, 或只照抄目標的起訖原文而本輪原話沒有這兩個時間)時, 宿主把目標的時段複製為硬/`user`(標記 `inheritedFrom`), 此後照使用者硬時段處理(含 `window_end`); 帶放行用語時不升級. 軟時段目標上沒有用語的使用者替代提議省略時段時仍不保留時段(沿用既有行為) | 符合上述規則時解碼層存為 `level:"hard"`, `origin:"user"`, 否則存為 `level:"soft"`, `origin:"self"`; 等級與來源由來源決定, 不採用模型給的 `level`(只有重新驗證已儲存的操作時沿用其已存的時間, `level`/`origin`, 見解析規則). 改約或替代提議未重述時段時, 新鮮提取把目標的使用者硬時段複製進所存的操作(標記 `inheritedFrom:<目標 id>`, 只有宿主能寫; 給模型看的承諾目標與關係上下文精簡視圖都不含此標記, 模型若仍照抄, 新鮮提取像處理 `level`/`origin` 一樣靜默丟棄), 省略從不解除; 投影與重建(`rebuildDerived`, 備份還原的 `rebuildCommitmentProjections`)只重放已存的操作, 不再臨時繼承, 因此舊的已存替代提議沒有時段時重建後仍沒有. 只有使用者來源的替代提議以 `contactRestriction:null` 且使用者原話帶解除用語(`contactLiftRequest`: 每個用語都綁定聯絡, 可以…找/聯繫/發消息/打擾(「可以」前不能是不/別/不太, 後不能緊接不/別), 隨時…找(前不能是別/不要/不許), 不用…勿擾/安靜/避開, 取消…約定/勿擾/限制/時段, 解除…限制/勿擾, 不(再)限制; 只去掉取消/解除用語中的「勿擾」字樣後, 其餘文字又要求不要聯絡時不算(「不可以找我」「別隨時找我」「可以不聯繫我嗎」「不用再避開了，別找我」都不算); 「我不用加班了」「可以發我文件嗎」「你不用回了」「把會議取消了」都不算)時才解除, 否則拋 `invalid_contact_restriction`. 時段內不物化任何機會, 不進破例判斷, 未交給宿主的待發內容取消, 連使用者指定時間的提醒也不送 |
| 狀態 | 「這幾天比較忙」「可能沒空」「我去睡了」「晚安」 | 起訖引文完全沒有時間詞 | 不產生 `contactRestriction`; 模型若產生, 解碼層只丟棄該限制, 承諾其它部分保留(但改約或替代提議的目標原本有時段時, 新時段被丟棄會拋 `invalid_contact_time`, 不靜默解除舊時段). 由已解釋缺席(contact-affect), `setBusyUntil` 與晚安的 `sleep:` 軟時段綁定表達; 她仍可判斷一次要不要表達思念 |
| 硬時段結束 | 上例的 07:00 | 時段結束後的下一次檢查(有 daemon 時為下一個 tick, CLI 模式為下一次宿主輪詢) | 只對 `origin:"user"` 的硬時段(她自己提出的時段不觸發; 經負面反饋 harden 的時段存為 `origin:"hardened"`, 也不觸發); 該時段例項在承諾條款生效之後才結束(生效時刻為設定該條款的來源, 即承諾建立來源的接受時間; 結束不晚於生效時刻的例項不送, 因此白天建立的每日夜間時段當天早上不送, 時段中途才答應的那一晚結束時照送); 安靜起點之後沒有使用者訊息(見下); 安靜至少持續 60 分鐘(`WINDOW_END_MIN_QUIET_MS`, 例如 06:50 說「七點前別找我」或一直聊到 06:30 都不送, 開會兩小時從頭安靜則送); 因此短於 60 分鐘的時段永遠不會觸發時段結束的想念: 這麼短的安靜不是一段需要守約的分離, 結束時立刻表達想念會顯得刻意, 在剛聊完或剛要求安靜後幾分鐘就主動來訊也會像糾纏; 從例項有效開始到結束她沒有確認送達的主動聯絡; 結束時刻沒有另一個硬時段正在生效, 未暫停, 未被關係糾正 `wait`/`skip` 擋下時, 物化 `window_end` 機會(鍵 `window_end:<commitmentId>:<windowKey>`, 不含修訂, 因此同一時段例項在修訂後也不會再送; 每個時段例項至多一次, 每日視窗因此每天至多一次, 結束後 6 小時內有效). 以上條件都成立也不一定發(使用者 2026-09-28 決定: 每次都發太像腳本): 每個時段例項擲一次種子骰, p = 0.30 + 0.55 × clamp((安靜時長 − 60 分鐘) / (8 小時 − 60 分鐘), 0, 1), 安靜時長為例項結束減安靜起點(1 小時 0.30, 4 小時約 0.54, 8 小時以上 0.85; 最高只到 0.85, 每晚 8 小時的視窗約每七個早上有一個不發); 該角色當前的驅力 episode 仍有未結束的發生(`waiting`/`deferred`/`evaluating`/`approved`)時再加 0.10, 上限 0.95(`WINDOW_END_P_MIN`, `WINDOW_END_P_MAX`, `WINDOW_END_FULL_QUIET_MS`, `WINDOW_END_DRIVE_BONUS`, `WINDOW_END_P_CAP`); u 為 sha256(`<subjectId>:<window_end 鍵>:<例項結束毫秒>`) 導出的 [0,1) 均勻數, 每日視窗每天不同, 同一例項的重試與重複輪詢相同; u < p 才物化並送出. 擲骰結果在第一次擲骰時寫入判斷記憶(`companion_judgments` 的合成列, `kind:"window_end_roll"`, 含 decision, p, u, tone, 安靜時長, 驅力是否開啟, 例項結束時刻與 window_end 鍵), 之後只讀回, 不再重擲; `skip` 另寫一筆輪詢診斷(`companion_poll_diagnostics`, reason/stage 為 `window_end_roll`, code 為 `skip`, 含 p 與 u; 不是錯誤, 不擋其他機會, 使用者指定時間的提醒照常送出), 該例項此後不再評估; 跳過不留機會列, 因此 `companionStatus` 回傳 `windowEndRolls`: 該角色最近至多 5 筆擲骰, 新到舊, 每筆含 `windowKey`, `instanceEndMs`, `p`, `u`, `decision`, `recordedAtMs`, 宿主或使用者由此可見某次時段結束是被擲骰跳過. 語氣方向由同一種子決定: 安靜 6 小時以上 care 0.35, longing 0.35, light 0.20, share 0.10; 較短時 light 0.35, care 0.30, longing 0.25, share 0.10. 簡言之: 時段內使用者靜默滿 30 分鐘後, 該時段的安靜才開始; 此後任何使用者訊息都算先來訊; 送出前至少要安靜 60 分鐘. 精確地說, 安靜起點(quietStart)為「例項有效開始」(例項開始與條款生效時刻取較晚者)與「當時那段對話的結束」取較晚者, 且不晚於例項結束: 條款生效後發給她的 direct 使用者訊息, 每則距前一則(或距例項有效開始)不超過 30 分鐘就串成同一段對話, 其最後一則的時刻即對話結束; 因此承諾所回覆的那則使用者訊息, 緊接著的晚安, 以及一路聊進時段內的對話(21:30 答應, 22:20/22:45/23:10/23:35 還在聊, 安靜起點為 23:35)都不算先來訊. 安靜起點之後直到本次檢查為止出現任何使用者訊息(例如 03:00, 06:50, 或結束後 07:05 且在輪詢之前)就不送. 「要不要發」不問 AgentJev(與使用者指定時間的提醒同樣豁免, 只由上述擲骰決定), 正文由宿主以 `purpose:"window_end_longing"` 生成, 輸入帶 `quietSince`(安靜起點的當地 HH:MM), `quietSinceMs`, `userChattedInWindow`(時段內安靜前是否聊過)與 `tone`(longing/care/share/light): 機會主題, 上下文檢索查詢與提示開頭都隨 `tone` 而變: longing 表達想念與關心; care 以問候與關心為主(問對方睡得怎樣, 現在怎樣); light 只發一句輕鬆的話; share 分享她自己最近確有的經歷(上下文中她看到或做過的事), 絕不編造, 沒有就改為一句簡單問候; light 與 share 的主題, 查詢與提示都不含想念字樣, 以免每個早上都被拉回「想你」; 各語氣都不編造她沒有經歷過的事; 可用「自從你 HH:MM 左右安靜下來」這類說法, 不聲稱自己整晚或整段時間都沒聯絡, 不追問, 不抱怨, 不要求回覆. 仍受 G1/G2, 忙碌截止(截止在寬限期內時截止後送出)與投遞不確定約束; 送出時記錄所在軟時段但不佔破例 |

解析規則: 起訖都是日期或相對時間時照字面; 同一個時長短語作起訖(「兩小時」「一個半小時」)表示從說話時刻起算; 只有鐘點時取當地時區內包含說話時刻或最早開始的那一次. 「X點前/X點之前/X點以前」「到X點為止」「現在到X點/從現在到X點」只給終點: 模型把終點原文作 `endQuote`, `startQuote` 重複同一原文(或使用者說的「現在」), 起點為說話時刻, 終點為說話時刻之後最近的一次 X 點(帶日期的「明早七點前」照字面, 但當地 00:00-06:00 說的「明早/明晨/明天早上/明天早晨」指正在到來的這個早晨: 01:00 說「明早七點前別找我」是 01:00 到當天 07:00; 以此類詞開頭的起點同樣如此, 以「明天」為準的終點隨之平移: 01:00 說「明早九點到明早十一點」「明天早上八點到明天晚上十點」「明天早上七點到明天中午十二點」都是當天, 23:00 說則是次日; 起點平移到當天而終點以後天/大後天/下週/週幾/日期為準時(01:00 說「明早八點到後天早上七點」)沒有唯一讀法, 失敗關閉); 重複的原文沒有「前/為止/到」標記時(「七點別找我」)不是範圍, 失敗關閉. 時段詞後接 24 小時制(「傍晚18點」「晚上21點」「下午15點」「夜裡23點」, 13-23 點)照字面; 「晚上12點」「晚上零點」「晚上0點」「夜裡12點」為零點, 「今天晚上12點」「明天晚上12點」是該日結束時的零點(不是中午); 早上/上午等時段詞後接 13 點以上失敗. 已知寬鬆: 「晚上13點」「傍晚22點」這類時段詞與鐘點不太搭配的說法照字面接受, 不報錯. 沒有上午/晚上的鐘點(「十點」)取較短的讀法; 兩種讀法一樣長時, 先排除起於 01:00-05:00(含)的讀法(晚上 21:30 說「三點到五點」是 15:00-17:00); 說話時刻本身在當地 00:00-06:00 時, 只排除該例項已在說話前開始的這種讀法(04:30 說「三點到五點」仍是 15:00-17:00, 說「五點到七點」是當天 05:00-07:00); 仍一樣時(「十點到七點」可為 10-19 或 22-7)取包含說話時刻的一個, 否則取之後最早開始的一個, 因此晚上說是 22:00 到次日 07:00, 23:00 或 00:00 在時段內說是這一夜 22:00 到 07:00, 早上說是 10:00 到 19:00. 「今晚/今夜」「明晚/明夜」加鐘點以說話時刻所在的當地日(或次日)推算: 5-11 點為 17-23 點, 12 點或 0 點為次日零點, 其它鐘點失敗; 「今早/今晨」「明早/明晨」加中午前的鐘點. 當地 00:00-06:00 說「今晚/今夜/今天晚上十點到明早/明晨/明天早上七點」指正在進行的這一夜: 從說話時刻到當天早上七點(該早晨已過時才照字面取下一夜); 23:00 說同一句仍是次日早上. 「這兩天」「這幾天」不是時間範圍. 失敗關閉: 起訖引文只要含任何時間詞(數字, 鐘點, 時長, 日期, 今晚/明早/今夜/明晨/今天/明天/後天, 週幾, 上午/下午/晚上等時段詞), 卻無法解析成唯一範圍(例如「後天下午別找我」只有日期沒有鐘點, 或單獨的「今晚」), 解碼拋 `invalid_contact_time`, 來源停在 failed, 語義處理未完成因而不主動聯絡; 丟失使用者指定的時段比拒絕解析更糟. 這種停滯可觀測: 回覆照常提交(回執 `processing:"pending"`, `pendingReason` 為錯誤碼), 之後 `pollCompanion` 返回 `{status:"waiting",reason:"semantic_pending",pendingReason:"source_processing_failed",diagnostics:[{sourceId,revision,stage,code}]}`(每個失敗來源一項, 至多 5 項), 並在 `companion_poll_diagnostics` 為每個失敗來源版本, 階段與錯誤碼寫一筆(重複輪詢不重寫; 來源重新就緒或消失後刪除, 超過 7 天的列也刪除); 仍在處理中的來源只返回 `semantic_pending`. 只有引文完全沒有時間詞時才當作狀態丟棄. 等級與來源的判定對使用者來源與她的答應相同: 使用者原話(使用者來源為該訊息本身, 她的答應為所回覆的使用者訊息)含起訖兩端原文, 要求不要聯絡(`noContactRequest`)且不是放行聯絡(`contactLiftRequest`)時為硬/`user`, 重述目標為使用者硬時段的時段等級與來源不變, 其餘都是她的軟時段(`soft`/`self`); 來源是使用者本身不再使時段變硬(使用者 2026-09-28 決定). 她自己提出, 時間只出自她自己的話的時段(S7)仍是她自己的軟時段; 舊版已儲存的軟性承諾不改寫. 重新驗證已儲存的操作(場景儲存以 `revalidate:true` 顯式標記, 不再由缺少 `contractVersion` 推斷)不重新解析起訖引文, 直接沿用已存的時間, 分鐘, 時區, `level` 與 `origin`; 已存時間完整時也不再要求起訖引文出現在該來源本身(重新驗證時沒有目標與所回覆的使用者訊息, 例如她沿用使用者原話新起訖的改約, 引文只在使用者訊息中), 已存時間不完整的列仍失敗關閉. 已知遺留: 舊版以其它規則存下的列(例如「晚上12點」存為 720, 或舊規則會拒絕的「傍晚18點」)因此保持原值, 不會報錯也不會被改正; 需要改正時由使用者重述時段. 同理, 2026-09-28 規則修改前以使用者來源存下的無用語時段(當時一律存為硬/`user`)重新驗證後仍是硬/`user`, 每日時段因此一直有效並照舊觸發 `window_end`, 直到使用者重述或解除. `window_end` 只在 Agent 宿主上產生.

定時與事件檢查都不再每次建立機會. `scheduled` 與 `event` 觸發共用同一個張力閘門(M3; 模型在 `companion-agent/src/companion/contact-pressure.ts`, 純函式, 不讀時鐘, 不呼叫模型). 張力 P(t) 與 OpenHer frustration 同單位, 由以下來源相加: S1 驅力, 最近一次持久化的 OpenHer 狀態 E0 依時間投影的 connection, expression, novelty frustration 扣除她自己送出後的釋放量, 乘以 ι=0.8+0.2·(initiative+warmth), 即 ι·(F_c+0.5F_e+0.3F_n); S2 記憶再喚起, 使用者對話喚起的記憶(見下文再喚起事件), clear 1.2, gist 0.8, 每 6 小時減半, 總和上限 2.0, 48 小時後忽略; S4 缺席, 未解釋的未回覆時長按使用者自身對話間隔分位數在 g50 到 g90 之間縮放到 0 到 2.0, 已解釋時為 −0.5×已解釋比例, 不確定時為 0, 同一等待情節已導致過一次送達後為 0; S6 後續, 自最新一則帶 plan 的直接使用者來源起 A_f·(Δ/3h)·e^{1−Δ/3h}, 3 小時達峰, 24 小時後為 0; S7 她自己的生活, 介面 `LifeAvailabilityProvider`(`CompanionFlow.lifeProvider`), M3 為空樁. 使用者指定時間的提醒(S3)不計入張力, 到期即物化. 危險率 λ=λ_max·σ·o·ρ·α·μ·(1−e^{−(P−θ_eff)/κ}), 只在 P>θ_eff 時為正: θ_eff=clamp(3.0·m_θ, 1.5, 4.5), θ_off=θ_eff−1, κ=0.75, λ_max 每小時 1; σ, m_θ, A_f, 權重與 μ 取自傾向表, o 為使用者開放度, ρ 為使用者節律, α 為她生活的可用度(off 0, busy 0.2 並在記錄中寫 `lifeSuppression`, glance 0.6, free 或未知 1), μ 為軟時段係數(預設 0.25). 硬時段, 暫停, 忙碌截止內, 遲滯標記已觸發且尚未跌破 θ_off 時, 該角色已有未結束的張力發生時, 以及 epoch 起點後 10 分鐘內, λ 為 0. epoch 起點 T0 取使用者最近活動, 對該角色最近確認送達, 最近一次張力發生的 skip, 最近一次暫停, 控制或傾向變更, 以及忙碌時間最近一次經 `setBusyUntil` 設定, 變更或提前解除(`companion_busy_changes`, 備份還原時保留較新者; 與暫停相同, 提前解除後重新起算並經過不應期, 不會在原忙碌時段內累積; 忙碌自然到期不是變更)中最晚者, 每個事件時刻先對齊到其後的下一個 UTC 5 分鐘格點(同一格內任何時刻確認的送達或 skip 開始同一個 epoch); 累積量 H 只在 T0 之後以 UTC 5 分鐘整倍數對齊的格點上累加 λ·5/60; 每個 epoch 一個種子均勻數 u=sha256(`subject:target:hazard:T0`), 在第一個 λ>0 且 H≥−ln u 的格點觸發. 觸發時刻是狀態與種子的函數, 狀態包括她送達的原始確認時刻與因此持久化的 E0 錨點: 場景中該則主動訊息的接受時刻就是原始確認時刻, 它持久化的 OpenHer 狀態(E0)錨定在此, 不移到格點(主控 2026-09-28 裁定); 張力模型的送出釋放同樣從原始確認時刻起算(與前臺讀取的場景投影一致); skip 記下的 P_dec 取判斷所在格起點(不早於 E0)的總張力. 因此在相同時刻確認送達的檢查結果完全相同: 對齊格點的每分鐘與每 5 分鐘檢查都在觸發的格點上判斷並確認, 得到同樣的 seed, 世代, epoch, 觸發時刻, 判斷, P_dec 與送達格. 不對齊格點的檢查相位(或例如 3 分鐘的間隔)在同一格內較晚確認送達: 下一個 epoch 仍從同一格點開始並用同一個 u, 但 E0 與釋放隨原始確認時刻而異, 之後的 epoch 可能因此提前或延後, 不以一個格點為上界(張力接近 θ 時可相差數個格點; 驅力 seed 鍵含原始送達時刻的摘要, 也可能不同); 結果完全相同只對在格點上確認送達的檢查成立. 同一格內但先後次序不同的使用者訊息是不同的狀態, 不在此保證內. 張力發生的每個重評時刻都在格點上: 從檢查起算的時長(`wait` 後備以判斷所在格與最近互動所在格計算, 上下文過大的一小時與宿主延後從判斷所在格起算)與軟時段或例外的結束(例如晚安後 12 小時)一律向上取整到下一個 UTC 5 分鐘格點; 張力發生的機會列以檢查所在格的起點建立, 效期因此相同; 對張力發生而言, 軟時段從其開始算到其結束後的下一個 UTC 5 分鐘格點, 判斷指紋, 軟時段延後, 破例路徑(每例項一次的破例與其判斷), 以及核准入列與宿主取件時的軟時段比對都如此讀取: 不在格點上結束的時段(例如晚安在接受後 12 小時又 1 毫秒結束)在其最後一格內被任何檢查以相同方式判斷, 延後的判斷在其後的格點才到期; 只有按時間結束的時段如此延伸: 晚安被格內一則直接使用者訊息結束時(該訊息在格起點之後, 不晚於檢查時刻), 格起點的晚安綁定不再帶入, 使用者訊息是狀態變化, 不影響 tick 等價; 其它機會(例如不是使用者指定時間的提醒)的重評時刻, 指紋與軟時段規則仍按 M1 取檢查當下. 因此在同一 epoch 內, 任何不超過 5 分鐘的檢查間隔都在同一格內觸發, 判斷, 經延後重判並送達(送達格相同, 確認時刻在格內可能不同). 不在此保證內的只有: 病理防護(G1 到 G3)以原始時刻解除; 使用者訊息等不在格點上的輸入變化使重建的列重判時, 重判在變化後的第一次檢查. 間隔更長時送達可能落在較晚的格內; 張力越過 θ 後觸發機率隨時間上升, 不是條件一到就發. 鐘點相依: 張力模型沒有鐘點, 固定間隔或最小間隔常數, 時刻相依只來自使用者節律(S5, 乘性, 下限 0.5), 她的生活(S7), 聊天中的時段承諾, 以及她自己的狀態: E0 的 initiative 與 warmth(ι)由 OpenHer 依當地時刻(`timeOfDay`, openher.ts)算出, 屬於她自己的狀態而保留(主控 2026-09-28 裁定); 平移不變性測試因此在張力庫層進行, 流程層把同一情境平移非整日時長, P 與觸發時刻可能因此略有差異. 觸發後每次檢查至多物化一個新發生, 取觸發點上合格貢獻最大的主導 seed(同分時 followup > recall > check_in > longing > share): longing, share 與 check_in 物化為 `drive` 機會, followup 為 `experience`/`followup`, recall 為 `recall` 機會(basis `{kind:"memory",id,revision}`). 機會列帶 `seed_kind`(提醒為 `reminder`, 硬時段結束的想念為 `window_end`)與 `pressure`(僅張力發生; 觸發點記錄, 不超過 2KB: `firedAtMs`, `epochStartMs`, `u`, `H`, `P`, `total`, `thetaEff`, `lambda`, `dominant`, `contributions`, `receptivity`, `life`, `softFactor`, `tendencyRevision`, 以及 seed 鍵, 世代與機會鍵); 這些數值不進入任何模型輸入. 後續機會因此不在使用者一說完就判斷, 而是大約 1 到 6 小時後的機率事件. 世代: seed 鍵為 `drive:<targetId>:<episode>`(longing, share), `check_in:<targetId>:<episode>`, `source:<id>:<revision>`(後續)與 `memory:<id>:<revision>`(再喚起); 第 n 代(n≥1)的機會鍵在 seed 鍵後加 `~g<n>`, 第 0 代就是原鍵. 某代被 skip 時, `companion_judgments` 記下 `seed_key`, `seed_kind`, `generation` 與當下張力 `pressure_at_decision`(P_dec; M1 留下的舊 skip 列沒有 P_dec, 視為 3.0), 該 seed 此後只在總張力超過 P_dec+0.5 時合格, 才開下一代; 其它 seed(新的 basis)不受此限; 張力夾值讓代數自然有限. 危險率只讀合格 seed 的張力之和(記錄中的 `P`; 含已用盡 seed 的總和記為 `total`, P_dec 與合格判定都以總和計): 被 skip 而尚未重新合格的 seed 不計入, 較小的 seed(例如剛開始上升的後續)因此不會搭著已用盡的想念越過 θ, 已用盡的 seed 在總和超過其 P_dec+0.5 時才再計入. 已確認送達或已關閉(重開事件, 或張力發生送達失敗)的 seed 鍵不再開新發生, 其來源也不再計入(與 S4 同一等待情節已導致送達後為 0 同理). 被 skip 的某代在實質輸入指紋改變且其機會列被重建時(來源, 活動, 畫像, 控制或聯絡設定變化), 與 M1 相同地重判同一發生(不開下一代, 不經危險率); 只有傾向或軟時段改變而列未重建時 skip 保持. 送出後釋放張力: 她對該角色確認送達的每則訊息, 按其 seed(機會列的 `seed_kind`, M3 前的舊列按種類推得; 張力模型與場景投影共用同一對應, 前臺, 主動與關係讀取一致)在讀取時從 connection frustration 扣除釋放量(longing, share, check_in, window_end 1.5; recall 1.0; followup 0.75; share 另扣 expression 1.0; 提醒 0), 隨 frustration 衰減率回升, 不訓練, 不持久化. 遲滯標記(`companion_judgments` 的 `pressure_marker`)只在張力聯絡(drive, recall, 後續)或硬時段結束的想念(`window_end`)對該角色確認送達時寫入, `wait`/`skip`/送達失敗都不鎖閘門; 標記只讀最近一次鎖住它的送達所表達的 seed(扣除釋放後): 想念, 分享與硬時段結束的想念讀 S1(與 M1 只讀 connection 相同), 後續, 再喚起與關心讀該 seed 自己, 它送出後不再計入, 因此在下一個格點即清除; 在某個格點跌破 θ_off 時清除並記下清除時刻, 重算不會把觸發移到清除之前; 未送出的後續, 再喚起等有界來源不阻止清除, 因此使用者一直不回時仍可能有第二則. `drivePressure()` 保留, 只作為測試注入 S1/S4 的接縫(注入時只在檢查當下評估一個格點). 已物化的發生在機會列被取消後照 M1 方式重建並沿用判斷, 不再經危險率: 一個 episode 從使用者最近一次活動或對該角色最近一次確認送達開始, 到下一次為止; 忙碌變更, 對其他角色的送達等使 `activity.revision` 前進的變化只進入機會列的識別並重建機會列, 重建的列沿用已存的 `wait`(及其重評時間)或 `skip`. episode 重開: 驅力發生在確認送達前被結束時, 記一筆重開事件(`companion_drive_reopens`, 每個發生一筆, 該發生此後不再重建), 事件時間(晚於 episode 起點者, 依時間取前 2 筆)納入 episode 識別, 下一次檢查可重新建立機會並重判一次. 重開事件有三種: 驅力正文 5 分鐘內未被宿主取走, 且其間上下文未變而原樣過期(`contact_context_expired` 的 `body_expired`, 只記這一筆正文所屬的發生; 同時被取消的其它待發列, 例如旁邊已延後的驅力, 不記重開, 其 `wait` 記憶不受影響), 硬時段開始時取消(`contact_restriction_hard`, 只算尚未交給宿主的列, 已 `sending`/`unknown`/確認送達者不算), 以及送達失敗(`failed`; 該機會列標為 `cancelled`, 清除該發生判斷記憶中的 `send`, `wait`/`skip` 記憶不受影響). 每個 episode 最多重開 2 次(連續送達失敗同樣計入), 之後等使用者活動或確認送達開始新 episode; 使用者糾正, 關閉或場景版本變化造成的取消不是重開事件; 正文因來源, 活動, 畫像, 控制, 聯絡設定或軟時段變化而失效時同樣以 `contact_context_expired` 取消, 但原因為 `context_changed`, 不記重開. 後續機會, 提醒與硬時段結束的想念送達失敗的既有語義不變, 不自動重試. 張力發生(後續, 再喚起)送達失敗時該發生即結束: 記一筆 `pressure_delivery_failed` 關閉事件(不計入驅力 episode 識別), 已核准的列保留但不再佔住該角色, 其它 seed 照常觸發; 再喚起比照驅力重開, 下一次檢查可開下一代重判, 每個 seed 鍵至多 2 次; 後續不重試. 再喚起的正文 5 分鐘內未被宿主取走且上下文未變而原樣過期時同樣結束(同樣記為 `pressure_delivery_failed` 關閉事件, 不計入驅力 episode 識別), 與送達失敗合計每個 seed 鍵至多重開 2 次, 不會每次檢查重建並重判同一個發生; 後續的正文過期維持 M1 語義. 回執為 `unknown` 時發生仍未結束. 回滾還原時, 遲滯標記列(`companion_judgments` 中該角色的驅力標記列)與確認送達回執一樣按 `updated` 保留較新者, 因此備份之後確認送達的驅力聯絡在還原後仍鎖住閘門, 不會立即再開 episode; 一般判斷記憶仍用備份版本. M1 的固定閾值 `CompanionFlow.driveThresholds` 已刪除. 常量問候鍵 `daily` 已移除, 新狀態沒有內在張力時不會產生問候. 開庫時的一次性遷移(`companion_schema_marks` 中的 `scheduler_v3`)把所有未消費的 `daily` 機會(舊版每分鐘的 `wake:<分鐘>` 與舊常量問候)標為 `cancelled`, 其未交給宿主的正文(`draft`/`ready`)一併取消(`result_code:"scheduler_migrated"`), 已交給宿主(`sending`/`unknown`)的投遞留給其回執處理; 受影響目標的狀態原因記為 `scheduler_migrated`; 還原舊備份時同樣在開庫時遷移.

AgentJev 回答 `wait`, 或軟時段破例判斷為 `uncertain` 時, 機會改為延後而非放棄: `pollCompanion` 返回 `{status:"deferred",reason,nextCheckAtMs}`, 與落庫的機會狀態一致, 不再有連續三次延後即放棄的上限. 後備重評時間為距上次互動時間的兩倍, 夾在 1 到 12 小時之間, 從無互動時為 12 小時, 且不超過該機會自身的 24 小時效期; 上次互動只算使用者活動或對該角色的確認送達, 對其他角色的送達不縮短它. 判斷記在發生(occurrence)層的 `companion_judgments`, 附實質輸入指紋(使用者活動, 忙碌截止, 畫像與控制修訂, 關係聯絡糾正, 有效承諾, 當前軟時段, 傾向修訂); 場景版本變化只會取消並重建機會列, 指紋未變時沿用原 `wait`(及其重評時間)或 `skip`, 不再呼叫模型, 指紋改變時已延後的機會立即到期重判(張力發生的指紋中, 軟時段算到其結束後的下一個格點, 見上文), 被 skip 的機會在其列重建時重判同一發生(M1 語義; 張力發生不因此開下一代). `skip` 返回 `{status:"dismissed"}`. 宿主模型決策路徑(`proactiveDecision`)保留自身的 `delayMinutes` 與最多三次延後. 每次觸發至多一次判斷: 一個 epoch 只觸發一次, 觸發後物化的發生未結束前危險率為零, 重建的列沿用已存判斷; 同一發生之後的判斷只來自後備重評或實質輸入指紋改變.

軟時段包括軟性勿擾承諾(她自己提出的時段與舊版資料; 使用者原話指定時間並要求不要聯絡的勿擾一律是硬時段, 只說出時段而沒有要求不要聯絡的是她的軟時段, 見上表), 以及 Agent 宿主上使用者本人明確說要睡或道晚安: 該訊息在 12 小時互動視窗內仍是最新使用者訊息時, 以 `sleep:<sourceId>@<revision>` 作為軟時段綁定. 任何軟時段綁定(包括她自己提出的時段與晚安)內, 危險率乘以 μ(預設 0.25, 傾向表可在 0.1 到 0.5 之間設定), 張力發生因此明顯減少但不被禁止. 軟時段內只有驅力機會可申請破例: AgentJev 評估具體的思念候選是否可能令使用者此刻開心, 證據不足時不破例; 每個時段例項最多一次, 重疊時段必須全部允許, 已傳送或投遞不確定均佔用該次機會. 破例名額已用, 或本時段例項的破例已被判為 `negative` 時, 其它驅力機會延後到時段結束(`reason:"contact_exception_used"` 或 `"contact_exception_declined"`), 不再每次檢查都擋在佇列前; `negative` 記在時段層(`companion_quiet_declines`), 同一時段例項內其它發生不再申請, 新的時段例項(例如新的晚安或承諾修訂)重新可申請. 承諾提醒與後續機會不會改寫成思念訊息: 使用者自己在原文中指定時間的提醒(期限或提醒時間的原文出自使用者的已接受來源)準時送出, 提醒優先於同時到期的其它機會, 只記錄所在時段而不佔用破例, 也不受防護欄阻擋; 其它提醒和後續機會延後到時段結束(`reason:"soft_window"`)再判斷. 使用者負面反饋經原文與實際破例訊息綁定後, 在正常回復中按角色口吻道歉: 承諾時段的剩餘有效期改為硬約束; 睡眠時段破例後使用者的第一則回覆明確表示不快時, 在使用者下一則訊息前一律不主動聯絡. 使用者糾正, 取消和來源撤銷仍走已有生命週期. 非 Agent 宿主(舊版酒館伴侶聊天)沒有本地破例判斷: 晚安不構成軟時段; 承諾軟時段內只放行使用者指定時間的提醒, 其餘待發內容取消(`reason:"contact_restriction_soft"`). AgentJev 不再因上下文帶有 `sleepBoundary` 而直接回答 `skip`/`negative`: 它留在判斷上下文供參考, 由既有題目判斷. 已知限制: 破例題目原文寫明使用者明確道晚安且仍適用時通知可能吵醒, 應判 `negative`, 因此真實本地模型多半會拒絕睡眠時段破例; 這是判斷結果而不是硬閘門, 題目措辭未改(另行處理).

傾向表 `companion_tendencies`(每個使用者與角色一列)保存使用者對主動聯絡的工作區設定: `disposition` 內 `thetaScale`(m_θ, 0.5 到 1.5, 預設 1), `hazardScale`(σ, 0.5 到 2, 預設 1), `followupAmplitude`(A_f, 0 到 3, 預設 2.0), `recallWeight`(0 到 2, 預設 1), `checkInWeight`(0 到 2, 預設 1), `softWindowFactor`(μ, 0.1 到 0.5, 預設 0.25); `openness`(使用者開放度 o, 0.25 到 1, 預設 1, 只能收窄); `receptivity`(是否以使用者節律調制, 預設開); `origin`(`default`, `init` 或 `workspace`), 修訂與時間. θ_eff 上限 4.5 低於張力夾值 5, 傾向無法把她設成永久沉默; 永久停止只來自硬條件(硬時段, 暫停, 關閉). SDK: `contactTendency(scope, characterId)` 返回目前值(未寫入時為預設, `origin:"default"`, `revision:0`); `setContactTendency(scope, characterId, patch, expectedRevision, origin?)` 以 `{disposition?, openness?, receptivity?}` 修改, `origin` 為 `workspace`(預設)或 `init`; 越界, 非有限數或未知鍵報 `invalid_contact_tendency`(不夾值), 修訂不符報 `context_changed_retry`. CLI 同名操作 `contactTendency`(`scope`, `characterId`; 讀取類, 旁路不排隊)與 `setContactTendency`(`scope`, `characterId`, `patch`, `expectedRevision`, 可選 `origin`; 寫入類, 排隊). 只有這兩個工作區操作與初始化會寫它: 聊天中的「以后主动点」「少找我」不改變傾向, 邀請只進判斷上下文, 邊界走時段承諾與暫停; 宿主不得因聊天中的請求呼叫 `setContactTendency`. 變更開始新的 epoch 並進入判斷指紋; 回滾還原時與聯絡設定一樣按修訂保留較新者. 開庫時為舊資料庫加入的欄位(`companion_opportunities.seed_kind`, `pressure` 與 `companion_judgments.seed_key`, `seed_kind`, `generation`, `pressure_at_decision`)以結構標記 `pressure_v1` 記在 `companion_schema_marks`.

記憶再喚起事件 `memory_reactivation_events` 是 S2 的唯一來源: Agent 伴侶模式的回覆路徑在上下文確認為當前後, 記下本輪帶回的 clear 或 gist 記憶(只存識別碼與來源修訂, 不存引文; 每個記憶每 30 分鐘一列, 寫入時刪除 7 天前的列). 主動聯絡自己的上下文不記錄, 她的聯絡不會推高自己的張力. 讀取時丟棄已不在當前快照中的記憶, 刪除, 修訂與回滾因此自然生效; 機會列與判斷記憶一樣沿用備份版本.

防護欄只擋病態模式, 預設開啟且可逐項關閉, 設定存於 `companion_guard_settings`(每個使用者每項一列, 帶修訂; 回滾還原時與聯絡設定一樣保留較新的使用者選擇): G1 同一角色 60 分鐘內已確認送達至少 4 則且期間沒有使用者活動時暫停, 直到使用者再次活動; G2 沒有使用者活動時 10 分鐘內最多 2 則; G3 同一使用者每個整點小時內 contact 類模型評估(AgentJev 聯絡判斷, 破例判斷與宿主決策)最多 6 次, 超出時暫停到該小時結束. 觸發時 `pollCompanion` 返回 `{status:"waiting",reason:"guard_G1"|"guard_G2"|"guard_G3"}`(G2, G3 附 `untilMs`), 並在 `companion_guard_events` 記一筆供觀測. SDK: `guardSettings(scope)` 返回綁定使用者的 G1-G3 設定(未設定時為預設值, `revision:0`); `setGuardSetting(scope, key, patch, expectedRevision)` 以 `{enabled?, value?}` 修改單項, 值為 G1/G2 `{windowMinutes, count}`(分鐘 1-1440, 次數 G1 2-100, G2 1-100)或 G3 `{perHour}`(1-1000), 修訂不符報 `context_changed_retry`, 值無效報 `invalid_guard_setting`; `guardEvents(scope, characterId?)` 列出觸發紀錄, 可按角色篩選. CLI 同名操作為 `guardSettings`(`scope`), `guardSetting`(`scope`,`key`,`patch`,`expectedRevision`) 與 `guardEvents`(`scope`, 可選 `characterId`).

宿主還需支援獨立後臺階段 `proactiveContext`(近 12 小時已授權互動摘要),`absenceExplanation`(使用者提前說明或返場)與 `contactResponseExpectation`(角色正文是否期待回應), 遵照各 task 的 JSON 協議返回; 後兩者在伴侶輪次中通常作為 `companionObservation` 的 part 到達. 它們不新增使用者 API 設定. 交給 AgentJev 聯絡判斷的上下文上限為 2,400 字元, 並有界: `proactiveContext` 的輸入只取能放進 20,000 字元的最新 direct 來源(較舊的略去而不報錯; 最新一則本身過長時截取其尾段); 摘要引用的來源只保留最新 8 個; 角色人設以不超過 600 字元的確定性摘要代入(有匯入的預設角色時取其結構化欄位: 名字, 與使用者的關係(關係代碼譯為中文, 例如 not_met 為「尚未相識」, 未知代碼略去), 核心性格與幾條語氣/互動說明; 否則在句末截斷, 但句末落在前一半時直接在 600 字元處截斷), 儲存的人設不變, 前臺回覆仍用完整人設. 已結束的一次性區間時段不再限制任何事, 其承諾狀態不變, 但不再進入判斷上下文與其預算(每日時段會重複, 保留). 不能略去的部分(人設摘要, 時鐘, 等待狀態與所有仍有效的聯絡時段承諾)在任何摘要任務之前先以假定的最大摘要確定性地估算(估算不是上限, 完成後仍溢出時同樣被捕捉並延後 1 小時); 放不下, 或完成後的上下文仍放不下(例如帶聯絡時段的承諾多到超出事實預算), 該機會以原因 `contact_context_too_large` 延後 1 小時(與 AgentJev `wait` 同一延後路徑), `pollCompanion` 返回 `{status:"waiting",reason:"contact_context_too_large",nextCheckAtMs}`, 並在 `companion_poll_diagnostics` 為該目標寫一筆(只按 7 天清除); 延後期間的輪詢不再重跑摘要任務, 輪詢也不再拒絕. 未回覆經歷與提前說明綁定各自來源, 跨過 12 小時摘要視窗也不會丟失; 推斷不代表使用者有意冷落. 時間輸入與前臺共用判斷快照, 提供 UTC, 使用者時區, 本地日期時間和星期; 作息習慣只支援"可能休息"的不確定判斷.

投遞結果 `unknown` 會停止盲目重試. 宿主核對現有訊息後呼叫 `reconcileCompanion(scope, characterId, deliveryId, outcome)`: 確認已傳送使用 `{status:'sent',hostMessageId}`, 只將現有訊息作為接受來源學習; 確認未傳送使用 `{status:'failed',code:'confirmed_absent'}`, 釋放後續機會, 舊訊息不會重發.CLI 同名操作支援以上欄位. 不能以網路超時作為"確認未傳送"的證據.

## 驗收範圍

SDK/佇列元件測試, 原生宿主子代理測試和長期體驗分別報告. 真實宿主驗收結果見工作區 `PROJECT_STATUS.md` 所引用的執行目錄; 介面程式碼與此說明本身不代表任何宿主已驗收.
