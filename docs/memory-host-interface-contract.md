# 空间记忆库 ↔ Agent 宿主接口契约

> 文档状态：v0.1（2026-11-06，首版接口契约）
> 契约版本：`memory-host-contract/1`
> 库基线：`integration/memory-host-20261106`，代码 HEAD `df4be98`，包版本 `0.10.0`
> 宿主参考：`E:\Repos\MinecraftLLM\docs\movement-primitives-refactor-plan-20261106.md`（源码基准 `8fa5a8e`）
> 相关设计：[空间记忆与导航库设计](./spatial-memory-library-design.md)、[实现审计](./implementation-audit-0.10.0.md)、[实现计划与代码审计要求](./memory-host-implementation-plan.md)

> **这是目标契约，不是“全部已实现”的报告。** 每一节都标注 `[已实现]`、`[待实现]` 或 `[宿主职责]`。Agent 侧在接线前必须读取 §15 的实现状态表，并通过 §2 的能力协商确认实际可用能力；不得把目标类型当成已存在的运行时入口。

---

## 0. 目的与阅读方式

本文件定义**空间记忆库**与 **Agent 宿主（Curio / mineflayer 适配层）**之间的唯一接口契约。目标是让宿主可以：

1. 把合法观测、实际遍历、已确认动作效果写入记忆库；
2. 以只读方式查询资源锚点、容器位置、历史路线、当前证据；
3. 可选地调用只读路线规划，拿到可检查的 `routeId`；
4. 可选地把 `routeId` 交给有界执行器，逐段执行并如实回执；
5. 在观测变化、会话变化、取消/超时和持久化边界上保持正确语义。

阅读顺序：

- 宿主接线负责人：§1 → §2 → §3 → §4 → §5 → §6 → §7 → §8 → §13 → §15。
- Agent/技能开发：§5 → §6 → §7 → §9 → §13。
- 库维护者：全部，尤其 §10、§11、§14、§15。

规范性用语：

- **MUST / 必须**：不满足即视为接线错误。
- **SHOULD / 应当**：默认应满足；偏离必须记录原因。
- **MAY / 可以**：可选能力，必须通过能力协商确认。
- **不得**：禁止行为；实现必须拒绝或返回结构化错误。

---

## 1. 职责边界

### 1.1 三层职责

| 层 | 负责 | 不负责 |
|---|---|---|
| **空间记忆库（本仓库）** | 记录证据与历史；查询事实；可选的只读路线规划；可选的有界路线执行编排（仅通过注入身体端口） | 自行扫描世界；持有 bot；选目标/技能/材料；自动救援/施工/探索；保存容器内容 |
| **宿主 / Curio** | 视锥与接触感知；L1 基础元语；身体控制；授权、材料与消耗；动作仲裁；容器精确账本；目标语义；生命周期 | 把原始 `blockUpdate`/墙后数据当观测；让库替自己决定策略 |
| **Agent / LLM** | 选择目标、技能、路线、风险取舍、是否继续/改路/放弃 | 直接做 50 ms 级身体控制；伪造观测或到达 |

### 1.2 纯记忆库硬边界

以下约束对 `memory` 核心入口始终成立：

1. **不持有身体。** 没有 bot、按键、寻路器或 `MoveExecutor` 依赖。
2. **不派发动作。** 核心入口不导出 `moveTo`/`dig`/`place`/`navigateTo`/`walkPath` 等动作编排。
3. **不自行观察。** 只接受宿主通过合法感知边界提交的 `Observation`/`ObservationBatch`。
4. **不保存容器内容。** 只保存容器位置锚点与存在性证据；M2 查询不计算新的可达性。物品数量归宿主精确账本。
5. **不生成策略。** 不自动挖、放、搭柱、堵水、造船、救援、探索或改目标。
6. **不伪造证据。** 未观察、遮挡、太暗、未加载、预算跳过不得写成空气；历史经过不得写成当前可走。

### 1.3 可选导航层

`planRoute`/`walkPath` 属于**可选导航层**，不是 memory 核心：

- `planRoute` 是只读规划，返回事实与候选，无世界写入、无移动、无消耗。
- `walkPath` 是有界执行编排，必须通过宿主注入的身体端口；库仍不持有 bot。
- 如果宿主决定完全自己做路线规划/执行，可以只使用 §4（写入）与 §5（查询），不使用 §6/§7。
- **一次导航委托只能选择一个规划后端。** 不得在同一委托里同时使用 `planRoute` 和宿主的 pathfinder 重新规划。

### 1.4 L1 基础元语不属于本库

| 宿主 L1 元语 | 归属 | 本库关系 |
|---|---|---|
| `move_step` | Curio | 库只接收其确认后的观测/遍历证据 |
| `mine_cell` | Curio | 库只接收 `confirmed_effect` 观测和 `markModified` |
| `place_cell` / `place_support` | Curio | 库只接收确认后的方块状态和修改历史 |
| `pillar_one` | Curio | 同上 |
| `look` / `press_keys` | Curio | 库不参与 |

本库**不得**为这些元语提供封装、代执行或隐式调用。

---

## 2. 版本、入口与能力协商

### 2.1 契约版本

- 契约版本字符串：`memory-host-contract/1`。
- 宿主必须在启动时读取能力报告，并把契约版本写入日志/动作记录。
- 响应可以增加字段；请求中的**未知字段必须拒绝**（`invalid_request`），不得静默忽略。
- 新增枚举值、改变字段语义或收窄必填字段 = 契约 minor/major 变更，必须同步宿主。

### 2.2 包入口

当前包（`package.json`）：

| 入口 | 当前状态 | 用途 |
|---|---|---|
| `curio-minecraft-3d-memory` | 已实现 | 兼容入口；当前同时导出 memory、topology、navigation、execution |
| `curio-minecraft-3d-memory/storage/sqlite` | 已实现 | SQLite 会话、Worker、账本、WorkingSet |
| `curio-minecraft-3d-memory/water` | 已实现 | 水面/船体几何验证（不可执行） |

目标拆分（待实现）：

| 目标入口 | 内容 |
|---|---|
| `curio-minecraft-3d-memory/memory` | 纯记忆核心：写入、查询、持久化适配；不导出动作 API |
| `curio-minecraft-3d-memory/navigation` | 可选导航层：`planRoute`、`walkPath`、路线句柄、执行编排 |
| `curio-minecraft-3d-memory/storage/sqlite` | 保持 |
| `curio-minecraft-3d-memory/water` | 保持（几何验证） |

在拆分完成前，宿主可以继续从根入口导入，但必须只使用本契约列出的 memory/query/plan/walk 接口，不得因为根入口存在 `navigateTo` 就把它当作 `walkPath` 的后端。

### 2.3 能力协商

```ts
export type ContractVersion = 'memory-host-contract/1';

export interface MemoryHostCapabilities {
  contract: ContractVersion;
  memory: {
    observeBatch: boolean;
    beginSession: boolean;
    markStale: boolean;
    markTraversed: boolean;
    markModified: boolean;
    saveFragment: boolean;
    addTraversal: boolean;
    recordNode: boolean;
    upsertEdge: boolean;
    savePortalEdge: boolean;
    checkpoint: boolean;
    flush: boolean;
    close: boolean;
  };
  query: {
    cells: boolean;
    fragments: boolean;
    traversals: boolean;
    nodes: boolean;
    edges: boolean;
    historyRoute: boolean;
    anchors: boolean;
    components: boolean;
    /** 增量：§5.2 暴露了 segments kind。 */
    segments: boolean;
    portals: boolean;
    /** 增量：§5.2 暴露了独立 kind，宿主需要能协商。 */
    resourceAnchors: boolean;
    containerAnchors: boolean;
    containerContents: false; // 永远为 false：宿主账本职责
  };
  plan: {
    walkSearch: boolean;
    walkHistory: boolean;
    walkAuto: boolean;
    nearArrival: boolean;      // v1: false
    reachBlockArrival: boolean; // v1: false
    digPlaceTower: boolean;    // v1: false
    swim: boolean;             // v1: false
    boat: boolean;             // v1: false
  };
  execute: {
    walk: boolean;
    groundedArrival: boolean;
    invalidation: boolean;
    cancellation: boolean;
    swim: boolean;             // v1: false
    boat: boolean;             // v1: false
  };
  persistence: {
    sqlite: boolean;
    manualResidency: boolean;
    workingSet: boolean;
    migrationAuthoritySwitch: boolean; // v1: false
  };
}
```

规则：

- 宿主 MUST 在调用某个接口前检查对应能力；`false` 时不得调用，也不得静默回退到权限更宽的旧后端。
- 能力报告中的 `false` 是契约事实，不是建议。
- `containerContents: false` 是恒定值：容器内容不在本库。

---

## 3. 共享原语与作用域

### 3.1 标识

| 名称 | 类型 | 语义 |
|---|---|---|
| `worldId` | `string` | 存档身份；一个 store 实例绑定一个不可变 `worldId` |
| `dim` | `string` | 维度身份 |
| `sessionId` | `string` | 连接/观察会话；重连必须换新值 |
| `observedAt` | `number` | 实际获得证据的真实时间；不是接收/保存时间 |
| `sequence` | `number` | 同一会话内的接收顺序；不是世界 tick |
| `actionId` | `string` | 已确认自身动作的关联 ID；不得按时间接近推断 |
| `executionId` | `string` | 一次受控执行的稳定身份；迟到回调必须按它隔离 |
| `routeId` | `string` | `planRoute` 产生、`walkPath` 消费的路线句柄；绑定世界/维度/会话/证据 |
| `planId` | `string` | 规划记录的身份（可与 `routeId` 相同；宿主可用于日志） |

### 3.2 坐标

- `Vec3Like` 是**连续脚底位置**，不是方块格。
- 方块格/支撑格由库内部用 `floor` 与形状规则推导；调用方不得先把脚位置取整再传给路线规划来“凑”到达。
- 路线点是连续脚位序列；执行器按实际身体样本确认。
- `exact` 到达与 `grounded` 到达是不同契约：
  - `exact`：坐标比较（旧 `navigateTo` 使用 1e-6）。
  - `grounded`：`bodyArrival` 容差 + 支撑/接地/稳定样本（新 `walkPath` 使用）。
