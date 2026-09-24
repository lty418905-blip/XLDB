# 共用地图状态

地图状态由 SillyTavern 跑团和 Agent 伴侣共用同一 SQLite 权威、来源生命周期与角色知情规则。两种入口的世界／会话／分支范围隔离，不会互相导入经历。酒馆 JavaScript 绘制 SVG 示意图；Agent 读取按角色筛选的投影和上下文。示意图坐标不代表经纬度或实际距离。当前未内置现实底图；Agent 可通过宿主联网搜索获取用户本轮明确提及地点的公开资料，仅用于本轮回答。

## 开始使用

酒馆进入“地图 → 地图设置与导入”，读取地图设置并选择显示方式。酒馆跑团接入后适用的地理处理直接开启，除导演外没有逐功能启停开关。Agent 伴侣在首次人设确认时请求定位权限；同意后默认启用伴侣地图，拒绝后关闭地图且不存坐标。这个选择不影响独立的跑团范围，也不授权 IP 定位。Agent 可通过 `geographyStatus` 查看状态，通过 `configureGeography` 调整已授权地图的显示及正文跟随。可任选下列方式，也可以组合使用：

- **跟随正文**：酒馆的 `geography` 阶段默认继承统一文本模型 API 设置，必要时可单独覆盖；Agent 委派宿主独立子代理。有效地理变化先随本轮用户正文提交，再生成回复；助手候选在接受后生效。计划、回忆和仅仅提及目的地不等于到达。
- **背景整理**：酒馆使用同一 `geography` 阶段配置，Agent 使用 `previewGeographyBackground` 委派宿主独立子代理。填写背景，或在酒馆勾选角色卡／世界书来源，生成预览并确认。未选资料不发送。模型必须为每项候选引用来源原文；原文、哈希及导入 JSON 路径留存于管理员数据，玩家导出不包含全量背景。
- **JSON 导入**：粘贴 `xldb-map-v1` 文档，选择作者设定或角色得到的地图／传闻，预览后确认。可省略所有坐标。导入与手动纠正不需要调用模型。

背景整理只抽取已有信息。原文没有道路，就不因两个地点相邻而画一条路；“步行半天”保存文字，分钟数保持 `null`。模型质量仍影响抽取，需核对预览中的地点、关系、位置及知情范围。

## JSON 示例

```json
{
  "format": "xldb-map-v1",
  "mapId": "river-country",
  "revision": 1,
  "basis": "author_setting",
  "defaults": {"knownBy": ["player"]},
  "places": [
    {"id": "town", "name": "河湾镇", "kind": "settlement"},
    {"id": "forest", "name": "北林", "kind": "area"},
    {"id": "pier", "name": "东码头", "kind": "landmark"}
  ],
  "relations": [{"id": "forest-north", "from": "forest", "to": "town", "kind": "north_of"}],
  "routes": [{
    "id": "town-pier", "from": "town", "to": "pier", "direction": "east",
    "passability": "unknown", "travel": {"text": "步行半天", "mode": "walk", "minutes": null}
  }],
  "initialPositions": [{"actorId": "player", "position": {"state": "at", "placeId": "town"}}]
}
```

`worldId` 可省略；填写时必须匹配当前世界。修改同一地图时递增 `revision`；相同 ID、版本与内容重复导入不会复制数据，同版本不同内容会被拒绝。初始位置不会覆盖已经接受的剧情位置，预览会列出冲突。

每项 `knownBy` 覆盖 `defaults.knownBy`；`[]` 表示不向任何角色公开。`player` 是玩家，NPC 使用名单中的稳定 ID。作者设定并不代表所有角色自动知晓。普通地图、上下文、布局与导出均按读者过滤；NPC 私有密道不能改变玩家布局或路线。

地点 `kind` 支持 `world`、`region`、`area`、`settlement`、`site`、`landmark`、`building`、`room`、`other`。`parentId` 表示包含层级；同名地点仍须使用不同 ID。`placement:"unlocated"` 可明确保留未定位地点。

方向关系支持 `north_of`、`south_of`、`east_of`、`west_of` 及四个对角方向，也支持 `inside`、`adjacent_to`、`connected_to`、`near`、`above`、`below`、`other`。路线的 `passability` 为 `open`、`blocked` 或 `unknown`。布局不会把方向关系自动变成可通行道路。

可选布局格式为 `{"basis":"schematic","axes":"x-east-y-south","nodes":{"town":{"x":50,"y":60}}}`，放在文档 `layout` 字段中。坐标范围 0–100，`axes:"free"` 表示无方位关系图。地图页支持层级选择与拖动；保存布局只改变独立布局修订，不改变角色位置、地理事实或时钟。布局与方向冲突时会显示提示，可在设置中改用无方位布局。

## 纠正与恢复

设置中的“地理纠正 JSON”可提交带原因和知情范围的修改。例如明确玩家已位于河湾镇：

```json
{
  "basis": "author_setting", "knownBy": ["player"], "reason": "更正场景起点",
  "operation": {"kind": "position", "action": "set", "actorId": "player", "position": {"state": "at", "placeId": "town"}}
}
```

`position.state` 还支持 `within`（区域内具体位置不详）、`in_transit`（行进中）和 `unknown`。NPC 位置按玩家最后获知的信息显示，不作为实时定位。地点、关系、通路纠正分别使用 `place/upsert`、`relation/upsert|remove`、`route/upsert|remove`，内容放入同名字段。

地图基线、正文来源、纠正和布局随保存点、撤销、分支及重启恢复。编辑或删除来源后，其失效位置和关系不继续进入地图。酒馆隐藏显示仍继续地理处理；Agent 可单独关闭伴侣范围的后续提取。重启不会重新调用模型解释已接受的地图历史。

Agent 伴侣可用 `geographyStatus`、`configureGeography`、`previewGeographyImport`、`previewGeographyBackground`、`importGeography`、`exportGeography`、`correctGeography`、`clearGeographyCorrection` 与 `saveGeographyLayout`。请求与版本字段见 [Agent 直接接口](AGENT.md)。Agent 的临时跑团任务使用另一个作用域；伴侣命令不接收跑团作用域。

用户本轮明确提到地点时，Agent 宿主可给 `recall` 或 `turn` 传入原文中的 `placeQuery`，委派独立子代理搜索附来源的公开地点资料。这只是本轮回答上下文，不会自动写成位置经历或地图事实；查不到时保持未知。拒绝设备定位不会触发 IP 定位。

## 刷新与验证边界

固定工作台与折叠变量面板共享玩家投影。插件收到提交回执后立即请求新投影；后台独立变化通过 15 秒轮询更新，插件忙碌时等待下一次空闲轮询。现实时间卡本地每秒更新，剧情时间只随有效事件变化。切换模式、分支或聊天会清除旧快照；配置表单仍由用户显式读取，避免后台刷新覆盖正在编辑的设置。

自动化验证、真实酒馆与真实模型质量的当前结果见源代码工作区 `PROJECT_STATUS.md`，不能以 JSON 解析或接口成功代替抽取质量验收。
