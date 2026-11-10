# 空间记忆库

<p>
  <img src="https://img.shields.io/badge/version-0.10.0-blue.svg" alt="Version 0.10.0">
  <img src="https://img.shields.io/badge/node-%3E%3D18-339933.svg" alt="Node 18+">
  <img src="https://img.shields.io/badge/minecraft-1.20.1-62B47A.svg" alt="Minecraft 1.20.1">
  <img src="https://img.shields.io/badge/typescript-5.x-3178C6.svg" alt="TypeScript 5.x">
  <img src="https://img.shields.io/badge/sqlite-optional-003B57.svg" alt="Optional SQLite">
  <img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="Apache 2.0 License">
</p>

[English](README.md) | 简体中文

面向 Minecraft Java 1.20.1 Agent 的独立 TypeScript 库。它记录某个位置最后观察到什么、过去如何经过、当前证据是否支持通行，以及路线的哪一段需要重新验证。目标、策略、资源投入与风险取舍仍由 Agent 决定。

范围限于**陆地行走与水面移动**——跳跃、台阶、梯子、下落衔接、水面游泳、已乘船移动以及上下岸。飞行、鞘翅与水下三维导航不在范围内。

**状态：0.10.0（未发布）。** 观测/查询、`planRoute` + `walkPath` walk 导航、运行态 Store 组合、拓扑运行态、SQLite 持久化与 M6 重启/checkpoint 回归已实现并有离线测试覆盖；`memory`/`navigation` 子路径已由包 `exports` 暴露；`MemoryHostCapabilities.execute.walk`/`groundedArrival`/`invalidation`/`cancellation` 因运行时入口已实现而报告 `true`，`execute.swim`/`boat` 与 `persistence.*` 仍为 `false`（D-059）。真实 Minecraft / mineflayer / Curio 接入尚未验收（H-01）。

**v0.11.0** 的推进状态见[实施计划](docs/v0.11.0-implementation-plan.md)。升级以已观察的体素地图作为普通导航来源：`planRoute({ source: 'auto', ... })` 直接使用提供的体素搜索，`pathId` 仅在显式 `source: 'history'` 请求中生效。已有历史 API 继续兼容保留；计划分别标明已实现改动、待接入宿主、待迁移与待游戏验证的部分。

## 功能

- **带证据的观测地图**（`voxel/`、`observation/`）：稀疏、版本化的 Section，逐格证据、新鲜度与会话处理；有界 `ObservationQueue`；局部 `ChangeReport` 只失效真正依赖它的工作。
- **历史几何与当前状态严格分离**（`topology/`）：`FragmentStore` 保存路径片段与已确认经过证据；`TopologyStore` 保存显式节点与有向边。别处的堵塞不会删除历史，历史也从不证明当前可通行。
- **有界历史查询**：`adjacency`、`reachable`、`route` 与 `historicalAnchorCandidates` 在有限工作预算内返回已记录事实——从不产生实时 `OPEN`、到达声明或可执行点列。
- **拓扑运行态**（`topology/`）：按方向验证边、独立的门户边、锚点查询、瞬时占位，以及有证据的碎片连通/合并记录。派生状态可失效，但不删除历史。
- **Walk 导航管线**（`navigation/`）：`planRoute` 基于有界搜索/历史证据发出单次使用 `routeId`；`walkPath` 通过调用方提供的单步身体端口执行该句柄，支持接地 `bodyArrival`、证据/会话失效的 `INVALIDATED` 停止与可选 `persistAction` 钩子。`navigateTo` 执行「实测起点 → 有界搜索 → 复验执行 → 实测到达」；`followKnownPath` 沿调用方显式指定的历史片段执行；`inspectRoute`、`inspectKnownRoute` 与 `frontierCandidates` 是只读投影。`recall_route` 未实现。
- **体素三维候选规划**（`searchLandRoute` / `searchLandRouteAsync`，v0.11 开发中）：按已观察支撑面进行有界 walk/step/drop A*；调用方显式允许且提供 `climbProvider` 时，也生成同 XZ 的上下梯子边。支持精确/附近目标与显式历史几何模式。结果始终要求当前复验并标记 `executable: false`。库内 `planRoute` 不自动选择这些候选，由宿主显式接线；本搜索尚不负责冷页加载和独立水平跳跃边。
- **有界派生缓存**：`TraversabilityCache` 默认最多 2048 项、最长复用年龄 60 秒。查询时有限清理过期项，宿主可显式调用 `pruneExpired()` / `clear()` 维护或释放；这些操作不删除地图观察。
- **受控路线执行**（`execution/`）：`WalkRouteExecutor` 驱动注入的单步 `MoveExecutor`；每段开始前要求当前 `OPEN` 证据；仅接受实测精确位置作为到达；证据变化时撤销在途路段。
- **陆地与水面验证**（`traversability/`、`water/`）：`evaluateLandTransition` / `LandRouteVerifier` 检查调用方声明的陆地转换与路线；`evaluateWaterRoute` / `checkWaterArrival` 检查水面游泳与已乘船几何。结果固定带 `assurance: 'geometry_only'` 与 `executable: false`。
- **显式 SQLite 持久化**（`storage/`，`curio-minecraft-3d-memory/storage/sqlite`）：单个 Worker 独占连接与事务。`checkpoint()` 是唯一显式保存触发点并返回确认后的 `CheckpointResult`；包含体素增量 checkpoint、手动 Section 驻留、`WorkingSetManager`、放置/访问/门户账本、追加式 journal，以及离线旧账本迁移演练。
- **与宿主解耦的集成面**：`SpatialMemoryStoreImpl` 组合运行态 Store 并提供作用域守卫；库通过窄适配类型消费感知与执行，从不 import 宿主源码。

