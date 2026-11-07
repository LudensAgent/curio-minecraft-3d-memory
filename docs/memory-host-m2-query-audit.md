# 空间记忆库 M2 查询端口审计（memory-host）

> 审计日期：2026-11-06
> 被审提交：`5ec1c0d`（`feat(query): add read-only spatial query port`）
> 分支：`integration/memory-host-20261106`
> 计划基线：[memory-host 实现计划](./memory-host-implementation-plan.md) §M2（提交 `960da25`）
> 契约基线：[Agent/宿主接口契约](./memory-host-interface-contract.md)（`5ec1c0d` 更新后）
> 审计范围：M2.1–M2.6、阶段门禁 G1；本仓库源码、测试、文档
> 非审计范围：M3–M9、Curio 宿主源码、真实 Minecraft Java 1.20.1 / mineflayer 联机运行
> 复核（2026-11-07，L-M2-04）：基于 `d40b94a`（`integration/memory-host-20261107`）逐项复检；下列状态与证据以该基线为准，已合入的 L-M2-01/02/03a/03b/03c 一并计入。

> 用户提到的提交 `45ec1c0d` 在本仓库不存在；经 `git rev-parse`、`git log --all` 核对后，按上下文审查实际存在的 M2 提交 `5ec1c0d`。

---

## 0. 结论

**M2 有条件通过（2026-11-07 复核：实现、测试与只读边界已收口；D-001 已按保守策略记录，最终人工复核项保留）。**

- M2.1、M2.2、M2.3、M2.4、M2.6 完成；阶段门禁 G1 通过。
- M2.5 的核心查询（资源/容器位置、`host_ledger` 边界）可用；“可达证据”按 D-001 接受降级为“M2 不计算可达性”，计划 M2.5 已同步（`f9b827b`）；D-001 后续跟踪项于 L-M2-03d 记录（`docs/memory-host-implementation-plan.md:302`），最终人工复核项保留。
- 前序批次已修复：M2-A2（`3ae4fd8`）、M2-A5 / M2-L1（`f09b92e`）、M2-L3（`4321fda`）、M2-L5（`883fe22`；契约 §5.2 的 `nodeId` 文档同步仍挂 L-M2-03d/M9）。
- 仍未收口：M2-A3（D-003，目标 M9）、M2-A4 的 M8 性能基准（文档落点已在 L-M2-03d 完成）。
- 未发现计划 §4.12 的阻断项；真实联机/宿主验收未执行，属于 M7，本文件不据此声称已通过。

一句话：**查询端口可交付，测试与只读边界成立；剩余问题为 D-001 人工复核、契约版本收口（M9）、`portals` 的 M8 基准（文档已落契约 §5.6），不是查询实现缺陷。**

---

## 1. 验证记录

| 命令 | 结果 | 说明 |
|---|---|---|
| `npm run typecheck` | exit 0 | `pretypecheck` build + `tsc --noEmit` 通过 |
| `npm test` | exit 1 | 48 个 suite / **1068 个用例通过**；3 个 `acceptance/*.test.mjs` 报 `No test suite found`，属计划 §5.1 已记录的已知噪声 |
| `node --test acceptance/provenance.test.mjs acceptance/run.test.mjs acceptance/consumer-close.test.mjs` | exit 0 | **32/32 通过** |
| `git show --check 5ec1c0d` | exit 0 | 无空白/格式错误 |
| `git status --short` | — | 仅保留用户原有的 `docs/spatial-memory-library-design.md` 修改和未跟踪文件；被审提交未夹带 |

被审提交范围：26 个文件，+3741/−17。提交信息使用 Conventional Commits，无工具/模型署名或 `Co-Authored-By`。

### 1.1 2026-11-07 复核（`d40b94a`，L-M2-04）

| 命令 | 结果 | 说明 |
|---|---|---|
| `npm run typecheck` | exit 0 | `pretypecheck` build + `tsc --noEmit` 通过 |
| `npx vitest run tests/query` | exit 0 | **6 个文件 / 82 个用例通过**（含本次新增的 M2-A6 过滤拒绝用例） |
| `npm test` | exit 1 | 61 个 suite：58 passed / 3 failed；**1238/1238 个用例通过**；3 个 failed 均为 `acceptance/*.test.mjs` 的 `No test suite found`（已知噪声） |

