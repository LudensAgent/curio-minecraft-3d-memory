# 导航 API 状态（设计 §7）

本文件记录设计 §7 五个名字在当前源码中的真实状态。它只依据本仓库源码、导出与离线测试，**不是**真实 Minecraft、mineflayer 或 Curio 宿主集成验收。

机器可读的权威表是 `src/navigation/capabilities.ts` 的 `NAVIGATION_CAPABILITIES`，从 `src/navigation/index.ts` 导出；包根入口 `src/index.ts` 的重新导出由集成方接线。本文件解释同一份事实；两者不一致时以代码和测试为准并立即修正表。

## 状态定义

| status | 含义 |
|---|---|
| `implemented` | 存在公开运行时入口，完成其 `supported` 中声明的范围。可能是起点边界、部分管线或需要调用方提供环境，`supported` / `unsupported` 说明边界。 |
| `read_only` | 存在公开运行时入口，但只投影调用方已持有的只读快照/历史；不移动、不观察、不 pin、不保存、不启动行动。 |
| `host_approximation` | 宿主可能有相近动作，但本库没有实现 §7 契约的入口。 |
| `not_implemented` | 没有实现该名字的公开运行时入口。类型契约或独立构件可以存在，但合起来仍不构成该能力。 |

`effects` 描述**该条目自己的公开入口**，不描述旁列构件。`entry: null` 的条目所有 `effects` 均为 `false`。

- `movesBody`：是否驱动调用方提供的执行器逐步移动身体。
- `turnsHead`：是否修改朝向。
- `writesLibrary`：是否写空间库、地图、历史或持久化。
- `pinsSections`：是否创建 Section pin 租约。
- `triggersObservation`：是否触发扫描/观察/证据刷新。
- `startsAction`：是否启动导航委托或宿主行动。

## 总表

| §7 名称 | status | 公开运行时入口 | movesBody | turnsHead | writesLibrary | pinsSections | triggersObservation | startsAction |
|---|---|---|---|---|---|---|---|---|
| `navigate_to` | `implemented` | `navigateTo` | true | false | false | false | false | true |
| `follow_known_path` | `implemented` | `startKnownWalkRoute`、`followKnownPath` | true¹ | false | false | false | false | true |
| `inspect_route` | `read_only` | `inspectRoute`、`inspectKnownRoute` | false | false | false | false | false | false |
| `frontier_candidates` | `read_only` | `frontierCandidates` | false | false | false | false | false | false |
| `recall_route` | `not_implemented` | 无 | false | false | false | false | false | false |

¹ `followKnownPath` 只有在 `environment.drive === true` 时才驱动执行器；默认 `drive` 未开启时仍只是起点边界，`startKnownWalkRoute` 本身从不调用 `MoveExecutor.move`。

`navigate_to` 的 `movesBody: true` 表示入口会驱动调用方提供的 `WalkRouteExecutor.advance()`，进而由调用方的 `MoveExecutor` 执行每一步；库自身不拥有真实身体。`writesLibrary: false`：库不写存储；可选的 `onMemoryWrite` 是宿主回调，`memoryWrite` 只记录宿主返回的状态。

## 逐项状态

### `navigate_to` — `implemented`（调用方驱动环境）

