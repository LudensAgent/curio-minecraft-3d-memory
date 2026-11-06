# 空间记忆库 M2 查询端口审计（memory-host）

> 审计日期：2026-11-06
> 被审提交：`5ec1c0d`（`feat(query): add read-only spatial query port`）
> 分支：`integration/memory-host-20261106`
> 计划基线：[memory-host 实现计划](./memory-host-implementation-plan.md) §M2（提交 `960da25`）
> 契约基线：[Agent/宿主接口契约](./memory-host-interface-contract.md)（`5ec1c0d` 更新后）
> 审计范围：M2.1–M2.6、阶段门禁 G1；本仓库源码、测试、文档
> 非审计范围：M3–M9、Curio 宿主源码、真实 Minecraft Java 1.20.1 / mineflayer 联机运行

> 用户提到的提交 `45ec1c0d` 在本仓库不存在；经 `git rev-parse`、`git log --all` 核对后，按上下文审查实际存在的 M2 提交 `5ec1c0d`。

---

## 0. 结论

**M2 有条件通过。**

- M2.1、M2.2、M2.3、M2.4、M2.6 完成；阶段门禁 G1 通过。
- M2.5 的核心查询（资源/容器位置、`host_ledger` 边界）可用，但计划目标中的“可达证据”通过修改契约被降级为“M2 不计算可达性”，需要用户确认。
- 未发现计划 §4.12 的阻断项；真实联机/宿主验收未执行，属于 M7。
- 功能完成度估计：**约 90%–95%**；若“可达证据”必须计入 M2.5，则完成度下降为“未完全达到目标”。

一句话：**查询端口本身可交付，测试与只读边界成立；剩余问题主要是范围决策、文档措辞和契约版本收口，不是查询实现缺陷。**

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

---

## 2. M2 逐项结论

| 任务 | 状态 | 证据与说明 |
|---|---|---|
| M2.1 定义 `SpatialQueryPort` 类型 | 完成 | `src/query/types.ts`、`src/query/index.ts`；`SpatialQueryRequest`/`SpatialQueryResult`/`SpatialQueryData`/`CellQueryView`/`SpatialQueryProblem` 与契约 §5 一致；未知 kind/字段由 `src/query/validate.ts` 拒绝 |
| M2.2 `cells` 查询 | 完成 | `src/query/cells.ts`；已观察/未观察/未驻留区分；`not_resident`/`loading`/`load_failed` → `gap.reason:'unloaded'` + `status:'partial'`；负坐标、副本隔离、不加载 Section 有测试。历史 `ObservationGap` 未持久化，契约 §15 已标为部分实现 |
| M2.3 碎片/traversal/nodes/edges 分页 | 完成 | `src/query/topology.ts`、`src/query/paging.ts`；默认 100、上限 1000、合并底层 100 条页、稳定 `after`、`total` 为完整匹配数；250 条跨页与末页无重复测试通过 |
| M2.4 历史路线/锚点/分量/portal | 完成 | `src/query/history.ts`；`historyRoute` 带 `historicalGeometry:true`/`executable:false`/`currentPassability:'UNKNOWN'`；未知 fragment 返回 `not_found`；`anchor` 为 `null` 时保持 `ok`；portal 与 walk graph 独立 |
| M2.5 资源/容器位置查询 | **有条件完成** | `src/query/anchors.ts` 支持 `dim/tag/label`、只返回 exact 节点、`containerAnchors` 需宿主 `isContainer`、`containerContents` 固定 `host_ledger`；但“可达证据”未实现，且无按位置/邻域过滤参数（见 M2-A1/M2-A6） |
| M2.6 能力报告与边界 | 完成 | `src/memory/capabilities.ts`、`src/query/capabilities.ts`；memory/query 按实际能力，plan/execute/persistence 保守为 `false`；`containerContents` 恒为 `false`；无分类器时 `containerAnchors` 返回 `unsupported` |
| G1 契约冻结 | 通过 | 类型、运行时校验、契约 §5/§15 与测试一致；新增项已记录在契约 §12.5 |

---

## 3. 待处理问题

### M2-A1｜M2.5 的“可达证据”被契约降级