本次收口仅改 `docs/memory-host-m2-query-audit.md` 与 `tests/query-port.test.ts`（新增 M2-A6 回归）；未改 `src/**`、契约或实现计划。

---

## 2. M2 逐项结论

| 任务 | 状态 | 证据与说明 |
|---|---|---|
| M2.1 定义 `SpatialQueryPort` 类型 | 完成 | `src/query/types.ts`、`src/query/index.ts`；`SpatialQueryRequest`/`SpatialQueryResult`/`SpatialQueryData`/`CellQueryView`/`SpatialQueryProblem` 与契约 §5 一致；未知 kind/字段由 `src/query/validate.ts` 拒绝 |
| M2.2 `cells` 查询 | 完成 | `src/query/cells.ts`；已观察/未观察/未驻留区分；`not_resident`/`loading`/`load_failed` → `gap.reason:'unloaded'` + `status:'partial'`；未观察格另带可选 `residency`/`unobservedReason`，五态可区分（D-002，`3ae4fd8`）；负坐标、副本隔离、不加载 Section、五态区分有测试。历史 `ObservationGap` 未持久化，契约 §15 已标为部分实现 |
| M2.3 碎片/traversal/nodes/edges 分页 | 完成 | `src/query/topology.ts`、`src/query/paging.ts`；默认 100、上限 1000、合并底层 100 条页、稳定 `after`、`total` 为完整匹配数；250 条跨页与末页无重复测试通过 |
| M2.4 历史路线/锚点/分量/portal | 完成 | `src/query/history.ts`；`historyRoute` 带 `historicalGeometry:true`/`executable:false`/`currentPassability:'UNKNOWN'`；未知 fragment 返回 `not_found`；`anchor` 为 `null` 时保持 `ok`；portal 与 walk graph 独立 |
| M2.5 资源/容器位置查询 | **完成（范围按 D-001/D-006 收窄；D-001 已接受降级，待人工复核）** | `src/query/anchors.ts` 支持 `dim/tag/label`、只返回 exact 节点、`containerAnchors` 需宿主 `isContainer`、`containerContents` 固定 `host_ledger`；“可达证据”按 D-001 明确不在 M2；“按位置”按 D-006 只返回位置字段、不做邻域过滤，`near`/`radius`/`pos` 由 validator 拒绝（回归见 M2-A6） |
| M2.6 能力报告与边界 | 完成 | `src/memory/capabilities.ts`、`src/query/capabilities.ts`；memory/query 按实际能力，plan/execute/persistence 保守为 `false`；`containerContents` 恒为 `false`；无分类器时 `containerAnchors` 返回 `unsupported` |
| G1 契约冻结 | 通过 | 类型、运行时校验、契约 §5/§15 与测试一致；新增项已记录在契约 §12.5 |

---

## 3. 问题状态（含已修复项）

### M2-A1｜M2.5 的“可达证据”被契约降级

- **严重度**：中
- **状态**：已决策（D-001：接受降级；`requires_user_review: true`，待人工复核）
- **证据**：
  - 计划 M2.5 已改为“可达证据不在 M2 范围；宿主结合路由/感知自行判断可达”：`docs/memory-host-implementation-plan.md:297`（决策落文档 `f9b827b`）。
  - 计划 M2.5 已在审计证据行记录 D-001 后续跟踪（`requires_user_review: true`，待人工复核）：`docs/memory-host-implementation-plan.md:302`（宿主结合自身路由/感知证据判断可达；未来库侧只读可达性投影须另走契约变更并同步字段/测试/能力位）。
  - 契约 §1.2、§5.4、§5.5 一致写明“M2 查询不计算新的可达性”：`docs/memory-host-interface-contract.md:55`、`:511`、`:519`。
  - 代码只返回原始 `SpatialNode`（位置、精度、观测时间、来源）：`src/query/anchors.ts:49-66`。
- **影响**：宿主无法从查询直接获得资源/容器锚点的可达关系，必须自行结合路由/感知证据判断。该方向与“位置记录不能推断可达”一致，但它是实现批次内对既有契约基线的范围缩减。
- **后续**：最终人工复核 D-001；决策落点已写入计划 M2.5（范围 + 后续跟踪项）并与契约一致。若人工复核后需要库侧只读可达性投影，另走契约变更并同步字段/测试/能力位，不直接扩展 M2。
- **验收标准**：计划、契约与代码对 M2.5 范围表述一致；若补实现，有正例/负例测试且能力报告同步。

