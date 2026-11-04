# 导航后续增量验收：有界只读同高四邻 walk 候选搜索

> 本文件是本任务新增的验收记录，不覆盖、不修改用户已有的
> `docs/spatial-memory-library-design.md` 或其他设计文档。

## 结论

新增**有界、只读、增量的同高四邻 walk 路线候选搜索**（`WalkRouteSearch`），组合现有
`VoxelMap` 与 `evaluateWalkStep`。搜索只沿当前评估为 `OPEN` 的边扩展，返回零条或多条边的
**候选**，并同时输出由同一次 OPEN 可达扩展得到、且 stance 已被实际 OPEN 评估证明的未知边界候选。

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
  会检测规则版本变化、证据 `validUntil` 过期和驻留 generation 变化。所有已评估边（不仅是 OPEN 路径，
  也包括支撑 `NO_VERIFIED_PATH` / `INSUFFICIENT_EVIDENCE` / `BUDGET_EXHAUSTED` 的 BLOCKED / UNKNOWN /
  STALE / UNSUPPORTED 边界）的 `evaluation.validUntil` 都并入搜索证据窗口；所需的当前证明过期后，
  终态负结论也会进入 `INVALIDATED`，不会永久保留为 `NO_VERIFIED_PATH`。相关 `ChangeReport`
  经 `invalidate` 消费后，整个累积搜索进入 `INVALIDATED`，清空候选/frontier 输出，要求调用方
  重新 `start`，绝不把旧 OPEN 边与新证据拼接成当前路线。无关 Section 的变化被忽略。
- **刷新型恢复**：刷新型（`invalidated: false`）报告通常不改内容。但若它触及的 Section 曾产生
  STALE/UNSUPPORTED 结论（例如证据只是过期），旧派生搜索仍进入 `INVALIDATED`，因为该结论依赖的
  证据代次已变化；仅触及 OPEN/BLOCKED/UNKNOWN 证据的安全刷新不使 search 失效。没有自动搜索/重试。
- **时钟重检**：每次 `advance` 用同一时刻完成切片评估后，会在发布快照前重读 `now`。若注入的形状
  提供者在评估期间推进了时钟，使刚用过的证据已过期，发布前即失效，不会把该候选描述为“当前 OPEN”。
- **调用方职责**：每次 `VoxelMap.observe`/`observeBatch`/`beginSession`/`markStale` 后，把返回的
  `ChangeReport` 交给 `invalidate`；驻留变化交给 `invalidateSections`。搜索不自动重试、不自动刷新观察。
- **Frontier 语义**：frontier 只在 stance **已被实际评估器证明可达**时报告。证明来自一次 `OPEN`
  `evaluateWalkStep`：其扫掠碰撞与支撑检查同时覆盖起点和终点 stance。调用方给出的起始坐标本身不是
  观察证据；空地图或只有起点中心格观察时，即使四条边都是 UNKNOWN，也返回空 `frontiers`，不会出现
  `reachability: 'OPEN'` 且 `basis: []` 的条目。`stance` 是已验证的已知侧；`to`/`gap` 是相邻
  UNKNOWN 证据，明确不声明可达，也从未进入搜索。`basis` 只包含该 stance 的局部已观察脚/头/支撑格
  （有界），并带 `computedAt`/`validUntil`；它只是局部分布摘要，本身不是任意身体净空/支撑的证明。
  快照顶层带 world/dim/session。不从几何邻近推断 `historicalConnection`（本类型不提供该字段）。
- **UNKNOWN 分类**：`UNKNOWN` 同时包含“从未观察”和“已观察但状态不完整”。只有 required cell 确实
  从未观察且无已保存记录时才产生新 frontier；有观察但 `stateComplete === false` 的 required cell
  只保留为诊断缺口，不产生 frontier。已保存但 `not_resident` / `loading` / `load_failed` 的 Section
  仍单独进入 `unavailableHistorical`，不当作新 frontier。
- **旧证据不可用**：UNKNOWN 缺口用 `sectionResidency` 逐格核查；若缺口落在
  `not_resident` / `loading` / `load_failed` 的已保存 Section，则进入 `unavailableHistorical`
  （含 Section key、驻留状态、已提交 revision），不冒充新 frontier。
- **只读**：搜索只调用 `sectionAt` / `cellAt` / `sectionResidency` / `residencyGeneration`，
  不调用 `observe`，不刷新证据时间/版本，不改变 `saveRevision`。快照深拷贝请求与全部输出。

## 实际运行的检查

修正提交实际运行（本 worktree，2026-11-04）：

```text
npm run build
  → 通过

npm run typecheck
  → 通过（含 pretypecheck 的 build）

npx vitest run tests/walk-search.test.ts --no-cache
  → 43 passed（1 个文件，clean exit）

npx vitest run --no-cache
  → 604 passed（20 个测试文件，clean exit）
```

说明：上一提交的验证曾遇到 Vitest 结束写缓存时
`mkdir .../node_modules/.vite/vitest: UNKNOWN`。`node_modules` 是预装 junction，该目录不可写；
当时 33 个测试断言已先通过，失败发生在测试完成后的缓存写入，不是断言失败。本环境该 Vitest
支持 `--no-cache`（不使用 `--cacheDir`）；以上命令均以 clean exit 完成，没有缓存警告。

