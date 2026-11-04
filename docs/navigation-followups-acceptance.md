# 导航后续增量验收：有界只读同高四邻 walk 候选搜索

> 本文件是本任务新增的验收记录，不覆盖、不修改用户已有的
> `docs/spatial-memory-library-design.md` 或其他设计文档。

## 结论

新增**有界、只读、增量的同高四邻 walk 路线候选搜索**（`WalkRouteSearch`），组合现有
`VoxelMap` 与 `evaluateWalkStep`。搜索只沿当前评估为 `OPEN` 的边扩展，返回零条或多条边的
**候选**，并同时输出由同一次 OPEN 可达扩展得到的未知边界候选。

候选不等于到达：`FOUND` 只表示当前证据支持一条候选点列；执行仍需 `RouteVerifier` 复验，并由
执行层用实测位置确认完成条件。本增量不注册宿主动作、不执行移动、不挖/不放、不选择目标、不自动探索。

## 公共 API

```ts
import { WalkRouteSearch } from 'curio-minecraft-3d-memory';
import type {
  WalkSearchRequest, WalkSearchOptions, WalkSearchSnapshot, WalkSearchState,
  WalkSearchCandidate, WalkSearchFrontier, WalkSearchUnavailableEvidence,
  WalkSearchDiagnostic, WalkSearchCounters, WalkSearchProblem, WalkSearchArrival,
} from 'curio-minecraft-3d-memory';

const search = new WalkRouteSearch(map, {
  now,                 // 证据过期时钟；与 observation.observedAt 可比
  maxNodes: 2048,      // 包含起点的硬节点上限
  maxEdges: 8192,      // 实际 evaluateWalkStep 调用的硬上限
  maxFrontiers: 64,    // frontiers 与 unavailableHistorical 各自输出上限
  maxDiagnostics: 64,  // 非 OPEN 边界诊断输出上限
});

search.start({
  worldId, dim, sessionId, mode: 'walk', body,          // body.feet 是固定连续脚位
  target, arrival: { kind: 'exact' } | { kind: 'near', radius },
  shapeProvider,                                         // 注入的形状规则；无宿主全局导入
});

search.advance(n);              // 每次至多评估 n 个边工作项；PENDING 表示预算用完但仍有工作
search.status();                // 只读快照；未 start 时为 null
search.cancel('reason');        // 取消；保留已完成的计数与取消前候选
search.invalidate(report);      // 消费 VoxelMap ChangeReport
search.invalidateSections(keys);// 消费驻留变化（unload/load/load_failed）
search.clear();                 // 丢弃本次搜索
```

`WalkSearchState`：`PENDING` / `FOUND` / `NO_VERIFIED_PATH` / `INSUFFICIENT_EVIDENCE` /
`UNSUPPORTED` / `BUDGET_EXHAUSTED` / `CANCELLED` / `INVALIDATED`。

## 契约要点

- **固定脚位与格点能力**：可达 stance 仅限 `body.feet + (整数 ΔX, 整数 ΔZ)`，Y 始终等于原脚高。
  exact 目标若高度不同或 X/Z 偏移不是整数，返回 `UNSUPPORTED`（`problem.kind === 'unsupported_target'`），
  不取整、不改写目标、不报 `NO_VERIFIED_PATH`。浮点近整数判定使用 `1e-9` 容差（与既有路线分解一致），
  返回的目标仍是调用方原值。
- **near 为完整 XYZ 距离**：在每个实际到达的 stance 上用三维欧氏距离判断，不投影到 XZ；
  半径必须显式给出且有限、非负。固定高度差已超过半径时直接返回 `NO_VERIFIED_PATH`（0 条边评估）。
- **零边候选**：起点已满足 exact/近目标时返回 0 边候选，不声称 `ARRIVED`、不虚构移动。
- **只走 OPEN**：每个方向调用 `evaluateWalkStep`；`BLOCKED` / `UNKNOWN` / `STALE` / `UNSUPPORTED`
  均不进入。四个邻居固定顺序，展开为 BFS，贡献确定性的最短边数候选。
- **硬上限与增量预算**：节点、实际边评估、frontier 输出和诊断输出分别有上限；达到节点/边上限返回
  `BUDGET_EXHAUSTED` 并给出 `problem.kind === 'budget_exhausted'` 的布尔与计数事实，不静默截断。
  `advance(n)` 的剩余工作在后续调用继续。
- **取消**：`cancel` 前后均不产生 `FOUND` 假象；开始前取消时 `edgesEvaluated === 0`；中途取消保留
  已到达节点数、边计数和取消前候选。
