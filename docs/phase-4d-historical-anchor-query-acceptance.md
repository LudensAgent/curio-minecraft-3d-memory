# 第 4D 批验收记录：有界、只读的历史可达锚点候选查询

> 本文件是本批次的独立验收记录。它是本任务新增的文件，不覆盖、不修改
> `docs/spatial-memory-library-design.md` 中用户已有的未提交改动。

## 结论

**阶段 4D 有界、只读历史可达锚点候选查询完成。**

此结论只覆盖「从已知节点出发，沿已有、方向正确、证据引用有效且符合模式条件的历史连接，
查询可达且满足筛选条件的锚点候选，并按 `bfs`/`highest`/`deepest` 排序限流返回」。它**不是**
当前可通行判断、可执行路线生成、自动目标选择或自动导航/探索。

## 交付内容

| 文件 | 内容 |
|---|---|
| `src/topology/topology-store.ts` | `TopologyStore` 新增 `historicalAnchorCandidates(fromNodeId, options?)`；内部 `runSearch` 扩展携带节点深度与节点快照；新增 `AnchorOrder` 等类型与排序/证明/选项解析辅助 |
| `src/topology/index.ts` / `src/index.ts` | 公开包入口导出 `AnchorOrder` / `HistoricalAnchorQueryOptions` / `HistoricalAnchorCandidate` / `HistoricalAnchorQueryResult` |
| `tests/topology-anchor-query.test.ts` | 31 项契约测试（起点、过滤、排序、证据、预算、证明、隔离、计数等） |
| `examples/historical-anchor-query.ts` | 可运行示例（纯公共 API，以公开包名导入） |
| `README.md` / `README_ZH.md` | 中英文说明更新 |

## 公共 API

```ts
historicalAnchorCandidates(
  fromNodeId: string,
  options?: HistoricalAnchorQueryOptions,
): HistoricalAnchorQueryResult
```

`HistoricalAnchorQueryOptions extends TopologyQueryOptions` 新增：
`source?: NodeSource`、`tag?: LandmarkTag`、`kind?: NodeKind`、`includeStart?: boolean`、
`order?: 'bfs' | 'highest' | 'deepest'`、`limit?: number`。

`HistoricalAnchorCandidate { node: SpatialNode; hops: number }`。

`HistoricalAnchorQueryResult { from; mode?; order; items; proofSegments; matchedCount;
resultsTruncated; disposition; gaps; stats; diagnostics; exhausted? }`。

默认：`includeStart = true`、`order = 'bfs'`、`limit = min(20, maxQueryBatch)`，未指定筛选字段
表示不按该字段过滤。`limit` 必须为正安全整数（0 非法），超过 `maxQueryBatch` 钳制到 Store 上限，
不新增第二套候选容量配置。

## 起点、过滤与排序

- **起点**：只接受 Store 内已存在的 `exact` 节点 ID；沿用 4C 的世界/维度/节点读取预算与错误
  规则。不接受坐标最近匹配，不用区域中心替代精确位置。`maxNodes=0` 不返回未经校验的起点；
  有预算时不存在/区域起点明确失败。
- **过滤**：`source`/`tag`/`kind` 按 AND 组合，只过滤返回候选，不裁剪图遍历。`source` 指
  `SpatialNode.source`，不与 `TraversalEvidence.source` 混淆；`tag` 缺失的节点不匹配指定
  `tag`；`label` 保持不透明。起点 → program 中间节点 → agent 基地节点的场景下，即便查询
  `source='agent'` 仍须经过 program 中间节点。
- **排序**：`bfs` 保持 BFS 发现顺序；`highest` 按 `pos.y` 降序；`deepest` 按 `pos.y` 升序；
  高度相同保持 BFS 发现顺序。高度只来自节点 `pos.y`，不读 `PathFragment.deepestY`、entrances、
  label 或连接类型来猜测。同一 Store 状态与相同请求结果稳定。
- **起点候选**：起点满足筛选且 `includeStart=true` 时作为零跳候选（`hops=0`，不制造经过证据、
  不证明发生过该 mode 移动、不返回 `ARRIVED`）。

## 复用 4C 搜索与证据语义

每次公开查询只执行一次共享预算下的有界搜索，复用 incident 邻接索引、节点/历史读取缓存、
前驱记录、`classifyReference` 引用分类、模式筛选、预算与诊断逻辑。内部 `runSearch` 额外携带
节点深度（`depth`）与节点快照（`nodes`），不导出内部搜索上下文，不引入通用图查询框架。

禁止全图扫描 `nodes()`/`edges()` 后伪装有界、对每个候选重新调用 `route()`、多次搜索各用新
预算、搜索后绕过预算重读节点/历史、按坐标接近或几何直线补边、把图按无向连通分量处理。

