# 第 4C 批验收记录：有界、只读的历史拓扑查询

> 本文件是本批次的独立验收记录。它是本任务新增的文件，不覆盖、不修改
> `docs/spatial-memory-library-design.md` 中用户已有的未提交改动。

## 结论

**阶段 4C 有界、只读历史拓扑查询完成。**

此结论只覆盖「对已记录历史图的有界、只读查询」：节点邻接、有向历史可达、单条历史候选
路线。它**不是**当前世界完整寻路、可执行路径生成、SQLite 持久化、真实 Curio 接入或整个
空间记忆库已完成。

## 交付内容

| 文件 | 内容 |
|---|---|
| `src/topology/topology-store.ts` | `TopologyStore` 新增三个窄查询：`adjacency` / `reachable` / `route`；有界 BFS、预算计数、模式筛选、共享 `classifyReference` 引用核对，并把 4B 的 `resolveRef` 复用同一判定 |
| `src/topology/fragment-store.ts` | 新增 `FragmentScope` 类型与 O(1) `getFragmentScope(id)` 轻量只读入口（不复制几何、不刷新时间） |
| `src/topology/index.ts` / `src/index.ts` | 公开包入口导出新查询方法所需类型 |
| `tests/topology-query.test.ts` | 4C 契约测试（邻接、可达、路线、预算、模式、轻量读取回退、快照隔离等） |
| `examples/historical-topology-query.ts` | 可运行示例（纯公共 API，以公开包名导入） |
| `README.md` / `README_ZH.md` | 中英文说明更新 |

## 三个查询入口与端点限制

`TopologyStore` 新增方法，均为**同步、只读、单次**调用，查询结束即释放临时状态，不提供
跨轮搜索任务或 continuation：

- **`adjacency(nodeId, options?)`** —— 读取一个节点的入边/出边，返回 `TopologyEdge` 快照。
  自环只出现在 `outEdges` 一次（不重复返回）。返回的边**未经过本次引用解析**，不能当作
  可用路线。
- **`reachable(fromNodeId, options?)`** —— 从明确节点出发的有向历史可达集合（含起点，深度
  为零）。
- **`route(fromNodeId, toNodeId, options?)`** —— 一条有依据的有向历史连接序列（最少边数）。

端点限制：可达与路线查询只接受本 Store 已存在的节点、`exact` 位置、同一世界同一维度。
缺失节点、区域端点、跨维度请求**明确失败**（抛错），不根据 label、坐标接近或区域中心
替换端点。邻接查询可读取区域节点（返回其空邻接），不因此生成连接。不存在的节点明确报错，
不与「存在但没有邻边」混淆。

## 遍历顺序与搜索算法

- 邻接直接复用 `nodeToEdgeIds` 关联索引，按 `Set` 插入顺序逐项访问 incident 边，不先复制、
  排序整个邻接集合。同一 Store 状态与同一请求得到稳定结果；本轮不保证不同导入顺序一定产生
  同一条候选路线。
- 可达与路线使用简单 **BFS**：入队去重，正确处理环、自环和平行边；队列用游标推进（不反复
  `shift` 大数组）；不为每个可达节点复制整条路径，路线查询只在找到目标后回溯一次前驱链。
- 只沿**出边**前进（`from → to`），不把图转为无向图。入边与未访问区域中的缺口不影响本次
  查询结论。BFS 只声称「本次允许参与搜索的历史图中最少边数路线」，不称为最短物理距离、
  最快、最安全或最低材料成本路线。

## 哪些边参与搜索

第一版只沿同时满足以下条件的出边前进：`basis === 'traversed'`；按 4B 规则解析后整条边
`resolution === 'resolved'`；满足本次 mode 筛选。`candidate` 边不参与；`missing` / `mismatch`
边不参与；即使一条引用符合要求，只要同一边另有引用缺失或失配，仍排除整条边。证据解析复用
4B 的 `classifyReference`（与绑定快照逐字段比较、核对经过记录与所属片段、核对作用域），
4C 不另写一套 `resolved` 判定。

## 模式筛选与证据选择

- **先解析整条边的引用，再处理模式筛选。**
- 指定 `mode`：至少一条当前匹配引用的明确 mode 等于请求 mode 才能使用这条边；若无匹配但
  存在 mode 未知的引用，记录 `mode_unknown` 缺口；若所有引用 mode 已知且均不匹配，作为
  `mode_mismatch` 正常筛除（不是证据缺失，也不是当前阻塞）。
- 未指定 `mode`：允许模式已知或未知的匹配证据，返回所采用证据的真实 mode；一条路线可包含
  不同历史模式，不整体标成 `walk`。
- 同一条边有多个合格证据时，选 **evidenceId 字典序最小**的一条作为该段见证；每段必须说明
  实际采用的 `evidenceId`，不从 source、连接类型或坐标差猜测模式。

## 结果状态语义

路线查询的结果状态按优先级判定：

1. **`FOUND`** —— 找到完整符合条件的历史连接序列。其他已检查分支存在缺口不推翻该结果；
   可附带诊断，但不改判失败。
2. **`BUDGET_EXHAUSTED`** —— 尚未找到完整路线，且工作预算阻止继续。不翻译成
   `NO_RECORDED_ROUTE`。
