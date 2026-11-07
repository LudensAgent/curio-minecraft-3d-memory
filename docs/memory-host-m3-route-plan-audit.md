# 空间记忆库 M3 规划端口审计（memory-host）

> 审计日期：2026-11-06
> 被审提交：`5b65ca1`（`feat(navigation): add read-only route planning with plan registry`）
> 分支：`integration/memory-host-20261106`
> 计划基线：[memory-host 实现计划](./memory-host-implementation-plan.md) §M3（提交 `960da25`）
> 契约基线：[Agent/宿主接口契约](./memory-host-interface-contract.md)（`5b65ca1` 更新后，仍为 `memory-host-contract/1`）
> 审计范围：M3.1–M3.7、阶段门禁 G2；本仓库源码、测试、文档
> 非审计范围：M4–M9、Curio 宿主源码、真实 Minecraft Java 1.20.1 / mineflayer 联机运行

> 审计方式：双轴代码审查（Standards / Spec 并行子代理，锚定 `git diff 5b65ca1^ 5b65ca1`）+ 人工核对源码、测试、调用链与验证命令；未只依据提交信息或类型声明下结论。两轴结论分别保留，不合并排序。

---

## 0. 结论

**M3 有条件通过。**

- M3.1–M3.7 的交付物均已存在：规划类型、`WalkRouteSearch` 适配、`source:'search'/'history'/'auto'`、`RoutePlanRegistry`、规划能力报告，且都从根入口和 `navigation` 子入口导出。
- 阶段门禁 **G2 通过**：`planRoute` 只读，不移动、不写地图/历史、不调用执行器；返回 `routeId`，`executable` 只对完整复验的 OPEN 路线为真。
- 未发现计划 §4.12 的阻断项；没有伪造 OPEN/ARRIVED/保存确认，没有静默回退 pathfinder，没有容器内容进入空间库。
- **Standards 轴**：0 个硬性违规；2 个边界判断、7 个可维护性气味（均为判断项，不参与阻断判断），详见 §2.1。
- **Spec 轴**：4 项发现：`maxNodes` 预算越界、`maxRoutePoints` 异常边界、timeout 缺回归测试、能力报告提前落到 M5.4；前两项已修复（A1/A2），后两项分别见 A4 与 M5.4/A8。
- 发现 **1 个中等正确性问题（双轴审查独立复现，已修复）**：请求的 `maxNodes` 在单个搜索切片内未被强制，搜索在该切片内 FOUND 时会返回可执行计划，即使实际到达节点数已超过请求预算（见 M3-A1）。
- 发现 **1 个中低问题（双轴审查独立复现，已修复）**：`environment.maxRoutePoints` 可以大于 `RouteVerifier` 的 `maxRouteLength`（默认 1024），长路线会让 `planRoute` 抛出普通异常而不是返回结构化预算错误（见 M3-A2）。
- 其余问题为边界校验、超时测试覆盖、能力报告批次归属和文档/提交卫生，不改变 M3 的主路径结论。
- 功能完成度估计：**约 90%–95%**。所有 M3 功能项都有公开入口、测试和契约状态更新；A1/A2 与提交卫生已修复，剩余缺口集中在超时测试覆盖与低风险边界（A3/A4）。
- 真实游戏/宿主联调未执行，属于 M7；本审计只能证明库内规划逻辑与 Fake 场景。

一句话：**M3 的主功能可交付、只读边界成立；`maxNodes` 预算越界与 `maxRoutePoints` 异常边界（A1/A2）已修复；进入 M4 前建议补 A3（快照作用域/目标交叉校验）与 A4（timeout 回归测试）。**

---

## 1. 验证记录

| 命令 | 结果 | 说明 |
|---|---|---|
| `npm run typecheck` | exit 0 | `pretypecheck` build + `tsc --noEmit` 通过 |
| `npm test` | vitest 退出码 1 | 57 个 suite：54 通过、3 个 `acceptance/*.test.mjs` 报 `No test suite found`（计划 §5.1 已记录的已知噪声）；**1126 个用例全部通过，0 个用例失败** |
| `node --test acceptance/provenance.test.mjs acceptance/run.test.mjs acceptance/consumer-close.test.mjs` | exit 0 | **32/32 通过** |
| `git show --check 5b65ca1` | exit 2 | `src/navigation/route-plan-support.ts` 文件末尾新增空行（M3-A5） |
| `git status --short` | — | 仅保留用户原有的 `docs/spatial-memory-library-design.md` 修改和未跟踪文件；被审提交未夹带这些改动 |

被审提交范围：20 个文件，+3578/−13。提交信息使用 Conventional Commits，无工具/模型署名或 `Co-Authored-By`。

