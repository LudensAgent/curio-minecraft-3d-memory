# 空间记忆库 M4 walk-path 执行审计（memory-host）

> 审计日期：2026-11-07
> 被审基线：`ad71f4a`（`merge(walk): integrate L-M4-07 body port contract tests`），分支 `integration/memory-host-20261107`
> 实现提交：`fdc7760`（定义执行类型）、`a09d061`（routeId 预检）、`a19d342`（执行绑定与结果加固）、`b40dddf`（失效报告）、`c22c2c5`（终态到达证据隔离）、`bdfdd17`（取消部分效果测试）、`c398649`（身体端口契约测试）
> 计划基线：[memory-host 实现计划](./memory-host-implementation-plan.md) §M4（自 `960da25` 创建后未变；后续 `f9b827b` 只改 §M2.5）
> 契约基线：[Agent/宿主接口契约](./memory-host-interface-contract.md) §7、§15（`ad71f4a` 时点，仍为 `memory-host-contract/1`）
> 审计范围：M4.1–M4.8、阶段门禁 G3；本仓库源码、测试、文档
> 非审计范围：M5–M9、Curio 宿主源码、真实 Minecraft Java 1.20.1 / mineflayer 联机运行

> 审计方式：逐项核对源码、测试、调用链与导出，并在 worktree 内实际运行验证命令；未仅依据提交信息或类型声明下结论。

---

## 0. 结论

**M4 库内可交付；阶段门禁 G3 在库自带 `createWalkPathExecution` 绑定与 Fake 身体端口范围内通过。**

- M4.1–M4.8 的交付物均已存在：执行请求/环境/结果类型、`createWalkPath` 预检入口、`createWalkPathExecution` 的 `WalkRouteExecutor` 绑定、失效/取消/到达映射、独立 `INVALIDATED` outcome 与 `WalkBodyPort` 契约测试。
- M4.1 实现存在，但计划要求的类型导出/outcome 穷尽专用测试缺失（D-027/B03-M4-03），验证记为 **PARTIAL**；M4.2–M4.8 有对应测试证据。
- **G3 通过（库自带 `createWalkPathExecution` 绑定、Fake）**：该绑定下 `walkPath` 不搜索、不施工、失效即停、`ARRIVED` 只由实测接地/支撑/稳定样本确认。公共 `createWalkPath` 允许注入 `execute`，本结论不覆盖任意注入实现；真实宿主是否遵守身体端口契约不在本审计证明范围（G6/M7）。
- 未发现计划 §4.12 的阻断项；在库自带绑定中未发现把 `INVALIDATED` 折叠为 `BLOCKED`/`NO_PATH`/`FAILED` 的实现路径，也未发现搜索、自动绕路或挖/放/搭柱/材料入口。
- 剩余未验证项集中在真实 Minecraft/mineflayer（H-01）、M5 能力报告与入口拆分、M6 的 `ActionRecord`/`memoryWrite` 持久化，以及契约 §15 状态表与 M9 版本收口；这些不属于 M4 实现缺陷。

一句话：**M4 的 routeId 预检、受限单步执行、失效/取消/接地到达语义与身体端口契约可交付，G3 在库自带绑定/Fake 范围成立；公共注入执行器边界、真实服务器、M5 能力协商与 M6 持久化仍未验证。**

---

## 1. 验证记录

| 命令 | 结果 | 说明 |
|---|---|---|
| `npm run typecheck` | exit 0 | `pretypecheck` build + `tsc --noEmit` 通过 |
| `npx vitest run tests/walk-path-start.test.ts tests/walk-path-execution.test.ts tests/walk-path-invalidation.test.ts tests/walk-path-arrival.test.ts tests/walk-path-cancel.test.ts tests/walk-body-port-contract.test.ts` | exit 0 | **6 个文件 / 95 个用例通过**：start 12、execution 24、invalidation 6、arrival 41、cancel 6、body-port 6 |
| `npm test` | exit 1 | 63 个 suite：60 passed / 3 failed；**1250/1250 个用例通过**。3 个 failed 均为 `acceptance/consumer-close.test.mjs`、`acceptance/provenance.test.mjs`、`acceptance/run.test.mjs` 的 `No test suite found`，属计划 §5.1 已记录的已知 collect 噪声，不是实现失败 |
| `node --test acceptance/provenance.test.mjs acceptance/run.test.mjs acceptance/consumer-close.test.mjs` | exit 0 | **32/32 通过**；按计划 §5.1 对 acceptance 单独验证，覆盖上述 `npm test` collect 噪声中的三个文件 |
| `git show --check`（7 个实现提交） | exit 0 | 无空白/格式错误 |
| `git status --short` | — | 审计开始时工作树干净；本审计只新增本文件，未改源码、测试或既有文档 |

