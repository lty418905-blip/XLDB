# 跑团地图

地图用于 SillyTavern 跑团／角色扮演模式，可独立于钱包和物品启用。核心保存地理关系和来源，JavaScript 绘制 SVG 示意图；坐标不代表经纬度或实际距离。

## 开始使用

进入“地图 → 地图设置与导入”，读取地图设置，启用地理状态并选择“显示地图”。可任选下列方式，也可以组合使用：

- **跟随正文**：配置独立 `geography` API，勾选“跟随已接受正文更新”。本轮用户正文的有效地理变化先提交，再生成回复；助手候选在接受后生效。计划、回忆和仅仅提及目的地不等于到达。
- **背景整理**：配置 `geography` API，允许背景整理模型。填写背景，或读取角色卡／世界书列表后勾选来源，生成预览并确认。未勾选的资料不发送。模型必须为每项候选引用来源原文；原文、哈希及导入 JSON 路径留存于管理员数据，玩家导出不包含全量背景。
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

地图基线、正文来源、纠正和布局随保存点、撤销、分支及重启恢复。编辑或删除剧情来源后，其失效位置和关系不继续进入地图。关闭“显示地图”仍允许已启用的正文地理更新；关闭整个地理模块则停止后续提取。重启不会重新调用模型解释已接受的地图历史。

## 刷新与验证边界

固定工作台与折叠变量面板共享玩家投影。插件收到提交回执后立即请求新投影；后台独立变化通过 15 秒轮询更新，插件忙碌时等待下一次空闲轮询。现实时间卡本地每秒更新，剧情时间只随有效事件变化。切换模式、分支或聊天会清除旧快照；配置表单仍由用户显式读取，避免后台刷新覆盖正在编辑的设置。

自动化验证、真实酒馆与真实模型质量的当前结果见源代码工作区 `PROJECT_STATUS.md`，不能以 JSON 解析或接口成功代替抽取质量验收。