---

## 2. 双轴代码审查结论

> 两轴使用独立子代理并行审查，锚定同一提交 `5b65ca1`；以下按轴分别保留，不合并、不跨轴重排。

### 2.1 Standards 轴

**文档化标准** — 未发现硬性违规。已核对：

- Conventional Commit `feat(navigation): ...`；无工具/模型署名；无冲突标记；契约 §12.6 与实现一致。
- 无 `any`/`ts-ignore`；`tsc --noEmit` 干净；route-plan 定向套件通过（292 个用例）。

**边界判断**

- `src/navigation/route-plan.ts:354-362` 在 `registry.register` 外使用 `try/catch`，把 `RoutePlanRegistryCapacityError` 转成结果。其他错误仍会重抛，没有吞错；但项目规范要求“尽量避免 `try/catch`”，仅在 I/O 或进程边界例外。
- `src/navigation/route-plan-support.ts` 抽取了单次调用的辅助函数（`searchGap`、`verdictOf`、`boundaryKindOf`、`firstDiagnostic`），与“不提前抽取单次使用的辅助函数”存在张力；可辩护为隔离映射边界。

**基线气味（均为判断项）**

1. **Data Clumps + Duplicated Code** — `HistoryPlanInput`（`route-plan-history.ts:39-50`）与 `PlanContext`（`route-plan.ts:71-82`）字段逐一重复，且同一 10 属性字面量在 `route-plan.ts:143-154` 与 `179-190` 重复两次。建议提取一个 builder/共享上下文类型。
2. **Duplicated Code** — 复验编排重复：`verifyRoutePoints({ verifier, scope, body, shapeProvider, points, now, deadlineMs, budget, wait, ... })` 的形状出现在 `route-plan.ts:316-328` 与 `route-plan-history.ts:136-148`，随后的 deadline/assemble 序列也重复。
3. **Duplicated Code / Data Clumps** — `{worldId, dim, sessionId}` 投影出现三次：`planScope`（`route-plan-support.ts:531-537`）、`routeScopeOf`（`route-plan-registry.ts:235-241`）、`cloneScope`（`243-245`）。
4. **Primitive Obsession** — `RouteBoundary.status` 与 `RoutePlan.verdict`（`route-plan-types.ts:66-67, 118`）重新声明了 `StepStatus`/traversability 联合类型（`src/traversability/step.ts:33`），存在漂移风险。
5. **Duplicated Code** — 能力表声明两次：`ROUTE_PLAN_CAPABILITIES`（`src/navigation/capabilities.ts`）与 `src/query/capabilities.ts:52-59` 中相同的 `plan:` 块；漂移保护测试承认了这份重复，建议复用导出的能力表。
6. **Speculative Generality** — `problemFromSearch` 处理 `'found'` 与 `'pending'`（`route-plan-support.ts:447-456`），两者在当前调用路径不可达（调用方已排除 `FOUND`，循环只处理 `PENDING`）；`'found'` 文案还与 `route-plan.ts:297-306` 的 candidate 空值检查重复。
7. **Divergent Change** — `route-plan-support.ts`（612 行）混合了起点校验、验证器编排、计划组装、问题映射、折线几何与克隆。

**本轴小结：** 7 项发现（0 个硬性违规、2 个边界判断、7 个气味）；本轴最重为 `HistoryPlanInput`/`PlanContext` 的数据团与调用点重复字面量。

### 2.2 Spec 轴

**（a）缺失或不完整**

1. **timeout 路径没有回归测试。** 计划 §4.9：“每个公开行为有正例 + 负例；失效/取消/超时/作用域/旧会话有测试。” `route-plan.ts:262-265` 与 `route-plan-support.ts:190-197` 都实现了规划中途超时，但 `tests/route-plan-search.test.ts:302-303` 只覆盖“deadline 已经过去”；没有测试在搜索或复验过程中推进时钟。

**（b）范围蔓延**

2. **能力报告改动超出 M3.7。** 计划 M3.7 只列出“修改文件：`src/navigation/capabilities.ts`、`tests/navigation-capabilities.test.ts`”，M5.4 才负责 `MemoryHostCapabilities`。本提交同时把 `src/query/capabilities.ts:54-57` 的 `plan.walkSearch/walkHistory/walkAuto` 翻为 `true` 并改写了 `tests/query-capabilities.test.ts`。该改动已记录在 §12.6，但它把 M5.4 的能力收口提前了。

**（c）看起来已实现但实现有误**