参与搜索的边沿用 4C：方向必须正确、`basis === 'traversed'`、整条边全部引用必须匹配、一条
有效一条缺失/失配时整边排除、`candidate`/`missing`/`mismatch` 按实际遇到报告缺口、指定 mode
必须有明确匹配见证、无匹配但存在未知 mode 时报告 `mode_unknown`、全部已知且不匹配时正常筛除、
未指定 mode 保留真实未知/混合模式、合格见证选 `evidenceId` 字典序最小者。缓存权威读取结果
（含 null），每条边仍与自己的绑定快照比较，不跨查询缓存引用有效性，历史读取错误明确传播。

本查询需收集候选，故不复用 `route` 的「找到目标即停止」；`route` 仍保留其提前结束行为。

## 预算、数量与完整性

沿用四项 4C 预算（`maxNodes`/`maxEdges`/`maxHistoryReads`/`maxDiagnostics`）与原有计数口径、
有限默认值、Store 上限、工作前检查、零预算与非法参数处理。新增选项在所属公开边界校验一次，
支持稳定 getter 属性输入。

- `matchedCount`：本次已确认可达且满足筛选的节点数，在应用 `limit` 前计数；预算耗尽或存在
  缺口时不称为整个历史图的候选总数。
- `resultsTruncated`：仅表示 `matchedCount > items.length`（返回上限截断），不表示搜索是否
  完整，也不能代替 `disposition`。
- `disposition`：`budget_exhausted` 优先，其次 `evidence_gaps`，否则 `complete`；即使已返回
  候选也不覆盖 `budget_exhausted`/`evidence_gaps`。
- 极值：达到 `limit` 后仍在预算内继续搜索，不找到第一个候选就返回。`order=highest/deepest`
  且 `limit=1` 时，`disposition=complete` 首项才可解释为本次范围内的最终极值，其余 disposition
  下首项仅是已确认候选中的极值。`resultsTruncated=true` 本身不破坏极值结论。
- 诊断：保留预算耗尽前已确认的缺口（未读引用不标 missing）；`maxDiagnostics=0` 或截断时
  `gaps`/`diagnosticsTruncated` 仍正确，不因详细诊断为空改判 `complete`。空 `items` 不自动
  意味没有历史候选，须结合 `matchedCount`/`includeStart`/筛选/disposition 解释。

## 共享溯源输出（proofSegments）

`proofSegments` 复用 `RouteSegment`，表示返回 items 所需「从起点到候选的 BFS 前驱路径并集」：
每个非起点候选都能沿它追溯到 `from`；每个非起点节点至多一条前驱边；共享前缀只返回一次；
被过滤的中间节点仍可出现在证明路径中；不额外复制中间节点元数据（from/to 已是节点 ID）；每段
保留实际 `evidenceId` 与经过证据快照（世界/维度/会话/时间/动作归属/mode）；不把跨会话多段
说成一次连续行程；起点候选不需要证明边；`items` 为空时 `proofSegments` 为空。证明只取自本次
搜索的前驱与见证，不重查历史、不重绑证据、不调用 `route()`。构建有界：先排序并应用 `limit`，
再为实际返回项构建证明；共享前缀按已收集节点集合去重；证明边数不超过本次确认访问节点数减一；
按前驱在先顺序输出；不为未返回候选额外输出证明（除非位于返回候选路径上）；不静默截断证明链。
返回的节点、证据、数组均与内部状态隔离。

## 本轮未实现

- 旧 `SpatialMemoryStore.surfaceAnchor`/`deepestAnchor` 坐标接口；自动识别地表/洞口/基地/资源
  目标；`Frontier`、自动探索、全图碎片或强弱连通分量分析。
- 自动建图、补边、双向边推断；`PORTAL`、跨维度路线；历史轨迹插值、脚点拼接、可执行点列。
- `VoxelMap` 当前通行复验；`WalkRouteExecutor`、Curio、mineflayer 接线。
- SQLite、Worker、迁移、恢复；搜索 continuation、跨调用缓存、锁、图版本系统。

查询不修改节点/边/片段/绑定/次数/时间，不扫描世界、移动身体、清理失效引用或自动修复历史事实。

## 运行结果

```text
node --version  → v24.14.1
npm  --version  → 10.9.0

npm run typecheck  → 通过
npm run build      → 通过
npm test           → 352 passed（12 个测试文件；新增 31 项 topology-anchor-query 测试，
                      既有 topology-query / topology-store / fragment-store 等全部保持通过）
npx tsx examples/historical-anchor-query.ts → 正常运行（以公开包名导入，先 build）
独立安装验证       → npm pack 后安装到全新临时消费者目录，node 运行 + 严格 tsc 类型检查均通过
git diff --check   → 通过（仅 LF/CRLF 行尾提示，无空白错误）
```

示例 `examples/historical-anchor-query.ts` 以公开包名 `curio-minecraft-3d-memory` 导入（非源码
路径），实际走包的 `exports` 入口；独立安装验证为：`npm pack` → 全新消费者目录
`npm install <tgz>` → `node` 运行与 `tsc`（`skipLibCheck: false`）类型检查均通过。

未进行真实 mineflayer/Curio 游戏验收；本阶段不以真实游戏为验收前置。