2026-11-07 两轴 review 修复后复跑 `npm run typecheck`（exit 0）与 acceptance `node --test`（32/32）；本次修复只改本文件。

实现提交使用 Conventional Commits，未发现工具/模型署名或 `Co-Authored-By`。被审基线 `ad71f4a` 已包含 L-M4-01–L-M4-07 的集成；`c398649` 为 L-M4-07 的测试提交。

---

## 2. M4 逐项结论

| 任务 | 状态 | 源码/测试证据 | 契约条目与退出条件 |
|---|---|---|---|
| M4.1 定义执行类型 | **实现完成；验证 PARTIAL**（专用类型穷尽测试缺失） | `src/navigation/walk-path-types.ts:25-122` 定义 `WalkPathRequest`/`WalkPathEnvironment`/`WalkBodyPort`/`ChangeReportSource`/`WalkPathOutcome`/`WalkPathResult`；`src/navigation/index.ts:32-51`、`src/index.ts:323-324,376,400-411` 导出入口与类型。`WalkPathOutcome` 含 `INVALIDATED`（`:80-87`），`NavOutcome` 未扩展（`src/navigation/types.ts:15-22`）。根入口将 walk-path 的 `ChangeReportSource` 别名导出为 `WalkPathChangeReportSource`（`src/index.ts:374-376`），因为根入口已存在 memory 写端口的 `ChangeReportSource`；该歧义按 D-027 归 M5.1 入口测试/文档。类型导出由 `npm run typecheck` 验证；无专用类型导出/outcome 穷尽测试，穷尽性仅由 tsc 与人工核对 | 契约 §7.2–§7.4 字段齐全（请求、环境、身体端口、结果、outcome）。计划 M4.1 的“类型导出/outcome 穷尽/INVALIDATED 独立”中，导出与类型由 tsc 验证，穷尽性仅人工核对，专用测试缺失（D-027/B03-M4-03），故该项验证为 PARTIAL，不写成完整通过 |
| M4.2 消费 routeId | **完成** | `src/navigation/walk-path.ts:122-162` 先消费再预检、失败仍单次使用、执行期间 pin、结束后 release；`:899-973` 实测起点、`executionId`、scope/session、body 可用性与 3D 欧氏距离 `>0.05`；`:975-1014` registry 错误分类。`tests/walk-path-start.test.ts:130-380` 共 12 用例，覆盖 `route_not_found`/`route_consumed`/`route_expired`/`route_not_executable`/`route_start_changed`/`scope_mismatch`/`route_start_unmeasured`/`route_body_unavailable`，并断言预检失败时 `bodyPort.move`/`stop` 调用数为 0、`execute` 钩子未调用 | 契约 §7.5.1–§7.5.4。退出条件：预检失败无身体动作、无记忆写入；测试直接断言无身体调用，源码不导入 store/写入端口 |
| M4.3 绑定 `WalkRouteExecutor` | **完成** | `src/navigation/walk-path.ts:348-536` 构造唯一 `WalkRouteRequest`：原序 `plan.points`、`startSample`、请求 deadline、`bodyArrival`、`shapeProvider`；`:395-449` 只 `executor.start` 一次；`:454-535` 将宿主回传样本的 `exec_<routeId>` 重绑为内部 delegation id，转发 change report，未调用搜索。`tests/walk-path-execution.test.ts:201-564` 共 24 用例；`tests/walk-body-port-contract.test.ts:154-204` 验证单步。测试对 `WalkRouteExecutor.start` 断言恰好一次、对 `WalkRouteSearch.advance` 断言 0 次 | 契约 §7.3、§7.5.5–§7.5.7。退出条件：执行路径无 `WalkRouteSearch`/pathfinder 调用；`maxRouteLength` 默认 1024，超限在 start 前拒绝 |
| M4.4 失效与结果映射 | **完成** | `src/navigation/walk-path.ts:471-484` 订阅 `ChangeReport` 并在下一步前交给 executor；`:585-670` 将当前段 `route_invalidated`/`scope_changed` 映射为 `INVALIDATED`，`unobserved`/`stale`/`unloaded` 映射为 `INVALIDATED`，明确阻塞映射为 `BLOCKED`；`:624-635` 保留 `invalidation.segment`/`reason`，仅当被转发的报告本身触发 `route_invalidated`/`scope_changed` 时附 `changes`。`invalidation.changes` 描述按实现收窄：无关报告先被转发、随后因 TTL/驻留/规则版本失效时，`changes` 为空（D-039/B07-M4-05）；它不是“终态前最近一次报告”的通用记录。`tests/walk-path-invalidation.test.ts:172-333` 共 6 用例：当前段失效、无报告失效、终态后旧报告不替换、后续段失效不打断当前段且未复验不执行、无关 Section 变化不打断、旧报告在更新证据下不覆盖新证据 | 契约 §7.4、§7.5.9、§8.1。退出条件：`INVALIDATED` 不被折叠成 `BLOCKED`/`NO_PATH`/`FAILED`；测试覆盖当前段失效与后续段行为 |
| M4.5 grounded 到达 | **完成** | `src/navigation/walk-path.ts:177-295` 公共边界复核 `ARRIVED`：本执行身份、全段确认、剩余点为空、`lastPosition` 在 `bodyArrival` 容差内、`lastObservation` 同作用域且接地/干燥；`:611-620` 投影到达；`:725-853` 零边计划要求至少两个有序稳定样本并满足 `stableMs`。`tests/walk-path-arrival.test.ts:174-681` 共 41 用例，覆盖默认/自定义容差、差一点不算、Promise resolve 不算、`nextPointIndex` 推进不算、旧回调不算、零边路径与注入执行器边界 | 契约 §7.4、§7.5.8。退出条件：`ARRIVED` 必有 `lastPosition`/`lastObservation`；否则映射为 `unconfirmed_arrival`（零确认段 → `INVALIDATED`，有确认段 → `PARTIAL`），测试覆盖 |
| M4.6 取消/超时/部分效果 | **完成** | `src/navigation/walk-path.ts:486-532` 每个控制切片检查 signal 与 deadline，分别调用 `executor.cancel`；`:542-557` deadline 映射 `TIMEOUT` 并保留实测位置/观测/trace；`:856-897` 取消与身体不可用保留实测证据。`tests/walk-path-cancel.test.ts:135-471` 共 6 用例：signal 取消、deadline 超时、部分位移不确认、在途 move 取消、body-port 取消映射、旧执行与新执行隔离 | 契约 §7.5.10–§7.5.11。退出条件：取消/超时结果不伪造成成功，不清空已确认位移/观测/trace/部分效果；测试直接断言 |
| M4.7 `INVALIDATED` outcome | **完成**（仅在 `WalkPathOutcome` 独立表达） | `src/navigation/walk-path-types.ts:74-87` 将 `INVALIDATED` 列为独立 outcome；`src/navigation/types.ts:15-22` 的 `NavOutcome` 保持原样，未扩展；`src/navigation/walk-path.ts:584-713` 做映射，不存在 `PATH_NOT_FOUND` 输出。结果外壳 `contract`/`routeId`/`executionId`/`confirmed`/`trace` 由各执行套件断言；`INVALIDATED` 断言分散在 start/execution/invalidation/arrival 套件（如 `tests/walk-path-invalidation.test.ts:188-252`、`tests/walk-path-arrival.test.ts:246-356`） | 契约 §7.4。计划退出条件：不把 `INVALIDATED` 写成 `PATH_NOT_FOUND`；本实现未扩展 `NavOutcome`，因此未改 `tests/nav-result.test.ts`；库无日志接口，“日志字段”不在实现范围，`trace` 是结果内审计字段 |
| M4.8 身体端口契约测试 | **完成** | `tests/walk-body-port-contract.test.ts:154-425` 共 6 用例（其中一个 `it.each` 含 2 个序列参数），对照 `src/execution/types.ts:20-125` 与 `src/navigation/walk-path.ts:401-415` 的端口/身份包装。五个契约点见下 | 契约 §7.3、§7.5.7、§7.5.11。退出条件：宿主实现可对照测试；测试文件即契约对照表 |