- **严重度**：中
- **状态**：待决策（需用户确认）
- **证据**：
  - 计划 M2.5 目标写的是“按 tag/label/位置返回锚点和**可达证据**”：`docs/memory-host-implementation-plan.md:295-302`。
  - 被审提交把契约 §1.2、§5.4、§5.5 的“可达证据/可达性”改为“M2 不计算可达性”：`docs/memory-host-interface-contract.md:511-513`、`docs/memory-host-interface-contract.md:519`。
  - 代码只返回原始 `SpatialNode`（位置、精度、观测时间、来源）：`src/query/anchors.ts:48-71`。
- **影响**：宿主无法从查询直接获得资源/容器锚点的可达关系，必须自行结合路由/感知证据判断。该方向与“位置记录不能推断可达”一致，但它是实现批次内对既有契约基线的范围缩减。
- **处理建议**：
  1. 若接受降级：在计划 M2.5 中明确“可达证据不在 M2 范围”，并新增后续里程碑跟踪项；
  2. 若不可接受：补一个只读可达性投影（明确基于历史边/锚点查询，不声明当前可通行），或按契约变更流程新增字段。
- **验收标准**：计划、契约与代码对 M2.5 范围表述一致；若补实现，有正例/负例测试且能力报告同步。

### M2-A2｜§15 对 `cells` 状态区分过度声称

- **严重度**：低（文档）
- **状态**：待修正
- **证据**：
  - `docs/memory-host-interface-contract.md:1260` 写“可区分 `no_record`/resident-unobserved/`not_resident`/`loading`/`load_failed`”。
  - `no_record` 与 resident-unobserved 在输出中完全相同，都是 `{ observed:false }`：`src/query/cells.ts:60-68`；测试也明确断言两者一致：`tests/query-cells.test.ts:159-187`。
  - `not_resident`/`loading`/`load_failed` 又统一折叠为 `gap.reason:'unloaded'`（契约 §5.4 的要求）。
- **影响**：宿主若按 §15 认为可以区分五种状态，会做出错误的能力判断。
- **处理建议**：把 §15 改为“内部读取驻留状态；对外只输出已观察、未观察（无 gap）、不可读（`gap:'unloaded'`）三类”；若确需区分，则在 `CellQueryView` 增加可选 `residency` 字段（属契约变更）。
- **验收标准**：§15、§5.4 与测试三处语义一致。

### M2-A3｜契约新增枚举值但未升级版本

- **严重度**：低（流程/发布门禁）
- **状态**：挂 M9
- **证据**：
  - 本批新增 `not_found` 状态、`segments`/`containerContents` kind、`query.segments`/`query.resourceAnchors` 能力位。
  - 契约 §12.3 规定“新增枚举值/改变语义/收窄必填 = major”：`docs/memory-host-interface-contract.md:1113-1118`。
  - §12.5 已记录并推迟到 M9，版本仍为 `memory-host-contract/1`：`docs/memory-host-interface-contract.md:1127-1134`、`src/memory/capabilities.ts:20-24`。
- **影响**：若宿主在 M9 前按 v1 枚举集硬编码，可能不识别新增状态/能力位。当前依赖能力协商，风险可控。
- **处理建议**：M9 发布前决定 minor/major 并同步宿主；在此之前保留能力协商要求。
- **验收标准**：M9 版本决策记录与能力报告一致。

### M2-A4｜`portals` 查询每次复制并排序全部 portal 边

- **严重度**：低（性能/文档）
- **状态**：挂 M8 / 文档补充
- **证据**：
  - `src/query/topology.ts:110-122` 调用 `pagePortalEdges`。
  - `src/query/paging.ts:106-118` 每次查询克隆并按 id 排序完整列表。
  - 数量受 `maxPortalEdges`（默认 1000）约束：`src/topology/topology-store.ts:690`。
- **影响**：与其他列表查询相比，`portals` 不是按底层游标分页；当前规模下风险有限，但未在契约 §5.6 标注为扫描型查询。
- **处理建议**：在 §5.6 或 §11 记录该有界全量排序；M8 基准时评估是否需要底层游标。
- **验收标准**：文档说明与实现一致；如有优化，附前后对比。

### M2-A5｜只读测试未直接断言证据时间/fragment 使用记录