## 运行要求

- 核心入口与 `water` 入口要求 **Node.js `>= 18`**。
- SQLite 入口要求 **Node.js `>= 20`** 与 **`better-sqlite3@^12`**。`better-sqlite3` 是可选 peer dependency，只有 `curio-minecraft-3d-memory/storage/sqlite` 会加载它。
- 碰撞形状与流体解释遵循 **Minecraft Java 1.20.1 语义**。库运行时不依赖 Minecraft 客户端或服务器；由调用方注入版本化 Provider。
- 面向 ESM / NodeNext TypeScript 消费者。包从 `dist/` 提供运行时 JavaScript 与 `.d.ts` 声明。

## 安装与消费

构建并生成可安装归档：

```bash
npm install --no-audit --no-fund
npm run build
npm pack
```

消费者在自己的项目中安装实际 `.tgz`，用包名与公开子路径引入——不要使用源码路径、`../dist`、`npm link` 或开发机目录别名：

```json
{
  "dependencies": {
    "curio-minecraft-3d-memory": "file:./curio-minecraft-3d-memory-0.10.0.tgz",
    "better-sqlite3": "^12.0.0"
  }
}
```

| 入口 | 内容 | 原生依赖 |
|---|---|---|
| `curio-minecraft-3d-memory` | 兼容根入口：观测、体素、通行性、拓扑、导航、执行与运行态 Store | 无 |
| `curio-minecraft-3d-memory/memory` | 纯记忆核心：观测、体素、拓扑、查询与能力报告；不含导航或身体入口 | 无 |
| `curio-minecraft-3d-memory/navigation` | `planRoute`、`walkPath`、路线注册表、搜索/执行绑定与只读导航投影 | 无 |
| `curio-minecraft-3d-memory/water` | 水面与已乘船验证 | 无 |
| `curio-minecraft-3d-memory/storage/sqlite` | SQLite 会话、账本、journal 与 `WorkingSetManager` | `better-sqlite3@^12` |

## 快速开始

### 打开共享空间会话

宿主通常为每个世界保留一个空间会话，并在感知更新与导航委托之间复用同一张地图：

```ts
import { openSpatialSession } from 'curio-minecraft-3d-memory/storage/sqlite';

const session = await openSpatialSession({
  databasePath,
  worldId: 'world',
  // 可选：'manual' 打开时不把全部已提交 Section 解码进内存。
  voxelLoading: 'eager',
});

session.voxel.beginSession('session-a');
session.voxel.observe({ /* 已确认的观测 */ });

await session.checkpoint(); // 唯一显式保存触发点
await session.close();
```

恢复的事实保留原观测时间与来源，但已保存的 `FRESH` 会变回 `STALE`。新观测只刷新实际观察到的格。

### 导航

```ts
import { navigateTo } from 'curio-minecraft-3d-memory';

const { result, record } = await navigateTo(
  {
    destination: { x: 10, y: 64, z: 10 },
    arrival: { kind: 'exact' },
    allowedModes: ['walk'],
    allowDigging: false,
    allowPlacing: false,
    allowTower: false,
    materials: [],
    exploration: 'known_only',
  },
  environment,
);

if (result.outcome === 'ARRIVED') {
  // result.confirmed、result.lastPosition 与 result.lastObservation 均为实测。
}
```