### 2.1 M4.8 五个身体端口契约点

| 契约点 | 结论 | 测试证据 |
|---|---|---|
| `executionId` 稳定、`sequence` 保留 | 通过 | 每次 `move` 的 `executionId` 均为 `exec_<routeId>`，宿主回传的内部 delegation id 不被接受；start sequence 为 0/负数/非整数时失败关闭；`tests/walk-body-port-contract.test.ts:155-204`、`tests/walk-path-execution.test.ts:312-340` |
| 重放样本拒绝 | 通过 | 同一或更小的 `sequence` 不会推进确认；即使目标位置样本重复出现也不会伪造到达，最终为 `TIMEOUT` 且确认段为 0；`tests/walk-body-port-contract.test.ts:206-235` |
| 旧回调隔离 | 通过 | 旧 `executionId` 的宿主样本、旧 move 结果和已完成执行的迟到回调都不进入新执行的证据；新执行仍可独立 `ARRIVED`，`stop` 只指向自身；`tests/walk-body-port-contract.test.ts:237-301`、`:303-424`、`tests/walk-path-cancel.test.ts:396-471` |
| 单步 `to` 不被改写 | 通过 | 每条路线边恰好一次 `move`，`to` 顺序与计划点完全一致，`from` 使用实测位置而非计划点；无跳过、合并或改目标；`tests/walk-body-port-contract.test.ts:181-186` |
| 无挖/放/搭柱/材料 | 通过（库侧） | 身体端口只暴露 `move`/`stop`；move 请求无 `dig`/`place`/`tower`/`tool`/`material` 等键；结果 `consumption` 仅为 `{placed: []}`；无搜索/换路调用；`tests/walk-body-port-contract.test.ts:176-203` |

