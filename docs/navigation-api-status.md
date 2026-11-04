# 导航 API 状态（设计 §7）

本文件记录设计 §7 五个名字在当前源码中的真实状态。它只依据本仓库源码、导出与离线测试，**不是**真实 Minecraft、mineflayer 或 Curio 宿主集成验收。

机器可读的权威表是 `src/navigation/capabilities.ts` 的 `NAVIGATION_CAPABILITIES`，从 `src/navigation/index.ts` 和包根入口 `src/index.ts` 导出。本文件解释同一份事实；两者不一致时以代码和测试为准并立即修正表。

## 状态定义

| status | 含义 |
|---|---|
| `implemented` | 存在公开运行时入口，完成其 `supported` 中声明的范围。可能是起点边界或部分管线，`supported` / `unsupported` 说明边界。 |
| `read_only` | 存在公开运行时入口，但只投影调用方已持有的只读快照；不移动、不观察、不 pin、不保存、不启动行动。 |
| `host_approximation` | 宿主可能有相近动作，但本库没有实现 §7 契约的入口。 |
| `not_implemented` | 没有实现该名字的公开运行时入口。类型契约或独立构件可以存在，但合起来仍不构成该能力。 |

`effects` 描述**该条目自己的公开入口**，不描述旁列构件。`entry: null` 的条目所有 `effects` 均为 `false`。

- `movesBody`：是否直接驱动身体移动。
- `turnsHead`：是否修改朝向。
- `writesLibrary`：是否写空间库、地图、历史或持久化。
- `pinsSections`：是否创建 Section pin 租约。
- `triggersObservation`：是否触发扫描/观察/证据刷新。
- `startsAction`：是否启动导航委托或宿主行动。

## 总表

| §7 名称 | status | 公开运行时入口 | movesBody | turnsHead | writesLibrary | pinsSections | triggersObservation | startsAction |
|---|---|---|---|---|---|---|---|---|
| `navigate_to` | `not_implemented` | 无 | false | false | false | false | false | false |
| `follow_known_path` | `implemented` | `startKnownWalkRoute` | false | false | false | false | false | true |
| `inspect_route` | `read_only` | `inspectRoute` | false | false | false | false | false | false |
| `frontier_candidates` | `read_only` | `frontierCandidates` | false | false | false | false | false | false |
| `recall_route` | `not_implemented` | 无 | false | false | false | false | false | false |

`follow_known_path` 的 `startsAction: true` 只表示 `startKnownWalkRoute` 在调用方提供的 `WalkRouteExecutor` 上登记了一次委托。该函数不调用 `MoveExecutor.move`；身体步骤只在调用方继续驱动 `WalkRouteExecutor.advance()` 后开始。

## 逐项状态

### `navigate_to` — `not_implemented`

- **入口**：无公开 `navigate_to` 函数，也没有宿主动作注册。
- **编译期契约**：`NavigateRequest`、`NavResult`、`NavProblem`、`ActionRecord`（`src/navigation/types.ts`）。
- **相关构件（非实现）**：
  - `WalkRouteSearch`：有界、只读、同高度的候选搜索。`FOUND` 只是候选，不是到达，也不执行。
  - `WalkRouteExecutor`：只执行调用方已提供并自行验证的点列；它不搜索、不选目标、不挖、不放、不搭柱、不消耗材料。
- **明确不支持**：搜索 → 验证 → 执行 → 实测到达的整合管线；挖/放/搭柱/材料额度；宿主仲裁、调度、嵌套、取消与提示词/动作目录接线；`ARRIVED` 确认。
- **证据**：`src/navigation/index.ts` 没有 `navigate_to` 导出；`tests/navigation-capabilities.test.ts` 断言 `'navigate_to' in navigation === false`。

### `follow_known_path` — `implemented`（起点边界）

- **入口**：`startKnownWalkRoute`。
- **契约**：`KnownWalkRouteRequest`、`KnownWalkRouteStart`、`KnownWalkRouteSnapshot`。
- **支持范围**：
  - 从调用方指定的单个历史 fragment 读取已存折线，原序交给调用方提供的 `WalkRouteExecutor`。
  - 仅 `walk` 模式、仅 `{ kind: 'exact' }` 到达条件。
  - 同高度、沿 X 或 Z 单格步进的折线；世界、维度、起点与点数预算必须匹配。
  - 历史只作为几何；执行器仍按当前证据逐段验证。
- **明确不支持**：
  - `near` / `reach_block` 到达条件、非 `walk` 模式、非空 `avoid`。
  - 对角、重复点、变高度折线。
  - 导航、选择或切换到另一条路。
  - 自动驱动执行器、宿主动作注册、仲裁、嵌套与调度取消。
  - 该起点边界自身不确认到达；`ARRIVED` 只由执行器根据实测样本确认。
- **证据**：`src/navigation/known-walk-route.ts`；`tests/known-walk-route.test.ts`；能力表 `entry: ['startKnownWalkRoute']`、`effects.startsAction: true`。

