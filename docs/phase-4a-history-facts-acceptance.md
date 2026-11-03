# 第 4A 批验收记录：历史路径事实内存层

> 本文件是本批次的独立验收记录。它是本任务新增的文件，不覆盖、不修改
> `docs/spatial-memory-library-design.md` 中用户已有的未提交改动。

## 结论

**第 4A 批历史路径事实内存层已实现并通过独立测试。**

此结论只覆盖「历史路径片段的纯内存存储与查询」。它**不是**完整拓扑、
完整 `SpatialMemoryStore`、持久化系统或真实 Curio 接入已完成。

## 交付内容

| 文件 | 内容 |
|---|---|
| `src/topology/fragment-store.ts` | `FragmentStore`：历史片段 + 经过证据的内存存储与查询 |
| `src/topology/path-fragment.ts` | 新增 `TraversalEvidence` 证据模型；`PathFragment` 字段与含义保持不变 |
| `src/topology/index.ts` | 导出新类与类型 |
| `src/index.ts` | 公开包入口导出 `FragmentStore` 及必要类型 |
| `tests/fragment-store.test.ts` | 43 项契约测试 |
| `examples/fragment-store-history.ts` | 可运行示例（纯公共 API，不依赖 Curio / 游戏 / 数据库） |
| `README.md` / `README_ZH.md` | 中英文说明更新 |

## 三类数据如何表达

**A. 几何记录（`PathFragment`）** —— 描述路径或观测结构的形状。保留既有字段
`id / worldId / dim / kind / entrances / polyline / geometrySource / links /
deepestY / createdAt / lastUsedAt / uses` 及其含义。保存几何不证明亲自经过，
也不证明当前可走；`entrances` 只是参考点，`kind` 为 `bridge`/`built` 不自动产生
亲历连接。

**B. 已确认经过证据（`TraversalEvidence`）** —— 由调用者显式提交哪些位置之间
实际连续经过。字段：`id / fragmentId / from / to / worldId / dim / sessionId /
observedAt / source`，以及可选的执行/动作关联 `executionId` / `actionId`（匹配
执行层的 `executionId` 与 `Observation.actionId`；缺省 = 未知，不补造归属）。
方向性：A→B 不证明 B→A；同坐标的不同真实经过按 `id` 区分，不按坐标去重；
`sessionId`/`observedAt` 可为 `null` 以显式表达缺失，不伪造时间；关联字段参与
幂等比较与冲突判断。

**C. 旧数据（`PathFragment.links` + `geometrySource: 'legacy'`）** —— 原样保留
`{a,b}` 结构与已知历史含义；不为其补造 session / executionId / 观测时间 / 默认
双向连通。`createdAt: 0`、`uses: 0` 等旧值按原样保存，不重置、不推算。

历史与现状严格分离：`FragmentStore` 不接触 `VoxelMap`，不写入方块、不刷新观测
时间、不产生当前 `OPEN`、不启动移动、不授予反向通行。当前地图 BLOCKED / STALE
不会删除历史几何或已发生的经过。

## 读写、分页、删除与容量语义

- **作用域**：实例绑定不可变 `worldId`；每条记录自带 `dim`；查询按 `dim` 过滤。
  不同世界/维度中的记录不会被坐标相同误合并；同 ID 跨作用域冲突会抛出。
- **新增 / 幂等重投递 / 冲突**：`saveFragment` 对「同 ID + 同内容」返回
  `unchanged`（不重复计数、不推进 `uses`）；「同 ID + 不同内容」抛冲突错误；
  `addTraversal` 同理。
- **明确更新**：`updateFragment(id, changes)` 只改显式提供的字段，`createdAt`
  与身份（`id/worldId/dim`）不可变，未提供的 `uses/lastUsedAt` 保持原值。
- **删除**：`forgetFragment(id)` 删除片段及其专属经过证据，不影响其他片段；
  删除不存在 ID 是稳定无操作；删除只能由显式操作触发。
- **只读查询**：`getFragment` / `fragments` / `traversals` 不改变时间、`uses`
  或内容；返回值是深拷贝，调用者修改返回值或写入后的原输入都不污染内部状态。
- **分页**：`fragments`/`traversals` 按 `id` 字典序稳定排序，`after` 为排他游标，
  `limit` 钳制到 `[1, maxQueryBatch]`，`total` 为过滤后匹配总数，无结果返回
  `{ items: [], total: 0 }`。查询先按 id 选页、再深拷贝当页记录，不整表深拷贝。
- **容量**：`maxFragments` / `maxPolylinePoints` / `maxEntrances` / `maxLinks` /
  `maxTraversals` / `maxQueryBatch` 均可配置；超出时抛出明确错误，不静默丢弃、
  不自动淘汰；校验或容量失败后原状态完整。这些是实现容量，不是游戏规则。

## 运行结果

```text
npm run typecheck  → 通过
npm run build      → 通过
npm test           → 249 passed（含新增 43 项 fragment-store 测试，基线 206 项全部保持通过）
npx tsx examples/fragment-store-history.ts → 正常运行（以公开包名导入，需先 build）
独立安装验证       → npm pack 后安装到全新目录，node 运行 + tsc 类型检查均通过
```

示例 `examples/fragment-store-history.ts` 以公开包名 `curio-minecraft-3d-memory`
导入（非源码路径），实际走包的 `exports` 入口；独立安装验证为：`npm pack` →
全新消费者目录 `npm install <tgz>` → `node` 运行与 `tsc` 类型检查均通过。

## 已知限制与后续接缝

本轮**未实现**，按设计后续批次落地：

- 拓扑图（`SpatialNode` / `SpatialEdge`）、碎片自动合并/拆分、路线搜索、
  `Frontier` 选择、`route/surfaceAnchor/deepestAnchor/fragmentation`。
- SQLite 持久化、单个 Worker、批次保存确认与迁移。
- 真实 Curio / mineflayer 感知与执行接线，以及旧 `passages` 查询契约兼容层。
- 自动轨迹采样、自动压缩/简化折线、新移动模式与执行策略。

`SpatialMemoryStore` 仍是目标接口；本批实现的是更窄的历史事实组件，供后续
Store 组合使用，未为其补空方法或恒定返回值。
