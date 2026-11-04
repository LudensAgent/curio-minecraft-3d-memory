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
- **有界陆地转换与路线验证**（`traversability/`）：`evaluateLandTransition` 针对一条由调用方显式声明、带精确脚位的转换（`step` / `drop` / `jump` / `ladder`），在 `VoxelMap` 已有证据上检查声明的连续通道与必要支撑/接触；`LandRouteVerifier` 在有序转换列表上按每次调用的工作预算复验。结果固定带 `assurance: 'geometry_only'` 与 `executable: false`；`jump` 必须注入版本化 `LandMotionModel`，`ladder` 必须注入版本化 `ClimbRegionProvider`。不做搜索、坐标取整/吸附、身体移动、挖掘或放置。见 `docs/land-route-validation.md`。
- **水面与已乘船验证**（`water/`，子路径 `curio-minecraft-3d-memory/water`）：`evaluateWaterRoute` 对调用方选定、等高的游泳/乘船路线，用注入的实心 `CollisionShapeProvider` 与独立的版本化 `FluidShapeProvider` 做扫掠检查；`checkWaterArrival` 基于实测有序采样单独确认水面 / 干岸 / 停靠目标。两者都不搜索路线、不执行控制器、不上下船、不造船/回收船，也不接管救援策略。见 `docs/water-validation.md`。
- **受控 walk 路线执行**（`execution/`）：`WalkRouteExecutor` 把已验证路线连接到可注入的单步 `MoveExecutor` 与实测身体反馈。它只执行调用者提供的点列（同高度、沿 X/Z 单轴一格），无有效 OPEN 证据不启动路段，`ARRIVED` 必须以实测 `exact` 位置为依据，并会在路段证据变化时撤销执行中的控制。
- **历史路径存储**（`topology/`，阶段 4A）：`FragmentStore` 将历史路径几何（`PathFragment`）与已确认经过证据（`TraversalEvidence`）与当前世界状态严格分离 —— 支持幂等写入、明确更新、删除、分页读取、容量上限与快照隔离。
- **拓扑事实存储**（`topology/`，阶段 4B）：`TopologyStore` 记录显式空间节点与有向连接（`candidate` 候选 vs 有依据的 `traversed`），保留每条边的证据引用，并报告这些引用当前能否解析 —— 但从不回答当前是否可通行。
- **有界历史图查询**（`topology/`，阶段 4C）：`TopologyStore` 新增有界、只读的 `adjacency` / `reachable` / `route` 查询 —— 有限工作预算、模式筛选、轻量历史读取，以及精确的 `FOUND` / `NO_RECORDED_ROUTE` / `INSUFFICIENT_EVIDENCE` / `BUDGET_EXHAUSTED` 结果 —— 仍不声称当前可通行、不生成可执行路线。
- **有界历史锚点查询**（`topology/`，阶段 4D）：`TopologyStore.historicalAnchorCandidates` 查询从节点出发、沿证据解析的历史连接可达且满足筛选（source/tag/kind）的锚点，按 `bfs`/`highest`/`deepest` 排序限流，附带共享证明 —— 不声称当前可通行、不选择行动目标、不生成可执行路线。
- **显式历史 checkpoint 持久化**（`storage/`，阶段 5A）：通过 `curio-minecraft-3d-memory/storage/sqlite` 子路径的 `openHistorySession`，用单个 SQLite Worker 持久化四类历史事实（`PathFragment`、`TraversalEvidence`、`SpatialNode` 及带原始绑定快照的拓扑边）。`checkpoint()` 是唯一显式保存触发点；`flush()`/`close()` 不隐式保存新内存变化。见 `docs/phase-5a-history-checkpoint-acceptance.md`。
- **显式组合空间 checkpoint 持久化**（`storage/`，阶段 5B）：通过同一子路径的 `openSpatialSession`，用单个 SQLite Worker 与单个事务把最近观测地图（`VoxelMap`）与历史事实一起持久化。启动时恢复完整观测状态并统一转 `STALE`；新观测只刷新实际观察到的格。见 `docs/phase-5b-spatial-checkpoint-acceptance.md`。
- **体素增量 checkpoint**（`storage/`，阶段 5C）：已有体素保存基线后，`checkpoint()` 只复制、编码并写入自上次确认保存以来事实发生变化的 Section，而不是整份替换。首次保存仍建立完整基线；空增量绝不清库；Worker 复核增量后的完整集合，使连续小增量无法累积出无法重新打开的数据库。见 `docs/phase-5c-voxel-incremental-checkpoint-acceptance.md`。
- **手动按需 Section 驻留**（`storage/`，阶段 5D1）：`openSpatialSession({ voxelLoading: 'manual' })` 在打开时只读取已提交 Section 目录，并需要显式 `loadSections` 后才能向已保存的 Section 写入。安全 `unloadSections`、有界 `pinSections`/`releasePins` 租约、`sectionResidency` 查询（`no_record` / `not_resident` / `loading` / `resident` / `load_failed`），以及驻留驱动的通行缓存与路线验证局部失效。未驻留不等于从未观察，回载不伪造新观察或当前 `OPEN`，部分驻留的增量 checkpoint 不删除未加载记录。见 `docs/phase-5d1-section-residency-acceptance.md`。
- **有界工作集管理**（`storage/`，阶段 5D2）：`WorkingSetManager` 把手动会话组合成显式的 `prepare` → 保护 → 淘汰 LRU 可淘汰项 → 有界加载 闭环，返回精确结果与保护租约。`free(target?)` 按 LRU 顺序淘汰可淘汰 Section 腾空间（或清空全部可淘汰项），`stats()` 报告有界工作集；每次加载/装入/卸载/Pin 仍走现有单 Worker 会话。管理器不成为事实、dirty 状态或保存确认的第二权威源。见 `docs/phase-5d2-working-set-acceptance.md`。

