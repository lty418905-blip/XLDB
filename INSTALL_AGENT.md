# 安裝 XLDB Agent

當前處於 MVP 測試階段, 功能可能存在實際應用問題.

## 1. 安裝

在解壓後的根目錄執行:

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File tools/setup.ps1 -Mode Agent
```

支援 Windows x64; 首次安裝需要網路和約 5 GB 可用空間. 執行時,AgentJev 權重, 依賴及快取僅儲存到工作區 `.local/`, 不會安裝全域 Python 或 npm 包. 模型資源由隨包清單固定到已驗證的資源版本, 安裝器逐項校驗 SHA-256. 安裝後從 `.local/install/install-receipt.json` 讀取 `nodePath`, 後續命令使用該路徑.

## 2. 首先請使用者填寫檢索設定

安裝完成後,Agent 直接告訴使用者:

> 請在當前工作區新建 `.local/agent/retrieval-api.txt`, 按下面模板填寫 embedding 和 reranker 的 API 地址, 金鑰及模型名, 儲存後告訴我. 金鑰只填寫在檔案中, 不用發到聊天裡.

```json
{
  "embedding": {"baseUrl": "", "key": "", "model": ""},
  "reranker": {"baseUrl": "", "key": "", "model": ""}
}
```

TXT 使用 UTF-8, 內容保留上述 JSON 格式;API 地址可填寫根地址或完整 embeddings/rerank 端點. 模型名使用服務提供方給出的標識. 查詢與允許檢索的記憶文本會發往所填服務.CLI 自動讀取該檔案, 已有設定直接複用. 若使用者明確暫不設定, 可繼續本地關鍵詞檢索.

## 3. 選擇入口

- **伴侶**:Agent 開啟角色選擇彈窗, 選擇六份預設之一, 或載入自己的角色 JSON; 檢視資料並確認後才開始啟用. 關閉或取消彈窗不會啟用新角色.
- **跑團/角色扮演**: 根據使用者提供的世界, 人物與開場建立獨立任務; 導演預設開啟, 所有文本推理交由 Agent 自己的獨立子代理執行.

隨後讀取 `.agents/skills/xldb-agent/SKILL.md`. 每次會話先執行 `node companion-agent/adapters/cli.mjs daemon ensure` 啟動(或沿用)常駐 daemon, 再開啟角色選擇彈窗或進入其任務迴圈; 會話結束時 `daemon stop`. 角色正文經過篩選的上下文生成, 使用者確認接受後再提交助手候選. 不要將跑團內容作為真實使用者畫像.

自訂角色可交給其他 AI 工具創作. 把 [詳細創作說明](companion-agent/docs/CHARACTER_CREATION_GUIDE.md) 和 [填寫模板](companion-agent/docs/CHARACTER_TEMPLATE.md) 交給它, 完成後匯出 JSON 並在彈窗載入. 可匯入的示例檔案位於 `companion-agent/presets/custom-character.template.json`. 支援原創角色, 作品角色及使用者提供的真實人物背景; 先說明自己的核心需求, 再由創作工具補全人生, 社會關係和生日.

## 更新

解壓新版本到獨立目錄, 按照 [恢復說明](shared/docs/RECOVERY.md) 備份並遷移資料; 不要覆蓋執行中的資料庫. 模型校驗匹配時安裝器複用已有檔案. 金鑰與 `.local/agent/` 資料不應上傳到 GitHub.