### M2-A2｜§15 对 `cells` 状态区分过度声称

- **严重度**：低（文档）
- **状态**：已修复（D-002；`3ae4fd8`，L-M2-02）
- **证据**：
  - `CellQueryView` 新增可选 `residency`（`SectionResidency`）与 `unobservedReason: 'no_record' | 'resident'`：`src/query/types.ts:126-137`；`src/query/cells.ts:60-78` 对五态分别填充，同时保持 `not_resident`/`loading`/`load_failed` → `gap.reason:'unloaded'` + `status:'partial'`。
  - 测试覆盖 `no_record` vs resident-unobserved，以及 `not_resident`/`loading`/`load_failed` 共用 `unloaded` gap 但 `residency` 不同：`tests/query-cells.test.ts:179-241`、`:322-360`；另确认未观察查询不分配 Section：`:205`。
  - 契约 §5.4 与 §15 已同步为“默认三类 + 可选字段细分五态”：`docs/memory-host-interface-contract.md:501`、`:1294`。
- **残留**：契约 §5.3 的 `CellQueryView` 形状块尚未加入新字段、全文未单列 `SectionResidency` 五值联合；按 D-026/B03-M2-03 延期到 L-M2-03d/M9。
- **验收标准**：§15、§5.4 与测试三处语义一致——已满足；§5.3 形状块同步仍待文档任务。

### M2-A3｜契约新增枚举值但未升级版本

- **严重度**：低（流程/发布门禁）
- **状态**：延期（D-003，目标 M9）
- **证据**：
  - 本批新增 `not_found` 状态、`segments`/`containerContents` kind、`query.segments`/`query.resourceAnchors` 能力位。
  - 契约 §12.3 规定“新增枚举值/改变语义/收窄必填 = major”：`docs/memory-host-interface-contract.md:1137-1140`。
  - §12.5 已记录并推迟到 M9，版本仍为 `memory-host-contract/1`：`docs/memory-host-interface-contract.md:1151-1158`、`src/memory/capabilities.ts:20-28`。
  - 版本与能力报告的一致性有测试锁定：`tests/query-capabilities.test.ts:21-22`。
- **影响**：若宿主在 M9 前按 v1 枚举集硬编码，可能不识别新增状态/能力位。当前依赖能力协商，风险可控。
- **处理建议**：M9 发布前决定 minor/major 并同步宿主；在此之前保留能力协商要求。
- **验收标准**：M9 版本决策记录与能力报告一致。

### M2-A4｜`portals` 查询每次复制并排序全部 portal 边

- **严重度**：低（性能/文档）
- **状态**：已文档化（D-004；契约 §5.6；M8 基准决定是否优化）
- **证据**：
  - `src/query/topology.ts:127-131` 调用 `pagePortalEdges`。
  - `src/query/paging.ts:111-118` 每次查询克隆并按 id 排序完整列表。
  - 数量受 `maxPortalEdges`（默认 1000）约束：`src/topology/topology-store.ts:690`、`:1280-1281`。
  - 契约 §5.6 已记录 `portals` 的有界全量排序：`docs/memory-host-interface-contract.md:543`（克隆完整边集 + 按 id 排序 + `after` 非底层游标 + 受 `maxPortalEdges` 默认 1000 约束 + M8 决定是否改游标）。
  - 契约 §5.6 另记录 `containerAnchors` 的节点索引扫描（`:543`、`:545`）；§11 的泛化“拓扑分页全量扫描/排序”行在 `:1113`。
- **影响**：与其他列表查询相比，`portals` 不是按底层游标分页；当前规模下风险有限，文档已标注为有界全量排序。
- **处理建议**：文档落点已完成（L-M2-03d，契约 §5.6）；M8 基准时评估是否需要底层游标。
- **验收标准**：文档说明与实现一致；如有优化，附前后对比。

### M2-A5｜只读测试未直接断言证据时间/fragment 使用记录

- **严重度**：低（测试覆盖）
- **状态**：已修复（D-005；`f09b92e`，B02/L-M2-01）
- **证据**：
  - `captureStoreState` 现比较节点/遍历的 `observedAt` 与 fragment 的 `uses`/`lastUsedAt`：`tests/query-fixtures.ts:159-170`。
  - `cells` 只读用例播种 `observedAt:4321` 与带 `uses` 的 fragment，查询后断言时间与计数不变：`tests/query-cells.test.ts:433-458`。
  - `historyRoute`/`anchor`/`components`/`segments` 同样覆盖：`tests/query-history.test.ts:444-474`。