内存层以**内存地图 + Fake 执行器**验证（见 `tests/walk-route-executor.test.ts` 与 `examples/walk-route-execution.ts`）；checkpoint 层以**真实 SQLite + 真实 Worker**验证（见 `tests/storage-checkpoint.test.ts`、`tests/spatial-checkpoint.test.ts`、`examples/history-checkpoint.ts` 与 `examples/spatial-checkpoint.ts`）。**尚未**接入真实 mineflayer/Curio 身体或寻路。

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

## 拓扑事实存储

`TopologyStore`（阶段 4B）记录调用者显式提交的拓扑，并将其与历史几何、当前通行性分离。实例绑定一个不可变 `worldId`，通过由 `FragmentStore` 直接满足的窄只读接口读取证据。

```ts
import { FragmentStore, TopologyStore } from 'curio-minecraft-3d-memory';

const history = new FragmentStore('world');
const topology = new TopologyStore(history);

// 节点（沿用现有 SpatialNode 结构）。
topology.saveNode({ id: 'a', kind: 'place', source: 'agent', worldId: 'world',
  dim: 'overworld', location: { kind: 'exact', pos: { x: 0.5, y: 64, z: 0.5 } } });
topology.saveNode({ id: 'b', kind: 'place', source: 'agent', worldId: 'world',
  dim: 'overworld', location: { kind: 'exact', pos: { x: 1.5, y: 64, z: 0.5 } } });

// 候选边：显式的「待验证」关系，不是经过事实。
topology.saveEdge({ id: 'e-ab', from: 'a', to: 'b', type: 'HORIZONTAL',
  basis: 'candidate', source: 'manual', evidenceIds: [] });

// 经过边：由一条具体的 A→B 经过记录支撑。
topology.saveEdge({ id: 'e-ab2', from: 'a', to: 'b', type: 'HORIZONTAL',
  basis: 'traversed', evidenceIds: ['ev-1'] });
```

行为：

- **有向**：A→B 与 B→A 是两条独立记录；保存 A→B 不自动生成 B→A。
- **两类依据**：`candidate` 是待验证关系（无证据）；`traversed` 要求匹配的 `TraversalEvidence`，其 `from`/`to` 与边端点精确对应。
- **引用解析**：每条经过边在读取时对照历史重新解析：`resolved` / `missing` / `mismatch`。删除源片段后边记录仍在并报告 `missing`，绝不翻译成当前 `BLOCKED`。
- **保护**：被边引用的节点不能改 `location` 或删除，须先删边；删边不删片段或证据。
- **容量**：agent/program 独立节点额度，加边/证据引用数/分页上限；超限明确报错，不静默淘汰。

仅支持同世界、同维度、精确端点、非 `PORTAL` 的连接；区域节点可保存与查询，但不能作为边端点。见 [`docs/phase-4b-topology-facts-acceptance.md`](docs/phase-4b-topology-facts-acceptance.md)。

## 有界历史图查询

`TopologyStore`（阶段 4C）对**已记录的历史图**提供三个有界、只读、同步查询 —— 从不回答当前
世界是否可通行，也从不给出可执行的走法：

- **`adjacency(nodeId, options?)`** —— 从 incident 索引按插入顺序读取一个节点的入边/出边。返回
  的是普通 `TopologyEdge` 快照，此处**不做**引用解析。
- **`reachable(fromNodeId, options?)`** —— 只沿证据完整解析且通过模式筛选的 `traversed` 出边，
  返回已确认可达的节点（含深度为零的起点）。