---

## 3. 阶段门禁 G3 结论

> 以下结论**仅覆盖库自带 `createWalkPathExecution` 绑定与 Fake 身体端口**。公共 `createWalkPath` 允许注入 `execute`；非 ARRIVED 结果会保留注入实现提供的 `consumption`/`memoryWrite` 字段（§7.4 模板允许字段存在，但 §7.5.7 要求 v1 `consumption` 为空），公共入口未做净化，因此不保证任意注入实现都满足 G3。

| 门禁要求 | 结论 | 证据 |
|---|---|---|
| `walkPath` 不搜索 | **通过（库自带绑定）** | `src/navigation/walk-path.ts` 只导入 `WalkRouteExecutor`，无 `WalkRouteSearch`/pathfinder/`navigateTo` 运行时导入；execution/invalidation/body-port 套件对 `WalkRouteSearch.advance` 断言 0 次；execution/invalidation 套件对 `WalkRouteExecutor.start` 断言一次（body-port 套件走实际单次执行绑定） |
| 不施工 | **通过（库自带绑定）** | 库自带执行绑定恒返回 `consumption: { placed: [] }`；`WalkBodyPort` 只有 `move`/`stop`；move 请求不含挖/放/搭柱/材料字段；无搜索或自动换路。公共注入 `execute` 的 `consumption`/`memoryWrite` 未净化，见本节范围说明 |
| 失效即停 | **通过（库自带绑定）** | 当前段证据失效 → 停止所属段、返回 `INVALIDATED` 并保留段索引/最后实测位置/已确认段数/剩余点；后续段失效不启动未复验段；无自动重试/救援；`tests/walk-path-invalidation.test.ts`、`tests/walk-path-execution.test.ts` |
| grounded 到达 | **通过（库自带绑定、Fake）** | `ARRIVED` 必须满足本执行身份、全段确认、剩余点为空、实测位置在 `bodyArrival` 容差内、`lastObservation` 同作用域且接地/干燥；零边路径还需两个有序稳定样本；测试覆盖差一点、Promise resolve、索引推进和旧回调等假到达 |

**G3 结论：仅在库自带绑定/Fake 范围通过。** 公共 `walkPath` 的注入执行器边界未验证；真实宿主是否按契约实现 `BodySample.sequence`/`observedAt`/`onGround` 与单步 `move`，属于 M7 真实联调（G6），本审计不据此声称已通过。

---

## 4. 限制、未验证与文档差异