- 本契约的 `walkPath` **只接受 grounded 到达语义**；不接受 1e-6 精确坐标相等来宣称到达。

### 3.3 作用域不变量

- 每次写入/查询/规划/执行都必须携带或派生 `worldId`/`dim`/`sessionId`。
- 作用域不匹配 MUST 返回 `scope_mismatch`，不得跨世界/维度重定向。
- 旧会话证据 MUST 被拒绝；不得用新会话身份覆盖或续签旧证据。
- 换维/重连/死亡重生后，旧 `routeId` 一律失效；必须重新规划。

### 3.4 证据与时间

- `Observation.observedAt` 是实际观测时间；`CellEvidence.validUntil` 是复用上限，不是世界变化时刻。
- `FRESH`/`STALE` 是证据新鲜度；`OPEN`/`BLOCKED`/`UNKNOWN`/`STALE` 是通行结论。
- `UNKNOWN`/`STALE` 绝不当 `OPEN`。
- 历史路径/遍历证据不证明当前可走。
- 任何“当前可走”的结论都必须来自当前证据 + 身体/模式上下文。

---

## 4. 写入契约（宿主 → 库）

### 4.1 写入端口

```ts
// [目标接口] memory core
export interface MemoryIngest {
  /** 开始/切换观察会话；返回本地 ChangeReport。 */
  beginSession(sessionId: string): ChangeReport;

  /** 原子接受一个观测批次；任一条非法则整批拒绝。 */
  observeBatch(batch: ObservationBatch): BatchChangeReport;

  /** 标记实际走过的格；只来自实测，不从请求/时间接近推断。 */
  markTraversed(dim: string, pos: Vec3Like): void;

  /** 标记已确认自身动作修改的格；必须带 actionId。 */
  markModified(dim: string, pos: Vec3Like, actionId: string): void;

  /** 保存历史几何；不生成 traversal，不证明当前可走。 */
  saveFragment(fragment: PathFragment): void;

  /** 保存实际连续走过的证据；fragment 必须已存在。返回写入结果（inserted/unchanged）。 */
  addTraversal(evidence: TraversalEvidence): SaveResult;

  /** 记录命名锚点；label/tag/metadata 对库不透明。 */
  recordNode(
    label: string,
    pos: Vec3Like,
    tag?: LandmarkTag,
    options?: RecordNodeOptions,
  ): SpatialNode;

  /** 记录明确的关系；不得自动生成反向边。 */
  upsertEdge(edge: SpatialEdgeRecord): void;

  /** 传送边与原始穿越证据；与步行图分开。 */
  savePortalEdge(edge: PortalEdgeInput, traversals: PortalTraversalEvidence[]): void;
  addPortalTraversal(edgeId: string, traversal: PortalTraversalEvidence): void;

  /** 观察中断/卸载/换会话；只改变新鲜度，不删除历史。 */
  markStale(dim: string, reason: StaleReason): ChangeReport;
}
```

**当前状态：**

- `[已实现]` `observeBatch`、`markTraversed`、`markModified`、`saveFragment`、`recordNode`、`upsertEdge`、`savePortalEdge`、`addPortalTraversal`、`beginSession`/`markStale`（在 `VoxelMap` 上）。
- `[已实现]` `SpatialMemoryStore.observeBatch` 返回 `BatchChangeReport`；store 先做世界作用域校验并抛 `SpatialMemoryScopeError`，再由 `VoxelMap.observeBatch` 完成整批形状/缺口校验与原子写入。
- `[已实现]` `SpatialMemoryStore.beginSession`/`markStale` 委托 `VoxelMap` 并返回 `ChangeReport`；旧会话写入由 `VoxelMap` 拒绝，历史与原始证据时间保留。
- `[已实现]` `SpatialMemoryStore.addTraversal` 与 `MemoryIngest.addTraversal` 委托 `FragmentStore.addTraversal`，保留 fragment 必须存在、同世界/同维、幂等/冲突/容量语义，并返回 `SaveResult`（响应字段增加；调用方可忽略）。
- `[已实现]` 统一 `MemoryIngest` 端口（`src/memory/ingest.ts`）；`SpatialMemoryStoreImpl` 实现该端口，写入方法不再要求宿主直接接触 `VoxelMap`/`FragmentStore`。
- `[已实现]` `ChangeReport` 订阅：`VoxelMap.subscribeChanges` 与 store 的 `ChangeReportSource`（`subscribeChanges`）在证据更新后同步转发；空报告不投递。

### 4.2 Observation 必填语义

| 字段 | 规则 |
|---|---|
| `pos` | 有限坐标；格坐标由库内部推导 |
| `state` | `name + properties`；不得只给名字却声称完整 |
| `stateComplete` | 缺属性时为 `false`；不得从空 properties 猜完整 |
| `evidence` | `seen` / `contact` / `confirmed_effect` |
| `source` | `vision` / `agent_action` / `local_rescan` |
| `observedAt` | 实际观测时间；不得用保存/接收时间 |
| `sessionId` | 当前会话；旧会话必须拒绝 |
| `sequence` | 同一会话内非递减接收顺序 |
| `actionId` | 仅 `confirmed_effect` 且确认归属时提供 |
| `worldId` / `dim` | 必须与目标 store 一致 |

硬性规则：

1. `agent_action` MUST 配 `confirmed_effect` 和 `actionId`。
2. `contact` 只能证明接触/受阻；不能填入未看见的方块名称。
3. 确认空气 MUST 显式写入 `state = air` 且 `evidence` 合法；未返回的格不是空气。
4. `ObservationGap.reason` 必须是边界实际能确认的原因；不确定用 `unknown`，不得在遮挡/太暗/未加载之间猜。
5. 同一批次的观测与 gap 一起提交；`observeBatch` 必须先校验整批，再写入。
6. 旧 `observedAt`/旧 `sequence`/旧会话的写入 MUST 拒绝；同一时间戳的不同状态 MUST 产生 `conflict`（当前证据 STALE），不得静默 last-writer-wins。
7. 写入成功后返回 `BatchChangeReport`；宿主 MUST 在下一控制步前把它转发给活跃的 verifier/executor。

### 4.3 TraversalEvidence 必填语义

```ts
export interface TraversalEvidence {
  id: string;
  fragmentId: string;
  from: Vec3Like;
  to: Vec3Like;
  worldId: string;
  dim: string;
  sessionId: string | null;   // null = unknown，不伪造
  observedAt: number | null;  // null = unknown，不用 Date.now 补
  source: string;             // 宿主来源标签，不透明
  executionId?: string;       // 实际执行身份；不得推断
  actionId?: string;          // 已确认动作身份；不得推断
  mode?: MoveMode;            // 未知则缺省，不默认 walk
}
```

规则：

- `fragmentId` MUST 已存在且同世界/同维度。
- `from → to` MUST 是实际连续走过的段；不得用计划坐标、传送或时间接近补边。
- `id` 幂等：同 id 同内容 = 不变；同 id 不同内容 = 冲突错误。
- 容量满时 MUST 拒绝整条写入，不得静默丢弃。
- 保存 traversal 不等于当前可走；只证明历史经过。

### 4.4 Fragment 必填语义

```ts
export interface PathFragment {
  id: string;
  worldId: string;
  dim: string;
  kind: 'dug' | 'walked' | 'bridge' | 'built';
  entrances: Vec3Like[];       // 地表参考点，不保证实际开口
  polyline: Vec3Like[];        // 脚点几何
  geometrySource: 'traversal' | 'observed_structure' | 'legacy';
  links?: { a: Vec3Like; b: Vec3Like }[];
  deepestY: number;
  createdAt: number;
  lastUsedAt: number;
  uses: number;
  externalRef?: string;
  metadata?: JsonObject;
}
```

规则：

- `kind`/`geometrySource` 是来源标签，不是当前通行结论。
- `bridge`/`built` 几何不得自动生成 `traversed` 或亲历 `links`。
- 当前堵塞只影响派生通行性，不删除 fragment。
- 旧记录迁移时必须保留 ID、来源和原始时间；不得把 `legacy` 几何升级成亲历。

### 4.5 写入生命周期

```
连接/重连 → beginSession(sessionId)
   ↓
感知循环 → observeBatch(batch) → BatchChangeReport
   ↓                                  ↓
   │                        转发给活跃 verifier/executor
   ↓
已确认移动 → markTraversed / addTraversal
已确认动作 → observeBatch(confirmed_effect) / markModified
   ↓
checkpoint() → saved / pending / failed
   ↓
重连/换维 → 旧 session 拒绝；相关证据 STALE
   ↓
flush() / close()
```

规则：

- “已观测” ≠ “已保存”。`observeBatch` 返回只表示内存接受。
- `checkpoint()` 是显式保存触发；返回确认后才算保存。
- 保存失败不得把已发生的身体效果改成未发生；单独报告 `memoryWrite`。
- 重启恢复保留原始观测时间；FRESH 证据恢复为 STALE；当前通行结论必须重新建立。
- `beginSession`/`markStale` 返回的 `ChangeReport` 也必须转发给活跃执行器。

---

## 5. 查询契约（库 → 宿主）

### 5.1 查询端口

```ts
// [目标接口] memory core
export interface SpatialQueryPort {
  query(request: SpatialQueryRequest): SpatialQueryResult;
}
```

### 5.2 请求

