# OpenHer 采用说明

情绪机制基于 OpenHer，固定版本 `ef5b2145c9c15582499ecc5fb9d10376d82eccdf`。来源与许可证见 [第三方声明](../THIRD_PARTY_NOTICES.md)。

`src/emotion/neural.ts` 与 `src/emotion/openher.ts` 将神经状态、权重学习、挫折相变及随机状态接入 TypeScript 核心。每个角色持久保存独立状态，已接受经历驱动学习，读取和未接受的助手候选不会重复训练。

长期关系与有来源的经历参与情绪校准。回复和称呼提示结合当前状态、角色背景、用户偏好与场景；角色主观感受不会反写客观历史。纠正、删除、分支和恢复按来源生命周期处理。