3. **请求的 `maxNodes` 没有成为搜索预算。** 契约 §6.2：“`maxNodes`/`maxEdges`……映射到 `WalkSearchLimits`”。规划器只在切片之间比较 `counters.nodesReached >= requestedMaxNodes`（`src/navigation/route-plan.ts:270-273`）；`advance(slice)` 只按 `maxEdges` 裁剪（`:275-283`），在该切片内到达的 `FOUND` 退出循环后不再复核（`:292-312`）。独立复现：3 格走廊、`{maxNodes: 2}`、`budgetPerSlice: 64`，`planRoute` 返回 `confidence:'verified'`、`executable:true`、3 个点的计划，超出声明的节点预算。现有测试只使用 `maxNodes: 1`，在第一次 `advance` 前就命中（`tests/route-plan-search.test.ts:227-240`）。

4. **`maxRoutePoints` 可以超过 `RouteVerifier.maxRouteLength`，产生抛出的 Error。** `route-plan.ts:576-580` 接受任意正整数；随后 `verifyRoutePoints` 调用 `verifier.register`（`route-plan-support.ts:163`），默认超过 1024 点即抛出（`src/traversability/route.ts:206-208`）。宿主设置 `maxRoutePoints: 2000`（或使用更小 `maxRouteLength` 的验证器）会得到原始异常，而不是 §4.7 要求的结构化 `problem`。历史计划同样只按 `maxRoutePoints` 检查大小（`route-plan-history.ts:111-120`）。

其余 M3.1–M3.7 与规格一致：实测起点、目标不取整、地图/历史只读、candidate 与 verified 分离、历史起点/终点分离、auto 回退、单次使用且 pin 的 TTL 句柄。

**本轴小结：** 4 项发现；本轴最重为 `maxNodes` 预算未被强制、却返回可执行计划。

---

## 3. M3 逐项结论

| 任务 | 状态 | 证据与说明 |
|---|---|---|
| M3.1 定义规划类型 | 完成 | `src/navigation/route-plan-types.ts`；`RoutePlanRequest`/`RoutePlan`/`RoutePlanSegment`/`RouteBoundary`/`RouteUnsupported`/`RouteEvidence`/`RoutePlanResult`/`RoutePlanSource` 与契约 §6.2/§6.4 一致；未知请求字段、未知 arrival/constraint 字段在 `src/navigation/route-plan.ts:371-557` 拒绝。契约 §6.4 的 `RouteSegment` 实现名为 `RoutePlanSegment`，已在 §12.6 记录（命名问题见 M3-A6） |
| M3.2 搜索源适配 | 完成 | `src/navigation/route-search.ts`；`start/advance/snapshot/cancel` 直接委托 `WalkRouteSearch`，不复制搜索状态；`concludeWalkSearch` 对 8 个状态做显式映射；`tests/route-search.test.ts` 覆盖委托、取消、全状态映射、只快照不推进 |
| M3.3 `source:'search'` 规划 | 完成 | `src/navigation/route-plan.ts` 的 `planWithSearch`；起点来自 `environment.sample()` 实测样本（`route-plan-support.ts:62-126`），目标原样传入；FOUND 后统一通过专用 `RouteVerifier` 复验，`verified` 仅在全段 OPEN、起点/目标匹配、证据未过期时为真；`NO_VERIFIED_PATH`/`INSUFFICIENT_EVIDENCE`/`UNSUPPORTED`/`BUDGET_EXHAUSTED`/取消/失效分别映射为结构化问题。`maxNodes`/`maxEdges` 在切片内钳制并在接受 FOUND 前复核（M3-A1 已修复） |
| M3.4 `source:'history'` 规划 | 完成 | `src/navigation/route-plan-history.ts`；只读 `getFragment`，不更新 `uses`/`lastUsedAt`/revision；当前阻塞保留几何并返回 candidate 边界；`requestedTarget`/`resolvedTarget` 分开；不调用 `startKnownWalkRoute`/执行器。测试覆盖不存在 pathId、跨维/跨世界、非法几何、近单位步、当前阻塞、端点略近、起点不符、单点历史、搜索预算拒绝 |
| M3.5 `source:'auto'` | 完成 | `src/navigation/route-plan.ts` 的 `planAuto`；有 `pathId` 时 history 优先，候选/失败回退 search，取消/超时不回退；无 `pathId` 直接 search；`RoutePlan.source` 报告实际来源；测试覆盖成功、阻塞回退、端点略近回退、无 pathId、无历史不写成无路、取消不启动搜索 |
| M3.6 `RoutePlanRegistry` | 完成 | `src/navigation/route-plan-registry.ts`；`register(draft)` 发号并返回副本；`consume` 首次调用即消费，过期/作用域/不可执行分别返回；成功消费即 pin，`release` 后仍保持已消费；容量默认 128、TTL 默认 30 s，淘汰优先 tombstone、绝不淘汰 pinned；不持久化、不接受宿主自造 id。测试覆盖单次消费、并发重复消费、作用域、过期、容量、pin、release |
| M3.7 规划能力报告 | 完成 | `src/navigation/capabilities.ts:238-270`、`src/query/capabilities.ts:52-60`；`ROUTE_PLAN_CAPABILITIES` 与 `MemoryHostCapabilities.plan.walkSearch/walkHistory/walkAuto` 为 true，其余规划位保持 false；`planRoute` 对 swim/near/reach_block/avoid 返回结构化 unsupported；测试覆盖能力表与拒绝路径 |
| G2 规划可审 | 通过 | `src/navigation/route-plan*.ts` 无 `navigateTo`/`MoveExecutor`/`WalkRouteExecutor` 运行时导入；规划后地图的 `saveRevision`/pin/residency/dirty 与历史 revision/`uses`/`lastUsedAt` 不变（`tests/route-plan-fixtures.ts:233-247`、搜索与历史只读断言）；`routeId` 只由注册表发出 |