### `inspect_route` — `read_only`

- **入口**：`inspectRoute(snapshot: WalkSearchSnapshot): RouteInspection`。
- **支持范围**：对调用方已持有的 `WalkSearchSnapshot` 做纯投影，返回搜索状态、原因、结构化 problem、候选路线、BLOCKED/UNKNOWN/STALE/UNSUPPORTED 边界诊断、frontier 候选、不可用历史证据、计数器、限制和有效时间。
- **明确不支持**：
  - 不接受 `pathId`、`FragmentStore` 或历史路线查询。
  - 不加载地图/Section、不观察、不 pin、不保存、不重新验证证据。
  - 不移动、不转头、不启动行动。
  - 不确认到达：`arrivalConfirmed` 与 `executionStarted` 恒为 `false`。
- **只读证据**：`tests/navigation-capabilities.test.ts` 在 `PENDING` 搜索上调用后，`search.status()`、`map.saveRevision`、`pinState()`、`checkpointDirtyMeasure()`、`residentSize()` 和已观察格证据均不变。

### `frontier_candidates` — `read_only`

- **入口**：`frontierCandidates(snapshot: WalkSearchSnapshot): FrontierCandidatesResult`。
- **支持范围**：投影快照中已有的、有界的未知边界候选。每个候选保留：
  - `stance`：由 OPEN 评估证明可到达的相邻站姿；
  - `pos`：未进入的相邻边界点；
  - `gap`：未观察格；
  - `basis`：局部已观察依据；
  - `computedAt` / `validUntil`。
- **明确不支持**：
  - 目标选择或排序。
  - 自动探索或世界扫描。
  - 拓扑/历史查询：`historicalConnection` 恒为 `'unknown'`，不伪造成 `false` 或 `true`。
  - 对边界点或 gap 的可达性声明。
  - 移动、转头、观察、pin、保存。
  - `selected` 与 `explorationStarted` 恒为 `false`。
- **边界**：输出受快照的 `maxFrontiers` 限制；`truncated` 直接取 `counters.frontierLimitReached`，不扩大工作。
- **证据**：`src/navigation/route-inspection.ts`；`tests/navigation-capabilities.test.ts` 的正向、空地图负向和拷贝隔离测试。

### `recall_route` — `not_implemented`

- **入口**：无公开 `recall_route` 函数。
- **相关构件（非实现）**：`FragmentStore.getFragment`、`TopologyStore.route` 等历史几何/图查询；它们只返回历史事实，不选择、不执行、不确认到达。
- **明确不支持**：基于 `pathId` 的路线召回并返回可执行路线或到达声明；宿主动作注册、仲裁、调度、嵌套与取消接线。
- **证据**：`tests/navigation-capabilities.test.ts` 断言 `'recall_route' in navigation === false`。

## 公开导出

包根入口新增：

```ts
import {
  NAVIGATION_CAPABILITIES,
  NAVIGATION_CAPABILITY_STATUSES,
  frontierCandidates,
  inspectRoute,
} from 'curio-minecraft-3d-memory';
```

相关类型：`NavigationCapability`、`NavigationCapabilityEffects`、`NavigationCapabilityName`、`NavigationCapabilityStatus`、`FrontierCandidateView`、`FrontierCandidatesResult`、`RouteBoundaryFact`、`RouteInspection`。

设计 §7 的 `Frontier` 类型仍是编译期契约；本次没有为它补造 `historicalConnection` 布尔值。只读投影使用 `FrontierCandidateView`，其中 `historicalConnection: 'unknown'` 明示未查询历史。

## 验证记录

全部为离线内存/Fake 测试，没有启动 Minecraft 服务器或 Bot。

```text
npm run build
-> exit 0

npx tsc --noEmit
-> exit 0

npx vitest run tests/navigation-capabilities.test.ts
-> exit 0; Test Files 1 passed; Tests 13 passed

npm test
-> exit 1; Test Files 3 failed | 27 passed (30); Tests 827 passed (827)
```

`npm test` 的退出码 1 来自三个既有文件 `acceptance/{consumer-close,provenance,run}.test.mjs` 的 `No test suite found in file ...` 加载噪声，不是断言失败；这三个文件在本次改动前就失败。827 个断言全部通过，其中 13 个为本次新增。

## 未实现、未接入与未验证

- `navigate_to` 的完整整合管线未实现；候选搜索与单步执行仍是分离构件。
- `recall_route` 未实现。
- `inspect_route` 不接受历史 `pathId`，也不重新验证证据或刷新新鲜度。
- `frontier_candidates` 不查询历史连接，不选择目标，不启动探索。
- 未接入 mineflayer、Curio 调度器、动作注册、提示词、嵌套技能或真实寻路器。
- 未运行真实 Java 1.20.1 世界验收；本文件不把类型声明、单元测试或构建通过当成真实集成证据。
