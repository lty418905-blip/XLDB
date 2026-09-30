# 共用地圖狀態

地圖狀態由 SillyTavern 跑團和 Agent 伴侶共用同一 SQLite 權威, 來源生命週期與角色知情規則. 兩種入口的世界/會話/分支範圍隔離, 不會互相匯入經歷. 酒館 JavaScript 繪製 SVG 示意圖;Agent 讀取按角色篩選的投影和上下文. 示意圖座標不代表經緯度或實際距離. 當前未內建現實底圖;Agent 可通過宿主聯網搜尋獲取使用者本輪明確提及地點的公開資料, 僅用於本輪迴答.

## 開始使用

酒館進入"地圖 → 地圖設定與匯入", 讀取地圖設定並選擇顯示方式. 酒館跑團接入後適用的地理處理直接開啟, 除導演外沒有逐功能啟停開關.Agent 伴侶在首次人設確認時請求定位許可權; 同意後預設啟用伴侶地圖, 拒絕後關閉地圖且不存座標. 這個選擇不影響獨立的跑團範圍, 也不授權 IP 定位.Agent 可通過 `geographyStatus` 檢視狀態, 通過 `configureGeography` 調整已授權地圖的顯示及正文跟隨. 可任選下列方式, 也可以組合使用:

- **跟隨正文**: 酒館的 `geography` 階段預設繼承統一文本模型 API 設定, 必要時可單獨覆蓋;Agent 委派宿主獨立子代理. 有效地理變化先隨本輪使用者正文提交, 再生成回覆; 助手候選在接受後生效. 計劃, 回憶和僅僅提及目的地不等於到達.
- **背景整理**: 酒館使用同一 `geography` 階段設定,Agent 使用 `previewGeographyBackground` 委派宿主獨立子代理. 填寫背景, 或在酒館勾選角色卡/世界書來源, 生成預覽並確認. 未選資料不傳送. 模型必須為每項候選引用來源原文; 原文, 雜湊及匯入 JSON 路徑留存於管理員資料, 玩家匯出不包含全量背景.
- **JSON 匯入**: 貼上 `xldb-map-v1` 檔案, 選擇作者設定或角色得到的地圖/傳聞, 預覽後確認. 可省略所有座標. 匯入與手動糾正不需要呼叫模型.

背景整理只抽取已有資訊. 原文沒有道路, 就不因兩個地點相鄰而畫一條路;"步行半天"儲存文字, 分鐘數保持 `null`. 模型質量仍影響抽取, 需核對預覽中的地點, 關係, 位置及知情範圍.

## JSON 示例

```json
{
  "format": "xldb-map-v1",
  "mapId": "river-country",
  "revision": 1,
  "basis": "author_setting",
  "defaults": {"knownBy": ["player"]},
  "places": [
    {"id": "town", "name": "河灣鎮", "kind": "settlement"},
    {"id": "forest", "name": "北林", "kind": "area"},
    {"id": "pier", "name": "東碼頭", "kind": "landmark"}
  ],
  "relations": [{"id": "forest-north", "from": "forest", "to": "town", "kind": "north_of"}],
  "routes": [{
    "id": "town-pier", "from": "town", "to": "pier", "direction": "east",
    "passability": "unknown", "travel": {"text": "步行半天", "mode": "walk", "minutes": null}
  }],
  "initialPositions": [{"actorId": "player", "position": {"state": "at", "placeId": "town"}}]
}
```

`worldId` 可省略; 填寫時必須匹配當前世界. 修改同一地圖時遞增 `revision`; 相同 ID, 版本與內容重複匯入不會複製資料, 同版本不同內容會被拒絕. 初始位置不會覆蓋已經接受的劇情位置, 預覽會列出衝突.