---

## 4. 待处理问题

### 4.1 正确性与规格问题

### M3-A1｜请求的 `maxNodes` 在搜索切片内未被强制，超出预算仍可能返回可执行计划

- **严重度**：中
- **状态**：已修复（2026-11-07）
- **修复**：`planWithSearch` 的每个切片同时按剩余 `maxNodes`/`maxEdges` 裁剪；循环结束后、接受 `FOUND` 前复核 `nodesReached`/`edgesEvaluated`，超限返回 `budget_exhausted` 且不注册计划。新增切片内超预算、长走廊、精确预算边界与 maxEdges 边界回归测试。
- **证据**：
  - 契约要求 `maxNodes`/`maxEdges` “映射到 `WalkSearchLimits`”：`docs/memory-host-interface-contract.md:587-592`、`607`。
  - 实现只在每次 `advance()` **之前**检查 `snapshot.counters.nodesReached >= requestedMaxNodes`：`src/navigation/route-plan.ts:266-273`；`advance` 的切片只按 `maxEdges` 余量裁剪，不按节点余量裁剪：`src/navigation/route-plan.ts:275-283`。
  - 如果搜索在这个切片内直接进入 `FOUND`，循环退出后不再复核 `requestedMaxNodes`，直接接受 candidate 并复验：`src/navigation/route-plan.ts:292-349`。
  - 现有测试只覆盖 `maxNodes: 1`（首个切片前就命中）：`tests/route-plan-search.test.ts:227-240`。
- **复现**：双轴 Spec 子代理独立复现——3 格走廊、`{maxNodes: 2}`、`budgetPerSlice: 64`，返回 `confidence:'verified'`、`executable:true`、3 个点的计划。人工探针同样复现——11 格走廊、`budgetPerSlice: 256`、`maxNodes: 2`，返回 11 点计划。两次均未返回 `budget_exhausted`。
- **影响**：Agent 的搜索预算是委托约束；返回超出预算的计划会破坏“预算贯穿规划/执行”的语义。虽然计划本身经过当前证据复验，但搜索已经消耗了远超请求的资源。
- **处理建议**：
  1. 在 `advance()` 返回后、接受 `FOUND` 前复核节点计数：若本次切片导致 `nodesReached > requestedMaxNodes`，返回 `budget_exhausted(limit:'nodes')`，不注册计划；
  2. 或把请求预算真正映射到搜索实例的 `WalkSearchLimits`（需要搜索源支持按请求配置，当前适配器共享实例，可能涉及接口扩展）；
  3. 补测试：小 `maxNodes` + 大 `budgetPerSlice` + 目标在切片内可达，断言不返回计划且 `registry.size` 不变。
- **验收标准**：任何返回的 `RoutePlan` 都不对应超出请求 `maxNodes`/`maxEdges` 的搜索；回归测试覆盖切片内 FOUND 的越界场景。

### M3-A2｜`maxRoutePoints` 未与 `RouteVerifier` 的点数上限对齐，长路线会抛异常