```ts
export type SpatialQueryRequest =
  | { kind: 'cells'; dim: string; positions: Vec3Like[] }
  | { kind: 'fragments'; dim?: string; fragmentKind?: PathFragment['kind']; geometrySource?: PathFragment['geometrySource']; after?: string; limit?: number }
  | { kind: 'traversals'; dim?: string; fragmentId?: string; after?: string; limit?: number }
  | { kind: 'nodes'; dim?: string; tag?: LandmarkTag; label?: string; source?: NodeSource; after?: string; limit?: number }
  | { kind: 'edges'; dim?: string; from?: string; to?: string; type?: ConnectionType; basis?: EdgeBasis; after?: string; limit?: number }
  | { kind: 'historyRoute'; dim: string; from: Vec3Like; to: Vec3Like; near?: number }
  | { kind: 'anchor'; dim: string; here: Vec3Like; order: 'surface' | 'deepest'; near?: number }
  | { kind: 'components'; dim: string }
  | { kind: 'segments'; fragmentId: string }
  | { kind: 'portals'; after?: string; limit?: number }
  | { kind: 'resourceAnchors'; dim?: string; tag?: LandmarkTag; label?: string; after?: string; limit?: number }
  | { kind: 'containerAnchors'; dim?: string; after?: string; limit?: number }
  // 增量（M2）：内容永远转交宿主账本；该 kind 不产生 data。
  | { kind: 'containerContents'; dim?: string; nodeId?: string }
  | { kind: 'snapshot' }
  | { kind: 'capabilities' };
```

### 5.3 结果信封

```ts
export type SpatialQueryStatus =
  | 'ok'
  | 'partial'
  | 'not_found'
  | 'unsupported'
  | 'scope_mismatch'
  | 'invalid_request';

/** One cell's read-only projection; `observed:false` never means air. */
export interface CellQueryView {
  pos: Vec3Like;
  observed: boolean;
  state?: BlockState;
  stateComplete?: boolean;
  evidence?: EvidenceKind;
  freshness?: Freshness;
  validUntil?: number;
  staleReason?: string;
  /** Present only when this requested cell could not be observed. */
  gap?: ObservationGap;
}

export type SpatialQueryData =
  | { kind: 'cells'; cells: CellQueryView[]; gaps: ObservationGap[] }
  | { kind: 'fragments'; items: PathFragment[]; total: number; nextAfter?: string }
  | { kind: 'traversals'; items: TraversalEvidence[]; total: number; nextAfter?: string }
  | { kind: 'nodes'; items: SpatialNode[]; total: number; nextAfter?: string }
  | { kind: 'edges'; items: EdgeView[]; total: number; nextAfter?: string }
  | { kind: 'historyRoute'; inspection: HistoricalRouteInspection }
  | { kind: 'anchor'; anchor: AnchorResult | null }
  | { kind: 'components'; report: ComponentReport }
  | { kind: 'segments'; segments: FragmentSegmentsResult }
  | { kind: 'portals'; items: PortalEdgeView[]; total: number; nextAfter?: string }
  | { kind: 'resourceAnchors'; items: SpatialNode[]; total: number; nextAfter?: string }
  | { kind: 'containerAnchors'; items: SpatialNode[]; total: number; nextAfter?: string }
  | { kind: 'snapshot'; snapshot: SpatialMemoryStoreSnapshot }
  | { kind: 'capabilities'; capabilities: MemoryHostCapabilities };

// `containerContents` 没有 data 变体：其成功形态就是结构化 `host_ledger`
// problem（见 §5.5）。不得返回 `items: []`。

export interface SpatialQueryResult {
  status: SpatialQueryStatus;
  contract: 'memory-host-contract/1';
  worldId: string;
  dim?: string;
  sessionId?: string;
  computedAt: number;
  readOnly: true;
  /** 历史/几何查询永远不可执行；当前证据查询也不代表执行授权。 */
  executable: false;
  data?: SpatialQueryData;
  problem?: SpatialQueryProblem;
  total?: number;
  nextAfter?: string;
}
```

`SpatialQueryProblem` 至少包含：

```ts
export type SpatialQueryProblem =
  | { kind: 'invalid_request'; detail: string }
  | { kind: 'scope_mismatch'; expected: WorldScope; actual: WorldScope }
  | { kind: 'unsupported'; query: SpatialQueryRequest['kind']; detail: string }
  | { kind: 'host_ledger'; detail: string }   // 容器内容等宿主职责
  | { kind: 'not_found'; detail: string };
```

### 5.4 查询语义

| 查询 | 返回 | 不得声称 |
|---|---|---|
| `cells` | 每格的 state/evidence/freshness/validUntil；未观察/未驻留原因（`not_resident`/`loading`/`load_failed` → `gap.reason:'unloaded'` + `status:'partial'`） | 未返回 = 空气；未驻留 = 从未观察；历史 gap 可重建 |
| `fragments` | 历史几何、kind、geometrySource、polyline、端点、分页 | 历史 = 当前可走 |
| `traversals` | 实际走过证据、方向、会话、时间 | 保存几何 = 实际走过 |
| `nodes` | 地点/资源/基地/危险等锚点、精确/区域位置、来源 | 名字/标签 = 自动资源发现 |
| `edges` | 方向/类型/依据/当前验证视图 | 反向自动成立；候选边 = 已走过 |
| `historyRoute` | 有序历史路点、分段、缺口；`historicalGeometry:true`、`executable:false`、`currentPassability:'UNKNOWN'` | 历史路线可直接执行 |
| `anchor` | 可达连通分量内的 surface/deepest 锚点 | 任意全网锚点；区域中心 = 精确交互目标 |
| `components` | 连通分量/碎片统计 | 当前可走 |
| `segments` | 由已记录 edge verification 推导的分段、cuts、blocked edge ids；未验证连接不会被切割，因此分段不等于当前可通行；未知 fragment 返回 `not_found` | 分段 = 已授权执行；分段 = 当前已确认可通行的全量证明；历史 fragment 被删除 |
| `portals` | 独立 portal 边与原始穿越证据 | 接近门 = 已穿越 |
| `resourceAnchors` | `tag`/`label` 过滤后的 `SpatialNode` 位置、精度、观测时间、来源 | 资源数量/价值/自动采集；M2 不计算可达性 |
| `containerAnchors` | 容器位置、存在性、精确坐标、观测时间；需要宿主注入 `isContainer` 分类器；只返回 exact 节点 | **容器内容/数量/空槽**；区域中心 = 精确容器目标 |
| `containerContents` | 固定 `status:'unsupported'` + `problem.kind:'host_ledger'`，无 `data` | 空箱；`items:[]`；任何内容/数量 |
| `snapshot` | 只读计数/版本/能力 | 当前通行结论 |
| `capabilities` | 能力报告 | 未实现能力已可用 |

### 5.5 容器查询的硬边界

- 本库只回答：“这个容器位置是否被记录、最后确认存在、最后记录的证据时间”。M2 的 `containerAnchors` 不计算新的可达性；可达性必须由宿主的路由/感知证据判断，不能从位置记录推断。
- 本库**不回答**：“箱子里有什么、有多少、还能放多少”。
- 请求容器内容时 MUST 返回：

```json
{
  "status": "unsupported",
  "readOnly": true,
  "problem": {
    "kind": "host_ledger",
    "detail": "container contents are owned by the host precise inventory ledger; the spatial library stores location/reachability evidence only"
  }
}
```

- 不得返回空列表或 `items:[]` 冒充“空箱”。

### 5.6 分页与边界

- 所有列表查询默认 `limit = 100`，最大 `limit = 1000`；M2 对越界值返回 `invalid_request`，不做静默截断。
- 当请求 `limit` 大于底层 store 的单页上限（默认 100）时，查询层合并在途页直到满足请求值；`total` 仍取过滤后匹配总数。
- `after` 是稳定 ID 游标；同一作用域内可重复查询。
- `total` 是匹配总数；不得用整页长度代替。
- `cells` 查询位置数量上限为 4096；超过返回 `invalid_request`。
- `containerAnchors` 的分类器没有索引，因此会分页扫描节点直到耗尽；扫描范围由 `TopologyStore` 的节点容量上限约束，`total` 是完整匹配数。大节点集上的频繁调用列为 M8 基准候选，不得用固定前缀预算牺牲游标正确性。
- 查询 MUST 只读：不移动、不转头、不扫描、不刷新观测时间、不写库、不 pin/保存。
- 查询不得隐式重试或回退到世界/区块扫描。`containerAnchors` 的宿主分类器没有索引，会对**内存节点索引**做一次只读遍历以获得精确 `total`；该 O(nodes) 工作是 M8 基准候选，不是世界扫描。
- M2 的请求不带 `worldId`：store 绑定单一不可变世界，`scope_mismatch` 保留给未来的世界寻址适配器，当前没有产生者。

### 5.7 当前实现映射

- `[已实现]` `SpatialMemoryStore.sectionAt`、`fragments`、`graph`、`displayNodes`、`edgeRuntime`、`portalEdges`、`route`、`routeInspection`、`surfaceAnchor`、`deepestAnchor`、`components`、`segments`、`fragmentation`。
- `[已实现]` `TopologyStore.nodes({ dim, source, tag, label, after, limit })`。
- `[已实现]` `FragmentStore.fragments/traversals`。
- `[已实现]` 统一 `SpatialQueryPort` 投影（`src/query/*`，通过 `SpatialMemoryStore.query(request)` 暴露）：cells、fragments、traversals、nodes、edges、historyRoute、anchor、components、segments、portals、resourceAnchors、containerAnchors、containerContents、snapshot、capabilities；未知字段/未知 kind 拒绝；列表分页 100/1000；查询只读。
- `[增量]` `containerContents` 与 `segments` 是 M2 新增请求 kind；`containerContents` 固定返回 `host_ledger`，无 `data`；`MemoryHostCapabilities.query.segments`/`resourceAnchors` 是 §2.3 的增量能力位。`not_found` 也作为新增状态用于未知 fragment。
- `[已实现，需宿主配置]` `containerAnchors` 依赖宿主注入 `isContainer` 分类器；未配置时返回 `unsupported` 且能力为 `false`。库不解释 label/metadata；扫描受节点容量约束并返回完整 `total`。
- `[宿主职责]` 容器内容、库存、玩家/生物实时占位语义（库可存位置/可达证据，但不复制账本）。

---

## 6. 规划契约（可选导航层，库 → 宿主）