- **失效/过期契约**：所有已读依赖 Section 记录 revision 无关的驻留 generation；`advance`/`status`
  会检测规则版本变化、证据 `validUntil` 过期和驻留 generation 变化。相关 `ChangeReport`
  经 `invalidate` 消费后，整个累积搜索进入 `INVALIDATED`，清空候选/frontier 输出，要求调用方
  重新 `start`，绝不把旧 OPEN 边与新证据拼接成当前路线。无关 Section 的变化被忽略。
  刷新型（`invalidated: false`）报告不改变内容，但搜索仍按原 `validUntil` 保守过期。
- **调用方职责**：每次 `VoxelMap.observe`/`observeBatch`/`beginSession`/`markStale` 后，把返回的
  `ChangeReport` 交给 `invalidate`；驻留变化交给 `invalidateSections`。搜索不自动重试、不自动刷新观察。
- **Frontier 语义**：frontier 来自同一次 bounded OPEN 可达扩展。`stance` 是当前 OPEN 可达的已知侧；
  `to`/`gap` 是相邻 UNKNOWN 证据，明确不声明可达，也从未进入搜索。`basis` 只包含该 stance 的
  局部已观察脚/头/支撑格（有界），并带 `computedAt`/`validUntil`；快照顶层带 world/dim/session。
  不从几何邻近推断 `historicalConnection`（本类型不提供该字段）。
- **旧证据不可用**：UNKNOWN 缺口用 `sectionResidency` 逐格核查；若缺口落在
  `not_resident` / `loading` / `load_failed` 的已保存 Section，则进入 `unavailableHistorical`
  （含 Section key、驻留状态、已提交 revision），不冒充新 frontier。
- **只读**：搜索只调用 `sectionAt` / `cellAt` / `sectionResidency` / `residencyGeneration`，
  不调用 `observe`，不刷新证据时间/版本，不改变 `saveRevision`。快照深拷贝请求与全部输出。

## 实际运行的检查

```text
npm run build
  → 通过

npm run typecheck
  → 通过（含 pretypecheck 的 build）

npx vitest run tests/walk-search.test.ts
  → 33 passed（1 个文件）

npx vitest run
  → 594 passed（20 个测试文件）
```

说明：`vitest` 结束写结果缓存时报告一次
`mkdir .../node_modules/.vite/vitest: UNKNOWN`。`node_modules` 是预装 junction，该目录不可写；
这是测试环境缓存写入警告，发生在本轮全部测试通过之后，不是测试失败。

`tests/walk-search.test.ts` 覆盖：

1. 正向绕行（直线被墙挡住后找到更长候选）、完全封闭返回 `NO_VERIFIED_PATH`。
2. 未知 / 过期 / 不支持形状的区分，以及三种缺口分别进入 frontier 或 `unavailableHistorical`。
3. 节点/边硬上限、每次 `advance` 的切片预算、非法预算与非法选项。
4. 开始前取消、中途取消、取消后不再评估。
5. exact 错高度、非整数偏移、非 walk 模式的能力限制；分数连续坐标与负坐标。
6. near 的完整 XYZ 判断：纯 XZ 满足但三维超半径时不接受；高度差超过半径时直接无路径。
7. 起点零边候选，reason 明确不是 `ARRIVED`。
8. 请求/快照隔离；只读搜索不改变地图证据、时间和 `saveRevision`。
9. 切片之间的相关改动、无关改动、shape 规则版本变化、证据过期；已 FOUND 候选过期撤销。
10. 旧已保存但未驻留/加载中/加载失败的 Section 不产生新 frontier。
11. 候选点列可由 `RouteVerifier` 复验为当前 `OPEN`。

## 本轮未实现 / 未验证

- 不是完整导航动作注册：没有接入 Curio 动作目录、仲裁、参数校验、取消/超时和嵌套技能。
- 不支持跳跃、台阶、梯子、下落衔接、游泳/水面、船及任何三维移动；仅固定脚高的四邻 walk。
- 不实现挖掘、放置、搭桥、清障、自动探索或目标选择；没有材料/授权参数。
- 不做旧记忆迁移、历史拓扑重验证导出或 `historicalConnection` 推断（后者由协调方后续模块提供）。
- 未启动真实 Minecraft 服务器或 mineflayer 验收；测试用 `tests/fakes.ts` 的 Fake 形状规则，
  **不代表 Minecraft 1.20.1 的真实碰撞/物理/流体语义**。
- frontier 的 `basis` 只是 stance 局部观察格的有界摘要，不是该步完整依赖集合。
- near 完成条件只在实际到达的格点 stance 上判定，不判定边中间位置。
- 失效由调用方显式转发 `ChangeReport`/驻留变化；未提供通用自动重试或后台重扫框架。