- **入口**：`navigateTo(request: NavigateRequest, environment: NavigateEnvironment)`。
- **环境由调用方提供**：世界/维度/会话、身体尺寸与姿态、`CollisionShapeProvider`、已测样本提供器 `sample()`、搜索实例或已计算快照、绑定同一地图的 `WalkRouteExecutor`、时钟、超时/期限、预算、可选取消信号、可选分段与宿主记忆回调。
- **顺序与支持范围**：
  - 校验原请求；拒绝非 `walk` 模式、`near`/`reach_block` 到达、挖/放/搭柱、非空材料、非空 `avoid`、`allow_frontier` 探索、未知字段等，并返回结构化 `problem`，不静默忽略。
  - 读取实测起点。若该实测位置已精确满足原目标，直接返回 `ARRIVED`（`confirmed: true`），不生成也不执行路线。
  - 否则运行有界 `WalkRouteSearch`；把搜索失败映射为结构化 `NavProblem`（`no_path`、`unobserved`、`unsupported_mode`/`unsupported_target`、`search_budget_exhausted`、`route_invalidated` 等），不把候选、预算耗尽或“暂时没找到”写成世界事实。
  - 把候选交给 `WalkRouteExecutor`；执行器对每段重新按当前证据验证，并从实测样本确认到达。
  - `ARRIVED` 必须同时满足：执行器结果为 `ARRIVED`、`confirmed: true`、实测 `lastPosition` 精确满足原目标、存在对应 `lastObservation`。缺少任一项降级为 `FAILED`/`unconfirmed_arrival`。
  - 取消/超时保留已确认位移、最后观测、原始 trace 与 `lastPosition`；单段精确行走不会伪造 `PARTIAL`。
  - 分段委托仅当先前显式分段已确认完成、后续分段失败时返回 `PARTIAL`；最后一次分段目标必须等于原请求目标。
  - 每次导航构建一条 `ActionRecord`：原请求目标、解析目标、允许模式、到达条件、挖/放/搭柱标记、材料、探索许可、约束、子动作（来源 `execution_helper`、角色 `body`、已确认结果）、`from`/`to`、trace、消耗（walk 为空 `placed`）、失败事实、`confirmed` 与完整 `result`。
  - 可选 `onMemoryWrite(result, record)` 由宿主执行持久化；返回 `saved`/`pending`/`failed` 时写入结果的 `memoryWrite`。库不自行保存，也不把未确认写入说成已保存。
- **明确不支持**：
  - 非 `walk` 模式（jump、swim、climb、ladder、drop、sneak）、`near`/`reach_block` 到达。
  - 挖、放、搭柱、材料额度、非空 `avoid`、frontier 探索。
  - 宿主动作注册、仲裁、调度、嵌套、提示词/动作目录接线。
  - 自动改目标、自动救援、隐式观察或隐藏世界读取。
  - 真实 Minecraft/mineflayer 执行；测试中的 `MoveExecutor` 是 Fake。
- **证据**：`src/navigation/navigate.ts`；`tests/navigation-pipeline.test.ts`（15 个用例覆盖实测到达、已到达无假路线、NO_PATH/BLOCKED 映射、非法请求、取消/超时保留位移、分段 PARTIAL、路径跟随、历史只读投影、frontier 历史回调查询）。

### `follow_known_path` — `implemented`（起点边界 + 可选驱动）

- **入口**：`startKnownWalkRoute(history, executor, request)`；`followKnownPath(request, environment)`。
- **契约**：`KnownWalkRouteRequest`、`KnownWalkRouteStart`、`KnownWalkRouteSnapshot`、`FollowKnownPathRequest`、`FollowKnownPathEnvironment`、`FollowKnownPathOutcome`。
- **支持范围**：
  - 用 `pathId` 选择单个历史 fragment；保留旧 `fragmentId` 别名（两者同时给出时必须相等，否则 `ambiguous_path`）。
  - 从 fragment 读取已存折线，原序交给调用方提供的 `WalkRouteExecutor`。
  - 仅 `walk` 模式、仅 `{ kind: 'exact' }` 到达条件；非空 `avoid` 明确拒绝。
  - 同高度、沿 X 或 Z 单格步进的折线；世界、维度、起点与点数预算必须匹配。
  - 历史只作为几何；执行器仍按当前证据逐段验证。
  - `followKnownPath` 在 `environment.drive === true` 时使用与 `navigateTo` 相同的实测驱动，返回可终止的 `NavResult` 和 `ActionRecord`；否则只返回 `started` 状态，不移动。