- **`route(fromNodeId, toNodeId, options?)`** —— 一条最少边数的有向历史连接序列，附带每段见证
  证据；否则给出精确的未找到原因。

```ts
import { FragmentStore, TopologyStore } from 'curio-minecraft-3d-memory';

const history = new FragmentStore('world');
const topology = new TopologyStore(history);
// … 保存节点 a/b/c，保存经过边 e-ab（a→b）与 e-bc（b→c）…

const r = topology.route('a', 'c', { mode: 'walk' });
if (r.status === 'FOUND') {
  r.nodeIds;   // ['a', 'b', 'c']
  r.edgeIds;   // ['e-ab', 'e-bc']
  r.segments;  // [{ edgeId: 'e-ab', evidenceId: 'ev-ab', evidence: … }, …]
}
```

行为：

- **端点**：可达/路线只接受已存在、`exact`、同世界同维度的节点；缺失节点、区域端点、跨维度
  请求明确失败（不静默替换）。
- **参与搜索的边**：只有 `basis: 'traversed'` 且每条引用都 `resolved` 的边参与；`candidate` /
  `missing` / `mismatch` 边被排除并作为缺口报告。方向严格 `from → to`。
- **模式**：可选 `mode` 筛选要求明确的证据 mode 匹配；mode 未知产生 `mode_unknown` 缺口，已知
  但不匹配为正常筛除。不指定时保留所采用证据的真实 mode（未知保持未知）。
- **预算**：`maxNodes` / `maxEdges` / `maxHistoryReads` / `maxDiagnostics` 有限、受 Store 上限
  钳制、零按字面生效；预算耗尽报告为 `BUDGET_EXHAUSTED`，不与 `NO_RECORDED_ROUTE` 混淆。
- **结果**：`FOUND` / `NO_RECORDED_ROUTE` / `INSUFFICIENT_EVIDENCE` / `BUDGET_EXHAUSTED` 语义
  精确；诊断有界，截断不会丢失缺口分类。

这些查询只返回历史事实，不产生当前 `OPEN`、不声称身体已到达、不生成可执行点列。见
[`docs/phase-4c-historical-topology-query-acceptance.md`](docs/phase-4c-historical-topology-query-acceptance.md)。

## 有界历史锚点查询

`TopologyStore.historicalAnchorCandidates(fromNodeId, options?)`（阶段 4D）回答「从这个已知节点
出发，沿证据解析、模式匹配的 `traversed` 边可以到达哪些已记录的锚点？最高或最深的是哪个？」。

```ts
import { FragmentStore, TopologyStore } from 'curio-minecraft-3d-memory';

const history = new FragmentStore('world');
const topology = new TopologyStore(history);
// … 保存节点与经过边 …

const r = topology.historicalAnchorCandidates('a', { tag: 'resource', order: 'highest', limit: 1 });
r.items;          // [{ node: SpatialNode, hops: 3 }]
r.matchedCount;   // 应用 limit 前的候选数
r.proofSegments;  // 到达返回候选所需的前驱路径并集
r.disposition;    // 'complete' | 'evidence_gaps' | 'budget_exhausted'
```

行为：

- **端点**：起点必须是已存在的 `exact` 节点；区域端点与缺失节点明确失败；`maxNodes: 0` 不返回
  未经校验的起点。
- **过滤**：`source` / `tag` / `kind` 按 AND 组合，只过滤返回候选、不裁剪遍历；缺失 `tag` 的
  节点不匹配指定 `tag`；不匹配的中间节点仍被穿越。
- **排序**：`bfs`（发现顺序）、`highest`（`pos.y` 降序）、`deepest`（`pos.y` 升序）；同高度保持
  BFS 顺序。高度只来自节点 `pos.y`，不来自片段 `deepestY` 或连接类型。
- **完整性**：`matchedCount` 为 limit 前的候选数；`resultsTruncated` 仅表示被 limit 截断；
  `disposition` 报告搜索是否完成；空 `items` 不自动等于「没有候选」。
- **证明**：`proofSegments` 是到达返回候选所需前驱路径的去重并集，按前驱在先顺序输出，每段带
  见证证据。

`highest`/`deepest` 不声称是地表或洞穴最深处，查询不证明当前可通行、不选择行动目标。见
[`docs/phase-4d-historical-anchor-query-acceptance.md`](docs/phase-4d-historical-anchor-query-acceptance.md)。

## 历史 checkpoint 持久化

`openHistorySession`（阶段 5A，子路径 `curio-minecraft-3d-memory/storage/sqlite`）通过单个 SQLite
Worker 持久化四类历史事实。调用者仍照旧使用内存 `FragmentStore` / `TopologyStore`；`checkpoint()`
是**唯一**的显式保存触发点。

