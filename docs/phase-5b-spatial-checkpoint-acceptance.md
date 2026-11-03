# 第 5B 批验收记录：最近观测地图的有界、显式保存与启动恢复

> 本文件是本批次的独立验收记录。它是本任务新增的文件，不覆盖、不修改
> `docs/spatial-memory-library-design.md` 中用户已有的未提交改动。

## 结论

**阶段 5B 最近观测地图的有界、显式保存与启动恢复完成。**

本批把 `VoxelMap`（最近观测地图）纳入与四类历史事实同一套 SQLite Worker 的持久化闭环，新增
组合入口 `openSpatialSession`，形成「合法观测进入 VoxelMap → 显式 checkpoint → SQLite 事务确认 →
关闭 → 重启恢复原观测事实 → 旧证据全部待重验（STALE）→ 新观测只刷新实际观察到的格」的完整流程。
`checkpoint()` 仍是**唯一**的显式保存触发点；本批不实现按需加载、自动保存、增量保存、压缩、事件
溯源、多写者协调、Curio 旧 JSON 迁移、mineflayer/Curio 接线或新寻路能力。

本批采用**有界数据集的完整启动恢复**：初始化期间完成加载、校验与恢复，成功后才交付会话；超容量时
明确拒绝，不截断、不部分成功；不提供运行时覆盖已有地图的旧快照加载能力。

## 交付内容

| 文件 | 内容 |
|---|---|
| `src/bytes.ts` | 把 `jsonEscapedByteLength` 抽为共享工具（topology 5A 与 voxel 5B 共用），`path-fragment.ts` 重新导出 |
| `src/voxel/snapshot.ts` | `VoxelCheckpointSnapshot` / `VoxelSectionSnapshot` / `VoxelCellSnapshot` / `VoxelCheckpointMeasure` 类型、深拷贝、字节估算与 `restoreVoxelSection` 校验重建 |
| `src/voxel/voxel-map.ts` | `saveRevision`（独立持久化修订）、`checkpointMeasure` / `checkpointSnapshot` / `restoreSnapshot` |
| `src/voxel/index.ts` / `src/index.ts` | 公开导出快照/度量类型 |
| `src/storage/sqlite/types.ts` | 组合会话类型、`SnapshotLimits` 新增体素上限、worker 线协议扩展、`VOXEL_FRAME_BYTES` |
| `src/storage/sqlite/worker.ts` | schema 升到 v2、`spatial_sections` 表、v1→v2 升级（备份 + 事务回滚）、体素编解码、组合 checkpoint 与体素加载 |
| `src/storage/sqlite/spatial.ts` | `openSpatialSession` 与会话实现（组合三 Store 的 checkpoint/flush/close/状态） |
| `src/storage/sqlite/index.ts` | 导出 `openSpatialSession` 与组合会话类型；历史入口保持不变 |
| `tests/spatial-checkpoint.test.ts` | 31 项契约测试（纯 VoxelMap 修订/快照/恢复 + 真实 SQLite/Worker + schema 升级） |
| `examples/spatial-checkpoint.ts` | 可运行示例（以公开包名与子路径导入） |
| `README.md` / `README_ZH.md` | 中英文说明更新 |

## 公共 API

```ts
import { openSpatialSession } from 'curio-minecraft-3d-memory/storage/sqlite';
import type { SpatialSession, SpatialPersistenceState, PersistenceError } from 'curio-minecraft-3d-memory/storage/sqlite';

const session = await openSpatialSession({ databasePath, worldId });
session.voxel;                 // VoxelMap（内存，同步读写）
session.history;               // FragmentStore
session.topology;              // TopologyStore
session.voxel.beginSession(sessionId); // 宿主显式提供本次观测会话身份
await session.checkpoint();    // 显式保存三类 Store，返回 SpatialCheckpointResult
session.getPersistenceState(); // SpatialPersistenceState（分领域修订/基线）
await session.flush();
await session.close();
```

`VoxelMap` 新增：`saveRevision`、`checkpointMeasure(maxBytes?)`、`checkpointSnapshot()`、
`restoreSnapshot(snapshot)`。`restoreSnapshot` 只接受尚未观测过的空地图，是初始化路径，不是运行时的
全量覆盖入口。

## 保存范围与数据格式