### 6.1 规划端口

```ts
// [目标接口] optional navigation
export interface RoutePlanner {
  planRoute(request: RoutePlanRequest, environment: RoutePlanEnvironment): Promise<RoutePlanResult>;
}
```

### 6.2 请求

```ts
export type RoutePlanSource = 'auto' | 'search' | 'history';

export interface RoutePlanRequest {
  /** 绝对连续脚位目标；名字/方向先由宿主 resolve_target 解析。 */
  to: Vec3Like;
  /** v1 只接受 walk。 */
  mode: 'walk';
  /** auto | search | history */
  source: RoutePlanSource;
  /** history 显式指定；v1 的 history 必须提供 pathId。 */
  pathId?: string;
  /** v1 只接受 exact。 */
  arrival: { kind: 'exact' };
  constraints?: {
    /** v1：非空 avoid 必须拒绝。 */
    avoid?: Vec3Like[];
    /** 映射到 WalkSearchLimits；必须为正整数。 */
    maxNodes?: number;
    maxEdges?: number;
  };
  /** 绝对截止时间（epoch ms）；必须有限且大于当前时间。 */
  deadlineMs: number;
}
```

校验规则：

- 未知字段 MUST 拒绝（`invalid_request`）。
- `to` 坐标必须有限；不得自动取整或改到附近/上方。
- `mode !== 'walk'` → `unsupported_mode`。
- `arrival.kind !== 'exact'` → `unsupported_arrival`。
- 非空 `avoid` → `unsupported_constraint`（v1 的 walk evaluator 不消费）。
- `source:'history'` 且缺少 `pathId` → `invalid_request`。
- `maxNodes`/`maxEdges` 超过实现上限 → `invalid_request` 或明确截断（不得静默）。
- `deadlineMs` 已过期 → `timeout`/`invalid_request`。

### 6.3 环境

```ts
export interface RoutePlanEnvironment {
  worldId: string;
  dim: string;
  sessionId: string;
  /** 身体尺寸/姿态；脚位置由实测样本提供。 */
  body: BodyContext;
  shapeProvider: CollisionShapeProvider;
  /** 规划时的实测身体样本；不得由请求坐标伪造。 */
  sample(): BodySample | null;
  /** 已知空间搜索源；source:'search'/'auto' 必需。 */
  search?: RouteSearchSource;
  /** 历史来源；source:'history'/'auto' 必需。 */
  history?: FragmentStore;
  now?: () => number;
  /** 每次切片的最大边评估数；用于让出事件循环。 */
  budgetPerSlice?: number;
  /** 协作让出；必须在切片之间调用。 */
  wait?: () => Promise<void>;
  signal?: AbortSignal;
  cancellationOrigin?: 'agent' | 'user' | 'scheduler' | 'lifecycle' | 'unknown';
}

/** 与当前 `WalkRouteSearch` 的 start/advance/snapshot/cancel 对齐。 */
export interface RouteSearchSource {
  start(request: WalkSearchRequest): void;
  advance(budget: number): WalkSearchSnapshot;
  snapshot(): WalkSearchSnapshot;
  cancel(reason: string): void;
}
```

规则：

- `sample()` 返回的必须是实测样本；`null`/scope 不匹配/未连接 → 结构化失败，不得用 `to` 当起点。
- `source:'search'`：只走已知且已验证空间；不自动 frontier 探索。
- `source:'history'`：v1 只接受显式 `pathId`；不做无限历史召回。
- `source:'auto'`：有 `pathId` 时先尝试 history；否则走 search。不得把“没找到历史”写成“世界无路”。
- 规划 MUST 只读：不移动、不转头、不扫描、不写记忆、不消耗材料。
- 规划在 `deadlineMs` 内必须让出事件循环；超时返回 `budget_exhausted`/`timeout`，不得阻塞控制线程。

### 6.4 结果

```ts
export interface RoutePlan {
  routeId: string;
  backend: 'spatial_library';
  source: 'search' | 'history';
  /** history 时来自 PathFragment.kind。 */
  kind?: PathFragment['kind'];
  points: Vec3Like[];
  segments: RouteSegment[];
  cost: number;
  confidence: 'verified' | 'candidate';
  executable: boolean;
  boundaries: RouteBoundary[];
  unsupported?: RouteUnsupported;
  evidence: RouteEvidence;
  expiresAt: number;
  pathId?: string;
  verdict?: 'OPEN' | 'BLOCKED' | 'UNKNOWN' | 'STALE';
  requestedTarget: Vec3Like;
  resolvedTarget: Vec3Like;
  /** 规划时的实测起点；walkPath 必须复核。 */
  start: Vec3Like;
}

export interface RouteSegment {
  index: number;
  mode: 'walk';
  points: Vec3Like[];
  cost: number;
}

export interface RouteBoundary {
  kind: 'blocked' | 'unknown' | 'stale' | 'unobserved' | 'unsupported' | 'budget';
  status: 'OPEN' | 'BLOCKED' | 'UNKNOWN' | 'STALE' | 'UNSUPPORTED';
  stance?: Vec3Like;
  to?: Vec3Like;
  reason: string;
  /** 证据范围/时间；缺失即未知，不补造。 */
  evidence?: RouteEvidence;
}

export type RouteUnsupported =
  | { kind: 'unsupported_mode'; mode: MoveMode; detail: string }
  | { kind: 'unsupported_arrival'; arrival: ArrivalSpec; detail: string }
  | { kind: 'unsupported_constraint'; constraint: string; detail: string }
  | { kind: 'unsupported_geometry'; detail: string }
  | { kind: 'unobserved'; gap: ObservationGap }
  | { kind: 'budget_exhausted'; limit: 'nodes' | 'edges' | 'time'; detail: string }
  | { kind: 'not_authorized'; detail: string }
  | { kind: 'scope_mismatch'; detail: string };

export interface RouteEvidence {
  worldId: string;
  dim: string;
  sessionId: string;
  /** 规划证据的最早有效期；执行前必须复核。 */
  validUntil: number;
  /** 形状/规则版本；变化会使路线失效。 */
  ruleVersion: string;
  /** 依赖的 Section 版本（可选；用于诊断/失效）。 */
  dependencies?: { key: SectionKey; revision: number }[];
}

export interface RoutePlanResult {
  plan?: RoutePlan;
  problem?: NavProblem | RouteUnsupported;
}
```

### 6.5 语义规则

1. **`backend` 必须是 `spatial_library`。** 不得用宿主的 pathfinder 冒充本库规划结果。
2. **`confidence:'verified'`** 只在以下全部成立时：
   - 候选路线已由 `RouteVerifier` 完整复验；
   - 所有段当前 `OPEN`；
   - 起点与实测样本一致；
   - 没有 `UNKNOWN`/`STALE`/`UNSUPPORTED` 段；
   - 证据未过期。
3. **`confidence:'candidate'`** 表示几何候选，不是可执行路线；`executable` 必须为 `false`。
4. **`executable:true`** 只在 `confidence:'verified'` 且模式/到达/约束均受支持时为真。
5. **零边路线**：起点已满足目标时，`points` 可只含一个点，`cost:0`，`confidence` 仍需实测确认；`walkPath` 可直接返回 `ARRIVED`，但不得伪造移动。
6. **`boundaries` 是事实**，不是自动挖/垫/探索队列；Agent 决定是否处理。
7. **`unsupported` 必须分类**：能力未实现、模式未实现、预算耗尽、证据未知、授权缺失分别表达；不得都写成“没路”。
8. **`requestedTarget` 与 `resolvedTarget` 都保留。** 历史召回终点可能略近；不得把“附近”当精确到达。
9. **`expiresAt`** = `min(evidence.validUntil, planNow + planTtlMs)`；执行前过期 → `INVALIDATED`。
10. **规划不写记忆。** `routeId` 只存在于有界、易失的 plan registry；重启/重连后失效。

### 6.6 `routeId` 生命周期

- `routeId` 由可选导航层的 **RoutePlanRegistry** 发出；宿主不得自行伪造。
- 绑定：`worldId`、`dim`、`sessionId`、`start`、`evidence`、`expiresAt`。
- 容量有上限（建议 128）；TTL 建议 30 s 或 `expiresAt` 的较小值。
- **单次使用**：第一次 `walkPath` 调用即消费；即使预检失败也不得复用。再次执行必须重新 `planRoute`。
- 正在执行的 route MUST 被 pin 住，不得被注册表淘汰。
- 旧会话/换维/重启后的 routeId MUST 失效。
- `routeId` 不持久化；不得跨进程恢复。

```ts
// [待实现] optional navigation
export interface RoutePlanRegistry {
  register(plan: RoutePlan): void;
  /**
   * Atomically consume a routeId. The first call consumes it, even if the
   * subsequent start/scope/expiry check fails; a new execution needs a new plan.
   */
  consume(routeId: string, scope: WorldScope, now: number): RoutePlan | RoutePlanRegistryProblem;
  /** Release an active execution's pin after terminal outcome. */
  release(routeId: string): void;
  readonly size: number;
}

export type RoutePlanRegistryProblem =
  | { kind: 'route_not_found'; routeId: string }
  | { kind: 'route_consumed'; routeId: string }
  | { kind: 'route_expired'; routeId: string; expiresAt: number }
  | { kind: 'scope_mismatch'; routeId: string; expected: WorldScope; actual: WorldScope }
  | { kind: 'route_not_executable'; routeId: string; reason: string };
```

### 6.7 历史与自动来源

- `source:'history'`：v1 要求显式 `pathId`，返回 `kind`/`pathId`/历史 `verdict`；路线仍须当前证据复验。
- `source:'auto'`：v1 = 显式 pathId 的 history 优先，否则 search；不做无限历史召回。
- 未来可增加宿主提供的 `historyCandidates` 有界召回接口；在契约扩展前不得隐式扩大。
- `source:'search'`：`WalkRouteSearch` 的有界搜索；只走已知空间；不自动 frontier 探索。

### 6.8 锚点解析（`resolve_target` 的库侧部分）