- **影响**：已消除；“查询不刷新证据时间/使用计数”现有直接回归断言。
- **验收标准**：新增断言失败时能捕获时间/使用记录被改写——已满足。

### M2-A6｜M2.5 的“位置”过滤未实现

- **严重度**：低（需求澄清）
- **状态**：已决策（D-006，2026-11-06）并补回归（L-M2-04）
- **证据**：`SpatialQueryRequest` 的 `resourceAnchors`/`containerAnchors` 允许字段只有 `dim/tag/label/after/limit` 与 `dim/after/limit`（`src/query/validate.ts:245-253`），没有位置/邻域参数；`src/query/anchors.ts:49-106` 也未做空间过滤。计划 M2.5 已于 `f9b827b` 同步“请求不接受 `near`/`radius`/`pos`”。
- **决策**：M2 的“按位置”只表示返回 `SpatialNode.location` 的位置字段，**不做位置/邻域过滤**；请求 union 不增加 `near`/`radius`/`pos`。宿主需要“附近资源/容器”时，先按 tag/label 分页拉取后按 `location.pos` 自行过滤；若后续确需库侧过滤，另走 minor 契约变更（复用 `anchor` 的 `near` 语义，明确半径边界、过滤后 `total`/游标，且不声明可达性）。
- **影响**：资源/容器锚点可查位置，但“附近”筛选由宿主负责；库不会隐式扫描或过滤。
- **验收标准**：计划 M2.5、契约 §5.4/§5.6、代码与测试对“位置”的语义一致；请求中的位置过滤参数必须被拒绝。
- **回归**：`tests/query-port.test.ts:55-75` 对 `resourceAnchors`/`containerAnchors` × `near`/`radius`/`pos` 断言 `invalid_request` 与精确 detail `unknown field "<field>" for query kind "<kind>"`；此前仅有其他未知字段覆盖，位置/邻域组合未被直接锁定。

### 3.1 前序批次已修复项（复核基线 `d40b94a`）

| 项 | 状态 | 证据与残留 |
|---|---|---|
| M2-L1 components 查询写缓存 | 已修复（`f09b92e`，B02/L-M2-01） | `src/query/history.ts:46-99` 改为从只读 nodes/edges 分页重算，不再调用会写缓存的 `TopologyStore.components`；`captureStoreState` 纳入 `componentCache`/`componentNext`（`tests/query-fixtures.ts:138-147`、`:185`），`tests/query-history.test.ts:365`、`:371-376`、`:446-474` 断言结果与 store 报告一致、缓存/计数未生成、证据时间未刷新 |
| M2-L3 worldId 双校验/query→store 类型耦合 | 已修复（`4321fda`，L-M2-03a） | `src/query/index.ts:48-52` 删除重复 `worldId` 校验（由 store 构造边界负责）；查询结果类型迁入 `src/query/types.ts`，query 模块无 store/navigation/execution 运行时导入；store 以编译期双向相等断言锁定 capability 名（`src/store/spatial-memory-store.ts:138-149`）。残留 D-030 为风格判断项 |
| M2-L5 `containerContents.nodeId` 被静默忽略 | 已修复（`883fe22`，L-M2-03c；D-040） | `nodeId` 已从类型与 validator 删除，`{kind:'containerContents',nodeId}` 失败关闭为 `invalid_request`（`tests/query-port.test.ts:48`、`:138-140`）；合法 `containerContents`（±dim）仍固定 `unsupported` + `host_ledger`、无 data（`src/query/anchors.ts:108-119`）。残留：契约 §5.2:420 仍列 `nodeId`，文档同步按 D-040/B08-M2-03 延期到 L-M2-03d/M9；`scope_mismatch` 保留为预留状态（`src/query/types.ts:276`） |

---

## 4. 已通过项

