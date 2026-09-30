# XLDB Agent

XLDB Agent 讓你自己的 Agent 擁有連續的記憶、情緒與角色經歷。它是一個本地常駐 daemon 加命令列工具（CLI），不需要 SillyTavern，可用於長期伴侶，以及單角色或多角色的跑團與角色扮演。

> **目前狀態：開發快照，不是正式版。** 最後一個正式版本是 `agent-v0.1.3-mvp`。本倉庫 `main` 分支是其後的開發快照，尚未打標籤，也未完成整套驗收。想要穩定使用請下載 [Releases](https://github.com/lty418905-blip/XLDB/releases) 中的正式版 `XLDB-Agent.zip`。

## 這是什麼

XLDB Agent 不自帶聊天模型，也不是一個獨立的聊天程式。它由**你提供的宿主 Agent** 驅動：宿主負責和你對話，XLDB 負責保存與整理狀態，並把需要模型推論的工作（角色正文、導演、記憶整理、情緒、世界狀態、畫像等）拆成一個個作業，交由宿主以全新上下文的子代理執行。前臺角色只拿到經過篩選、該角色應該知道的內容。

宿主 Agent 需要能：

- 在本機執行命令；
- 讀寫本地檔案；
- 啟動彼此獨立、全新上下文的子代理。

主要功能：

- **伴侶**：從六份內建角色（均為中文人設）中選擇，或匯入自己的角色 JSON。伴侶有延續的記憶、OpenHer 情緒、承諾與約定、可糾正的使用者習慣與關係理解，以及虛擬角色的生理狀態與示意地圖。
- **跑團與角色扮演**：告訴 Agent 世界、人物與開場，XLDB 建立獨立的任務；導演預設開啟，並保持每個角色的知情範圍與劇情狀態。跑團內容不會被當成真實使用者的畫像。
- **自然記憶**：事實與情景分開記錄；外圍細節隨時間模糊，重要事實與承諾受保護；之後出現相關線索時，模糊的記憶可以依原本的可見範圍被重新喚起。
- **資料管理**：來源糾正、儲存點、分支、撤銷、備份與恢復。伴侶與跑團的資料分開儲存。

### 與 XLDB-sillytavern 倉庫的關係

XLDB 有兩個入口，共用同一套核心程式（`shared/`）：

| 倉庫 | 內容 | 宿主 |
|---|---|---|
| [XLDB](https://github.com/lty418905-blip/XLDB)（本倉庫） | `shared/` + `companion-agent/` | 你自己的 Agent |
| [XLDB-sillytavern](https://github.com/lty418905-blip/XLDB-sillytavern) | `shared/` + `sillytavern/` | SillyTavern |

兩者的資料分開儲存，不會互通。

## 目前狀態

- **正式版本**：`agent-v0.1.3-mvp`。
- **本倉庫 `main`**：0.1.3 之後的開發快照（`package.json` 仍標為 `0.1.3-mvp`）。相對於 0.1.3，主要新增常駐 daemon（`daemon ensure` / `wait`，初始化彈窗也經由它執行），並大幅改寫主動聯絡的內部判斷。
- **仍在開發中**（未完成前不要當作已提供的功能）：
  - 共用核心的記憶修復；
  - 統一劇情時鐘（核心邏輯已在程式碼中，尚未接入）；
  - 判斷模型路線：可選的線上 Jev 判斷服務（見下方「設定」）屬於計劃，這個快照不包含；
  - daemon 內的主動聯絡投遞與空閒個人學習；
  - 主動聯絡新判斷規則的完整接入與長期驗收。

## 需求

- Windows x64。
- 一個符合上述條件的宿主 Agent。
- 首次安裝需要網路與約 5 GB 可用空間。不需要預先安裝 Node.js 或 Python：安裝器會視需要下載便攜版本，所有執行時、模型與快取只放在工作區的 `.local/`，不修改全域環境。

## 安裝

完整步驟見 [INSTALL_AGENT.md](INSTALL_AGENT.md)。最簡單的方式是把解壓後的資料夾交給你的 Agent，並告訴它：

> 按 INSTALL_AGENT.md 安裝 XLDB，然後引導我完成設定。

手動安裝時，在解壓後的根目錄執行：

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File tools/setup.ps1 -Mode Agent
```

- 安裝器會下載並組裝本地 AgentJev 模型與便攜執行時，逐項校驗 SHA-256。
- 安裝完成後，後續命令使用 `.local/install/install-receipt.json` 中 `nodePath` 指向的 Node；下方命令中的 `node` 即指這個 `nodePath`。

接下來由 Agent 依 `.agents/skills/xldb-agent/SKILL.md` 操作。每次會話的基本流程：

```powershell
node companion-agent/adapters/cli.mjs daemon ensure       # 啟動或沿用常駐 daemon
node companion-agent/adapters/cli.mjs onboard REQUEST_JSON # 首次啟用伴侶：開啟角色選擇彈窗
node companion-agent/adapters/cli.mjs run REQUEST_JSON     # 每一輪互動
node companion-agent/adapters/cli.mjs daemon stop          # 會話結束
```

- 伴侶的選擇與確認由你本人在瀏覽器彈窗中完成；關閉或取消彈窗不會啟用新角色。
- 自訂角色可以交給其他 AI 工具創作，參考 [創作指南](companion-agent/docs/CHARACTER_CREATION_GUIDE.md) 與 [填寫模板](companion-agent/docs/CHARACTER_TEMPLATE.md)。

請求欄位與完整介面見 [companion-agent/docs/AGENT.md](companion-agent/docs/AGENT.md)。

## 設定與外部服務

XLDB 不內建任何金鑰。

| 用途 | 服務 | 送出的資料 |
|---|---|---|
| 所有文本推論（角色正文、導演、記憶、情緒、世界、畫像等） | 你的宿主 Agent 所用的模型，經由它的子代理執行。XLDB 本身不直接呼叫聊天模型 API，也不需要另外填聊天模型金鑰 | 每個作業所需的對話、角色與狀態內容 |
| 語義檢索與重排（建議） | 你在 `.local/agent/retrieval-api.txt` 填寫的 embedding 與 reranker 服務，例如 SiliconFlow 上的 bge-m3 與 bge-reranker-v2-m3 | 當前查詢，以及該角色被允許檢索的記憶文本 |
| 地點公開資料（伴侶，按需） | 宿主 Agent 的聯網搜尋 | 只有你本輪明確提到的地點名稱 |
| 本地判斷模型 AgentJev | 在本機執行 | 不離開你的電腦；安裝時從本專案 GitHub Release 下載 |
| 線上 Jev 判斷（**計劃中**，此快照不包含） | 你自行設定時才使用的 OpenCode Zen Jev | 計劃：判斷所需的狀態文字 |

檢索設定檔的格式（UTF-8 JSON，金鑰只寫在檔案裡，不要在聊天中傳給 Agent）：

```json
{
  "embedding": {"baseUrl": "", "key": "", "model": ""},
  "reranker": {"baseUrl": "", "key": "", "model": ""}
}
```

API 地址可填根地址或完整的 embeddings / rerank 端點。未設定時使用本地 BM25 關鍵詞檢索，品質較低；兩者可以分別設定。

## 隱私

- **資料存放在本機。** 資料庫與索引預設在 `.local/agent/data`，以明文保存，不加密。請不要上傳 `.local/` 或檢索設定檔。
- **送往模型的內容。** 所有文本推論都經過你的宿主 Agent，因此對話、角色與狀態內容會送往宿主所用的模型服務，並受其政策約束。伴侶模式的內容可能包含私密或親密內容。
- **送往檢索服務的內容。** 設定 embedding 或 reranker 後，查詢與允許檢索的記憶文本會送往你填寫的服務。
- **位置。** 首次啟用伴侶時，你可以選擇是否允許瀏覽器定位；只有你同意並確認後才保存這一次的位置。拒絕後伴侶地圖關閉，XLDB 不會從 IP 推測你的位置。地點查詢只送出你本輪明確提到的地點名稱。
- **學習與畫像。** 伴侶對你的習慣與偏好的理解是假設性的，可以查看、糾正、刪除，也可以關閉學習。
- **判斷服務（計劃中）。** 日後若加入並由你設定線上 Jev 判斷，判斷所需的狀態文字（伴侶狀態可能含親密內容）會送往 OpenCode Zen。
- **內容政策。** XLDB 不額外加入內容審查或題材限制；你所用模型服務的內容政策照常適用。

## 已知限制

- 只支援 Windows x64。
- 宿主必須支援全新上下文的子代理；不支援時 XLDB 無法運作，不會改為自行呼叫外部 API。
- 每輪伴侶互動會派發多個子代理作業，延遲與費用取決於你的宿主與模型。較弱的模型容易產生不合格式的輸出，這一輪會被拒絕並需要重試。
- 主動聯絡需要宿主長時間執行並能投遞訊息。短命令結束後不會在背景繼續；目前的常駐 daemon 也還不投遞主動訊息、不執行空閒個人學習，這兩者只在以 SDK 長駐的宿主中可用。
- 地圖是示意圖，沒有內建真實底圖。
- 內建角色與部分提示詞只有中文；英文場景的品質可能較低。
- 自動儲存點目前每次保存完整快照，資料量會隨訊息數明顯增長。
- 在真實宿主中的完整長期驗收尚未完成；安裝成功只代表依賴與核心可用。

## 許可

本專案使用**自訂許可，不是開源許可證**，也不屬於公共領域。摘要如下（以 [LICENSE.md](LICENSE.md) 全文為準）：

- **允許**：個人為非商業學習目的下載、保存、閱讀，並依隨附說明在本地安裝、設定和執行。
- **未經權利人書面授權不得**：分發、轉載、鏡像或再發佈全部或實質部分（包括修改版與安裝包）；修改原始碼或製作衍生作品；用於任何商業用途。
- 第三方元件保留各自的許可證；GitHub 服務條款已授予的平臺內檢視與 Fork 等權利不受影響。
- 按現狀提供，不附任何擔保。

## 第三方聲明

詳見 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。摘要：

- **OpenHer**（Apache-2.0，固定版本 `ef5b214`）：`shared/src/emotion/neural.ts` 與 `shared/src/emotion/openher.ts` 為其 TypeScript 移植與修改；許可全文見 `shared/third-party/OpenHer-LICENSE`，採用說明見 [shared/docs/OPENHER_ADOPTION.md](shared/docs/OPENHER_ADOPTION.md)。
- **AgentJev**（原始碼與模型卡均為 Apache-2.0）：推論程式的採用部分與模型權重，許可見 `shared/third-party/agentjev/`。
- **安裝時取得的依賴**：Node.js、LanceDB、TypeScript，以及 AgentJev 執行時的 Python、PyTorch（CPU）、Transformers、Safetensors 等，各自適用其許可證。

## 回報與支援

- 問題與建議請在本倉庫的 GitHub Issues 提出，附上版本、命令輸出中的錯誤碼與重現步驟。**請勿貼上 API 金鑰、檢索設定檔、`.local/` 中的資料或作業檔。**
- 備份、遷移與恢復見 [shared/docs/RECOVERY.md](shared/docs/RECOVERY.md)；檢索細節見 [shared/docs/RETRIEVAL.md](shared/docs/RETRIEVAL.md)；地圖格式見 [shared/docs/MAP.md](shared/docs/MAP.md)。
- 超出許可範圍的使用（分發、修改、商業用途）請聯絡倉庫擁有者 lty418905-blip 取得書面授權。

---

## English

*Summary only; the Chinese sections above are authoritative.*

**XLDB Agent** gives your own agent continuous memory, per-character emotion (based on OpenHer) and lived character history, for a long-term companion or for single- and multi-character roleplay. It is a local resident daemon plus a CLI, and it needs no SillyTavern. It ships no chat model. A **user-provided host agent** that can run local commands, read and write files and spawn fresh-context subagents drives it. XLDB turns every model task (prose, director, memory, emotion, world and profile) into a job, and the host runs each job in a fresh subagent. The SillyTavern entry lives in the sibling repository [XLDB-sillytavern](https://github.com/lty418905-blip/XLDB-sillytavern). Both share the `shared/` core but keep separate data.

**Status.** The last tagged release is `agent-v0.1.3-mvp`. This `main` branch is an untagged development snapshot, and `package.json` still says 0.1.3-mvp. Since 0.1.3 it adds the resident daemon and reworks proactive-contact internals. Memory fixes, the unified story clock (core logic present, not wired in) and judge routing are in progress. The optional hosted Jev judge is planned and not included. Proactive-contact delivery and idle personal learning inside the daemon are also still in progress, and full long-term acceptance in a real host is not complete.

**Install** (Windows x64, network access and about 5 GB free): hand the folder to your agent with "Install XLDB following INSTALL_AGENT.md", or run `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File tools/setup.ps1 -Mode Agent`. Your agent then follows `.agents/skills/xldb-agent/SKILL.md`. After installation, `node` in the commands means the `nodePath` recorded in `.local/install/install-receipt.json`.

**Configuration and privacy.** No keys are bundled. All text inference goes through your host agent's model. Put embedding and reranker settings in `.local/agent/retrieval-api.txt`, for example SiliconFlow bge-m3 and a reranker. Those providers receive queries and permitted memory text. Without them XLDB falls back to local BM25. AgentJev runs locally. Place lookups send only a place name you named, through the host's web search. Data is stored locally, unencrypted. Companion content can be private or intimate, and it goes to your host's model provider. Browser location is used only if you allow and confirm it during first companion setup; declining turns the map off, and XLDB never infers location from your IP. What the companion learns about your habits and preferences is a hypothesis you can view, correct, delete or switch off.

**Known limitations.** Windows only. The host needs fresh-context subagents, and each turn dispatches several jobs. Proactive contact needs a long-running host, and the daemon does not deliver contact messages yet. Built-in characters are Chinese. The map is schematic. Automatic savepoints currently store a full snapshot each time, so data grows noticeably with message count.

**Licence.** A custom licence, not open source. Personal, non-commercial study use, including local install and running, is allowed. Redistribution, modification and commercial use require written permission. Third-party parts (OpenHer and AgentJev, both Apache-2.0) keep their own licences. See [LICENSE.md](LICENSE.md) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

**Feedback.** Please use GitHub Issues and never post keys or private data.