每項 `knownBy` 覆蓋 `defaults.knownBy`;`[]` 表示不向任何角色公開.`player` 是玩家,NPC 使用名單中的穩定 ID. 作者設定並不代表所有角色自動知曉. 普通地圖, 上下文, 佈局與匯出均按讀者過濾;NPC 私有密道不能改變玩家佈局或路線.

地點 `kind` 支援 `world`,`region`,`area`,`settlement`,`site`,`landmark`,`building`,`room`,`other`.`parentId` 表示包含層級; 同名地點仍須使用不同 ID.`placement:"unlocated"` 可明確保留未定位地點.

方向關係支援 `north_of`,`south_of`,`east_of`,`west_of` 及四個對角方向, 也支援 `inside`,`adjacent_to`,`connected_to`,`near`,`above`,`below`,`other`. 路線的 `passability` 為 `open`,`blocked` 或 `unknown`. 佈局不會把方向關係自動變成可通行道路.

可選佈局格式為 `{"basis":"schematic","axes":"x-east-y-south","nodes":{"town":{"x":50,"y":60}}}`, 放在檔案 `layout` 欄位中. 座標範圍 0-100,`axes:"free"` 表示無方位關係圖. 地圖頁支援層級選擇與拖動; 儲存佈局只改變獨立佈局修訂, 不改變角色位置, 地理事實或時鐘. 佈局與方向衝突時會顯示提示, 可在設定中改用無方位佈局.

## 糾正與恢復

設定中的"地理糾正 JSON"可提交帶原因和知情範圍的修改. 例如明確玩家已位於河灣鎮:

```json
{
  "basis": "author_setting", "knownBy": ["player"], "reason": "更正場景起點",
  "operation": {"kind": "position", "action": "set", "actorId": "player", "position": {"state": "at", "placeId": "town"}}
}
```

`position.state` 還支援 `within`(區域內具體位置不詳),`in_transit`(行進中)和 `unknown`.NPC 位置按玩家最後獲知的資訊顯示, 不作為即時定位. 地點, 關係, 通路糾正分別使用 `place/upsert`,`relation/upsert|remove`,`route/upsert|remove`, 內容放入同名欄位.

地圖基線, 正文來源, 糾正和佈局隨儲存點, 撤銷, 分支及重啟恢復. 編輯或刪除來源後, 其失效位置和關係不繼續進入地圖. 酒館隱藏顯示仍繼續地理處理;Agent 可單獨關閉伴侶範圍的後續提取. 重啟不會重新呼叫模型解釋已接受的地圖歷史.

Agent 伴侶可用 `geographyStatus`,`configureGeography`,`previewGeographyImport`,`previewGeographyBackground`,`importGeography`,`exportGeography`,`correctGeography`,`clearGeographyCorrection` 與 `saveGeographyLayout`. 請求與版本欄位見 [Agent 直接介面](AGENT.md).Agent 的臨時跑團任務使用另一個作用域; 伴侶命令不接收跑團作用域.

使用者本輪明確提到地點時,Agent 宿主可給 `recall` 或 `turn` 傳入原文中的 `placeQuery`, 委派獨立子代理搜尋附來源的公開地點資料. 這只是本輪迴答上下文, 不會自動寫成位置經歷或地圖事實; 查不到時保持未知. 拒絕裝置定位不會觸發 IP 定位.

## 重新整理與驗證邊界

固定工作臺與摺疊變數面板共享玩家投影. 外掛收到提交回執後立即請求新投影; 後臺獨立變化通過 15 秒輪詢更新, 外掛忙碌時等待下一次空閒輪詢. 現即時間卡本地每秒更新, 劇情時間只隨有效事件變化. 切換模式, 分支或聊天會清除舊快照; 設定表單仍由使用者顯式讀取, 避免後臺重新整理覆蓋正在編輯的設定.

自動化驗證, 真實酒館與真實模型質量的當前結果見原始碼工作區 `PROJECT_STATUS.md`, 不能以 JSON 解析或介面成功代替抽取質量驗收.