- **只读边界**：`src/query/*` 无 `navigation`/`execution`/store/身体端口运行时导入；查询源被收窄为 `SpatialQuerySources`，不暴露写 API；`components` 也从只读分页重算，不写组件缓存（M2-L1）。
- **不加载/不 pin**：`cells` 对 `not_resident`/`loading`/`load_failed` 返回 gap，测试确认 residency、pin、resident 数量不变。
- **驻留区分**：未观察格带可选 `residency` + `unobservedReason`，五态可区分；旧消费者忽略新字段仍只见三类（M2-A2/D-002）。
- **分页**：默认 100、上限 1000；请求超过底层 100 条页时合并；`total` 为完整匹配数；游标无重复/丢失。
- **未知输入**：未知 kind/字段、非法 limit、非整数/NaN 坐标、非法 enum 均返回结构化 `invalid_request`，不抛到宿主的控制循环；`resourceAnchors`/`containerAnchors` 的 `near`/`radius`/`pos` 同样失败关闭（M2-A6）。
- **历史语义**：历史路线/锚点/分量/分段不声明可执行或当前可通行；未知 fragment 返回 `not_found`。
- **容器硬边界**：`containerContents` 固定 `unsupported` + `host_ledger`，无 `data`，不会伪造成空箱；`nodeId` 请求字段被拒绝（M2-L5）；`containerAnchors` 无分类器时 `unsupported` 且能力为 `false`。
- **能力报告**：plan/execute/persistence 未实现项保持 `false`；query 能力与实际 handler 一致；契约版本 `memory-host-contract/1` 由测试锁定并挂 M9（M2-A3/D-003）。
- **证据时间**：查询后 `observedAt`、fragment `uses`/`lastUsedAt`、遍历时间均不变（M2-A5）；`captureStoreState` 覆盖 revision、pin、residency、组件缓存、cell/section。
- **提交卫生**：被审提交只包含查询端口相关文件，未覆盖用户未提交的设计文档、无工具/模型署名；本次复核只改审计与 `tests/query-port.test.ts`。

---

## 5. 后续处理清单

- [ ] **M2-A1**（D-001，2026-11-07；人工复核未完成）：已决策接受“M2 不计算可达性”（`requires_user_review: true`）；计划 M2.5 已同步范围（`f9b827b`）；D-001 后续跟踪项于 L-M2-03d 记录（`docs/memory-host-implementation-plan.md:302`），契约 §1.2/§5.4/§5.5 已对齐。无需补查询层可达投影。
- [x] **M2-A2**（D-002，`3ae4fd8`）：已加可选 `residency`/`unobservedReason`，§5.4/§15 与测试三处一致；残留 §5.3 形状块/`SectionResidency` 定义按 D-026 交 L-M2-03d/M9。
- [ ] **M2-A3**（D-003，目标 M9）：M9 发布前决定契约版本（minor/major）并同步宿主；当前保持 `memory-host-contract/1` + 能力协商。
- [ ] **M2-A4**（D-004，文档目标 L-M2-03d 已完成，M8 基准未开始）：契约 §5.6 已标注 `portals` 的有界全量排序（`docs/memory-host-interface-contract.md:543`）；M8 基准后评估是否需要底层游标。
- [x] **M2-A5**（D-005，`f09b92e`）：只读测试已直接断言 `observedAt`、fragment `uses`/`lastUsedAt` 不变。
- [x] **M2-A6**（D-006，2026-11-06；回归 L-M2-04）：M2 只返回位置字段，不做邻域过滤；`tests/query-port.test.ts:55-75` 断言 `near`/`radius`/`pos` 被拒绝。
- [x] **M2-L1 / M2-L3 / M2-L5**：分别由 `f09b92e` / `4321fda` / `883fe22` 修复；证据见 §3.1。M2-L5 的契约 §5.2 文档同步仍挂 L-M2-03d/M9。

---

## 6. 未执行项

- 真实 Minecraft Java 1.20.1 / mineflayer / Curio 联机验收（M7）；Fake/单测通过不代表真实感知与控制边界通过。
- D-001（M2.5 范围收窄）的人工复核（`requires_user_review: true`）；本文件不把 workflow 决策当作已获用户确认。
- M9 契约版本决策与宿主枚举集同步；M8 `portals`/节点扫描性能基准。
- `./memory`、`./navigation` 包子入口拆分与独立消费者验收（M5/M9）。
- `npm pack`、独立安装与类型声明消费验证（M9）。
- JSON→SQLite 权威切换与迁移门禁（M6）。

---

## 7. 参考

- [memory-host 实现计划](./memory-host-implementation-plan.md)
- [Agent/宿主接口契约](./memory-host-interface-contract.md)
- [0.10.0 实现审计](./implementation-audit-0.10.0.md)
- [空间记忆库设计](./spatial-memory-library-design.md)