只持久化 `VoxelMap` 中真实存在的 Section 与已接受的事实。每个 Section 的**权威字段**：Section 键
（dim/cx/cz/sy）、`palette`、`bits`、`cells`、`evidence`（含完整 `Observation`）、`revision`。
**可重建字段**（不持久化，恢复时确定性重建）：`explored`（evidence 存在性）、`stale`（freshness）、
`lastObservedAt`（最大 observedAt）、`traversed`/`modified`/`risk`（当前 `VoxelMap` 从不写入，恢复为空）。

- 完整保留 `Observation`：`state`（name + 完整 `properties`，不靠字符串拆分）、`stateComplete`、
  `evidence`、`source`、`observedAt`、`observedWorldTick`、`sessionId`、`sequence`、
  `originObservationId`、`actionId` 等。
- 已观察空气、未知、状态不完整分开表达；空 `properties` 不当作完整状态。
- 校验：palette 索引 0 为空气、bits 与 palette 长度一致、cells 长度、evidence 索引范围、重复
  Section/格、作用域/坐标归属，以及 palette/cells/evidence 三者一致、`section.revision` 等于各格
  evidence revision 之和。损坏数据在所属边界拒绝，不用默认零值补成空气。

体素以 `spatial_sections` 表（`world_id`/`seq`/`id`/`payload`）存储，payload 为带 `v:1` 版本号的
JSON，`cells` 用 base64 编码。**体素尚无保存记录**（无 `has_voxel=1` 的 checkpoint）与**已保存一个空
体素集合**（有 `has_voxel=1` 的 checkpoint 但 0 行）可区分。

## 恢复、会话与新鲜度

- 恢复走专用初始化路径，不重放 `observe`/`observeBatch`；只向新的、尚未交付的空 `VoxelMap` 恢复。
- 原 `observedAt`/`observedWorldTick`/`sequence`/来源/动作关联/原 `sessionId` 保持不变；不用保存时间、
  启动时间或当前时间填充；不重新计算或延长 `validUntil`。
- 已保存的 `FRESH` 仅表示旧会话当时状态，恢复后统一 `STALE`（`staleReason: 'observation_gap'`）；
  未观察格仍未知；不恢复通行缓存或可执行 `OPEN`；不生成离线经历。
- 宿主必须通过 `beginSession(sessionId)` 明确提供本次观测会话；磁盘中的 `sessionId` 只作为旧证据来源；
  复用旧 ID 不能把恢复证据变回 `FRESH`。
- 重观察沿用现有顺序、完整性与局部 `ChangeReport` 契约：只刷新实际观察到的格，同 Section 邻格不续签。

## 持久化修订与确认

`saveRevision` 是独立于 `Section.revision`/`CellEvidence.revision` 的持久化修订：已接受且改变待保存事实
的更新推进它（包括 refresh-only 更新）；被拒绝的旧观察、真正幂等输入、只读查询、失败操作不推进。checkpoint
捕获时记录各 Store 修订；ACK 只确认当时捕获的版本，不覆盖之后的新观察/refresh dirty。初始化恢复与转 STALE
属初始化规则，不冒充新观察，初始化后建立恢复基线；无后续事实更新不产生虚假未保存观察。

`SpatialPersistenceState` 区分各领域当前/已确认修订、恢复基线与本会话最后确认提交、dirty、在途、未确认与
保存错误。历史入口与组合入口各自保留真实保存基线；同一组合 checkpoint 内历史与体素可共享 `checkpointId`，
但历史单独更新后不把最新历史 `checkpointId` 当成体素的保存确认。

## 有界与主线程预检

有限默认上限：`maxVoxelSections`（10000）、`maxObservedCells`（1_000_000）、`maxPaletteEntries`
（200_000），与 5A 的 `maxBytes`（64 MiB）一起构成**统一**总体字节预算。主线程先做低成本数量/字符串长度
下界预检，共享剩余预算，在深复制或 `postMessage` 前拒绝；计算世界 ID、维度、属性键值、证据字段、数组/二进制
编码与外层结构成本，保留 5A 对 UTF-8、JSON 转义、数组分隔符与超大 worldId 的修复；不在主线程完整 stringify
或执行 SQL。Worker 用真实 `Buffer.byteLength` 复核，加载前用 `COUNT`/`octet_length` 预检，解码过程中继续
验证结构与容量，不先任意加载整库；主线程可保守高估，Worker 不低估。超限明确失败，不截断、不部分成功、不改
已确认数据库状态。

## schema 升级与旧入口兼容