```ts
import { openHistorySession } from 'curio-minecraft-3d-memory/storage/sqlite';

const session = await openHistorySession({ databasePath, worldId: 'world' });

session.history.saveFragment({ /* … */ });
session.topology.saveNode({ /* … */ });
await session.checkpoint();   // 一次事务内捕获并提交完整历史
await session.close();        // 停止接受写入，并有界关闭 Worker

const reopened = await openHistorySession({ databasePath, worldId: 'world' });
reopened.history.fragments(); // 已提交状态恢复
```

行为：

- **显式保存**：内存写入立即可查询，只有 `checkpoint()` 才会落盘；不自动保存、不做增量日志、不后台重试。
- **有界且原子**：一次 checkpoint 在单个事务内替换该 worldId 的四类事实，并有明确、有文档的容量
  上限（`SnapshotLimits`）；超限在复制前拒绝，内存与上一份 checkpoint 均不变。
- **原始绑定**：边连同其原始证据绑定快照一起恢复 —— 不经过 `saveEdge` 重绑 —— 因此被删除/替换的
  证据继续报告 `missing`/`mismatch`，且 4C/4D 查询依赖的插入顺序得以保留。
- **生命周期**：`checkpoint()` 在 `busy`/`closing`/`closed` 时拒绝；`flush()` 只等待已接受的
  checkpoint；`close()` 报告最后确认的 checkpoint、未保存变化与未确认请求。
- **失败语义**：`PersistenceError` 区分容量/参数拒绝、SQL 回滚、Worker 失败、`timeout_unconfirmed`
  （提交可能已落盘但未确认）与 schema/数据校验 —— 不伪造保存、不清除后续 dirty。
- **隔离**：`worldId` 显式且按库隔离；空 checkpoint 只清空自己的世界。

原生驱动（`better-sqlite3` `^12`）是**可选 peer dependency**：核心 `curio-minecraft-3d-memory` 入口
不加载原生驱动、支持 Node `>=18`；SQLite 子路径额外要求 `better-sqlite3`（Node `>=20`）。见
[`docs/phase-5a-history-checkpoint-acceptance.md`](docs/phase-5a-history-checkpoint-acceptance.md)。

## 组合空间 checkpoint 持久化

`openSpatialSession`（阶段 5B，子路径 `curio-minecraft-3d-memory/storage/sqlite`）通过同一个 SQLite
Worker 把最近观测地图（`VoxelMap`）与四类历史事实一起持久化。`checkpoint()` 仍是**唯一**的显式保存
触发点，并在一个事务内捕获三个 Store。

```ts
import { openSpatialSession } from 'curio-minecraft-3d-memory/storage/sqlite';

const session = await openSpatialSession({ databasePath, worldId: 'world' });

session.voxel.beginSession('session-a');   // 宿主命名本次观测会话
session.voxel.observe({ /* … 已确认 Observation … */ });
session.history.saveFragment({ /* … */ });

await session.checkpoint();                 // 体素 + 历史在一个事务内提交
await session.close();

const reopened = await openSpatialSession({ databasePath, worldId: 'world' });
reopened.voxel.cellAt('overworld', x, y, z); // 已提交事实，统一转 STALE
```

行为：

- **显式保存**：内存写入立即可查询，只有 `checkpoint()` 才会落盘；不自动保存、不做增量日志、不后台重试。
- **启动恢复而非重放**：恢复的事实保留原 `observedAt`/`sessionId`/来源/归属，但已保存的 `FRESH` 转为
  `STALE` —— 宿主命名新观测会话并重新观察以恢复新鲜度；重观察只刷新被观察的那一格。
- **有界且原子**：一次 checkpoint 在单个事务内、在统一字节预算与有限体素上限（`maxVoxelSections`、
  `maxObservedCells`、`maxPaletteEntries`、`maxBytes`）下替换该世界的体素与历史。主线程先对本次批次做预检、
  超限在复制前拒绝；Worker 另在事务内复核增量后的完整集合、超限整批回滚。
- **基线后增量（5C）**：首次 `checkpoint()` 写完整体素集合；之后只复制、编码并写入发生变化的
  Section（`voxelMode: 'incremental'`），未变化的 Section payload 保持字节级不变。历史本轮仍为完整快照。
- **schema 升级**：v1 数据库升级到 v2（新增 `spatial_sections` 与体素 checkpoint 列），再 v2 → v3（新增每
  Section 已提交元数据列并从既有 payload 回填），各带一致备份与事务回滚；既有历史、ID、顺序与绑定被保留。
  历史入口 `openHistorySession` 的写入只替换历史，不触碰体素。