- **明确不支持**：
  - `near` / `reach_block` 到达条件、非 `walk` 模式、非空 `avoid`。
  - 对角、重复点、变高度折线。
  - 导航、选择或切换到另一条路。
  - 宿主动作注册、仲裁、嵌套与调度取消。
  - `drive` 未开启时的身体执行。
- **证据**：`src/navigation/known-walk-route.ts`、`src/navigation/navigate.ts`；`tests/known-walk-route.test.ts`、`tests/navigation-pipeline.test.ts`。

### `inspect_route` — `read_only`

- **入口**：
  - `inspectRoute(snapshot: WalkSearchSnapshot): RouteInspection`；
  - `inspectKnownRoute(history: FragmentStore, pathId: string, options?): KnownRouteInspectionResult`。
- **支持范围**：
  - 对调用方已持有的 `WalkSearchSnapshot` 做纯投影，返回搜索状态、原因、结构化 problem、候选路线、BLOCKED/UNKNOWN/STALE/UNSUPPORTED 边界诊断、frontier 候选、不可用历史证据、计数器、限制和有效时间。
  - 对已存 fragment 做纯历史投影：polyline、端点、legacy links、`geometrySource` 对应的精度（traversal / observed / inferred）、深度、时间戳、有界历史 traversal 记录与计数。
  - 当前开放性与新鲜度默认明确为 `unknown`。只有调用方传入 `evidence` 时才反映其内容：stale 证据报告为 `stale`；有 blocked 位置报告为 `blocked`；只有调用方同时声明 `verifiedWholeRoute: true` 且无 blocked 时才报告 `open`。
- **明确不支持**：
  - 不接受地图/Section，不加载、不观察、不 pin、不保存、不重新验证证据。
  - 不移动、不转头、不启动行动。
  - 不确认到达：`arrivalConfirmed`、`executionStarted`、`currentOpennessClaimed` 等均为字面 `false`。
  - 不从历史几何推断当前可通行；未知/过期不会被当成 OPEN。
- **只读证据**：`tests/navigation-capabilities.test.ts` 验证快照投影不改变搜索、地图版本、pin、脏度、驻留与已观察格；`tests/navigation-pipeline.test.ts` 验证 `inspectKnownRoute` 前后 fragment store 快照、revision、traversal 总数以及旁置地图的 `saveRevision` / `pinState()` 不变。

### `frontier_candidates` — `read_only`

- **入口**：`frontierCandidates(snapshot: WalkSearchSnapshot, options?: FrontierCandidatesOptions): FrontierCandidatesResult`。
- **支持范围**：投影快照中已有的、有界的未知边界候选。每个候选保留：
  - `stance`：由 OPEN 评估证明可到达的相邻站姿；
  - `pos`：未进入的相邻边界点；
  - `gap`：未观察格；
  - `basis`：局部已观察依据；
  - `computedAt` / `validUntil`。
  - 可选 `historicalConnection` 回调：只有调用方自己的历史查询返回 `true`/`false` 时才写入布尔值；返回 `undefined` 或未提供回调时为 `'unknown'`。
- **明确不支持**：
  - 目标选择或排序。
  - 自动探索或世界扫描。
  - 本模块的拓扑查询/导入：模型不导入 topology，也不伪造 `false`/`true`。
  - 对边界点或 gap 的可达性声明。
  - 移动、转头、观察、pin、保存。
  - `selected` 与 `explorationStarted` 恒为 `false`。
- **边界**：输出受快照的 `maxFrontiers` 限制；`truncated` 直接取 `counters.frontierLimitReached`，不扩大工作。
- **证据**：`src/navigation/route-inspection.ts`；`tests/navigation-capabilities.test.ts`；`tests/navigation-pipeline.test.ts` 的默认 unknown 与 true/false/undefined 回调测试。

### `recall_route` — `not_implemented`