```ts
export interface SpatialAnchorResolveRequest {
  dim: string;
  label?: string;
  tag?: LandmarkTag;
  near?: Vec3Like;
  radius?: number;
}

export type SpatialAnchorResolveResult =
  | { status: 'found'; node: SpatialNode; precision: 'exact' | 'region'; reachability: ReachabilityResult }
  | { status: 'ambiguous'; nodes: SpatialNode[] }
  | { status: 'not_found' }
  | { status: 'unsupported'; detail: string };
```

- 库负责：按 `label`/`tag`/`near` 解析锚点、返回精确/区域位置和可达证据。
- **宿主负责**：`base`/`home`/`death`/方向/名字语义、首选基地选择、目标解析后的绝对坐标。
- 区域中心不得直接当精确交互目标；需要精确脚位时由宿主解析。

### 6.9 陆地/水面评估的定位

- `evaluateLandTransition` / `LandRouteVerifier` / `evaluateWaterRoute` / `checkWaterArrival` 是**纯几何查询/验证**，`assurance:'geometry_only'`、`executable:false`。
- 它们可以支撑 `assess_landings` 的事实部分，但不能替代宿主的感知、物理控制和到达确认。
- v1 的 `planRoute` 只支持同高 walk；step/drop/jump/ladder/swim/boat 必须返回 `unsupported_mode`/`unsupported_geometry`，不得回退 pathfinder。

---

## 7. 执行契约（可选导航层/宿主，routeId → 有界执行）

### 7.1 执行端口

```ts
// [目标接口] optional navigation 或宿主实现
export interface RouteExecPort {
  walkPath(request: WalkPathRequest, environment: WalkPathEnvironment): Promise<WalkPathResult>;
}
```

### 7.2 请求

```ts
export interface WalkPathRequest {
  /** 必须来自 planRoute；单次使用。 */
  routeId: string;
  /** 绝对截止时间（epoch ms）。 */
  deadlineMs: number;
  signal?: AbortSignal;
  /** 可选覆盖；默认 GROUNDED_ARRIVAL_DEFAULTS。 */
  bodyArrival?: GroundedArrival;
}
```

### 7.3 环境

```ts
export interface WalkPathEnvironment {
  worldId: string;
  dim: string;
  sessionId: string;
  body: BodyContext;
  shapeProvider: CollisionShapeProvider;
  /** 最新实测身体样本；null/旧会话/未连接即失败。 */
  sample(): BodySample | null;
  /** 单步身体端口；只执行一个 authorized move，不重新寻路。 */
  bodyPort: WalkBodyPort;
  /** 观测变化源；必须与 observeBatch 同一链。 */
  changes?: ChangeReportSource;
  now?: () => number;
  cancellationOrigin?: 'agent' | 'user' | 'scheduler' | 'lifecycle' | 'unknown';
}

export interface WalkBodyPort {
  move(request: ExecutableMove): Promise<ExecutableMoveResult>;
  stop(executionId: string): void;
}

export interface ChangeReportSource {
  subscribe(callback: (report: ChangeReport) => void): () => void;
}
```

宿主必须提供：

- `BodySample`：实测脚位、`executionId`、严格递增 `sequence`、真实 `observedAt`、`onGround`/`inWater`/`alive`/`connected`/`observationReady`。
- `ExecutableMove`：单段授权移动；不得隐藏寻路、施工、挖/放/搭柱或换目标。
- `stop(executionId)`：只停止所属执行；不得 `stopAll()` 或影响新动作。
- 观测变化：`observeBatch` → `BatchChangeReport` → `changes`/executor；不得只更新地图而不通知执行器。

### 7.4 结果

```ts
export type WalkPathOutcome =
  | 'ARRIVED'
  | 'PARTIAL'
  | 'NO_PATH'
  | 'BLOCKED'
  | 'INVALIDATED'
  | 'TIMEOUT'
  | 'CANCELLED';

export interface WalkPathResult {
  outcome: WalkPathOutcome;
  contract: 'memory-host-contract/1';
  routeId: string;
  executionId: string;
  lastPosition?: Vec3Like;
  lastObservation?: LastObservation;
  confirmedSegments: number;
  remainingPoints: Vec3Like[];
  invalidation?: {
    segment: number;
    reason: string;
    changes?: ChangeReport;
  };
  problem?: NavProblem;
  consumption?: {
    placed: { pos: Vec3Like; name: string }[];
    durabilityLost?: number;
    digMs?: number;
  };
  memoryWrite?: 'saved' | 'pending' | 'failed';
  /** 仅 ARRIVED 必须为 true；其他结果为 false。 */
  confirmed: boolean;
  trace: { pos: Vec3Like; ts: number }[];
}
```

结果分类：

| outcome | 语义 |
|---|---|
| `ARRIVED` | 所有段确认完成；实测接地/支撑/稳定满足 `bodyArrival`；`confirmed:true` |
| `PARTIAL` | 已确认部分段，但因偏离/执行失败等**非失效**原因未完成原目标 |
| `NO_PATH` | 执行前复验在已知空间内找不到可行路线；未移动 |
| `BLOCKED` | 执行前/段前复验发现明确的当前阻塞；未移动或停在阻塞前 |
| `INVALIDATED` | 起点/证据/会话/作用域变化导致路线失效；停止并保留最后实测位置 |
| `TIMEOUT` | 截止时间耗尽；保留最后位置与已确认段 |
| `CANCELLED` | 父委托/用户/生命周期取消；保留最后位置与部分效果 |

### 7.5 执行语义

1. **只接受 `planRoute` 发出的 `routeId`。** 任意点列不得直接交给 `walkPath`；Agent 要自己组合点列，用宿主 L1 `move_step` 逐格执行。
2. **单次使用。** `walkPath` 入口即消费 `routeId`；失败后必须重新 `planRoute`。
3. **作用域/会话/证据复核。** `worldId`/`dim`/`sessionId` 不匹配、`expiresAt` 过期、证据失效 → `INVALIDATED`/`scope_changed`，不得执行。
4. **起点复核。** 当前实测脚位与计划 `start` 的欧氏距离 > `0.05`（默认）→ `INVALIDATED`，`reason:'route_start_changed'`；不得从别的起点硬套路线。
5. **逐段当前证据。** 每段启动前必须以当前 `OPEN` 证据复验；`UNKNOWN`/`STALE`/`BLOCKED` 不得放行。
6. **不重新规划。** 执行器不得调用搜索、pathfinder 或自动绕路；路线失效即停。
7. **不施工。** v1 的 `walkPath` 不接受挖/放/搭柱/材料；`consumption` 必须为空。后续扩展必须单独授权。
8. **如实到达。** `ARRIVED` 必须同时具备：
   - 终点段执行器的 `ARRIVED`；
   - `confirmed: true`；
   - 实测 `lastPosition` 满足原完成条件；
   - 对应 `lastObservation`；
   - 接地/支撑/稳定样本符合 `bodyArrival`。
   **不得**用 1e-6 坐标相等、Promise resolve、`nextPointIndex` 或按键次数代替。
9. **失效即停。** 当前段证据失效 → 停止所属段，返回 `INVALIDATED`、段索引、最后实测位置、已确认段数、剩余点；后续段失效 → 撤销其 OPEN，未复验不得启动。
10. **取消/超时。** 保留已确认位移、最后观测、trace、部分效果；不得回滚已发生的身体效果。
11. **控制权归属。** `executionId` 隔离迟到回调；旧执行的 `stop`/结果不得清掉新执行。
12. **不自动重试/救援。** 失败返回事实；是否重试/改路/放弃由 Agent 决定。

### 7.6 与 `navigateTo` 的关系

- `navigateTo` 是旧的“规划+执行”一体入口，要求实测位置与目标在 1e-6 内一致；`walkPath` 使用 grounded `bodyArrival`。
- **`walk_path` 不得以 `navigateTo` 为实现后端**；应使用 `WalkRouteExecutor` + 宿主 `WalkBodyPort`。
- `navigateTo` 可以保留给精确坐标测试或未来扩展，但不属于本契约的 `walk_path`。
- 如果宿主同时使用 `navigateTo` 和 `walkPath`，必须在委托层明确选择唯一后端，不得在同一委托内混用。

### 7.7 水面/船

- v1 **不提供** `swimPath`/`boatPath` 执行；`walkPath` 只执行 `mode:'walk'`。
- `planRoute` 对 `swim`/`boat` 返回 `unsupported_mode`。
- 水面/船体几何验证（`evaluateWaterRoute`/`checkWaterArrival`）可以作为宿主的只读事实输入，但 `assurance:'geometry_only'`、`executable:false`，不得当执行许可。
- 水面/船执行属于后续契约扩展；不得用 `walkPath` 假装覆盖。

---

## 8. 失效、会话与生命周期

### 8.1 ChangeReport 转发

```ts
export interface ChangeReport {
  sections: {
    key: SectionKey;
    revision: number;
    invalidated: boolean;
    cells: { pos: Vec3Like; kind: CellChangeKind }[];
  }[];
}
```

规则：

1. 宿主每次 `observeBatch`/`observe`/`beginSession`/`markStale` 后 MUST 取得 `ChangeReport`/`BatchChangeReport`。
2. 报告 MUST 在下一个执行控制步前转发给活跃的 `RouteVerifier`/`WalkRouteExecutor`/`walkPath`。
3. 执行器在当前段依据失效时 MUST 停止该段并返回 `INVALIDATED`。
4. 无关远处变化不得打断当前委托；只失效依赖该 Section 的验证。
5. 不得把 `ChangeReport` 当成世界事实广播；它只描述本次接受证据造成的本地失效。
6. 监听器/verifier 回调抛错时，**写入已经提交**。运行时应通知其余订阅者，并报告带 `committed:true` 的 `ChangeReportDeliveryError`；宿主不得把该错误当成“观测被拒绝”而重试写入。订阅者可通过 `subscribeChanges(sink, { onError })` 隔离自己的失败。

### 8.2 会话状态