- **严重度**：中低
- **状态**：已修复（2026-11-07）
- **修复**：`RouteVerifier.maxRouteLength` 改为公开只读；`resolveConfig` 校验宿主上限，显式 `maxRoutePoints` 超过验证器上限返回 `invalid_request`，默认取 `min(1024, maxRouteLength)`；`verifyRoutePoints` 在 `register` 前再检查点数并返回 `budget_exhausted(limit:'points')`。搜索与历史共用该配置校验，并补低上限、长路线、精确边界测试。
- **证据**：
  - `environment.maxRoutePoints` 只校验为正整数，没有上限：`src/navigation/route-plan.ts:576-580`；默认 1024：`src/navigation/route-plan-support.ts:45`。
  - 搜索结果与历史结果都直接交给 `verifyRoutePoints`，后者调用 `verifier.register`：`src/navigation/route-plan-support.ts:161-171`；历史路径同样先只按 `maxRoutePoints` 检查：`src/navigation/route-plan-history.ts:111-120`。
  - `RouteVerifier.register` 对超过默认 `maxRouteLength`（1024）的路线直接抛错：`src/traversability/route.ts:126`、`206-208`。
- **复现**：直线走廊 1100 格、目标 `x=1099.5`、`environment.maxRoutePoints: 2000`。`planRoute` 抛出 `route has 1100 points, exceeding the limit of 1024`，而不是返回结构化 `budget_exhausted`/`invalid_request`。双轴 Spec 子代理独立确认；宿主给验证器配置更小的 `maxRouteLength` 也会触发。
- **影响**：宿主配置 `maxRoutePoints > 1024` 时，规划边界会把异常抛到控制循环，违反“失败提供结构化原因”的契约；长路线场景才会触发，概率不高但属于可复现边界。
- **处理建议**：
  1. 在环境配置校验中把 `maxRoutePoints` 限制到与验证器一致的上限（提取共享常量或让验证器暴露上限），超限返回 `invalid_request`；
  2. 或捕获 `register` 的点数上限错误并映射为 `budget_exhausted(limit:'points')`；
  3. 搜索与历史两条路径共用同一上限校验，补长路线回归测试。
- **验收标准**：任何 `maxRoutePoints` 配置下，`planRoute` 都不因点数上限抛出未结构化异常；超限有明确 `problem` 且 `registry.size` 不变。

### M3-A3｜搜索结果快照的作用域/目标未与规划环境交叉校验

- **严重度**：低
- **状态**：待补强
- **证据**：
  - `WalkSearchSnapshot` 携带 `worldId/dim/sessionId/mode/body/from/target/arrival/ruleVersion`：`src/navigation/walk-search.ts:229-240`。
  - `planWithSearch` 只使用 `state/candidate/counters/limits`：`src/navigation/route-plan.ts:233-312`；没有比较快照的 world/dim/session/mode、起点 `from` 或目标 `target` 与 `RoutePlanEnvironment`/`RoutePlanRequest` 是否一致，最终计划的 `evidence` 一律使用环境作用域：`src/navigation/route-plan-support.ts:340-349`。
  - `RouteSearchSource` 是公开注入接口，宿主可实现自定义适配器；当前只有测试用 `replaySearchSource` 覆盖“回放快照”，没有作用域不一致用例：`tests/route-plan-fixtures.ts:174-185`。
- **影响**：正常使用 `createWalkRouteSearchSource` 时，`start` 会拒绝 worldId 不匹配，dim/session 来自同一环境，风险有限。但自定义搜索源或被误接的搜索实例可能把另一作用域/目标的 candidate 带入，计划仍会以当前环境作用域标记证据。复验通常能拦住不可执行结果，但错误仍然会被描述成当前作用域的规划结论。
- **处理建议**：在 `start()` 后与 `FOUND` 前校验 `snapshot.worldId/dim/sessionId/mode` 与环境和请求一致，不一致返回 `scope_changed`/`invalid_request`；同时校验 `candidate.target` 与 `request.to`（或明确记录“以 `reachedAt` 与请求目标比较”这一行为）。补一个作用域不一致的 replay-source 测试。
- **验收标准**：跨作用域/跨目标的搜索快照不会生成带当前作用域 `evidence` 的计划；有负例测试。

### M3-A4｜规划中途的 deadline/timeout 路径缺少回归测试

- **严重度**：低（测试覆盖）
- **状态**：待补测试
- **证据**：
  - 搜索规划在循环中检查 `context.now() >= context.deadlineMs`：`src/navigation/route-plan.ts:262-265`、`287-290`；验证器循环同样检查：`src/navigation/route-plan-support.ts:190-197`。
  - 现有测试只覆盖“deadline 已过期”的请求边界：`tests/route-plan-search.test.ts:297-311`；没有测试规划进行中时间推进导致 `timeout`，也没有分别覆盖搜索阶段与复验阶段的超时。
