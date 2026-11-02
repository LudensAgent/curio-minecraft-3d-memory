# 空间记忆库（curio-minecraft-3d-memory）

为 Minecraft Java 1.20.1 的 Agent 提供**空间事实、历史几何、通行验证和可组合的导航辅助**的独立 TypeScript 库。范围限于**陆地行走**与**水面移动**（含跳跃、台阶、梯子、下落衔接、水面游泳、已乘船移动及上下岸）。

- **只提供事实与执行辅助**：回答「这里最后观察到什么、曾经如何经过、当前证据是否支持通行、哪段需要重新验证」。目标、策略、资源投入、风险取舍与技能学习由 Agent 决定。
- **数据三层分离**：历史几何（永不因堵塞删除）、最近观测状态（版本化、带证据）、派生通行性（可失效缓存）。
- **不反向依赖宿主**：通过 `WorldAdapter` 抽象消费 mineflayer/Curio 的感知与执行，不 import 宿主源码。

设计依据与开发约束见 [`docs/spatial-memory-library-design.md`](docs/spatial-memory-library-design.md) 与 [`AGENTS.md`](AGENTS.md)。设计文档中的接口是**目标契约**，本仓库当前为**初步目录架构**：类型与目录已就位，各阶段实现按设计 §10 逐步落地。

## 目录结构

```
src/
├── index.ts            # 公共 API 出口（最小且明确的导出面）
├── constants.ts        # 单一配置常量（Section 尺寸、PASSAGE_LINK 等）
├── types.ts            # 基础原语（Vec3Like / BlockState / WorldScope / MoveMode）
├── observation/        # World Observer：Observation / 证据 / 新鲜度（§3.2）
├── voxel/              # Spatial Mapper：Section / Palette / 位打包（§4）
├── traversability/     # 派生通行性：Traversability / HazardFact（§3.3）
├── topology/           # Topology Manager：路径片段 / 节点 / 边（§3.1、§5）
├── adapter/            # WorldAdapter 目标适配面（§2.1）
├── navigation/         # L2 导航原语与结果信封（§7）
├── store/              # SpatialMemoryStore 运行态接口（§9）
├── storage/            # SQLite 持久化与 Worker（§9，阶段 5）
└── compat/             # 旧 WorldMemory 入口的兼容层（§8、§9.1）
```

## 开发

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run build       # 产出 dist/（NodeNext ESM + 类型声明）
```

> 持久化驱动（`better-sqlite3`）按设计 §9.2 在阶段 5 接入，本阶段 `storage/` 仅含接口与 schema 契约，未引入原生依赖。