| 事件 | 宿主动作 | 库行为 |
|---|---|---|
| 连接 | `beginSession(sessionId)` | 旧会话证据拒绝；返回 ChangeReport |
| 暂停/断线 | `markStale(dim, 'observation_gap')` | 证据 STALE；路线失效 |
| 重连 | 新 `sessionId` + `beginSession` | 保留历史/时间；当前通行重新建立 |
| 死亡/重生 | 新会话/作用域；旧路线失效 | 不把死亡时长算成亲历 |
| 换维 | 新 `dim`/会话；旧 routeId 失效 | 作用域隔离；不跨维复用 |
| 进程重启 | 重新打开 SQLite 会话 | 恢复历史；FRESH → STALE；不恢复 OPEN |

### 8.3 持久化

- 只有 `checkpoint()` 提交；`flush()` 只等待已接受的保存；`close()` 有界关闭。
- 已观测 ≠ 已保存；保存失败单独报告，不把身体效果改成未发生。
- 重启后 `routeId` 全部失效；历史保留；当前通行缓存从空建立。
- 手动驻留模式下，执行路线前 SHOULD 使用 `WorkingSetManager`/`pinSections` 保护依赖 Section；执行结束释放。
- 保存失败、写满磁盘、杀进程恢复等边界 MUST 在宿主日志中可见。

### 8.4 观测中断与未知

- 未加载/未驻留/未观测/预算跳过都必须如实返回；不得用旧帧、空 Section 或“本轮列表没有它”冒充空气。
- 加载旧快照不得覆盖新观测，也不得刷新观测时间。
- 查询未驻留 Section 时返回 `null`/`not_resident`；不得返回“空”。

---

## 9. 错误与结果契约

### 9.1 通用规则

- 每次失败 MUST 同时提供：
  - `message`：语义文字，说明发生了什么；
  - `problem`：结构化原因，供程序判断。
- 不得只返回通用 `ERROR`/`PATH_NOT_FOUND` 让调用方猜。
- 未知/未观测/授权/能力/预算/真实障碍分别表达；不得把“暂未找到”写成“世界无路”。
- 没有证据时不得给精确方块名或坐标；接触证据不得补出隐藏方块名。

### 9.2 问题分类

| `problem.kind` | 含义 | 宿主应做什么 |
|---|---|---|
| `invalid_request` | 字段非法/未知/越界 | 修请求；不重试同一参数 |
| `scope_mismatch` | 世界/维度/会话不匹配 | 切会话/重新打开；不跨域读取 |
| `unsupported_mode` | 模式未实现 | 换模式或返回能力缺口 |
| `unsupported_arrival` | 到达条件未实现 | 换精确/grounded 条件 |
| `unsupported_constraint` | `avoid` 等约束未实现 | 移除约束或显式声明 |
| `unsupported_geometry` | 形状/转换未支持 | 用 L1 元语或等 P3 |
| `unobserved` | 本次请求的格未观察 | 由 Agent 决定是否观察/转向 |
| `unloaded` / `stale` | 未加载/过期 | 重新观察；不得当 OPEN |
| `blocked` / `head_blocked` | 有证据的障碍 | 由 Agent 决定挖/绕/放弃 |
| `hazard` | 风险与本次约束冲突 | 由 Agent 决定是否接受 |
| `not_authorized` | 无授权 | 向 Agent 请求授权 |
| `occupied` | 临时实体占位 | 等待/改路；不写永久地形 |
| `support_missing` | 缺支撑 | 由 Agent 决定 `place_support` |
| `search_budget_exhausted` / `budget_exhausted` | 预算耗尽，不等于不可达 | 扩大预算或改路 |
| `no_path` | 已验证范围内无路 | 改目标/手段 |
| `timeout` / `cancelled` | 期限/取消 | 保留最后位置；由 Agent 决定 |
| `route_invalidated` / `route_start_changed` | 证据/起点变化 | 重新 `planRoute` |
| `unconfirmed_arrival` / `unmeasured_position` / `deviation` | 未到/无实测/偏离 | 不重判成功；按实际反馈 |
| `host_ledger` | 容器内容等宿主职责 | 查询宿主精确账本 |

### 9.3 映射到宿主结果外壳

- 新导航委托：
  - `ARRIVED` → `succeeded` **仅当** `confirmed:true`、实测位置满足原目标、有 `lastObservation`。
  - `PARTIAL` → 失败码 + 保留进展；不得包装成完成。
  - `INVALIDATED` → 失败码 + `data.nav`；不得自动重试。
  - `CANCELLED` → `cancelled`；`TIMEOUT` → 超时码。
  - `BLOCKED`/`NO_PATH` → 失败码；不得用通用 `PATH_NOT_FOUND` 反推世界障碍。
- `data.nav` SHOULD 携带完整 `RoutePlan`/`WalkPathResult`/`SpatialQueryResult`，包括 `problem`、`routeId`、`source`、`backend`、`lastPosition`、`lastObservation`、`invalidation`、`memoryWrite`。
- 旧的 `SkillResult`/代码技能返回外壳保持兼容；不得把新证据在取消/嵌套/恢复路径中丢弃。

---

## 10. 授权与安全边界

1. **库不授权施工。** 挖/放/搭柱/材料由宿主/Agent 显式授权；`planRoute`/`walkPath` v1 对非空材料、挖放搭柱返回 `unsupported`/`not_authorized`。
2. **库不自动救援。** 溺水、岩浆、卡死、坠落只返回事实和缺口；不自动堵水、垫方块、换装备或切换目标。
3. **库不自动探索。** 只走 `known_only`；不自动 frontier。
4. **库不接收墙后数据。** 原始 `blockUpdate`、区块事件、客户端已加载世界不能独立改变记忆、新鲜度、通行结论或路线。
5. **库不保存容器内容。** 只保存位置/存在证据；M2 查询不计算新的可达性。
6. **库不伪造归因。** 动作效果必须有 `actionId`/`EffectEvidence.verified`；不得按时间接近归因。
7. **库不把 `OPEN` 当授权。** `OPEN` 只表示当前证据支持该物理动作；不表示已授权、无风险或执行器支持。
8. **库不把历史当事实现状。** 历史路线、遍历、桥、建造几何都要重新验证当前通行性。

---

## 11. 性能与资源约束

宿主接线时 MUST 遵守：

- 查询使用分页/预算；不得在控制循环中调用无界 `fragments()`/`graph()`/`fragmentation()` 全量 drain。
- `cells` 批量查询有上限；超过分片。
- `planRoute` 必须有 `maxNodes`/`maxEdges`/`deadlineMs`；不得阻塞主线程。
- `walkPath` 的路线长度受 `maxRouteLength`（默认 1024）约束；超长路线应分段规划，不得静默截短。
- 手动驻留模式执行路线时，pin 依赖 Section；结束释放。
- SQLite 只在 Worker 中同步执行；控制线程不得直接跑 SQL。
- `checkpoint()` 可能重写 history/topology/ledger；宿主应在安全点调用，避免高频。

已知性能热点（详见 [实现审计 §11](./implementation-audit-0.10.0.md)）：

| 热点 | 影响 | 宿主缓解 |
|---|---|---|
| `VoxelMap.sectionAt` 全 Section 深拷贝 | walk 搜索/评估可能产生大量拷贝 | 限制搜索边数；等待库提供非拷贝读取 |
| 拓扑分页全量扫描/排序 | 大图查询慢 | 使用分页/小 limit；避免全量 drain |
| 路线执行全路线 snapshot | 逐点执行 O(n²) | 控制路线长度；等待库优化 |
| SQLite checkpoint 全量重写 | 保存慢/内存峰值 | 在安全点 checkpoint；分域保存 |

这些是**已知风险**，不是宿主可以忽略的“实现细节”。

---

## 12. 兼容性、迁移与版本

### 12.1 保留的旧入口

- `SpatialMemoryStore` 现有方法保持可用。
- `navigateTo`、`followKnownPath`、`inspectRoute`、`frontierCandidates`、`WalkRouteExecutor`、`startKnownWalkRoute` 保留。
- `navigateTo` 不属于本契约的 `walk_path` 后端；宿主不得用它替代。
- 旧 `WorldMemory`/JSON 兼容层保留；迁移仍只有 dry-run，不属于本契约的运行时保证。

### 12.2 目标拆分

- 新增 `memory` 入口：只导出写入/查询/持久化适配类型。
- 新增 `navigation` 入口：导出 `planRoute`/`walkPath`/`RoutePlanRegistry`。
- 根入口保留兼容导出，但新宿主 SHOULD 使用子入口；根入口的动作 API 不得被当作 memory core 能力。
- 拆分完成前，本契约的类型按“目标接口”标注；宿主可以先依赖根入口的现有类型，但必须按 §15 状态表核对。

### 12.3 版本规则

- 新增可选字段：minor。
- 新增枚举值/改变语义/收窄必填：major。
- 请求未知字段：拒绝；响应未知字段：忽略但记录。
- 旧的 `routeId` 不跨契约版本复用；升级后重新规划。

### 12.4 M1 兼容性记录

- `SpatialMemoryStore` 新增必选 `observeBatch`、`beginSession`、`markStale`、`addTraversal`、`subscribeChanges`。调用方源码兼容；外部实现者必须补齐这些方法。
- `SpatialMemoryStore.observeBatch` 新增到接口并返回 `BatchChangeReport`；`addTraversal` 返回 `SaveResult`。忽略返回值的调用不受影响。
- `VoxelMap` 的订阅者（以及 `onChange`）异常不再原样冒泡，而是继续通知其余订阅者后聚合为 `ChangeReportDeliveryError`（`committed:true`）。
- 包版本仍为 `0.10.0`；正式发布时按 §12.3 决定 minor/major，并同步宿主与能力报告。

### 12.5 M2 兼容性记录