- **影响**：timeout 分支目前靠代码审查通过，缺少回归保护；后续 M4 会依赖“规划超时不是无路”的语义。双轴 Spec 子代理独立确认该覆盖缺口。
- **处理建议**：用可控 `TestClock` 在 `wait()` 中推进时间，分别覆盖搜索切片超时和 `RouteVerifier` 复验超时；断言返回 `{kind:'timeout'}`、不注册计划、地图/历史状态不变。
- **验收标准**：两个阶段的超时都有会失败的回归用例。

### M3-A5｜提交卫生：文件末尾多余空行

- **严重度**：低（提交卫生）
- **状态**：已修复（2026-11-07）
- **证据**：`git show --check 5b65ca1` exit 2，报告 `src/navigation/route-plan-support.ts:612: new blank line at EOF.`。文件以空行结束。
- **影响**：不影响运行；但会持续让 `git show --check` 失败，降低后续提交检查的信噪比。
- **处理建议**：删除末尾多余空行；后续提交前运行 `git show --check`。
- **验收标准**：`git show --check` 对修复提交 exit 0。

### M3-A6｜契约类型命名与版本收口（挂 M9）

- **严重度**：低（文档/发布门禁）
- **状态**：挂 M9
- **证据**：
  - 契约 §6.4 定义 `RouteSegment`（`docs/memory-host-interface-contract.md:674`、`690`）；实现导出 `RoutePlanSegment`（`src/navigation/route-plan-types.ts:53-59`），因为根入口已存在 topology 的 `RouteSegment`（`src/index.ts:220`）。§12.6 已解释映射（`docs/memory-host-interface-contract.md:1156`），但 §6.4/§15 的读者仍可能直接引用错误的类型名。
  - M3 新增 `budget_exhausted.limit: 'points'`、`RoutePlanResult.message`、必选 `RoutePlanEnvironment.verifier`/`registry` 等接口变化，契约仍为 `memory-host-contract/1` 并依赖能力协商（`docs/memory-host-interface-contract.md:1152`）。
- **影响**：类型导入与版本协商在 M9 前仍可能产生宿主误解；这与 M2-A3 是同一类发布门禁问题，M3 又扩大了变更面。
- **处理建议**：在 §6.4 类型处加一行“实现名为 `RoutePlanSegment`”；M9 统一决定 minor/major 并同步宿主；在此之前保留能力协商要求。
- **验收标准**：契约命名与导出可一一核对；M9 版本决策记录与能力报告一致。

### M3-A7｜请求边界的两处宽松行为（可选）

- **严重度**：低（可选）
- **状态**：已解决（D-009，2026-11-07；仅文档）
- **决议**：保留严格请求边界（D-009），并在契约 §6.2 按当前运行时记录两处语义：
  1. 未知字段 MUST 拒绝（`invalid_request`）的规则不变，适用于请求顶层对象及 `arrival`/`constraints` 对象本身；`pathId` 只由 `history`（必需）与 `auto`（可选）消费，`source:'search'` 不消费且提供它无效果——运行时只校验其为非空字符串，不因 `search` 拒绝或应用，文档明确宿主不得依赖；
  2. `to`/`avoid` 点只读取有限的 `x`/`y`/`z`，运行时**不拒绝**点对象上的额外键，文档声明宿主类型检查是这一层的边界。
  本次仅更新契约 §6.2 与本审计，未改运行时行为，也未新增生产者或校验。
- **证据**：
  - `source:'search'` 时提供 `pathId` 会被接受并静默忽略：`src/navigation/route-plan.ts:449-458`、`209-394`；契约只规定 history/auto 使用 `pathId`。
  - 未知字段在请求顶层（`src/navigation/route-plan.ts:420-422`）、`arrival`（`:508-510`）与 `constraints`（`:551-553`）对象上都会被拒绝；`to`（`:424`）与 `avoid`（`:555-571`）只校验有限 `x`/`y`/`z`，其点对象上的额外属性（如 `{x,y,z,w}`）通过 `isFinitePoint`（`src/navigation/route-plan-support.ts:553-561`）后被接受。
- **影响（已由 D-009 收口）**：不会造成错误路线。严格顶层/`arrival`/`constraints` 字段拒绝的规则保持不变；`source:'search'` 下的 `pathId` 只做非空字符串校验、不被消费也无效果，`to`/`avoid` 点对象的额外键被忽略。这两点已作为 D-009 的决定写入契约 §6.2，并明确宿主不得依赖 `pathId` 在 `search` 下生效、嵌套点对象键由宿主类型检查负责；文档未声称运行时新增这些校验。
- **处理建议**：无。D-009 已决定保留严格边界并如实记录上述两处宽容语义；本次仅改文档，不新增运行时校验。
- **验收标准**：计划、契约、实现三者对这两个输入语义一致（D-009；L-M3-02 已同步契约 §6.2 与本审计）。