- **严重度**：低（测试覆盖）
- **状态**：可选
- **证据**：`tests/query-fixtures.ts:115-125` 的 `captureStoreState` 覆盖 `saveRevision`、pin、residency、fragment/topology revision、cell/section，但未比较 `observedAt`、fragment `uses`/`lastUsedAt`。
- **影响**：代码路径检查未发现写入，风险低；但“查询不刷新证据时间”目前没有直接断言的回归测试。
- **处理建议**：在 `cells`/`historyRoute` 只读用例中先播种已观察格和带 `uses` 的 fragment，查询后比较原始时间与使用计数。
- **验收标准**：新增断言失败时能捕获时间/使用记录被改写。

### M2-A6｜M2.5 的“位置”过滤未实现

- **严重度**：低（需求澄清）
- **状态**：待澄清（可与 M2-A1 合并）
- **证据**：`SpatialQueryRequest` 的 `resourceAnchors`/`containerAnchors` 只有 `dim/tag/label/after/limit`，没有位置/邻域参数；`src/query/anchors.ts:48-71` 也未做空间过滤。契约 §5.2 与实现一致。
- **影响**：如果计划中的“位置”指按位置过滤，则该项未落地；如果仅指返回位置字段，则已满足。
- **处理建议**：在计划中澄清；若需要空间过滤，按新增可选字段（minor）或新增查询 kind 的流程处理。
- **验收标准**：计划/契约/代码对“位置”的语义一致。

---

## 4. 已通过项

- **只读边界**：`src/query/*` 无 `navigation`/`execution`/身体端口运行时导入；查询源被收窄为 `SpatialQuerySources`，不暴露写 API。
- **不加载/不 pin**：`cells` 对 `not_resident`/`loading`/`load_failed` 返回 gap，测试确认 residency、pin、resident 数量不变。
- **分页**：默认 100、上限 1000；请求超过底层 100 条页时合并；`total` 为完整匹配数；游标无重复/丢失。
- **未知输入**：未知 kind/字段、非法 limit、非整数/NaN 坐标、非法 enum 均返回结构化 `invalid_request`，不抛到宿主的控制循环。
- **历史语义**：历史路线/锚点/分量/分段不声明可执行或当前可通行；未知 fragment 返回 `not_found`。
- **容器硬边界**：`containerContents` 固定 `unsupported` + `host_ledger`，无 `data`，不会伪造成空箱；`containerAnchors` 无分类器时 `unsupported` 且能力为 `false`。
- **能力报告**：plan/execute/persistence 未实现项保持 `false`；query 能力与实际 handler 一致。
- **提交卫生**：只包含本任务文件；未覆盖用户未提交的设计文档；无工具/模型署名。

---

## 5. 后续处理清单

- [ ] **M2-A1**：确认是否接受“可达证据”降级；接受则更新计划并新增后续跟踪项，不接受则补只读可达性投影。
- [ ] **M2-A2**：修正契约 §15 的 `cells` 状态描述，或扩展 `CellQueryView`（需契约变更）。
- [ ] **M2-A3**：M9 发布前决定契约版本（minor/major）并同步宿主。
- [ ] **M2-A4**：在契约性能章节标注 `portals` 的有界全量排序；M8 评估优化。
- [ ] **M2-A5**：补强只读测试对 `observedAt` 与 fragment 使用记录的断言（可选）。
- [ ] **M2-A6**：澄清“按位置”的含义；如需要空间过滤，走契约变更流程。

---

## 6. 未执行项

- 真实 Minecraft Java 1.20.1 / mineflayer / Curio 联机验收（M7）；Fake/单测通过不代表真实感知与控制边界通过。
- `./memory`、`./navigation` 包子入口拆分与独立消费者验收（M5/M9）。
- `npm pack`、独立安装与类型声明消费验证（M9）。
- JSON→SQLite 权威切换与迁移门禁（M6）。

---

## 7. 参考

- [memory-host 实现计划](./memory-host-implementation-plan.md)
- [Agent/宿主接口契约](./memory-host-interface-contract.md)
- [0.10.0 实现审计](./implementation-audit-0.10.0.md)
- [空间记忆库设计](./spatial-memory-library-design.md)