`environment` 由调用方提供，包含世界/维度/会话身份、实测身体样本、`WalkRouteSearch` 来源、绑定同一地图的 `WalkRouteExecutor`、形状 Provider、预算以及可选取消信号。库不扫描世界，也不拥有身体。

沿调用方显式指定的历史片段执行时使用 `followKnownPath(request, { ...environment, history, drive: true })`；未开启 `drive` 时只返回起点边界。

### 验证陆地与水面几何

```ts
import {
  evaluateLandTransition,
  LandRouteVerifier,
  resolveLandLimits,
} from 'curio-minecraft-3d-memory';
import { checkWaterArrival, evaluateWaterRoute } from 'curio-minecraft-3d-memory/water';

const transition = evaluateLandTransition(
  map,
  { worldId, dim, sessionId, body, transition: declaredTransition },
  { shapeProvider, jumpModel, climbProvider },
  Date.now(),
  resolveLandLimits({ maxWork: 4096 }),
);

const route = evaluateWaterRoute(
  map,
  {
    worldId, dim, sessionId,
    points,
    profile: 'surface_swim',
    solidShapeProvider,
    fluidShapeProvider,
  },
  Date.now(),
);

const arrival = checkWaterArrival({ goal, scope, map, samples, now, maxSampleAgeMs });
```

陆地验证支持 `step`、`drop`、`jump` 与 `ladder`；`jump` 必须注入版本化 `LandMotionModel`，`ladder` 必须注入版本化 `ClimbRegionProvider`。水面路线必须等高且姿态固定为 90° 的整数倍。两个验证器都不搜索路线、不移动身体、不挖掘、不放置、不上下船，也不接管救援策略。

### 保存历史与拓扑

```ts
import { FragmentStore, TopologyStore } from 'curio-minecraft-3d-memory';

const history = new FragmentStore('world');
const topology = new TopologyStore(history);

topology.saveNode({ id: 'a', kind: 'place', source: 'agent', worldId: 'world',
  dim: 'overworld', location: { kind: 'exact', pos: { x: 0.5, y: 64, z: 0.5 } } });
topology.saveNode({ id: 'b', kind: 'place', source: 'agent', worldId: 'world',
  dim: 'overworld', location: { kind: 'exact', pos: { x: 1.5, y: 64, z: 0.5 } } });

topology.saveEdge({ id: 'e-ab', from: 'a', to: 'b', type: 'HORIZONTAL',
  basis: 'traversed', evidenceIds: ['ev-1'] });

const route = topology.route('a', 'b', { mode: 'walk' });
// route.status: FOUND | NO_RECORDED_ROUTE | INSUFFICIENT_EVIDENCE | BUDGET_EXHAUSTED
```

A→B 与 B→A 是两条独立记录。只有证据仍可解析的 `traversed` 边参与历史查询。候选边只是待验证关系，不证明曾经经过。完整结果与失败语义见下方验收文档。

一条实际确认走过的通道应作为一个原子单元写入，而不是依次调用单记录接口：

```ts
import { writeConfirmedCorridor } from 'curio-minecraft-3d-memory';

const receipt = writeConfirmedCorridor(history, topology, {
  fragment,                 // 只含确认几何
  traversals,               // 每个确认走过的段一条
  nodes,                    // 精确端点；id 必须稳定
  edges,                    // 有向 traversed 边，引用 evidence
  sessionId,
  coordinate: 'cell',       // 显式按整数格规范化；'exact' 保留浮点
});
// receipt.status: 'written' | 'unchanged' | 'rejected'
// receipt.committed: 'all' | 'none'（没有 prefix 半写入）
// receipt.problem: node_referenced | endpoint_mismatch | scope_mismatch | ...
```

写入器先校验整条通道再改动，任一失败同时回滚两个 store，相同重试幂等。它不按邻近格缝合：节点位置变化但仍被本次通道之外的边引用时，返回外部边 id 并拒绝，不会静默改端点。规划点列、未确认位移和历史几何不得作为 traversal 提交。

### 管理有界工作集

```ts
import { WorkingSetManager } from 'curio-minecraft-3d-memory/storage/sqlite';

const session = await openSpatialSession({
  databasePath,
  worldId: 'world',
  voxelLoading: 'manual',
  residencyLimits: { maxResidentSections: 8 },
});
const manager = new WorkingSetManager(session);

const prepared = await manager.prepare(routeDependencySections);
// prepared.status: 'ready' | 'incomplete' | 'failed'
// 仅 status === 'ready' 时 prepared.lease 有效；由调用方负责释放。
```

