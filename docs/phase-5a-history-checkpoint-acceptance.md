# 第 5A 批验收记录：历史事实的显式、有界检查点保存与恢复

> 本文件是本批次的独立验收记录。它是本任务新增的文件，不覆盖、不修改
> `docs/spatial-memory-library-design.md` 中用户已有的未提交改动。

## 结论

**阶段 5A 历史事实的显式、有界检查点保存与恢复完成。**

本批把四类历史事实 —— `PathFragment`、`TraversalEvidence`、`SpatialNode`、以及带原始绑定快照的
拓扑边 —— 通过单个 SQLite Worker 持久化，形成「内存事实 → SQLite 事务提交 → 关闭 → 重启恢复 →
查询结果一致」的闭环。调用者仍通过内存 Store 的同步方法读写，`checkpoint()` 是**唯一**的显式保存
触发点；本批不自动订阅每次 CRUD、不引入定时保存、增量日志或后台重试。

此结论只覆盖「显式、全量（该 worldId 本会话管理的完整历史事实）、带硬上限的 checkpoint 保存与
恢复」。它**不是** VoxelMap/Section 持久化、当前通行缓存恢复、自动保存、增量更新、Curio/mineflayer
接线，也不把历史引用恢复成 `resolved` 说成当前世界可通行。

## 交付内容

| 文件 | 内容 |
|---|---|
| `src/topology/fragment-store.ts` | `FragmentStore` 新增会话内 `revision`（仅实际改变事实时递增）、`checkpointMeasure` / `checkpointSnapshot` / `restoreSnapshot`（窄、有校验的恢复入口），导出 `snapshotEvidence` |
| `src/topology/topology-store.ts` | `TopologyStore` 新增 `revision`、`checkpointMeasure` / `checkpointSnapshot` / `restoreSnapshot`；恢复不经过 `saveEdge` 重绑，保留原绑定快照 |
| `src/storage/schema.ts` | `TABLE_NAMES` 补充 `schema_meta` / `checkpoints` / `traversal_evidence` |
| `src/storage/sqlite/types.ts` | 公共类型：`HistorySession`、`PersistenceError`、`SnapshotLimits`、`CheckpointResult`、`PersistenceState` 等；worker 线协议 |
| `src/storage/sqlite/worker.ts` | `better-sqlite3` 单 Worker 独占连接：建连、同步 SQL、事务、JSON 编解码均在 Worker |
| `src/storage/sqlite/index.ts` | `openHistorySession` 与会话实现：`checkpoint` / `flush` / `close` / `getPersistenceState` |
| `src/index.ts` / `src/topology/index.ts` | 公开导出新的 checkpoint 快照/度量类型（不改公共核心入口的运行时） |
| `package.json` | `./storage/sqlite` 子路径 export；`better-sqlite3` 作为可选 peer dependency；`pretest`/`pretypecheck` 先 build |
| `tests/storage-checkpoint.test.ts` | 33 项契约测试（纯 Store revision/导出/恢复 + 真实 SQLite + Worker + 临时文件） |
| `examples/history-checkpoint.ts` | 可运行示例（以公开包名与子路径导入） |
| `README.md` / `README_ZH.md` | 中英文说明更新 |

## 公共 API

```ts
import { openHistorySession } from 'curio-minecraft-3d-memory/storage/sqlite';
import type { HistorySession, PersistenceState, PersistenceError } from 'curio-minecraft-3d-memory/storage/sqlite';

const session = await openHistorySession({
  databasePath,      // 必填，首版要求绝对路径
  worldId,           // 必填
  fragmentOptions?, topologyOptions?, snapshotLimits?, timeoutMs?,
});

session.history;               // FragmentStore（内存，同步读写）
session.topology;              // TopologyStore（内存，同步读写）
await session.checkpoint();    // 显式保存，返回 CheckpointResult { checkpointId, worldId, fragmentRevision, topologyRevision }
session.getPersistenceState(); // PersistenceState
await session.flush();         // 只等待已接受的 checkpoint
await session.close();         // 停止接受写入并有界关闭 Worker
```

`PersistenceError`（`kind` 为机器可读分类）：`invalid_argument` / `capacity` / `busy` / `closing` /
`closed` / `sql` / `worker_start` / `worker_communication` / `timeout_unconfirmed` / `schema` / `data`。

## 保存范围与格式

只持久化四类历史事实，以及每条证据引用原有的绑定快照：

- `path_fragments`：稳定 ID、worldId/dim、几何坐标、点序、links、entrances、kind、
  `geometrySource`、`deepestY`、`createdAt` / `lastUsedAt` / `uses`。
