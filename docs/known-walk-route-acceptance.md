# 显式历史路线启动接缝验收记录

> 本文件只记录本次新增的 `startKnownWalkRoute` 接缝。它不修改设计文档、不注册 Curio 动作、
> 不接管执行器生命周期，也不把历史几何当成当前可通行证据。

## 结论

新增一个最小、可组合的启动边界：调用者从 `FragmentStore` 指定一个历史片段，由
`startKnownWalkRoute(history, executor, request)` 把该片段原始有序 polyline 交给既有
`WalkRouteExecutor.start`，返回 `STARTED`（附执行器实际状态与路线快照）或 `REJECTED`
（结构化原因 + 语义文字）。

- `STARTED` 只表示执行器接受了这次委托；它不是 `OPEN`，更不是 `ARRIVED`。逐段复验、实测到达、
  观测报告、推进、超时与取消继续由同一个 `WalkRouteExecutor` 完成。
- 片段 `kind`（`dug/walked/bridge/built`）与 `geometrySource`（含 `legacy`）只作为几何来源快照；
  只有显式 `mode: 'walk'` 才启动，且不会因此写入任何 `TraversalEvidence`。
- 不读取/刷新观测，不搜索替代路线，不挖、不放、不消耗材料，不改变历史记录、时间戳或 `uses`。

## 新增文件

| 文件 | 内容 |
|---|---|
| `src/navigation/known-walk-route.ts` | `startKnownWalkRoute`、请求/结果类型、启动前校验 |
| `tests/known-walk-route.test.ts` | 真实 `FragmentStore` + 真实 `WalkRouteExecutor` + Fake body/map 的契约测试 |
| `docs/known-walk-route-acceptance.md` | 本验收记录 |

公共出口同时更新：

- `src/navigation/index.ts`
- `src/index.ts`

## 公共 API

```ts
startKnownWalkRoute(
  history: FragmentStore,
  executor: WalkRouteExecutor,
  request: KnownWalkRouteRequest,
): KnownWalkRouteStart
```

```ts
type KnownWalkRouteRequest = Omit<WalkRouteRequest, 'points'> & {
  fragmentId: string;
  parentActionId?: string; // 仅元数据，不连接任何宿主取消
  maxRoutePoints?: number; // 默认 1024，只做启动前预算检查
};

type KnownWalkRouteStart =
  | { kind: 'STARTED'; status: WalkRouteStatus; route: KnownWalkRouteSnapshot }
  | { kind: 'REJECTED'; reason: KnownWalkRouteRejectionReason; message: string };
```

`KnownWalkRouteSnapshot` 保留 `fragmentId`、`geometrySource`、`kind`、`parentActionId`（若提供）、
`worldId/dim/sessionId`、`mode`、`arrival`、原始有序 `points` 与原始终点 `target`。所有快照均为新副本，
不与存储记录或调用者可变的请求对象共享引用。

拒绝原因码：`missing_history`、`wrong_scope`、`unsupported_geometry`、`unsupported_mode`、
`unsupported_arrival`、`unsupported_constraint`、`wrong_start`、`route_budget`。

## 启动前校验顺序

以下校验全部发生在 `executor.start` 之前，因此被拒绝时既有委托（包括在途移动）保持不变：

1. 请求 `worldId` 与历史库 `worldId`、片段 `dim` 与请求 `dim` 必须一致（`wrong_scope`）。
2. 片段必须存在（`missing_history`）。
3. 只接受 `mode: 'walk'`（`unsupported_mode`）与 `arrival: { kind: 'exact' }`（`unsupported_arrival`）。
4. 非空 `avoid` 被拒绝（`unsupported_constraint`），因为现有 walk evaluator 不消费该约束。
5. `maxRoutePoints` 必须是 `[2, 1024]` 内的整数，且 polyline 不得超过它（`route_budget`）。
6. polyline 至少两点，且每段必须同高、沿 X 或 Z 恰好一格；重复点、稀疏、对角、跨高度均拒绝
   （`unsupported_geometry`）。不取整、不反转、不插值、不跳过重复点。
7. 固定身体的 `feet` 必须严格等于历史路线首点（`wrong_start`）。

## 实际验证

在仓库根目录运行（Node `v24.14.1`，Windows 11）：

| 命令 | 结果 |
|---|---|
| `npm run typecheck`（先 `npm run build`，再 `tsc --noEmit`） | 通过，退出码 0 |
| `npx vitest run tests/known-walk-route.test.ts --no-cache` | 25 个测试通过 |
| `npx vitest run tests/walk-route-executor.test.ts tests/grounded-walk-route.test.ts --no-cache` | 92 个测试通过（74 + 18） |
| `git diff --check` | 无输出，退出码 0 |

Vitest 首次运行时测试本身全部通过，但写入 `node_modules/.vite/vitest`（`node_modules` 为 junction）
时报 `UNKNOWN: unknown error, mkdir`，因此后续使用 `--no-cache` 取得干净的退出码。这是本机缓存目录
问题，不影响测试结果。

测试覆盖：

- 原始分数坐标、带转向的三点路线按原顺序逐段执行，只有实测到达才产生 `ARRIVED`。
- 当前无证据、`BLOCKED`、`STALE` 三种情况下均不调用 `move`，也不产生到达。
- 15 个启动前拒绝分支各自验证：拒绝码正确，且既有在途委托的 `delegationId`、`nextPointIndex`、
  `activeStepIndex` 不变，`executor.stop` 未被调用，也没有新移动请求。
- `deadlineMs` / `timeoutMs` 被原样传入并出现在 `WalkRouteStatus` 与每个 `ExecutableMove`；
  越过原 deadline 后由原执行器返回 `TIMEOUT`。
- 调用者直接使用原执行器 `cancel`，保留已接受的部分位移、原执行器 `stop` 调用与中止信号。
- `built` + `legacy` 几何可以按 `walk` 启动，但历史库 `traversals` 始终为 0，revision 与
  checkpoint 快照不变。
- 返回快照、执行器状态与历史库互不别名；修改返回的 `points`/`target` 不影响存储或执行器。

## 限制与未验证项

- **仅 Fake 身体验收。** 使用真实 `FragmentStore`、真实 `WalkRouteExecutor`、Fake `MoveExecutor`
  与内存 `VoxelMap`；未接入 mineflayer、真实寻路或游戏服务器，不能宣称真实游戏控制已通过。
- **未做宿主注册。** 未注册 Curio 动作、参数校验、仲裁、嵌套技能或调度取消链；`parentActionId`
  只是快照元数据，不连接任何宿主持有/取消句柄。
- **只支持既有执行器的一格同高直行几何。** 任意历史 polyline（跨高度、对角、稀疏、重复点）在
  启动前被拒绝；需要额外移动模式的片段不会被“转换”为可执行路线。
- **`maxRoutePoints` 不控制执行器自身设置。** 它只提供不超过 1024 的启动前上限。若
  `WalkRouteExecutor` 以更小的 `maxRouteLength` 构造，超长路线会按既有边界由 `executor.start`
  抛出异常；本函数无法检查或放宽该内部设置。
- **部分非法值仍走既有异常边界。** 非有限 body 尺寸/位置、非有限时钟、请求 `worldId` 与执行器
  地图 `worldId` 不一致等值只有执行器能判定，会按既有 `start` 异常传播；本函数不声称把它们
  全部转换为 `REJECTED`。
- **不产生当前通行结论或历史事实。** 启动成功不写入 `OPEN`、`ARRIVED` 或 `TraversalEvidence`；
  每段仍需执行器基于当前证据复验，到达仍需实测身体样本确认。