schema 版本 1 → 2：新增 `checkpoints.voxel_revision`/`checkpoints.has_voxel` 与 `spatial_sections` 表。
升级路径：先校验旧 v1 格式 → 用 `VACUUM INTO` 形成包含 WAL 已提交数据的一致备份 → 在单个事务内加列、建表、
更新版本，失败回滚。保留现有历史记录、ID、顺序、原绑定及其他 worldId 数据；未知版本/损坏数据库不清空、不
回退 JSON、不复活已删除记录。`openHistorySession` 保持原公共调用方式与返回语义，写入只替换历史数据，不清空
或伪造体素数据；新代码的历史入口可用升级后的数据库；5A 旧公共类型不要求体素参数。

## 运行结果

```text
node --version  → v24.14.1
npm  --version  → 10.9.0
better-sqlite3  → 12.11.1（native binding 实测通过）

npm run typecheck  → 通过
npm run build      → 通过（产出 dist/storage/sqlite/index.js + spatial.js + worker.js）
npm test           → 433 passed（14 个测试文件；新增 31 项 spatial-checkpoint 测试，既有 402 项保持通过）
npx tsx examples/spatial-checkpoint.ts → 正常运行（以公开包名与子路径导入）
git diff --check   → 通过
```

包接入验证：`npm pack` 后在独立临时消费者中从 `curio-minecraft-3d-memory` 与
`curio-minecraft-3d-memory/storage/sqlite` 导入并运行，类型声明正确、Worker 构建产物可运行、纯核心不依赖
SQLite 原生模块。未进行真实 mineflayer/Curio 游戏验收。

## 本轮未实现

- 运行时按需加载、LRU、Pin、预取；运行时覆盖活跃地图的旧快照加载。
- 自动保存、增量保存、后台重试队列；压缩、事件溯源、多写者协调。
- Curio 旧 JSON 账本迁移；mineflayer/Curio 身体接入。
- 新寻路、Frontier、水面或其他移动能力。
- 持久化或恢复当前 `OPEN`、执行任务、路线缓存。

本批不宣称已接入真实游戏、自动保存、按需加载或 Curio 迁移。

## 评审修正（P2）

针对一轮代码评审的五个问题做了修正，并各加了回归测试：

- **恢复未核对证据维度/坐标/所属格**：`restoreVoxelSection` 现在校验 `observation.dim` 与 Section 维度、
  由位置分解出的 Section 坐标（cx/cz/sy）与局部格索引（cellIndex）三者一致；异维/异 Section/异格证据原子
  拒绝。
- **恢复与会话激活边界未封闭**：`restoreSnapshot` 只接受「未激活、未观测」的 pristine 地图（无 Section、无
  当前会话、无中断边界），不再仅用「地图为空」判断；新增 `VoxelMapOptions.requireSession`，组合会话强制开启，
  在显式 `beginSession` 前拒绝实时观察，阻止恢复后的旧会话迟到观察自动激活并刷新 STALE 格。
- **组合入口回退世界 ID 预算早停**：`checkpoint()` 先用两个外层结构与 `2 × worldId.length` 的廉价下界拒绝，
  再计算一次转义长度并复用到两个 envelope，保留 5A 已有保护。
- **体素字节估算漏算属性逗号**：`observationBytes` 补齐属性对象括号与属性间逗号，估算对 1000 项属性输入仍保守
  （回归测试断言 `checkpointMeasure().bytes >= 真实序列化字节`）。
- **组合加载在解码后才检查共享字节预算**：`loadVoxel` 改为接收历史占用扣除后的剩余字节预算，在读取/解析
  payload 前用 `octet_length` 拒绝超限；回归测试以损坏的体素 payload 验证按 `capacity`（而非 JSON 解析 `data`）
  拒绝。

## 评审修正（P3）

- **保留宿主配置对象的属性读取语义**：`openSpatialSession` 不再用对象展开复制 `voxelOptions`（对象展开只复制
  自有可枚举属性，会丢失类原型 getter），改为显式读取 `validityWindowMs` / `now` 再强制 `requireSession: true`。
  回归测试用类原型 getter 验证 `validUntil` 使用 `validityWindowMs=100`（而非默认 60000）且 `now=1500` 生效。
- **加强早停测试断言**：世界 ID 早停测试补充 `vi.spyOn`，断言 `checkpointMeasure` / `checkpointSnapshot` 均未被
  调用，锁定「未扫描字符串、未复制快照」的性能修复，而非仅断言最终报 `capacity`。