- `SpatialMemoryStore` 新增必选 `query(request)`。通过 `SpatialMemoryStore` 类型使用库的调用方源码兼容；**自行实现该接口的外部实现者必须补齐**（这是接口新增，不是可选方法）。
- `SpatialMemoryStoreOptions` 新增可选 `query: { now?, isContainer? }`；不提供时使用 `Date.now`、`containerAnchors` 为 `unsupported`。
- `VoxelMap` 新增只读 `sessionId` getter；不改变会话行为。
- `MemoryHostCapabilities`、`CONTRACT_VERSION` 与查询类型从根入口导出；`query.segments`、`query.resourceAnchors`、`containerContents`/`segments` kind 与 `not_found` 状态是增量。
- 查询结果新增可选 `sessionId`（当前观察会话）与 `problem` 分类；未改变既有写入/路由接口。
- 按 §12.3，新增枚举值/收窄必填属于契约变更。预发布仍标记 `memory-host-contract/1` 并依赖能力协商；正式发布时由 M9 决定 minor/major 并同步宿主。包版本仍为 `0.10.0`（未发布）。

---

## 13. 宿主接线步骤（Checklist）

### 13.1 启动

1. 选择 SQLite 数据库绝对路径和 `worldId`。
2. `openSpatialSession({ databasePath, worldId, voxelLoading })`。
3. 读取 `MemoryHostCapabilities`；记录契约版本。
4. 若使用手动驻留，准备 `WorkingSetManager`。

### 13.2 连接/重连

1. 新连接 → 新 `sessionId` → `beginSession(sessionId)`。
2. 取得 `ChangeReport`，转发给活跃 verifier/executor。
3. 旧 `routeId` 全部作废。
4. 断线/暂停 → `markStale`；不伪造离线经历。

### 13.3 感知

1. 视锥/接触扫描产生 `ObservationBatch`（只含实际看见/接触的格 + gap）。
2. `observeBatch(batch)`。
3. 取得 `BatchChangeReport`，**先**转发给活跃 verifier/executor，再进入下一控制步。
4. 观察到空气必须显式写入；未返回的格不是空气。
5. 不得订阅原始 `blockUpdate` 作为记忆入口。

### 13.4 记录实际经过/动作

1. 实测确认移动后 → `markTraversed`；需要历史几何时 `saveFragment` + `addTraversal`。
2. 实测确认动作效果后 → `observeBatch({ evidence:'confirmed_effect', actionId, ... })` / `markModified`。
3. 不得用计划坐标、时间接近或 `succeeded` 摘要补记录。

### 13.5 查询

1. Agent 需要资源/容器/路线事实 → `query({ kind: ... })`。
2. 容器内容 → 明确 `host_ledger`；查询宿主精确账本。
3. 历史路线 → 只当历史；执行前必须 `planRoute` 或用 L1 元语。
4. 查询无副作用；不得用查询代替观察。

### 13.6 规划与执行

1. Agent 选择目标/技能/模式。
2. 如果使用可选导航层：`planRoute(request, environment)`。
3. 检查 `RoutePlan.executable`、`confidence`、`boundaries`、`unsupported`、`expiresAt`。
4. 只有 `executable:true` 才能 `walkPath({ routeId, deadlineMs, signal })`。
5. 提供 `WalkBodyPort`/`BodySample`/`ChangeReportSource`；不得让路径器自行重新规划。
6. 处理 `ARRIVED`/`PARTIAL`/`INVALIDATED`/`CANCELLED`/`TIMEOUT`；保留最后实测证据。
7. 失败不自动重试；由 Agent 决定是否重新 `planRoute`。

### 13.7 保存/关闭

1. 在安全点 `checkpoint()`；确认 `saved`/`pending`/`failed`。
2. `flush()` 只等待已接受的保存；不要用它捕获新变化。
3. `close()` 有界；报告未保存范围。
4. 重启后重新建立当前通行；不得复用旧 `OPEN`/`routeId`。

### 13.8 禁止事项

- 不把 `navigateTo` 当 `walkPath`。
- 不让宿主 pathfinder 在 `walkPath` 内重新规划。
- 不用 `OPEN` 当授权。
- 不把容器内容塞进空间库。
- 不把 L1 元语封装进 memory core。
- 不把历史路线/几何当当前可走。
- 不用 `succeeded`/Promise resolve 代替实测到达。

---

## 14. 验收与测试矩阵

### 14.1 契约测试

| 领域 | 必须覆盖 |
|---|---|
| 写入 | 整批原子；非法/旧会话拒绝；gap/空气；同时间戳冲突；`agent_action` 必须 `actionId`；traversal 必须已存在 fragment；容量拒绝 |
| 查询 | 只读无副作用；作用域校验；分页/游标/total；未驻留 vs 未观察；容器内容返回 `host_ledger`；资源按 tag/label 查询 |
| 规划 | search/history/auto；未知字段拒绝；非 walk/near/avoid 拒绝；预算耗尽；证据有效期；零边路线；`candidate` 不可执行；`routeId` 作用域/单次使用 |
| 执行 | 起点 >0.05 拒绝；逐段当前 OPEN；不重新规划；证据失效 `INVALIDATED`；取消/超时保留位置；grounded `ARRIVED`；`nextPointIndex` 不算到达；旧回调隔离 |
| 失效 | `ChangeReport` 只失效依赖 Section；无关变化不打断；在途段失效即停；后续段未复验不启动 |
| 生命周期 | 断线/重连/换维/死亡；旧会话拒绝；恢复 STALE；不恢复 OPEN；`routeId` 失效 |
| 持久化 | 已观测 vs 已保存；保存失败不回滚身体效果；重启恢复原始时间；手动驻留 pin/release |
| 性能 | 分页/预算；大图不全量 drain；长路线不 O(n²)；checkpoint 有界 |

### 14.2 Fake 与真实环境

- Fake 测试证明库内状态、授权映射、控制调用次序；**不能**代替真实 mineflayer/Minecraft。
- 真实验收必须覆盖：视觉/接触观测、真实脚位、支撑/净空、服务器位置纠正、多人/流体、断线重连。
- `walkPath` 的真实身体验收依赖 Curio M0/M1；在通过前，所有“真实执行”声明保持未验证。

### 14.3 接入完成定义（DoD）

1. 能力报告与契约版本写入启动日志。
2. 所有写入携带作用域/会话；旧会话被拒绝。
3. 每次 observation → ChangeReport → executor 的链路可追踪。
4. `planRoute` 返回的 `routeId` 只能由 `walkPath` 消费，且单次使用。
5. `walkPath` 不调用搜索/pathfinder；`ARRIVED` 有实测证据。
6. 容器内容查询明确转到宿主账本。
7. 取消/超时/失效保留最后位置和部分效果。
8. 重启后不恢复 OPEN/routeId；历史与原始时间保留。
9. 未实现能力返回结构化 `unsupported`，不静默回退。
10. 真实 Java 1.20.1 场景通过 §14.1 的对应项；未通过的必须标注“未验证”。

---

## 15. 实现状态表（接线前必读）

| 接口/能力 | 状态 | 证据/说明 |
|---|---|---|
| `Observation`/`ObservationBatch`/`ObservationGap` | 已实现 | `src/observation/types.ts` |
| `VoxelMap.observeBatch` → `BatchChangeReport` | 已实现 | `src/voxel/voxel-map.ts` |
| `SpatialMemoryStore.observeBatch` 返回报告 | 已实现 | `src/store/spatial-memory-store.ts`；返回 `BatchChangeReport` |
| `VoxelMap.beginSession`/`markStale` | 已实现 | 返回 `ChangeReport` |
| `SpatialMemoryStore.beginSession`/`markStale` | 已实现 | store 委托 `VoxelMap` 并返回 `ChangeReport` |
| `markTraversed`/`markModified` | 已实现 | `VoxelMap`/`SpatialMemoryStore` |
| `FragmentStore.addTraversal` | 已实现 | `src/topology/fragment-store.ts` |
| `SpatialMemoryStore.addTraversal` | 已实现 | store 作用域检查后委托；返回 `SaveResult` |
| 统一 `MemoryIngest` | 已实现 | `src/memory/ingest.ts`；`SpatialMemoryStoreImpl` 实现 |
| `ChangeReport` 订阅/转发 | 已实现 | `VoxelMap.subscribeChanges`、store `ChangeReportSource`；投递失败聚合为 `ChangeReportDeliveryError`（`committed:true`） |
| `contact` 证据的方块名 | 部分实现 | `Observation.state.name` 必填，模型无法表达“名称未知”；`validateObservation` 要求 contact 必须 `stateComplete:false`，未看见的名称不得由宿主提交；可表达未知名称的 state 模型列为后续任务 |
| 旧 `sequence` 拒绝 | 部分实现 | 新旧由 `observedAt` 判定；`sequence` 是接收顺序，不用于覆盖判断。契约 §4.2 规则 6 的措辞待与实现对齐 |
| `SpatialMemoryStore` 查询方法 | 已实现（分散） | `src/store/store.ts` |
| 统一 `SpatialQueryPort` | 已实现 | `src/query/*`；`SpatialMemoryStore.query(request)` 暴露；含 segments；未知字段/kind 拒绝、分页 100/1000、只读 |
| `segments` 查询 | 已实现 | 包装 `TopologyStore.segments`；未知 fragment 返回 `not_found`；不删除/改写 fragment 历史 |
| `MemoryHostCapabilities` / `CONTRACT_VERSION` | 已实现（M2 部分） | `src/memory/capabilities.ts`；memory/query 按实际能力，plan/execute/persistence 保守 `false` |
| `cells` 未驻留/gap 语义 | 部分实现 | 可区分 `no_record`/resident-unobserved/`not_resident`/`loading`/`load_failed`；历史 `ObservationGap` 未持久化，只报告当前驻留 gap |
| `WalkRouteSearch` | 已实现 | `src/navigation/walk-search.ts` |
| `WalkRouteExecutor` + `bodyArrival` | 已实现 | `src/execution/*` |
| `startKnownWalkRoute` | 已实现（启动执行，不是 plan-only） | `src/navigation/known-walk-route.ts` |
| `planRoute`/`RoutePlan`/`RoutePlanRegistry` | 待实现 | 本契约 §6 |
| `walkPath`/`WalkPathResult` | 待实现 | 本契约 §7；可先用 `WalkRouteExecutor` 由宿主实现 |
| `INVALIDATED` outcome | 待实现 | 当前 `NavOutcome` 无此值，使用 `route_invalidated` problem |
| `PerceptionSource`/`BodyAdapter` 拆分 | 已实现 | 计划中的感知端口命名为 `PerceptionSource`，避免与既有证据来源联合类型 `ObservationSource` 冲突；`WorldAdapter` 保留为兼容交叉类型 |
| 容器位置锚点查询 | 已实现（需宿主分类器） | `SpatialMemoryStore.query({kind:'containerAnchors'})`；只返回 exact 节点；未注入 `isContainer` 时为 `unsupported` |
| 容器内容查询 | 不适用 | `SpatialMemoryStore.query({kind:'containerContents'})` 固定返回 `host_ledger`；不返回 `items`/空箱 |
| 水面/船几何验证 | 已实现（仅几何） | `assurance:'geometry_only'`、`executable:false` |
| 水面/船执行 | 未实现 | 不属于 v1 `walkPath` |
| SQLite Worker/checkpoint/WorkingSet | 已实现 | `src/storage/sqlite/*` |
| JSON→SQLite 权威切换 | 未实现 | 只有 dry-run |
| L1 元语 | 宿主职责 | 不属于本库 |
| Curio M0/M1 | 外部前置 | 真实 `walkPath` 联调前必须先通过 |