`prepare` 先整批校验请求，用临时 Pin 租约保护，再按 LRU 淘汰已提交、干净且未被 Pin 的 Section，其余通过会话单 Worker 加载。`free()` 为接受新观测腾空间，`stats()` 返回只读快照。

## 宿主接入生命周期

库只提供事实与执行辅助；宿主负责连接、合法感知与身体控制。可运行的 Fake 示例见 `examples/shared-session-lifecycle.ts`。

1. **启动**：宿主提供数据库绝对路径与 `worldId`；`await openSpatialSession()` 完成后再使用 `session.voxel`，不要每个动作新建地图。
2. **共享地图**：持续感知与多个 walk 委托共用 `session.voxel`；共享地图不代表共享执行所有权。
3. **连接与重连**：观测 `sessionId` 来自实际连接生命周期。正常重连同一世界不更换 `worldId`；用 `map.beginSession(sessionId)` 切换，旧会话的迟到证据会被拒绝。
4. **感知更新**：先 `map.observe(...)` 写入合法观测，再把返回的 `ChangeReport` 交给活跃的验证器或执行器。库从不主动扫描世界。
5. **路线生命周期**：加载并保护实际路线依赖（`WorkingSetManager.prepare` + 租约），验证、执行，然后释放。取消某个委托不关闭共享会话。
6. **保存与关闭**：`checkpoint()` 捕获并提交当前变化；`flush()` 只等待已接受的保存；`close()` 在有界时间内关闭。顺序：停止接收写入 → 最终 checkpoint → 检查确认 → close。
7. **恢复**：历史记录与原证据时间会恢复；当前通行性必须重新建立，不能把从磁盘读回的数据当作新观测。

## 导航能力状态

| 设计 §7 名称 | 状态 | 公开入口 | 边界 |
|---|---|---|---|
| `navigate_to` | implemented | `navigateTo` | 仅 walk；精确到达；同高度、沿 X/Z 单格；搜索、执行器与实测样本由调用方提供 |
| `follow_known_path` | implemented | `followKnownPath`、`startKnownWalkRoute` | 仅 walk；一条显式选定的历史片段；`followKnownPath` 仅在 `drive: true` 时驱动执行 |
| `inspect_route` | read_only | `inspectRoute`、`inspectKnownRoute` | 只投影已有快照或历史片段；不移动、不观察、不 Pin、不保存 |
| `frontier_candidates` | read_only | `frontierCandidates` | 只投影有界的未知边界候选；不选择目标、不启动探索 |
| `recall_route` | not implemented | — | 无公开运行时入口；历史查询不等于路线召回或执行 |

`navigateTo` 会明确拒绝 `near` / `reach_block` 到达条件、非 walk 模式、挖掘、放置、搭柱、非空材料列表、非空 `avoid` 约束与 `allow_frontier`。这些拒绝以结构化结果返回，绝不静默忽略设置。

`planRoute` 报告 walk search/history/auto 为 `true`，更宽模式为 `false`；`walkPath` 只接受注册表发出、单次使用的 walk 路线，且从不重新规划。规范的 `MemoryHostCapabilities` 将已实现的 walk 执行位（`walk`、`groundedArrival`、`invalidation`、`cancellation`）报告为 `true`；`swim`、`boat` 与全部 `persistence.*` 位保持 `false`（D-059）。接线时应使用 `composeCapabilities` 与宿主自身接线求交集；`false` 或未声明的能力是明确的 `unsupported` 拒绝，不是静默回退。

## 目录结构

```
src/
├── index.ts            # 公共 API 出口（最小且明确的导出面）
├── constants.ts        # 共享配置常量
├── types.ts            # 基础原语（Vec3Like / BlockState / WorldScope / MoveMode）
├── observation/        # Observation / 证据 / 新鲜度与有界队列
├── voxel/              # 稀疏 Section、Palette、位打包与证据历史
├── traversability/     # 派生通行性 + 有界陆地转换/路线验证
├── water/              # 水面与已乘船验证（子路径 /water）
├── topology/           # 历史、显式拓扑、运行态边、门户、锚点与占位
├── adapter/            # WorldAdapter 目标适配面
├── navigation/         # walk 搜索、navigateTo、followKnownPath 与只读投影
├── execution/          # 受控 walk 路线执行闭环
├── store/              # SpatialMemoryStore 运行态组合与作用域守卫
├── storage/            # SQLite 持久化、账本、journal 与 Worker
└── compat/             # 旧 WorldMemory 兼容层与迁移演练

examples/
├── walk-route-execution.ts         # Fake 执行闭环
├── fragment-store-history.ts       # 历史事实与当前阻塞对照
├── topology-facts.ts               # 显式拓扑事实与当前阻塞对照
├── historical-topology-query.ts    # 有界历史图查询
├── historical-anchor-query.ts      # 有界历史锚点查询
├── history-checkpoint.ts           # SQLite 历史 checkpoint 生命周期
├── spatial-checkpoint.ts           # 组合空间 checkpoint 生命周期
├── spatial-checkpoint-incremental.ts # 体素增量 checkpoint
├── spatial-residency.ts            # 手动按需 Section 驻留
├── working-set.ts                  # 有界工作集 + Fake 路线
└── shared-session-lifecycle.ts     # 宿主共享会话生命周期参考
```

