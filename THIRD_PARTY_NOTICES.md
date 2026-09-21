# 第三方声明

XLDB 自有且未另行许可的部分适用 [自定义许可](LICENSE.md)。以下部分保持其原有许可证。

## OpenHer

- 来源：https://github.com/kellyvv/OpenHer
- 固定版本：`ef5b2145c9c15582499ecc5fb9d10376d82eccdf`
- Copyright 2026 OpenHer Contributors
- 许可证：Apache-2.0；随附上游文本：[third-party/OpenHer-LICENSE](third-party/OpenHer-LICENSE)。
- 适用文件：`src/emotion/neural.ts`、`src/emotion/openher.ts`，遵循文件已有许可声明。
- XLDB 修改包括 TypeScript 移植、显式时钟、可序列化确定性随机状态、事务及来源生命周期接线、关系校准和有界历史。详见 [采用说明](docs/OPENHER_ADOPTION.md)。

## 安装时获取的依赖

Node.js、LanceDB、TypeScript 及类型定义等依赖由安装器获取，分别适用其分发包中的许可证。本仓库不包含这些运行时、依赖二进制、模型权重或用户数据；自定义许可不覆盖这些第三方组件。