### M3-A8｜能力报告改动提前落到 M5.4（范围蔓延）

- **严重度**：低（批次归属/流程）
- **状态**：已接受（D-010，2026-11-07；仅文档）
- **决议**：接受 M3 提前落地的能力位为“已实现能力的提前静态报告”（D-010），不视为范围蔓延阻断项；当前值与实现一致。M5.4 负责把 `ROUTE_PLAN_CAPABILITIES` 与 `MemoryHostCapabilities.plan` 收敛为单一来源，并记录这些能力位的批次归属（M3 提前落地、M5.4 收口）。本次仅更新本审计，未改运行时行为，也未新增能力生产者或校验。
- **证据**：
  - 计划 M3.7 的修改文件只列 `src/navigation/capabilities.ts`、`tests/navigation-capabilities.test.ts`；`MemoryHostCapabilities` 归 M5.4（`docs/memory-host-implementation-plan.md:384-390`、`497-503`）。
  - 被审提交同时把 `src/query/capabilities.ts:54-57` 的 `plan.walkSearch/walkHistory/walkAuto` 改为 `true`，并改写 `tests/query-capabilities.test.ts`：`git diff 5b65ca1^ 5b65ca1 -- src/query/capabilities.ts`。
  - 该变更已在本提交新增的契约 §12.6 中记录（`docs/memory-host-interface-contract.md:1154-1164`）。
- **影响**：M3 批次提前落地了 M5.4 的静态能力事实。当前值与实现一致，风险可控；但 M5.4 若调整能力协商口径，可能出现 `ROUTE_PLAN_CAPABILITIES` 与 `MemoryHostCapabilities.plan` 两处真相。
- **处理建议**：无额外动作。D-010 已接受该提前静态报告；M5.4 只需合并核对 `ROUTE_PLAN_CAPABILITIES` 与 `MemoryHostCapabilities.plan`（配合 §4.2 第 5 项收敛为单一来源），并记录批次归属。不回退能力位。
- **验收标准**：M5.4 记录能力位的批次归属；测试断言两份能力报告来自同一来源。

### 4.2 Standards 轴（判断项）

> 以下来自 §2.1，均为判断项，**不与 §4.1 的正确性问题合并排序，也不作为阻断项**。建议在 M4 前后择机处理；优先处理第 1、2 项。

1. **Data Clumps + Duplicated Code**：`HistoryPlanInput`（`src/navigation/route-plan-history.ts:39-50`）与 `PlanContext`（`src/navigation/route-plan.ts:71-82`）字段重复；同一 10 属性字面量在 `route-plan.ts:143-154`、`179-190` 重复。建议提取共享上下文/builder。
2. **Duplicated Code**：复验编排及随后的 deadline/assemble 序列在 `route-plan.ts:316-328` 与 `route-plan-history.ts:136-148` 重复。建议提取一个内部 `buildVerifiedPlan` 边界。
3. **Duplicated Code / Data Clumps**：`{worldId, dim, sessionId}` 投影在 `route-plan-support.ts:531-537`、`route-plan-registry.ts:235-245` 出现三次。建议复用同一个 scope 构造器。
4. **Primitive Obsession**：`RouteBoundary.status`/`RoutePlan.verdict`（`route-plan-types.ts:66-67, 118`）重新声明 `StepStatus`/`route` 状态联合，存在与 `src/traversability/step.ts:33` 漂移的风险。建议引用既有类型或派生。
5. **Duplicated Code**：`ROUTE_PLAN_CAPABILITIES`（`src/navigation/capabilities.ts`）与 `src/query/capabilities.ts:52-59` 的 `plan:` 块重复。建议由导航层导出唯一表，能力报告引用它。
6. **Speculative Generality**：`problemFromSearch` 的 `'found'`/`'pending'` 分支（`route-plan-support.ts:447-456`）在当前调用路径不可达。建议删除或改为断言。
7. **Divergent Change**：`route-plan-support.ts`（612 行）混合起点校验、验证器编排、计划组装、问题映射、折线几何与克隆。若 M4 继续加逻辑，建议按“校验/验证/组装”拆分。

**边界判断**：`registry.register` 外层的 `try/catch`（`route-plan.ts:354-362`）只为映射容量错误，其他错误会重抛；单次辅助函数抽取（`route-plan-support.ts`）与项目规范存在张力。两者都可保留，但建议在注释中说明边界理由。

---

## 5. 已通过项