3. **`INSUFFICIENT_EVIDENCE`** —— 未找到目标、前沿已处理完，但搜索前沿实际遇到
   `candidate` / `missing` / `mismatch` / 指定模式下的 `mode_unknown`。报告观察到的缺口，
   不声称某缺口必然是唯一原因。
4. **`NO_RECORDED_ROUTE`** —— 前沿完整处理、未找到目标、也未遇到待验证证据缺口。只表示
   当前记录中无符合条件的历史连接，不表示现实世界无路。

可达查询返回已确认到达的节点集合，并以 `disposition` 区分 `complete` / `evidence_gaps` /
`budget_exhausted` 三种停因。零跳路径（`from === to`）单独处理：仍校验节点存在与端点支持、
仍遵守节点读取预算；成功时返回一个节点、零条边、零条经过证据，不伪造移动记录、不返回
`ARRIVED`、不为零边路径制造一次该模式的移动证明。

## 预算计数、诊断截断与轻量读取回退

四个可配置预算，默认有限（等于 Store 侧上限）并受 Store 侧上限钳制；**零按字面生效**；负数、
非整数、`NaN`、`Infinity`、不安全整数被拒绝。预算在对应工作发生前检查，达到数值上限不自动
等于失败（若查询已完成则返回真实完成结果），不扫描剩余图来确认自己是否超预算：

- `maxNodes`：首次读取一个节点元数据时计数（含起点与终点），同次查询缓存命中不重复计数；
  同时约束节点缓存、搜索访问集合与结果规模。
- `maxEdges`：每处理一个 incident 候选计数（含随后被方向或条件筛除的边）；同一条边在不同
  节点的 incident 集合中被再次检查时按实际工作再次计数。
- `maxHistoryReads`：每次实际调用历史读取接口前计数（`getTraversal` + 片段作用域读取），
  缓存命中不计作实际读取但不跳过绑定比较；预算不足以完整解析一条边时，该边既不进入已确认
  结果也不沿其继续，未读取的证据不冒充 `missing`。
- `maxDiagnostics`：限制返回的详细诊断条目数；达到上限只截断诊断、不停搜索，保留
  `diagnosticsTruncated`；即使上限为零，发生过证据缺口的事实也不丢失（`gaps` 与状态仍正确），
  不会因此误报 `NO_RECORDED_ROUTE`。

轻量读取回退：`FragmentStore` 新增 O(1) `getFragmentScope(id)`（返回 id/worldId/dim，不复制
polyline/entrances/links，不刷新时间/次数）。`TopologyHistorySource` 增加可选的同名能力；
存在时优先使用轻量入口，不存在时兼容回退 `getFragment(id)` 只取作用域，每次实际调用都计入
`maxHistoryReads`。缓存的是**权威读取结果**，不是「该 evidenceId 已 resolved」——同一
evidenceId 可能被不同边绑定到不同历史快照，每条边仍与自己的绑定快照独立比较。

## 历史候选路线 ≠ 当前可执行路线

结果只表达已记录历史图中的关系，不输出或暗示：自动补出的直线脚点、可直接交给
`WalkRouteExecutor` 的点列、当前 `OPEN`、当前身体已到达、全程已在同一次会话连续走过。只有
端点的经过记录不提供完整轨迹；关联片段的 polyline 未经核对不直接拼成可执行路径。所有查询
不修改节点/边/片段/证据/绑定，不刷新 `observedAt`/`createdAt`/`lastUsedAt`/`uses`，不清理
缺失引用，不自动修复/重绑/补边/改模式，不扫描世界、不调用 VoxelMap 验证、不移动身体。

## 本轮未实现

- 当前地形寻路、路径平滑、碰撞检查、身体执行；从任意坐标自动匹配最近节点；区域中心到精确
  脚点转换。
- 自动补边、自动建图、轨迹拼接/插值；`surfaceAnchor` / `deepestAnchor` / `Frontier`。
- `PORTAL` 或跨维度路线。
- SQLite 持久化、单个 Worker、迁移。
- Curio / mineflayer 接线；图版本系统、锁、增量搜索或跨轮任务调度。
- 现有 `SpatialMemoryStore.route(dim, from, to)` 的另一套目标契约（本次基于节点 ID 的查询
  不冒充其完整实现，也不为其补空方法）。

## 运行结果

```text
node --version  → v24.14.1
npm  --version  → 10.9.0

npm run typecheck  → 通过
npm run build      → 通过
npm test           → 317 passed（11 个测试文件；新增 32 项 topology-query 测试，
                      既有 topology-store / fragment-store 等全部保持通过）
npx tsx examples/historical-topology-query.ts → 正常运行（以公开包名导入，先 build）
独立安装验证       → npm pack 后安装到全新临时消费者目录，node 运行 + 严格 tsc 类型检查均通过
git diff --check   → 通过（仅 LF/CRLF 行尾提示，无空白错误）
```

示例 `examples/historical-topology-query.ts` 以公开包名 `curio-minecraft-3d-memory` 导入（非源码
路径），实际走包的 `exports` 入口；独立安装验证为：`npm pack` → 全新消费者目录
`npm install <tgz>` → `node` 运行与 `tsc`（`skipLibCheck: false`）类型检查均通过。