- **生命周期**：`checkpoint()` 在 `busy`/`closing`/`closed` 时拒绝；`flush()` 只等待已接受的 checkpoint；
  `close()` 报告最后确认的 checkpoint、未保存变化与未确认请求。

见 [`docs/phase-5b-spatial-checkpoint-acceptance.md`](docs/phase-5b-spatial-checkpoint-acceptance.md)。

## 手动按需 Section 驻留

`openSpatialSession({ voxelLoading: 'manual' })`（阶段 5D1）把已提交 Section **目录**与驻留内存工作集分开。打开时不解码完整已提交事实集；调用方显式加载 Section，并 Pin 当前路线实际依赖的那些 Section。

```ts
import { openSpatialSession } from 'curio-minecraft-3d-memory/storage/sqlite';
import type { SectionKey } from 'curio-minecraft-3d-memory';

const session = await openSpatialSession({ databasePath, worldId: 'world', voxelLoading: 'manual' });
const key: SectionKey = { worldId: 'world', dim: 'overworld', cx: 0, cz: 0, sy: 4 };

session.sectionResidency(key).residency;      // 'no_record' | 'not_resident' | 'loading' | 'resident' | 'load_failed'
const { loaded, missing } = await session.loadSections([key]); // 显式、有界加载
session.voxel.beginSession('live');
session.voxel.observe({ /* … 携带原时间的重新观察 … */ });
await session.checkpoint();                    // 增量；绝不删除未加载记录

const lease = session.pinSections([key]);     // 保护路线实际依赖的 Section
session.unloadSections([key]);                 // 被 Pin 保护时拒绝（结构化原因）
session.releasePins([lease.token]);
session.unloadSections([key]);                 // 安全：已提交 + 干净 + 未 Pin
```

行为：

- **目录 vs 驻留。** 打开时只读取已提交目录（身份、稳定顺序、payload 字节数、已观察格/palette 数、revision），
  不解码 payload，并受同一 `maxVoxelSections`/`maxBytes`/`maxObservedCells`/`maxPaletteEntries` 限制。驻留工作集
  有独立的 `maxResidentSections`/`maxResidentBytes` 上限（`ResidencyLimits`），覆盖加载、新建 Section 与观察增长。
- **显式预加载契约。** 向已保存但未驻留（或加载中）的 Section 写入会在任何变更前抛出 `VoxelResidencyError`
  （`requires_load`）；全新 Section 在驻留预算内直接接受。`observeBatch` 整批预检，未就绪 Section 不会留下半批
  写入。调用方先加载，再携原始 `observedAt`/`sessionId`/`sequence`/来源重投观察。
- **加载 ≠ 观察。** `loadSections` 恢复的已提交证据统一转 `STALE`（过去观察），绝不冒充新观察或当前 `OPEN`；
  不重放 `observe`、不置脏、不重置会话/中断边界。
- **安全卸载。** `unloadSections` 只释放已提交、无未保存变化、未被 Pin 的 Section，其余给出结构化原因
  （`pinned` / `dirty` / `not_committed`）。只释放运行态 payload，不删除目录记录、不清历史、不自动保存、不把
  该 Section 标为从未观察。
- **Pin 租约。** `pinSections` 返回 token；`releasePins(token)` 只释放自身租约。多个调用方可 Pin 同一 Section，
  重复/未知 token 释放为无操作，旧任务迟到释放不会解除新任务保护。Pin 不隐式加载、不刷新证据。
- **驻留失效。** `unloadSections`/`loadSections` 返回变更的 key；将其喂给 `TraversabilityCache.invalidateSections(keys)` /
  `RouteVerifier.invalidateSections(keys)`，卸载后不再返回旧 `OPEN`、回载后不再卡在此前 `UNKNOWN`，无关 Section 不受影响。
  见 `docs/phase-5d1-section-residency-acceptance.md`。

本轮只是手动按需驻留机制：不含自动 LRU/淘汰、预取、观察 overlay，也未接入真实 mineflayer/Curio 路线保护。

## 有界工作集管理

`WorkingSetManager`（阶段 5D2，`curio-minecraft-3d-memory/storage/sqlite`）是手动会话之上、由调用方显式启用的组合层。它把「提交当前需要的 Section 集合」变成有界的 prepare 循环——先整批校验、用临时 Pin 租约保护、在固定候选/卸载预算内按 LRU 顺序淘汰可淘汰 Section、经单 Worker 加载缺失 Section，最后返回精确结果与保护租约。