- **入口**：无公开 `recall_route` 函数。
- **相关构件（非实现）**：`FragmentStore.getFragment`、`TopologyStore.route` 等历史几何/图查询；它们只返回历史事实，不选择、不执行、不确认到达。`inspectKnownRoute` 与 `followKnownPath(pathId)` 分别提供只读投影和指定路线执行，但不构成通用的路线召回选择能力。
- **明确不支持**：基于 `pathId` 的通用路线召回并返回可执行路线或到达声明；宿主动作注册、仲裁、调度、嵌套与取消接线。
- **证据**：`tests/navigation-capabilities.test.ts` 断言 `'recall_route' in navigation === false`。

## 公开导出

本工作包从 `src/navigation/index.ts` 导出：

```ts
import {
  followKnownPath,
  frontierCandidates,
  inspectKnownRoute,
  inspectRoute,
  navigateTo,
  startKnownWalkRoute,
  NAVIGATION_CAPABILITIES,
  NAVIGATION_CAPABILITY_STATUSES,
} from './navigation/index.js';
```

相关类型：`NavigateEnvironment`、`NavigateOutcome`、`NavigateSearchSource`、`NavigateSegment`、`NavigationMemoryWrite`、`FollowKnownPathEnvironment`、`FollowKnownPathOutcome`、`InspectKnownRouteOptions`、`KnownRouteEvidence`、`KnownRouteInspection`、`KnownRouteInspectionResult`、`KnownRouteTraversalView`、`FrontierCandidatesOptions`、`HistoricalConnectionLookup`、`FrontierCandidateView`、`FrontierCandidatesResult`、`RouteBoundaryFact`、`RouteInspection`。

包根入口 `src/index.ts` 的重新导出由集成方接线；本工作包未修改根入口。

`NavProblem` 新增 `{ kind: 'invalid_request'; detail: string }`，用于请求边界上的未知字段或非法结构；它不表达任何世界障碍或路径结论。`ActionRecord.delegation.constraints` 为可选字段，只在调用方提供约束时记录。

## 验证记录

全部为离线内存/Fake 测试，没有启动 Minecraft 服务器或 Bot。

```text
tsc -p tsconfig.build.json
-> exit 0

tsc --noEmit
-> exit 0

vitest run tests/navigation-pipeline.test.ts
-> exit 0; Test Files 1 passed; Tests 15 passed

vitest run tests/navigation-capabilities.test.ts tests/known-walk-route.test.ts \
            tests/walk-route-executor.test.ts tests/walk-search.test.ts
-> exit 0; Test Files 4 passed; Tests 158 passed

vitest run
-> exit 1; Test Files 4 failed | 28 passed (32); Tests 1 failed | 853 passed (854)
```

`vitest run` 的退出码 1 来自三个既有 `acceptance/{consumer-close,provenance,run}.test.mjs` 的 `No test suite found in file ...` 加载噪声，以及既有的 `tests/spatial-checkpoint.test.ts` 在本机 Windows 临时目录上的 `Cannot redefine property: jsonEscapedByteLength` / `EPERM` 环境失败；这些失败与本次导航改动无关。853 个断言通过。

## 未实现、未接入与未验证

- `recall_route` 未实现。
- `navigate_to` 只支持同高度、单格 X/Z 的精确脚格行走；`near`、`reach_block` 与三维高度变化未实现。
- 挖、放、搭柱、材料、非空 `avoid`、frontier 探索只做显式拒绝，没有执行入口。
- 搜索、执行、观测失效与取消由调用方提供；本次没有把库接到 mineflayer、Curio 调度器、动作注册、提示词、嵌套技能或真实寻路器。
- 没有在真实 Java 1.20.1 世界中运行验收；本文件不把类型声明、单元测试、构建通过或 Fake 执行器写成真实集成证据。`ARRIVED` 的“实测”指调用方提供的 `BodySample`，真实身体适配仍需宿主验证。