## 开发

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run build       # 产出 dist/（NodeNext ESM + 类型声明）
```

用 `tsx` 运行示例：

```bash
npx tsx examples/walk-route-execution.ts
npx tsx examples/shared-session-lifecycle.ts
npx tsx examples/working-set.ts
# 完整列表见 examples/ 目录
```

运行独立消费者验收（打包 → 临时安装 → 运行时断言 + 类型检查）：

```bash
node acceptance/run.mjs
```

示例与测试使用 Fake 感知、Fake 身体与 Fake move executor；持久化测试使用真实 SQLite 数据库与真实 Worker。这些测试都不会启动 Minecraft 服务器或连接 mineflayer Bot，真实游戏验收仍未执行。

> 以公开包名（`curio-minecraft-3d-memory`，或 `curio-minecraft-3d-memory/storage/sqlite` 子路径）导入的示例用于验证包的 `exports` 入口；请先 `npm run build`。

## 文档

- [设计与开发约束](docs/spatial-memory-library-design.md)——目标契约、数据模型与落地顺序。
- [AGENTS.md](AGENTS.md)——仓库开发规则与边界。
- [记忆宿主接口契约](docs/memory-host-interface-contract.md)——§15 实现状态表与能力协商。
- [记忆宿主实现计划](docs/memory-host-implementation-plan.md)——里程碑、文件级任务与退出条件。
- [0.10.0 实现审计](docs/implementation-audit-0.10.0.md)——纯记忆库历史审计与已知缺口。
- M2/M3/M4 审计：[查询](docs/memory-host-m2-query-audit.md)、[路线规划](docs/memory-host-m3-route-plan-audit.md)、[walk 执行](docs/memory-host-m4-walk-path-audit.md)。
- [运行态 Store 组合](docs/spatial-memory-store.md)——`SpatialMemoryStoreImpl` 行为与已知事实缺口。
- [旧账迁移门禁](docs/legacy-migration-gate.md)——离线 JSON → SQLite 演练与权威切换门禁。

## 已知限制

- **未做真实游戏验收。** 身体样本、世界适配器、搜索实例与形状/流体 Provider 均由调用方提供。Fake 测试证明库内逻辑，不证明 mineflayer 控制或 Minecraft 物理。
- **仅限 walk 范围。** `navigateTo` 只支持同高度、沿 X/Z 单格的精确到达。跳跃、台阶、梯子、下落、游泳、船、`near` / `reach_block`、挖掘、放置、搭柱、材料、非空 `avoid` 与 Frontier 探索都不是可执行导航模式。
- **`recall_route` 未实现。** 历史路线与锚点查询只是事实，不是可执行路线选择，也不构成到达声明。
- **陆地与水面验证是纯几何的。** 它们不搜索路线、不移动身体、不操作船，也不接管救援策略；结果固定带 `assurance: 'geometry_only'` 与 `executable: false`。
- **持久化是显式的。** 没有自动保存或后台重试；只有 `checkpoint()` 提交。恢复后的观测为 `STALE`，当前通行性必须重新建立。JSON → SQLite 权威切换尚未执行，目前只有离线迁移演练。
- **感知由宿主负责。** 库不扫描客户端世界、不加载区块，也不把原始 `blockUpdate` 事件当作证据。它只记录宿主合法提供的观测。
- **容器与库存仍归宿主账本。** 库关联位置与可达证据，不复制或维护物品数量。
- **不包含飞行、鞘翅与水下三维导航。** 这些不在本库范围内。
- **Store 投影限制。** `SpatialEdge` 只是 `TopologyStore` 的有损投影；门户边独立于步行图。未提供历史查询时，`Frontier.historicalConnection` 返回 `unknown`。请使用 Store 文档中列出的详细读取与 inspection API。

## License

使用 [Apache License 2.0](LICENSE) 许可。