`tests/walk-search.test.ts` 覆盖：

1. 正向绕行（直线被墙挡住后找到更长候选）、完全封闭返回 `NO_VERIFIED_PATH`。
2. 未知 / 过期 / 不支持形状的区分，以及三种缺口分别进入 frontier 或 `unavailableHistorical`。
3. 节点/边硬上限、每次 `advance` 的切片预算、非法预算与非法选项。
4. 开始前取消、中途取消、取消后不再评估。
5. exact 错高度、非整数偏移、非 walk 模式的能力限制；分数连续坐标与负坐标。
6. near 的完整 XYZ 判断：纯 XZ 满足但三维超半径时不接受；高度差超过半径时直接无路径。
7. 起点零边候选，reason 明确不是 `ARRIVED`；零边候选的 `validUntil` 保持 `Infinity`，
   不受证据过期影响。
8. 请求/快照隔离；只读搜索不改变地图证据、时间和 `saveRevision`。
9. 切片之间的相关改动、无关改动、shape 规则版本变化、证据过期；已 FOUND 候选过期撤销。
10. 旧已保存但未驻留/加载中/加载失败的 Section 不产生新 frontier。
11. 候选点列可由 `RouteVerifier` 复验为当前 `OPEN`。

修正后新增的针对性回归（均在上述 43 项内）：

12. 空地图四条 UNKNOWN 边不产生任何 `reachability: 'OPEN'` frontier；调用方起始坐标不被当作证明。
13. 仅起点中心格的观察也不产生 frontier；有真实 `OPEN` 路径到达的 stance（x=1.5）才产生，
    且 `basis` 非空。
14. 完全观察但 `stateComplete === false` 的 required cell 只出现在诊断中，不产生假 frontier。
15. 完全封闭的终止负结论 `validUntil` 是有限值（BLOCKED 证据窗口），时钟越过该窗口后
    `NO_VERIFIED_PATH` 转为 `INVALIDATED`；规则版本变化和依赖 Section 驻留变化同样使终态负结论失效。
16. 证据过期导致 `INSUFFICIENT_EVIDENCE` 后，对同一批六个 floor/air 格的 refresh-only
    （`invalidated: false`）报告会使旧搜索结果 `INVALIDATED`，且不自动重试；普通 FRESH OPEN
    刷新不使已 FOUND 候选失效。
17. 注入形状提供者在评估期间推进时钟时，`advance` 发布前重检时钟并把刚刚产生的候选标记为
    `INVALIDATED`；地图证据/`saveRevision` 不变。

## 本轮未实现 / 未验证

- 不是完整导航动作注册：没有接入 Curio 动作目录、仲裁、参数校验、取消/超时和嵌套技能。
- 不支持跳跃、台阶、梯子、下落衔接、游泳/水面、船及任何三维移动；仅固定脚高的四邻 walk。
- 不实现挖掘、放置、搭桥、清障、自动探索或目标选择；没有材料/授权参数。
- 不做旧记忆迁移、历史拓扑重验证导出或 `historicalConnection` 推断（后者由协调方后续模块提供）。
- 未启动真实 Minecraft 服务器或 mineflayer 验收；测试用 `tests/fakes.ts` 的 Fake 形状规则，
  **不代表 Minecraft 1.20.1 的真实碰撞/物理/流体语义**。
- frontier 的 `basis` 只是 stance 局部观察格的有界摘要，不是该步完整依赖集合，也不是身体净空证明。
- 只有被 `OPEN` 评估证明过的 stance 才报告 frontier。若某个边界先被评估、而该 stance 直到搜索结束
  都没有任何 `OPEN` 步覆盖，该边界不会报告（保守少报，不产生假阳性）。`frontierCandidates` 统计的是
  分类出的从未观察候选（验证前），可能大于 `frontiersReported`。
- `UNKNOWN` 的 required cell 分类按 Section 粒度区分已保存不可用与从未观察；同一缺口若混有已保存
  Section，则只报告 `unavailableHistorical`，不额外拆分 frontier。
- 负结论的证据窗口取所有已评估边的 `validUntil` 最小值，因此可能因与当前阻挡边界无关的其他已读证据
  过期而保守失效；这是有意的“不得混用旧证据”取舍，且不会自动重试。
- refresh-only 失效按 Section 判定：仅当刷新触及曾产生 STALE/UNSUPPORTED 结论的 Section 时发生；
  同一 Section 内未参与该结论的格也会导致整个 search 失效（不做逐格派生追踪）。
- near 完成条件只在实际到达的格点 stance 上判定，不判定边中间位置。
- 零边候选只有一个点，不能直接传给需要至少两个点的 `RouteVerifier`；调用方必须分支，并从实测身体
  位置确认完成条件后才能报告到达。
- 失效由调用方显式转发 `ChangeReport`/驻留变化；未提供通用自动重试或后台重扫框架。
