# 空间记忆库（curio-minecraft-3d-memory）

为 Minecraft Java 1.20.1 的 Agent 提供**空间事实、历史几何、通行验证和可组合的导航辅助**的独立 TypeScript 库。范围限于**陆地行走**与**水面移动**（含跳跃、台阶、梯子、下落衔接、水面游泳、已乘船移动及上下岸）。

> English version: [README.md](README.md).

## 概览

- **只提供事实与执行辅助**：回答「这里最后观察到什么、曾经如何经过、当前证据是否支持通行、哪段需要重新验证」。目标、策略、资源投入、风险取舍与技能学习由 Agent 决定。
- **数据三层分离**：历史几何（永不因堵塞删除）、最近观测状态（版本化、带证据）、派生通行性（可失效缓存）。
- **不反向依赖宿主**：通过 `WorldAdapter` 抽象消费 mineflayer/Curio 的感知与执行，不 import 宿主源码。

设计依据与开发约束见 [`docs/spatial-memory-library-design.md`](docs/spatial-memory-library-design.md) 与 [`AGENTS.md`](AGENTS.md)。设计文档中的接口是**目标契约**，本仓库按设计 §10 逐步落地。

### 已实现

- **体素地图**（`voxel/`）：稀疏、版本化的观测状态，含逐格证据、会话/中断处理与局部 `ChangeReport`。
- **通行性**（`traversability/`）：只读单步行走评估、可失效缓存，以及对有序点列的受限路线验证。
- **受控 walk 路线执行**（`execution/`）：`WalkRouteExecutor` 把已验证路线连接到可注入的单步 `MoveExecutor` 与实测身体反馈。它只执行调用者提供的点列（同高度、沿 X/Z 单轴一格），无有效 OPEN 证据不启动路段，`ARRIVED` 必须以实测 `exact` 位置为依据，并会在路段证据变化时撤销执行中的控制。
- **历史路径存储**（`topology/`，阶段 4A）：`FragmentStore` 将历史路径几何（`PathFragment`）与已确认经过证据（`TraversalEvidence`）与当前世界状态严格分离 —— 支持幂等写入、明确更新、删除、分页读取、容量上限与快照隔离。

以上均以**内存地图 + Fake 执行器**验证（见 `tests/walk-route-executor.test.ts` 与可运行的 `examples/walk-route-execution.ts`）。**尚未**接入真实 mineflayer/Curio 身体、寻路或 SQLite 持久化。

## 历史路径存储

`FragmentStore` 是阶段 4A 的历史路径事实内存层。实例绑定一个不可变 `worldId`；每条记录自带 `dim`，不同世界/维度中的记录不会被坐标相同误合并。

```ts
import { FragmentStore } from 'curio-minecraft-3d-memory';

const store = new FragmentStore('world');

// 历史几何 —— 保存它不证明亲自经过，也不证明当前可走。
store.saveFragment({
  id: 'frag-1', worldId: 'world', dim: 'overworld', kind: 'walked',
  entrances: [{ x: 0.5, y: 64, z: 0.5 }],
  polyline: [{ x: 0.5, y: 64, z: 0.5 }, { x: 1.5, y: 64, z: 0.5 }],
  geometrySource: 'traversal', deepestY: 12,
  createdAt: 1000, lastUsedAt: 1000, uses: 1,
});

// 已确认经过证据 —— 显式提交、有方向（A→B 不证明 B→A）。
store.addTraversal({
  id: 'ev-1', fragmentId: 'frag-1',
  from: { x: 0.5, y: 64, z: 0.5 }, to: { x: 1.5, y: 64, z: 0.5 },
  worldId: 'world', dim: 'overworld', sessionId: 's1',
  observedAt: 1000, source: 'confirmed_walk',
});

store.fragments({ dim: 'overworld' });   // 分页、按 id 排序、只读快照
store.traversals({ fragmentId: 'frag-1' });
```

行为：

- **写入**：`saveFragment` / `addTraversal` 新增，或在相同内容幂等重投递时返回 `unchanged`；同 ID 不同内容为冲突并抛错。`updateFragment(id, changes)` 是明确更新入口 —— 不重置 `createdAt`/身份，也不重置 `uses`/`lastUsedAt`（除非调用者显式提供）。
- **读取**：`getFragment`、`fragments`、`traversals` 返回深拷贝快照，不改变时间、`uses` 或内容。分页按 `id` 升序、以排他 `after` 游标推进，`limit` 钳制到 `maxQueryBatch`，`total` 为匹配总数。
- **删除**：`forgetFragment(id)` 删除片段及其专属经过证据，不影响其他片段；删除不存在 ID 是稳定无操作。
- **容量**：`maxFragments`、`maxPolylinePoints`、`maxEntrances`、`maxLinks`、`maxTraversals`、`maxQueryBatch` 可配置；超出抛明确错误（不静默丢弃、不自动淘汰），失败写入不破坏原状态。

历史与现状严格分离：存储不触碰 `VoxelMap`，不产生当前 `OPEN`，他处发生阻塞/过期也不会删除已记录的历史。见 [`docs/phase-4a-history-facts-acceptance.md`](docs/phase-4a-history-facts-acceptance.md)。

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
├── execution/          # 受控 walk 路线执行闭环（§7 第一步、阶段 3）
├── store/              # SpatialMemoryStore 运行态接口（§9）
├── storage/            # SQLite 持久化与 Worker（§9，阶段 5）
└── compat/             # 旧 WorldMemory 入口的兼容层（§8、§9.1）

examples/
├── walk-route-execution.ts   # 可运行的 Fake 执行闭环示例
└── fragment-store-history.ts # 可运行的 Fake 历史事实与当前阻塞对照示例
```

## 开发

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run build       # 产出 dist/（NodeNext ESM + 类型声明）
npx tsx examples/walk-route-execution.ts    # 运行 Fake 执行示例
npx tsx examples/fragment-store-history.ts  # 运行 Fake 历史事实示例
```

> `examples/fragment-store-history.ts` 以公开包名（`curio-minecraft-3d-memory`）而非源码路径导入，用于验证包的 `exports` 入口 —— 请先 `npm run build` 再运行。

> 持久化驱动（`better-sqlite3`）按设计 §9.2 在阶段 5 接入，本阶段 `storage/` 仅含接口与 schema 契约，未引入原生依赖。

## License

UNLICENSED（私有）。