- `traversal_evidence`：`sessionId` / `observedAt` / `source` / `mode`，以及 `executionId` /
  `actionId` 等可选归属；未知时间保持 `null`，不用 `Date.now()`/保存时间/`0` 补齐。
- `spatial_nodes`：`source` / `kind` / `tag` / `label` / exact/region 精度。
- `spatial_edges`：`type` / `basis` / `fragmentId` / `source`，以及每条引用最初绑定的
  `TraversalEvidence` 快照（`evidenceId` + `snapshot`）与引用顺序。

独立、版本化的格式（schema version = 1）。记录用 JSON payload + 明确 SQL 列（`world_id` / `id` /
`seq`）保存，不把整个世界塞进单个 JSON 文档，不做压缩或几何 delta。`spatial_edges` 不设对
`traversal_evidence` 的删除级联外键：当前权威经过记录缺失是合法的历史状态。

## 显式 checkpoint 生命周期

- **初始化**：`openHistorySession` 建 Worker → 打开/校验 schema → 有界读回该 worldId 的最新
  checkpoint → 校验并重建全新 Store，成功后才交付会话。初始化失败清理 Worker/连接，不暴露半恢复
  状态；空库或尚无该世界记录返回空 Store。
- **checkpoint**：捕获调用时刻的完整历史事实；最多一个在途；已有保存请求在途时在快照复制前拒绝
  `busy`；`closing`/`closed` 同样在复制前拒绝；只有收到对应事务提交确认才返回成功。checkpoint
  固定 `checkpointId`、捕获时的 FragmentStore revision 与 TopologyStore revision。
- **flush**：只等待调用时已接受的 checkpoint，不隐式捕获之后的内存变化；无在途请求时结束等待但
  如实报告 dirty；不把「队列已空」解释成「当前内存事实已保存」。
- **close**：立即停止接受新 checkpoint，在有界总期限内等待已接受的保存请求并关闭 Worker；不隐式
  创建最后一个 checkpoint。正常流程为 `await session.checkpoint(); await session.close();`。返回
  最后确认的 checkpoint、是否有未保存变化、是否存在未确认请求、是否真正完成关闭。关闭的是持久化
  通道，调用者持有的内存 Store 不因此变成自动持久化对象。

所有超时参数有有限默认值（`timeoutMs` 默认 30000ms）并验证合法性；`flush`/`close` 不通过嵌套等待
不断重置原期限。

## 内存修订与保存确认

两个 Store 各持一个会话内 `revision`，仅用于 checkpoint 截点与 dirty 判断：

- 成功且实际改变事实时递增；幂等 `unchanged`、失败写入、删除不存在记录、只读查询均不递增；删除
  片段及其经过证据的级联效果计入变化。
- `revision` 不是时间、观测编号或经过次数；不扩展成通行图版本系统或跨进程协调。`restoreSnapshot`
  会把 revision 重置为 0（恢复基线），修订计数在新会话重新建立，不伪装成跨重启的观测时间。

`getPersistenceState()` 区分：当前内存修订（`fragmentRevision` / `topologyRevision`）、当前会话已
确认的修订（恢复基线或最近确认的 checkpoint）、`dirty`、在途 checkpoint、生命周期、最近保存错误；
`baselineCheckpointId`（打开时恢复的 checkpoint）与 `lastConfirmedCheckpointId`（本会话确认的
checkpoint）分开。收到旧 checkpoint 的确认只确认它捕获的修订：后续修改仍保持 dirty。dirty、保存
错误、提交是否确认是三个不同概念。

## 有界的一致快照捕获

本批采用一次同步、带硬上限的快照捕获：捕获过程不 `await`，两个 Store 在同一事件循环截点取数。
在复制和 `postMessage` 前进行有界预检 —— 总记录数、几何点与 links、边引用及其绑定快照、字符串与
嵌套数据总量。`SnapshotLimits` 提供有限明确的默认值（如 `maxFragments` 10000、`maxBytes` 64 MiB），
超限立即拒绝，不截断后保存为成功；拒绝时内存事实与已有数据库 checkpoint 都不改变。

预检与快照复制在 Store 自己拥有数据的边界进行受控导出（不绕过 private Map、不按 ID 排序的
`edges()` 导出、不反复全图分页）。主线程只做受限预检、快照复制与消息传递；JSON 编解码、SQL 及较重
转换放在 Worker。加载同样有数量与数据体积限制，不先读回任意大的库内容再在主线程截断。

## 原绑定恢复、删除、顺序与 worldId 隔离