```ts
import { WorkingSetManager } from 'curio-minecraft-3d-memory/storage/sqlite';

const session = await openSpatialSession({ databasePath, worldId: 'world', voxelLoading: 'manual', residencyLimits: { maxResidentSections: 8 } });
const manager = new WorkingSetManager(session);

const result = await manager.prepare([a, b, c]);
result.status;      // 'ready' | 'incomplete' | 'failed'
result.prepared;    // ready 时为全请求；否则为空
result.loaded;      // 本次加载
result.noRecord;    // 无保存记录 —— 不伪造、不观察
result.notReady;    // loading / load_failed —— 本次未就绪
result.evicted;     // 本次为腾空间淘汰的可淘汰 Section
result.capacity;    // 成功为 null，否则结构化缺口（request_too_large / count_capacity / byte_capacity / …）
result.lease;       // 仅 status === 'ready' 时有效 —— 由调用方负责释放

// 接受新观测前先腾空间，用完再释放。
session.releasePins([result.lease.token]);
manager.free({ sections: 4 });   // 按 LRU 淘汰可淘汰项，直到驻留 ≤ 4 个 Section
manager.stats();                 // 有界只读快照（不加载/淘汰/保存/扫世界）
```

行为：

- **显式启用。** 默认 eager 加载不变；调用方构造 `WorkingSetManager` 才启用，且要求 `manual` 驻留会话。
- **会话门禁。** `prepare`/`free` 在任何 Pin/LRU/卸载前先取得**会话级**操作门禁（由 `SpatialSession` 持有，多个管理器与
  直接 `loadSections`/`checkpoint` 入口共享），busy、closing/closed、或另一个操作在途时直接拒绝，绝不「先淘汰再报 busy」。
- **精确成本。** `prepare` 先通过有界解码（`measureSections`）精确测量待加载 Section 的驻留成本，再按精确成本淘汰并安装
  （`installSections`），绝不用保守字节估算淘汰或误拒；恰好落在字节边界上的请求会被接受。
- **结果与租约一致。** `status` 区分 `ready`（全部驻留且受保护）、`incomplete`（存在 `noRecord`/`notReady`，无租约）、
  `failed`（容量缺口或读取失败，无租约）；`prepared` 始终反映实际保护状态。
- **确定性 LRU。** 成功命中（已驻留）与成功加载都会推进 Section 的 LRU 位置；新 Section 有确定初始位置。LRU 只是运行态缓存元数据——不持久化、不替代 `observedAt`/`sequence`/`revision`/保存批次、不刷新证据时间。淘汰循环单次快照 LRU 并用游标单向遍历，每个候选至多访问一次。
- **安全淘汰。** 按最旧优先选择候选并跳过本次请求集合；最终卸载始终经 `session.unloadSections`，因此 dirty、被 Pin、未提交的 Section 以结构化原因上报（`dirty` / `pinned` / `not_committed`），绝不凭陈旧元数据猜测。只释放已提交、干净、未被 Pin 的 Section；明显无法容纳的请求在淘汰前即被拒绝。
- **有界失败。** `no_record` 与 `load_failed` 分别表达，绝不报为「已就绪」。硬失败（读取失败 / 容量）会释放临时租约；部分淘汰后加载失败被如实上报，不伪装成回滚，也不删除数据库事实、不清除无关 dirty。数量缺口与字节缺口在结构化原因中区分。
- **索引一致。** 绕过管理器的直接 `loadSections` / `unloadSections` / `observe` 之后，`stats()` 会把 LRU 索引与真实驻留集合对齐（有界内存枚举），因此管理器不要求调用方放弃既有公开入口。

路线 Pin 闭环见 `examples/working-set.ts`：准备路线实际依赖的 Section → 恢复当前证据 → 验证 → 保护依赖 → 执行 Fake walk 路线 → 释放 → 腾空间。本轮只新增有界工作集管理：不含预测预取、后台淘汰、自动 checkpoint、观察 overlay、新寻路，也未接入真实 mineflayer/Curio。

## 目录结构

