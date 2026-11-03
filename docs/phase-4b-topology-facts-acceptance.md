# 第 4B 批验收记录：显式拓扑事实内存层

> 本文件是本批次的独立验收记录。它是本任务新增的文件，不覆盖、不修改
> `docs/spatial-memory-library-design.md` 中用户已有的未提交改动。

## 结论

**第 4B 批显式拓扑事实内存层已实现并通过独立测试。**

此结论只覆盖「显式节点、有向连接事实与证据引用管理」的纯内存存储与查询。它
**不是**完整拓扑导航、完整 `SpatialMemoryStore`、SQLite 持久化或真实 Curio 接入
已完成。

## 交付内容

| 文件 | 内容 |
|---|---|
| `src/topology/topology-store.ts` | 新增 `TopologyStore`：显式节点/有向连接/证据引用及其引用解析 |
| `src/topology/path-fragment.ts` | `TraversalEvidence` 新增可选 `mode?: MoveMode`；导出共享的 `cloneTraversalEvidence` / `traversalEvidenceEqual` / `assertValidMode` |
| `src/topology/fragment-store.ts` | 新增 `getTraversal(id)` 按 ID 直查；证据快照/幂等/冲突判断纳入 `mode` |
| `src/topology/graph.ts` | 修正 `NodeSource` 注释为阶段 4B 行为（无最旧淘汰；agent/program 独立额度、超容量明确拒绝） |
| `src/topology/index.ts` / `src/index.ts` | 公开包入口导出新类与类型 |
| `tests/topology-store.test.ts` | 30 项契约测试 |
| `examples/topology-facts.ts` | 可运行示例（纯公共 API，不依赖 Curio / 游戏 / 数据库） |
| `README.md` / `README_ZH.md` | 中英文说明更新 |

## 新旧类型的关系

- **节点**沿用现有 `SpatialNode`（`id / kind / source / tag / label / worldId / dim /
  location`），含义不变。`source` 的 agent/program 语义保留，二者使用**独立容量**，
  本阶段均「超容量明确拒绝」，不自动淘汰（`NodeSource` 注释已相应修正，不再声称
  已实现最旧淘汰）。
- **连接**不直接复用现有 `SpatialEdge`——它混合了历史连接与后续当前验证契约
  （`directed` / `modes` / `verifications`），本阶段不假装实现其中全部语义。新增窄类型
  `TopologyEdge`：保留 `id / from / to / type / fragmentId` 的既有含义，新增 `basis`
  （依据分类）与 `evidenceIds`（经过证据引用）。当前引用解析结果放在查询投影
  `EdgeView` 中，当前通行性**不进**历史事实记录。
- 现有 `SpatialEdge` 的公开导出保持不变，字段含义不变；本阶段不提供旧
  `SpatialEdge` 的转换接口，也不接收当前通行 `verifications`。

## 两类连接与证据强度

- **`candidate`**：调用者显式提交的候选关系。它表示「记录了这个待验证连接」，
  不证明曾经过、不证明当前可走；保留调用者给出的来源说明，`fragmentId` 只是关联，
  不自动从保存节点/片段/观察生成。
- **`traversed`**：引用明确 `TraversalEvidence` 的历史有向连接，只有证据检查全部
  通过才接受。写入时至少检查：两端节点存在且属于本 Store 的 `worldId`、两端同维度、
  两端均为 `exact`、非 `PORTAL`、至少引用一条明确证据、证据与其片段存在、证据/片段/
  节点的 `worldId`/`dim` 一致、证据 `from`/`to` 与边的起/终点精确对应且方向一致、边若
  提供 `fragmentId` 须与证据所属片段一致。

两类连接在查询结果中以 `basis` 明确区分，不用同一个无说明的「已连接」布尔值表达。

## 方向、模式与引用解析

- **方向**：边统一按有向记录保存，A→B 与 B→A 是两条独立记录，不因保存 A→B 自动生成
  B→A；双向历史连接由两条分别有依据的记录表达。
- **模式**：`TraversalEvidence.mode` 缺省表示未知，旧记录不补默认 `walk`，不从
  `source`/连接类型/坐标差猜测。边的已知历史模式只来自它明确引用且匹配的证据 `mode`；
  候选关系不因 `type` 为 `LADDER`/`SWIM` 等自动获得模式。`mode` 纳入边界校验、快照、
  幂等与冲突判断；不增加任何执行能力或授权。