---

## 16. 附录

### A. `plan_route` JSON ↔ 本契约字段映射

| 宿主 `plan_route` 字段 | 本契约字段 | 规则 |
|---|---|---|
| `to` | `RoutePlanRequest.to` | 绝对连续脚位；名字/方向先 resolve |
| `mode` | `RoutePlanRequest.mode` | v1 只接受 `walk` |
| `source` | `RoutePlanRequest.source` | `auto/search/history` |
| `pathId` | `RoutePlanRequest.pathId` | history 必填 |
| `arrival` | `RoutePlanRequest.arrival` | v1 只接受 `exact` |
| `constraints.avoid` | `RoutePlanRequest.constraints.avoid` | 非空拒绝 |
| `constraints.maxNodes/maxEdges` | `constraints.maxNodes/maxEdges` | 映射 `WalkSearchLimits` |
| `deadlineMs` | `RoutePlanRequest.deadlineMs` | 绝对时间 |
| `routeId` | `RoutePlan.routeId` | 注册表发出 |
| `backend` | `RoutePlan.backend` | 必须是 `spatial_library` |
| `source` | `RoutePlan.source` | 实际使用的来源 |
| `kind` | `RoutePlan.kind` | history 的 fragment kind |
| `points/segments/cost` | `RoutePlan.points/segments/cost` | 连续脚位/分段/步数 |
| `confidence` | `RoutePlan.confidence` | `verified` 才可执行 |
| `executable` | `RoutePlan.executable` | 仅 verified 且支持 |
| `boundaries` | `RoutePlan.boundaries` | 事实，不是行动队列 |
| `unsupported` | `RoutePlan.unsupported` | 分类缺口 |
| `evidence` | `RoutePlan.evidence` | 世界/维度/会话/有效期 |
| `expiresAt` | `RoutePlan.expiresAt` | 执行前复核 |
| `pathId` | `RoutePlan.pathId` | history 来源 |
| `verdict` | `RoutePlan.verdict` | 历史验证结论 |
| `requestedTarget/resolvedTarget` | 同名 | 原目标/实际解析目标 |

### B. `walk_path` JSON ↔ 本契约字段映射

| 宿主 `walk_path` 字段 | 本契约字段 | 规则 |
|---|---|---|
| `routeId` | `WalkPathRequest.routeId` | 单次使用 |
| `deadlineMs` | `WalkPathRequest.deadlineMs` | 绝对时间 |
| `signal` | `WalkPathRequest.signal` | 父委托取消 |
| `bodyArrival` | `WalkPathRequest.bodyArrival` | 默认 `GROUNDED_ARRIVAL_DEFAULTS` |
| `outcome` | `WalkPathResult.outcome` | 见 §7.4 |
| `lastPosition` | 同名 | 实测；无证据则缺省 |
| `lastObservation` | 同名 | 同一证据快照 |
| `confirmedSegments` | 同名 | 已确认段数 |
| `remainingPoints` | 同名 | 未执行点 |
| `invalidation` | 同名 | 段索引/原因/ChangeReport |
| `consumption` | 同名 | v1 必须为空 |
| `memoryWrite` | 同名 | 宿主保存确认 |
| `confirmed` | 同名 | 仅 ARRIVED 为 true |
| `data.nav` | 完整结果 | 宿主兼容层保留 |

### C. 示例：规划

```jsonc
// 请求
{
  "to": {"x": 1.5, "y": 64, "z": 0.5},
  "mode": "walk",
  "source": "search",
  "arrival": {"kind": "exact"},
  "constraints": {"maxNodes": 512, "maxEdges": 2048},
  "deadlineMs": 1793900000000
}
```

```jsonc
// 返回
{
  "routeId": "rt_01...",
  "backend": "spatial_library",
  "source": "search",
  "points": [{"x": 0.5, "y": 64, "z": 0.5}, {"x": 1.5, "y": 64, "z": 0.5}],
  "segments": [{"index": 0, "mode": "walk", "points": ["..."], "cost": 1}],
  "cost": 1,
  "confidence": "verified",
  "executable": true,
  "boundaries": [],
  "unsupported": null,
  "evidence": {"worldId": "w", "dim": "overworld", "sessionId": "s", "validUntil": 1793900600000, "ruleVersion": "1.20.1/1"},
  "expiresAt": 1793900600000,
  "requestedTarget": {"x": 1.5, "y": 64, "z": 0.5},
  "resolvedTarget": {"x": 1.5, "y": 64, "z": 0.5},
  "start": {"x": 0.5, "y": 64, "z": 0.5}
}
```

### D. 示例：执行

```jsonc
// 请求
{ "routeId": "rt_01...", "deadlineMs": 1793900000000 }
```

```jsonc
// 返回（到达）
{
  "outcome": "ARRIVED",
  "routeId": "rt_01...",
  "executionId": "exec_01...",
  "lastPosition": {"x": 1.5, "y": 64, "z": 0.5},
  "lastObservation": {"worldId": "w", "dim": "overworld", "sessionId": "s", "observedAt": 1793899999000, "onGround": true, "inWater": false},
  "confirmedSegments": 1,
  "remainingPoints": [],
  "confirmed": true,
  "trace": [{"pos": {"x": 0.5, "y": 64, "z": 0.5}, "ts": 1793899990000}, {"pos": {"x": 1.5, "y": 64, "z": 0.5}, "ts": 1793899999000}]
}
```

### E. 术语

| 术语 | 含义 |
|---|---|
| `FRESH`/`STALE` | 证据新鲜度；STALE 不等于“世界已变” |
| `OPEN`/`BLOCKED`/`UNKNOWN`/`STALE` | 通行结论；UNKNOWN/STALE 绝不当 OPEN |
| `verified` | 当前证据完整复验通过，不等于执行一定成功 |
| `candidate` | 几何候选，不可执行 |
| `grounded arrival` | 实测接地/支撑/稳定，按 `bodyArrival` 容差 |
| `host_ledger` | 宿主精确账本（容器内容、库存） |
| `routeId` | 可选导航层的易失路线句柄，单次使用 |
| `memoryWrite` | 宿主保存确认；不是身体效果 |

### F. 关键文件索引

| 主题 | 文件 |
|---|---|
| 观测/证据 | `src/observation/types.ts`、`src/observation/validate.ts`、`src/observation/queue.ts` |
| 体素/变更报告 | `src/voxel/voxel-map.ts`、`src/voxel/section.ts` |
| 历史/遍历 | `src/topology/path-fragment.ts`、`src/topology/fragment-store.ts` |
| 拓扑/锚点 | `src/topology/topology-store.ts`、`src/topology/graph.ts` |
| 查询/store | `src/store/store.ts`、`src/store/spatial-memory-store.ts` |
| 规划搜索 | `src/navigation/walk-search.ts`、`src/navigation/known-walk-route.ts` |
| 执行 | `src/execution/types.ts`、`src/execution/walk-route-executor.ts` |
| 结果契约 | `src/navigation/types.ts` |
| 持久化 | `src/storage/sqlite/types.ts`、`src/storage/sqlite/spatial.ts` |
| 适配契约 | `src/adapter/types.ts` |

---

## 17. 未决项与下一步

以下决策在本契约中已给出推荐，但需要宿主确认后才能冻结：

1. **`routeId` 单次使用**：推荐是。失败后重新规划，避免陈旧路线复用。
2. **`INVALIDATED` 作为独立 outcome**：推荐是；当前 `NavOutcome` 没有，需要扩展或由 `WalkPathResult` 单独表达。
3. **`walkPath` 归属**：推荐放在可选 `navigation` 入口；宿主也可以按本契约自行实现，但语义必须一致。
4. **`source:'auto'` 的历史召回**：v1 只接受显式 `pathId`；未来由宿主提供有界候选。
5. **容器内容查询**：永久 `host_ledger`；不进入空间库。
6. **水面/船执行**：v1 只保留几何验证；执行作为后续契约扩展。
7. **根入口拆分**：推荐新增 `./memory`/`./navigation`，根入口保留兼容；新宿主使用子入口。

下一步（建议顺序）：

1. 在 `integration/memory-host-20261106` 上实现 §4/§5 的 memory 端口与统一查询；
2. 实现 §6 的 `planRoute` + `RoutePlanRegistry`（先 search/history，Fake 测试）；
3. 实现 §7 的 `walkPath` 接口与 Fake 身体测试；真实身体等 Curio M0/M1；
4. 按 §14 跑契约测试；再进入真实 Java 1.20.1 联调。