```
src/
├── index.ts            # 公共 API 出口（最小且明确的导出面）
├── constants.ts        # 单一配置常量（Section 尺寸、PASSAGE_LINK 等）
├── types.ts            # 基础原语（Vec3Like / BlockState / WorldScope / MoveMode）
├── observation/        # World Observer：Observation / 证据 / 新鲜度（§3.2）
├── voxel/              # Spatial Mapper：Section / Palette / 位打包（§4）
├── traversability/     # 派生通行性 + 有界陆地转换/路线验证（§3.3）
├── water/              # 只读水面与已乘船验证（子路径 /water）
├── topology/           # Topology Manager：路径片段 / 节点 / 边（§3.1、§5）
├── adapter/            # WorldAdapter 目标适配面（§2.1）
├── navigation/         # L2 导航原语与结果信封（§7）
├── execution/          # 受控 walk 路线执行闭环（§7 第一步、阶段 3）
├── store/              # SpatialMemoryStore 运行态接口（§9）
├── storage/            # SQLite 持久化与 Worker（§9，阶段 5）
└── compat/             # 旧 WorldMemory 入口的兼容层（§8、§9.1）

examples/
├── walk-route-execution.ts         # 可运行的 Fake 执行闭环示例
├── fragment-store-history.ts       # 可运行的 Fake 历史事实与当前阻塞对照示例
├── topology-facts.ts               # 可运行的 Fake 显式拓扑事实与当前阻塞对照示例
├── historical-topology-query.ts    # 可运行的 Fake 有界历史图查询示例
├── historical-anchor-query.ts      # 可运行的 Fake 有界历史锚点查询示例
├── history-checkpoint.ts           # 可运行的 SQLite 历史 checkpoint 生命周期示例
├── spatial-checkpoint.ts           # 可运行的组合空间 checkpoint 生命周期示例
├── spatial-checkpoint-incremental.ts # 可运行的体素增量 checkpoint 示例
├── spatial-residency.ts            # 可运行的手动按需 Section 驻留示例
├── working-set.ts                  # 可运行的有界工作集管理 + Fake 路线示例
└── shared-session-lifecycle.ts     # 可运行的宿主共享会话生命周期参考示例
```

## 陆地与水面验证

两个验证器都是只读、有界的。它们只消费 `VoxelMap` 已接受的证据，不扫描、不加载、不生成、不搜索路线、不执行移动、不挖、不放、不建造、不上下船，也不接管救援策略。

### 陆地转换与路线

```ts
import {
  evaluateLandTransition,
  LandRouteVerifier,
  resolveLandLimits,
} from 'curio-minecraft-3d-memory';

const evaluation = evaluateLandTransition(
  map,
  { worldId, dim, sessionId, body, transition }, // transition.kind 必须显式给出
  { shapeProvider, jumpModel, climbProvider },  // jumpModel / climbProvider 仅对应类型需要
  Date.now(),
  resolveLandLimits({ maxWork: 4096 }),
);

const verifier = new LandRouteVerifier(map, { limits: { maxWork: 8192 } });
verifier.register({ worldId, dim, sessionId, body, rules, transitions });
```

`body.feet` 必须与 `transition.from` 精确相等，坐标不取整、不吸附。结果与快照固定带 `assurance: 'geometry_only'` 与 `executable: false`。仅支持 `step` / `drop` / `jump` / `ladder` 四类几何子集；`jump` 必须提供注入的版本化 `LandMotionModel`，`ladder` 必须提供注入的版本化 `ClimbRegionProvider`；缺失时返回 `UNSUPPORTED`，绝不推断为可通行。见 [`docs/land-route-validation.md`](docs/land-route-validation.md)。

### 水面与已乘船

```ts
import { checkWaterArrival, evaluateWaterRoute } from 'curio-minecraft-3d-memory/water';

const route = evaluateWaterRoute(map, {
  worldId, dim, sessionId,
  points,                // 调用方选定、有序、Y 完全相同
  profile,               // surface_swim | mounted_boat
  solidShapeProvider,
  fluidShapeProvider,
}, Date.now());

const arrival = checkWaterArrival({ goal, scope, map, samples, now, maxSampleAgeMs });
```

路线必须等高且姿态固定为 90° 的整数倍；竖直转换或任意偏航返回 `UNSUPPORTED`。实心碰撞与流体/水面解释是两套独立的版本化权威；Provider 的每次邻格读取都受预算约束并记录为 Section 依赖。`OPEN` 只表示有限几何/证据契约成立，从不表示已经到达、已获授权、执行器支持或无风险。`checkWaterArrival` 是基于实测有序采样的独立完成确认，返回 `ARRIVED` 或 `UNCONFIRMED`。两者都不搜索、不控制身体、不操作船。见 [`docs/water-validation.md`](docs/water-validation.md)。

## 安装与消费

```bash
npm install --no-audit --no-fund          # 开发依赖
npm run build                             # 产出 dist/（NodeNext ESM + 类型声明）
npm pack                                  # 产出 curio-minecraft-3d-memory-<version>.tgz
```

消费者在独立项目中安装实际 `.tgz`，用包名与公开子路径引入（不用源码路径、`../dist`、`npm link` 或开发机目录别名）：

```json
{ "dependencies": { "curio-minecraft-3d-memory": "file:./curio-minecraft-3d-memory-0.8.0.tgz", "better-sqlite3": "^12.0.0" } }
```