- **真实环境未验证（H-01）**：未在真实 Minecraft Java 1.20.1 / mineflayer 上运行；本审计不能证明真实碰撞、物理 tick、感知延迟或控件边界下的 `ARRIVED`/`INVALIDATED`/取消行为。
- **证据来源为单测与 Fake**：`ARRIVED`、`INVALIDATED`、`TIMEOUT`、`CANCELLED` 的语义仅由 `tests/walk-path-*.test.ts` 与 Fake `WalkBodyPort` 证明；宿主若伪造 `observedAt`/`onGround`/`sequence`，库侧无法独立复核真实世界。
- **M5 未完成**：`./memory`/`./navigation` 子入口与 `MemoryHostCapabilities` 收口仍属 M5；当前能力报告 `execute.walk`/`groundedArrival`/`invalidation`/`cancellation` 仍为 `false`（`src/query/capabilities.ts:64-71`），宿主尚不能通过能力协商声明 M4 执行能力。
- **M6 未完成**：`ActionRecord`/`memoryWrite` 持久化钩子未实现；`WalkPathResult.memoryWrite` 在库自带绑定中从不赋值，`consumption` 仅 `{placed: []}`；M4 不产生可保存的执行记录。
- **契约 §15 状态表未同步**：契约仍将 `walkPath`/`WalkPathResult` 与 `INVALIDATED outcome` 标为“待实现”（`docs/memory-host-interface-contract.md:1301-1302`）；这是 M4 实现后遗留的文档状态，需 M5/M9 收口，不改变库内实现结论。
- **M4.1 验证 PARTIAL（D-027）**：M4.1 无专用类型导出/outcome 穷尽测试，穷尽性仅由 `tsc` 与人工核对；根入口将 walk-path 的 `ChangeReportSource` 别名导出为 `WalkPathChangeReportSource`（`src/index.ts:374-376`），与 memory 写端口的 `ChangeReportSource` 存在命名歧义，按 D-027/B03-M4-02 归 M5.1 入口测试/文档。M4.7 未修改 `tests/nav-result.test.ts`，因为 `NavOutcome` 未扩展；库无日志接口，计划中的“日志字段”没有对应实现点。
- **公共注入边界（G3 不覆盖）**：`createWalkPath` 的 `execute` 是注入钩子；库自带 `createWalkPathExecution` 恒返回空 `consumption`，但公共入口没有额外净化自定义 `execute` 返回的 `consumption`/`memoryWrite`，非 ARRIVED 结果会保留这些字段（字段存在符合 §7.4 模板，但 v1 §7.5.7 要求 `consumption` 为空，需宿主遵守）。公共边界只能复核 `lastPosition`/`lastObservation` 的可观测字段（作用域、接地、干燥、容差）；速度/`stableMs` 稳定条件由执行器保证。M4.8 契约测试覆盖的是库绑定与身体端口，不是任意自定义执行器。
- **能力边界**：M4 不提供挖/放/搭柱/材料、自动换路、自动重试、救援或水面/船执行；失败返回事实，是否重试/改路/放弃由 Agent 决定。不得把 M4 的 `walkPath` 描述为具备施工或救援能力。

---

## 5. 后续处理清单

- [ ] **M5.1/M5.4**：收口 `MemoryHostCapabilities` 与 `execute.*` 能力位；M5.1 入口测试/文档处理根入口 `ChangeReportSource`/`WalkPathChangeReportSource` 别名歧义（D-027）。在此之前宿主按 `false` 处理执行能力。
- [ ] **M6.2**：实现 `walkPath` 的 `ActionRecord`/`memoryWrite` 保存钩子，并补成功/失败/取消/失效记录测试。
- [ ] **M9**：同步契约 §15 的 `walkPath`/`INVALIDATED` 状态，决定 `memory-host-contract/1` 的版本归属。
- [ ] **M7/G6**：真实 Minecraft/mineflayer/Curio 联调；未通过前不得声称真实执行能力已验收。
- [ ] （可选）为 M4.1 补独立类型/outcome 用例；若宿主可注入自定义 `execute`，评估是否在公共边界净化非空 `consumption`/`memoryWrite`，并明确 G3 是否覆盖注入实现。

---

## 6. 参考

- [memory-host 实现计划](./memory-host-implementation-plan.md)
- [Agent/宿主接口契约](./memory-host-interface-contract.md)
- [M2 查询端口审计](./memory-host-m2-query-audit.md)
- [M3 规划端口审计](./memory-host-m3-route-plan-audit.md)
- [0.10.0 实现审计](./implementation-audit-0.10.0.md)
- [空间记忆库设计](./spatial-memory-library-design.md)