- 恢复不通过 `saveEdge()` 重绑，而是走窄、有校验的 `restoreSnapshot`：验证结构、ID、作用域、端点
  与绑定内部一致性，但不要求当前权威引用必须存在或匹配；恢复后再由现有查询逻辑计算
  `resolved`/`missing`/`mismatch`。
- 删除片段及其经过证据重启后不复活；未删除的拓扑边仍可引用历史绑定，恢复后显示 `missing`；同 ID
  证据被替换后恢复仍显示 `mismatch`，不发生隐式重绑。
- 保留边的插入顺序并按该顺序重建 incident 索引，引用数组顺序也保留；4C 的 BFS 路线与 4D 的同高
  候选顺序依赖该顺序，顺序字段只是存储顺序，不是观测时间。
- 一个 checkpoint 在一个事务中完整替换对应 worldId 的历史状态；当前世界的保存不删除另一个世界的
  数据；空历史 checkpoint 明确清空该世界已提交的历史事实。

## 失败语义

至少区分：参数或容量拒绝（尚未接受保存）、`busy`/`closing`/`closed`、SQL 事务失败且已回滚、
Worker 启动/加载/通信失败、超时或 Worker 中断导致提交结果未确认、schema 或数据校验失败。失败不回
滚已接受的内存事实、不伪造保存确认、不清除后续 dirty、不自动清空数据库、不回退旧 JSON 复活已删除
记录、不自动重试至成功或无限等待。

Worker 在提交后、回传确认前中断时，数据库可能已提交但调用方尚未确认：如实报告 `未确认`
（`timeout_unconfirmed`），不断言「肯定没有写入」。超时后进入明确的不可继续写入状态并终止/关闭
Worker；所有已接受请求都得到成功确认或明确失败，Worker error/exit 不留下永久 pending Promise。

故障注入留在内部测试接缝或测试进程中；本批未向公开 API 暴露任意 SQL 或生产故障开关。真实的
「提交后丢失确认」「Worker 崩溃」等竞态按上述语义实现并在代码中处理，但不以生产公开开关测试；由
超时路径与拒绝路径契约覆盖。

## 原生依赖与 Node 兼容

- `better-sqlite3` 为**可选 peer dependency**（`peerDependenciesMeta.optional`），纯核心入口
  `curio-minecraft-3d-memory` 不加载原生驱动、不启动 Worker、不建库、不建文件；未安装时只有显式
  `openHistorySession` 才明确失败。
- 锁定并验证 `better-sqlite3 ^12`（实测 12.11.1），其 `engines` 为 Node `>=20`；本库核心保持
  `engines.node: >=18` 不变（未悄悄提高）。SQLite 子入口需要 `better-sqlite3 ^12`（Node >=20），
  核心包本身仍支持 Node >=18。
- Worker 使用 `new URL('./worker.js', import.meta.url)` 的稳定资源路径，打包产物包含实际 Worker
  文件，不依赖 `src`、`tsx`、开发机绝对路径或进程工作目录。

## 本轮未实现

- VoxelMap / Section 持久化与按需加载；当前通行缓存、`OPEN` 状态或执行任务恢复。
- Curio、mineflayer 接线；旧 JSON、容器、放置、访问、传送账本迁移。
- 自动保存、增量更新、WAL 事件溯源；LRU、后台压缩、多数据库写者；Frontier 或新导航能力。

历史引用恢复成 `resolved` 只表示原历史引用匹配，不代表当前世界可通行。重启不刷新观测时间、不编造
离线经历，不把旧经过证据变成新会话的亲历。

## 运行结果

```text
node --version  → v24.14.1
npm  --version  → 10.9.0
better-sqlite3  → 12.11.1（native binding 实测通过）

npm run typecheck  → 通过（pretypecheck 先 build）
npm run build      → 通过（产出 dist/storage/sqlite/index.js + worker.js）
npm test           → 385 passed（13 个测试文件；新增 33 项 storage-checkpoint 测试，
                      既有 topology / fragment / voxel / traversability 等全部保持通过）
npx tsx examples/history-checkpoint.ts → 正常运行（以公开包名与子路径导入，先 build）
npm pack 后独立临时消费者安装        → 见下方「包接入验证」
git diff --check   → 通过
```

示例 `examples/history-checkpoint.ts` 以公开包名 `curio-minecraft-3d-memory` 与子路径
`curio-minecraft-3d-memory/storage/sqlite` 导入，演示 写入 → checkpoint → close → reopen →
查询一致，并演示 `missing` 与 `mismatch` 在恢复后仍被保留。

未进行真实 mineflayer/Curio 游戏验收；本阶段不以真实游戏为验收前置。