```ts
import {
  LandRouteVerifier,
  RouteVerifier,
  WalkRouteExecutor,
  evaluateLandTransition,
} from 'curio-minecraft-3d-memory';
import { openSpatialSession, WorkingSetManager } from 'curio-minecraft-3d-memory/storage/sqlite';
import { checkWaterArrival, evaluateWaterRoute } from 'curio-minecraft-3d-memory/water';
```

运行时要求 Node `>= 18`。核心入口（`curio-minecraft-3d-memory`）、`water` 子入口
（`curio-minecraft-3d-memory/water`）以及核心入口导出的陆地验证器均无原生依赖、不启动 Worker；SQLite 子入口
（`curio-minecraft-3d-memory/storage/sqlite`）在单个 Worker 线程内使用 `better-sqlite3`（可选 peer dependency），
使用 SQLite 的消费者须显式安装 `better-sqlite3@^12`。独立安装验收一键命令：`node acceptance/run.mjs`
（打包 → 临时安装 → 运行时断言 + 类型检查，任一失败非零退出）。

## 宿主共享会话生命周期

库只提供事实与执行辅助；宿主（Curio）负责连接、真实感知与身体控制。接线顺序见
`examples/shared-session-lifecycle.ts`（默认 eager 加载，适用于世界规模落在会话预算内的情况）：

1. **宿主启动**：宿主提供数据库绝对路径与 `worldId`，`await openSpatialSession({ databasePath, worldId })`
   完成后再使用返回的 `session.voxel`，不每个动作新建地图。
2. **共享地图**：持续感知与多个 walk 委托共用 `session.voxel`；共享地图不代表共享各委托的执行所有权。
3. **连接与重连**：观测 `sessionId` 来自实际连接生命周期；正常重连同一世界不更换 `worldId`。用
   `map.beginSession(sessionId)` 切换，旧会话的迟到观测被拒绝，不能重新标 FRESH。
4. **感知更新**：宿主先 `map.observe(...)` 写入合法观测，再把返回的 `ChangeReport` 交给活跃路线
   （`RouteVerifier.apply` / `WalkRouteExecutor.observe`）；库不主动扫描世界。
5. **路线生命周期**：加载、准备并保护实际路线依赖（`WorkingSetManager.prepare` + 租约），结束
   `releasePins`；取消某动作不关闭共享会话。需按需驻留见“手动按需 Section 驻留 / 有界工作集管理”。
6. **保存与关闭**：`checkpoint()` 捕获并提交当前变化（唯一保存触发）；`flush()` 只等待已接受的保存；
   `close()` 做有界关闭。顺序：停止接收写入 → 最终 `checkpoint` → 检查确认 → `close`。
7. **恢复**：恢复的是历史记录与原证据时间，当前通行性必须重新建立，不能把读回数据库当作重新观察。

## 开发

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run build       # 产出 dist/（NodeNext ESM + 类型声明）
npx tsx examples/walk-route-execution.ts    # 运行 Fake 执行示例
npx tsx examples/fragment-store-history.ts  # 运行 Fake 历史事实示例
npx tsx examples/topology-facts.ts          # 运行 Fake 显式拓扑示例
npx tsx examples/historical-topology-query.ts # 运行 Fake 有界历史图查询示例
npx tsx examples/historical-anchor-query.ts   # 运行 Fake 有界历史锚点查询示例
npx tsx examples/history-checkpoint.ts        # 运行 SQLite checkpoint 生命周期示例
npx tsx examples/spatial-checkpoint.ts        # 运行组合空间 checkpoint 生命周期示例
npx tsx examples/spatial-checkpoint-incremental.ts # 运行体素增量 checkpoint 示例
npx tsx examples/spatial-residency.ts         # 运行手动按需 Section 驻留示例
npx tsx examples/working-set.ts               # 运行有界工作集管理 + Fake 路线示例
npx tsx examples/shared-session-lifecycle.ts  # 运行宿主共享会话生命周期参考示例
node acceptance/run.mjs                       # 运行独立消费者安装验收（打包 + 临时安装 + 断言 + 类型检查）
```

> `examples/fragment-store-history.ts`、`examples/topology-facts.ts`、`examples/historical-topology-query.ts`、`examples/historical-anchor-query.ts` 与 `examples/history-checkpoint.ts` 以公开包名（`curio-minecraft-3d-memory`，其中 `history-checkpoint.ts` 使用 `curio-minecraft-3d-memory/storage/sqlite` 子路径）而非源码路径导入，用于验证包的 `exports` 入口 —— 请先 `npm run build` 再运行。

> 持久化入口（`curio-minecraft-3d-memory/storage/sqlite`）在单个 Worker 线程内使用 `better-sqlite3`（可选 peer dependency）。核心入口（`curio-minecraft-3d-memory`）无原生依赖、从不启动 Worker。

## License

UNLICENSED（私有）。