- **只读边界**：`src/navigation/route-plan*.ts`、`route-search.ts` 无执行器/`navigateTo`/身体端口的运行时导入；规划后地图 revision、pin、residency、dirty 与历史 revision、`uses`、`lastUsedAt` 不变；测试直接比较前后快照。
- **实测起点**：起点只来自 `BodySample`；`null`、非有限值、world/dim/session 不匹配、未连接/未存活/未就绪、非法身体尺寸均返回结构化问题，绝不用请求目标当起点。
- **目标保真**：`request.to` 原样传入搜索；不取整、不替换、不改高度；不支持的目标几何返回 `unsupported_geometry`。
- **复验与置信度**：FOUND 后统一用专用 `RouteVerifier` 复验；`confidence:'verified'`/`executable:true` 只在全段 OPEN、起点/目标匹配、证据未过期时成立；candidate 的 `executable` 恒为 false，注册表消费返回 `route_not_executable`。
- **边界与错误分类**：BLOCKED/STALE/UNKNOWN/UNSUPPORTED 保留为 `boundaries`；`no_path` 的 message 明确“不证明世界不可达”；未知证据、预算、模式、到达方式、约束、作用域分别表达，不折叠成“没路”。
- **历史只读**：显式 `pathId` 才读取；不调用 `startKnownWalkRoute`；不更新 fragment 使用记录；当前阻塞保留历史几何；请求目标与历史终点分开；跨维/跨世界拒绝。
- **auto 来源如实**：history 优先、失败回退 search、取消/超时不回退、无 pathId 直接 search；计划 `source` 报告实际后端，不写“无历史=无路”。
- **注册表**：发号由注册表完成，宿主自造 id 返回 `route_not_found`；单次消费；过期/作用域/不可执行分别返回；pin 期间不淘汰；无持久化、无跨进程恢复。
- **能力报告**：walkSearch/walkHistory/walkAuto 为 true，near/reachBlock/digPlace/swim/boat 为 false；未实现能力不会静默回退到更宽后端。
- **提交隔离**：未覆盖用户未提交的 `docs/spatial-memory-library-design.md`；未夹带无关文件；无工具/模型署名。

---

## 6. 后续处理清单

- [x] **M3-A1**：修复 `maxNodes` 切片内越界；补“切片内 FOUND 超预算”回归测试。建议在 M4 开始前完成。
- [x] **M3-A2**：对齐 `maxRoutePoints` 与 `RouteVerifier.maxRouteLength`；超限返回结构化问题。建议在 M4 开始前完成。
- [ ] **M3-A3**：校验搜索快照的作用域/目标；补 replay-source 负例。
- [ ] **M3-A4**：补搜索阶段与复验阶段的 deadline/timeout 回归测试。
- [x] **M3-A5**：删除 `src/navigation/route-plan-support.ts` 文件末尾空行。
- [ ] **M3-A6**：在契约 §6.4 标注 `RoutePlanSegment` 实现名；M9 统一决定契约版本并与 M2-A3 合并处理。
- [x] **M3-A7**（可选）：由 D-009 解决（L-M3-02）。保留严格顶层字段拒绝；契约 §6.2 记录 `pathId` 仅 history/auto 消费、search 忽略且无效果，以及 `to`/`avoid` 只读 `x`/`y`/`z`、嵌套额外键由宿主类型检查。仅文档，未改运行时。
- [x] **M3-A8**：由 D-010 接受（L-M3-02）。M3 提前落地的能力位视为已实现能力的提前静态报告；M5.4 收敛 `ROUTE_PLAN_CAPABILITIES` 与 `MemoryHostCapabilities.plan` 的单一来源并记录批次归属。
- [ ] **M3-S1–S7**（可选，判断项）：按 §4.2 逐项评估，优先第 1、2 项（上下文数据团、复验编排重复）；不阻断 M4。

---

## 7. 未执行项

- `walkPath(routeId)` 的消费、执行、失效与 grounded 到达（M4）；本审计不证明 routeId 到执行的完整链路。
- `./memory`、`./navigation` 包子入口拆分、独立安装与类型声明消费验证（M5/M9）。
- `npm pack`、独立消费者安装（M9）。
- SQLite 持久化、重启恢复、迁移门禁（M6）。
- 真实 Minecraft Java 1.20.1 / mineflayer / Curio 联机验收（M7）；Fake/单测通过不代表真实感知、碰撞规则与控制边界通过。
- 性能基准（M8）；本批未新增基准或未测优化。

---

## 8. 参考

- [memory-host 实现计划](./memory-host-implementation-plan.md)
- [Agent/宿主接口契约](./memory-host-interface-contract.md)
- [M2 查询端口审计](./memory-host-m2-query-audit.md)
- [0.10.0 实现审计](./implementation-audit-0.10.0.md)
- [空间记忆库设计](./spatial-memory-library-design.md)