- **引用解析**：接受 `traversed` 边时保存证据 ID 与当时绑定的证据语义快照（快照只用于
  保持绑定含义、比较与历史展示，不是第二个可写权威源）。查询边时通过只读历史接口重新
  解析当页引用，比较证据的**全部声明字段**（身份、片段、作用域、端点、会话、时间、
  来源、执行/动作关联及可选 `mode`），区分：
  - `resolved`：引用可解析且内容匹配；
  - `missing`：引用缺失（原证据/片段已被删除）；
  - `mismatch`：引用存在但内容不匹配。
  候选边的 `resolution` 为 `null`（无证据引用可解析）。

## 删除、更新与容量语义

- **删除源片段**：调用者可直接 `FragmentStore.forgetFragment` 删除片段及其证据。边
  记录与原绑定摘要**保留**，查询明确报告 `missing`；不自动删除节点/边、不把本地摘要
  冒充权威记录、不把缺口翻译成当前世界 `BLOCKED`。
- **重导入**：原证据删除后，用同 ID 写入不同内容**不能**让旧边自动改绑（报告
  `mismatch`）；完全相同证据的显式重导入可恢复 `resolved`。未引入代次/墓碑系统。
- **删除边**：只删除拓扑记录与本组件内的关联索引，不删除 `FragmentStore` 中的片段或
  证据。删除不存在 ID 为稳定无操作。
- **节点**：`save / update / get / list / forget`。`id / worldId / dim / source` 不通过
  更新改写；`label / tag / kind` 可显式更新（显式 `undefined` 清除 `label`/`tag`）；
  节点仍被任意边引用时拒绝改变 `location` 与删除节点（同值 `location` 更新保持幂等）。
- **边**：`save / update / get / list / forget`。`id / from / to` 创建后不变，调整端点应
  显式删旧建新；改 `basis` 为 `traversed`（或改 `evidenceIds`）时重新执行全部校验。
- **容量**：`maxAgentNodes` / `maxProgramNodes`（独立额度）/ `maxEdges` /
  `maxEdgeEvidenceRefs`（单边证据引用数）/ `maxQueryBatch` 均可配置；超限抛明确错误，
  不静默截断证据、不自动淘汰；校验、冲突、容量或引用检查失败后记录与关联索引均无部分
  修改。写操作返回 `inserted / updated / unchanged`；同 ID 不同内容为冲突；未知 ID 更新
  失败。

## 快照与 getter 支持

所有公开输入、返回值和更新结果均保持快照隔离：修改传入节点的位置/区域、证据引用数组，
或修改查询结果及其嵌套内容，都不污染内部记录。普通对象与稳定 getter 提供的合法字段均
正确读取（坐标/位置/标签/证据字段逐项读取，不用对象展开复制外部证据或坐标）；非法
getter 值（如非有限坐标）导致原子拒绝。

## 三类概念必须区分

1. **历史有依据**：`basis: 'traversed'` 且引用匹配的证据存在——只说明「有过这段经过」；
2. **引用当前可解析**：查询时证据仍能从权威来源解析且内容匹配（`resolved`）；
3. **当前可通行**：本阶段**不负责**这个判断，`TopologyStore` 不接触 `VoxelMap`，不产生
   当前 `OPEN`/`BLOCKED`，当前地图 BLOCKED/STALE 不会删除节点、边或经过记录。

## 运行结果

```text
npm run typecheck  → 通过
npm run build      → 通过
npm test           → 279 passed（含新增 30 项 topology-store 测试，基线 249 项全部保持通过）
npx tsx examples/topology-facts.ts → 正常运行（以公开包名导入，需先 build）
独立安装验证       → npm pack 后安装到全新目录，node 运行 + tsc 类型检查均通过
git diff --check   → 通过
```

示例 `examples/topology-facts.ts` 以公开包名 `curio-minecraft-3d-memory` 导入（非源码
路径），实际走包的 `exports` 入口；独立安装验证为：`npm pack` → 全新消费者目录
`npm install <tgz>` → `node` 运行与 `tsc` 类型检查均通过。

## 已知限制与后续接缝

本轮**未实现**，按设计后续批次落地：

- 自动建图、距离补边、碎片自动合并/拆分、多段证据自动串接、轨迹压缩/采样。
- 连通分量、最短路、`route` / `surfaceAnchor` / `deepestAnchor` / `Frontier`。
- 当前通行验证缓存、自动重验证或移动执行；`PORTAL` 与跨维度连接（明确报告不支持）。
- SQLite 持久化、单个 Worker、迁移或跨进程事务。
- 真实 Curio / mineflayer 感知与执行接线，以及旧 `SpatialEdge`/`graph(dim)` 查询契约
  兼容层与转换接口。
- 自动淘汰、自动探索、施工或其他策略。

`SpatialMemoryStore` 仍是目标接口；本批实现的是更窄的显式拓扑事实组件，供后续 Store
组合使用，未为其补空方法或恒定返回值。
