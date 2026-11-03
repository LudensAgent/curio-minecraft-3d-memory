# 第 5D1 批验收记录：Section 显式按需加载、安全卸载与 Pin 保护

> 本文件是本批次的独立验收记录。它是本任务新增的文件，不覆盖、不修改
> `docs/spatial-memory-library-design.md` 中用户已有的未提交改动。

## 结论

**阶段 5D1 完成。** 在保持 5B/5C「默认全量启动恢复」不变的前提下，新增**显式选择的手动按需加载模式**，
形成闭环：建立保存记录 → 手动打开只读目录 → 显式 `loadSections` → 接受合法观测 → 增量 `checkpoint` → 确认
保存 → 安全 `unloadSections` → 再次加载，事实不丢失、旧证据不变新。

默认 `openSpatialSession` 的完整恢复行为与 `openHistorySession` 的调用、保存、恢复和错误语义保持不变；只有显式
传入 `voxelLoading: 'manual'` 才进入新模式。本批不实现自动 LRU、预取、未加载 Section 的观察 overlay 或自动保存。

## 交付内容

| 文件 | 内容 |
|---|---|
| `src/voxel/residency.ts` | 驻留状态、目录、Pin 租约、卸载结果与 `ResidencyLimits` 类型、默认值与 `resolveResidencyLimits`、`VoxelResidencyError` |
| `src/voxel/snapshot.ts` | `estimateObservationResidentGrowth`（单次观察驻留字节增长保守上界） |
| `src/voxel/voxel-map.ts` | `manualResidency` 模式：目录安装、驻留状态、写入预检（`requires_load` + 驻留预算）、`installLoadedSections`/`unloadSections`/`pinSections`/`releasePins`/`sectionResidency`、`checkpointFullCounts`、`checkpointSnapshot` 部分驻留拒绝 |
| `src/traversability/cache.ts` | `TraversabilityCache.invalidateSections(keys)`（按 Section key 局部失效，不依赖 revision） |
| `src/traversability/route.ts` | `RouteVerifier.invalidateSections(keys)`（丢弃依赖步骤结果并转发缓存） |
| `src/storage/sqlite/types.ts` | `VoxelLoading`、`LoadSectionsResult`、`load_sections` 线协议、`open` 带 `voxelLoading` 与目录响应、`timeout` 错误 kind |
| `src/storage/sqlite/worker.ts` | schema v2 → v3（`spatial_sections` 新增 `observed_cells`/`palette_entries`/`revision` 列并回填）、目录读取、`load_sections` 处理、增量提交后完整集复核用列 |
| `src/storage/sqlite/spatial.ts` | 会话新增 `voxelLoading`、`sectionResidency`/`loadSections`/`unloadSections`/`pinSections`/`releasePins`、`checkpoint` 用 `checkpointFullCounts` |
| `tests/spatial-voxel-residency.test.ts` | 20 项契约测试（纯 VoxelMap 驻留 + 缓存/路线失效 + 真实 SQLite/Worker） |
| `examples/spatial-residency.ts` | 可运行示例（以公开包名与子路径导入） |
| `README.md` / `README_ZH.md` | 中英文说明更新 |

## 公共 API

```ts
import { openSpatialSession } from 'curio-minecraft-3d-memory/storage/sqlite';
import type { SectionKey } from 'curio-minecraft-3d-memory';

const session = await openSpatialSession({ databasePath, worldId, voxelLoading: 'manual' });
const key: SectionKey = { worldId, dim: 'overworld', cx: 0, cz: 0, sy: 4 };

session.sectionResidency(key).residency;       // no_record | not_resident | loading | resident | load_failed
const { loaded, missing } = await session.loadSections([key]);
session.unloadSections([key]);                 // 结构化卸载（pinned/dirty/not_committed）
const lease = session.pinSections([key]);
session.releasePins([lease.token]);
```

`VoxelMap` 自身也暴露同样的 `installDirectory`/`sectionResidency`/`installLoadedSections`/`unloadSections`/
`pinSections`/`releasePins`，且 `observe`/`observeBatch` 的驻留预检在 `VoxelMap` 内部完成——不能只保护 session
包装方法而绕过 `session.voxel.observe`。

## 目录与加载语义

- 手动打开用 `loadVoxelDirectory` 读取 `id/seq/octet_length(payload)/observed_cells/palette_entries/revision`，
  **不解码任何 payload**；先检查字节/数量预算，再物化目录。目录本身受 `maxVoxelSections`/`maxBytes` 约束。
- `loadSections` 去重、限制请求规模（`maxLoadBatchSections`），在读取 payload 前检查所选记录字节总量，只解码
  请求的 Section；`restoreVoxelSection` 校验 codec/作用域/坐标/格索引/证据一致性，任一损坏整批拒绝。
- 回载证据保留原 `observedAt`/`sessionId`/`sequence`/来源，统一转 `STALE`；不重放 `observe`、不置脏、不推进
  `saveRevision`、不产生当前 `OPEN`。加载/卸载/Pin 都不推进保存修订，也不清除其他 Section 的 dirty。

## 显式预加载写入契约

- 目录确认不存在的全新 Section：按原规则同步接受观测，仍受驻留预算限制。
- 已保存但未驻留、或正在加载的 Section：在修改内存前抛出 `VoxelResidencyError`（`code: 'requires_load'`），
  携带 Section 范围。
- `observeBatch` 在写入前完成整批驻留与容量预检，未就绪 Section 不会留下半批写入。
- 约束覆盖 `VoxelMap.observe`/`observeBatch` 本体，不依赖 session 包装。

## 驻留状态与 Pin

- `sectionResidency` 区分 `no_record`（确认无保存记录）、`not_resident`（有记录未驻留）、`loading`（加载中）、
  `resident`（已驻留）、`load_failed`（加载失败）。加载失败不转成「无记录」，未驻留不转成「从未观察」。
- `unloadSections` 只卸载「已提交、无未保存变化、无在途、未被 Pin」的 Section，其余给出结构化原因
  （`pinned`/`dirty`/`not_committed`）；只释放运行态 payload，不删目录、不清历史、不自动保存、不标从未观察。
- Pin 用独立租约：多调用方可保护同一 Section，释放只释放自身 token，重复/未知 token 释放为无操作，旧任务释放
  不解除新任务保护；Pin 不隐式加载、不刷新证据；租约数与覆盖 key 数有界（`maxPins`/`maxPinnedSections`）。

## 派生缓存与路线失效

- `TraversabilityCache.invalidateSections` 与 `RouteVerifier.invalidateSections` 按 Section key 局部失效，不依赖
  `Section.revision`（驻留变化不推进 revision）。卸载后不再返回旧 `OPEN`，回载后不再卡在此前 `UNKNOWN`，相同
  revision 的回载也不复用卸载前结论；无关 Section 的缓存与路线不清空。测试覆盖「只影响指定 Section」。

## 增量保存与四类容量

- 完整已提交集合：`maxVoxelSections`/`maxObservedCells`/`maxPaletteEntries`/`maxBytes`（增量事务内用 `SUM` 列
  复核，不依赖主线程驻留计数）。
- Section 目录：`maxVoxelSections`（数量）+ `maxBytes`（payload 字节）。
- 驻留工作集：`maxResidentSections`/`maxResidentBytes`（`ResidencyLimits`，计量口径为 `estimateVoxelSectionBytes`
  的保守编码估算，非精确堆内存）。
- 单次加载/保存批次：`maxLoadBatchSections` + 保存批次字节预检。

`checkpoint` 在增量分支改用 `checkpointFullCounts()`（驻留 + 目录），部分驻留时内存计数不再冒充完整数据集。
`checkpointSnapshot()` 在部分驻留时明确拒绝，不返回「仅驻留部分」冒充完整快照。

## schema 升级

v2 → v3：`spatial_sections` 新增 `observed_cells`/`palette_entries`/`revision` 三列，`VACUUM INTO` 一致备份后，
在单事务内加列、从既有 payload 一次性有界回填、更新版本；失败回滚到仍为 v2 的数据库。v1 路径先 v1→v2 再
v2→v3。现有 v1/v2 历史、ID、顺序与绑定保留；增量提交与满集复核同时写这些列，不形成第二套权威源。

## 运行结果

```text
node --version  → v24.14.1
npm  --version  → 10.9.0
better-sqlite3  → 12.11.1（native binding 实测通过）

npm run typecheck  → 通过
npm run build      → 通过
npm test           → 484 passed（16 个测试文件；新增 28 项 spatial-voxel-residency 测试）
npx tsx examples/spatial-residency.ts → 正常运行（以公开包名与子路径导入）
git diff --check   → 通过（见提交前检查）
```

验证过的关键契约（`tests/spatial-voxel-residency.test.ts`）：

1. 默认模式兼容既有 5A/5B/5C 行为（既有 456 项测试保持通过）。
2. 手动打开只读目录，不解码 payload（`sectionResidency` 为 `not_resident`，`cellAt` 为未观察）。
3. 只加载请求的 Section，其余保持未驻留；`missing` 与 `no_record` 正确。
4. 已保存但未驻留的观察被 `requires_load` 拒绝；加载后携原时间重投成功。
5. `observeBatch` 未就绪 Section 不留下半批写入。
6. 全新 Section 可接受观察，且受 `maxResidentSections` 预算约束。
7. 观察一格、保存、卸载、回载后，同 Section 其他格不丢（原事实与原时间）。
8. 回载保留原时间和来源，转 `STALE`，不冒充新观察或当前 `OPEN`。
9. 损坏 payload 加载失败读作 `load_failed`，绝不当 `no_record`，且后续观察仍被拒绝。
10. dirty、被 Pin、未提交的 Section 不能卸载（结构化原因）。
11. 多租约、重复释放、旧任务释放不破坏其他保护。
12. `invalidateSections` 只丢弃依赖指定 Section 的缓存项与路线步骤。
13. 部分驻留增量 checkpoint 不删除未加载记录（未加载 Section payload 字节级不变）。
14. 负坐标、多维度手动加载正确。
15. `loadSections` 与 `checkpoint` 共用单在途 I/O，冲突报 `busy`。

## 本轮未实现

- 自动 LRU、自动淘汰、预测预取；未加载 Section 的 observation overlay 或异步合并；
- 自动保存、后台重试、自动拆批；历史与拓扑增量化；
- Curio 旧 JSON 迁移、双写；事件溯源、动作日志、压缩；
- 新寻路、垂直移动、水面或船；真实 mineflayer/Curio 接线与路线保护自动接通；
- 当前通行结果或执行任务的持久化。

本轮是手动按需加载与安全驻留机制，不宣称已完成大世界自动缓存或真实游戏验收。

## 评审修正（P1/P2/P3）

针对一轮代码评审的问题做了修正，并各加回归测试：

- **P1 装入旧快照覆盖未保存新观测**：`installLoadedSections` 现整批预检，拒绝装入任何「已驻留」的 Section
  （加载是安装非驻留 Section 的窄入口，覆盖会替换运行时事实并使 `pendingSections` 指向被替换对象）。回归测试
  「installLoadedSections refuses to overwrite a resident section」。
- **P2 驻留变化未接入缓存/路线**：`VoxelMap` 增加每 Section 驻留代次（卸载/装入各 +1，观察不变）。
  `TraversabilityCache` 与 `RouteVerifier` 按依赖代次自动失效，无需显式 `invalidateSections`——卸载支撑 Section
  后评估为 `UNKNOWN`（不再返回旧 `OPEN`），回载后评估为 `STALE`（不再卡在此前 `UNKNOWN`），无关 Section 不受影响。
  回归测试覆盖缓存与路线验证的自动失效，以及「按路线实际依赖取得 Pin、释放后可卸载」。
- **P2 保存 ACK 未更新目录**：`checkpoint()` 捕获待提交 Section 快照与模式，ACK 到达时 `commitDirectory` 用捕获
  快照更新目录（`full` 替换 / `incremental` upsert），不读 ACK 时最新内存。新 Section 保存成功后卸载不再报
  `not_committed`，已有 Section 更新后目录格数/palette/版本/字节数同步。回归测试「a confirmed checkpoint updates
  the directory」与「an incremental checkpoint refreshes the committed metadata」。
- **P2 驻留字节预算漏计与漂移**：`estimateObservationResidentGrowth` 改为合成单格 Section 的完整
  `estimateVoxelSectionBytes`（保守上界，不再低估）；`markStale`/`beginSession` 经 `markSectionCellsStale` 统一
  增减账（staleReason 增长计入）。新增 `VoxelMap.residentSize()` 供观测，回归测试「markStale accounts for
  resident byte growth」。
- **P2 v2→v3 迁移无界读取全部 payload**：`openDatabase` 接收 limits，`upgradeV2ToV3` 先做 `COUNT`/`octet_length`
  元数据预检（超限在解码前拒绝），再用稳定 `rowid` 游标分批解码/回填并逐批校验 observed-cells/palette 上限，
  事务回滚保留。
- **P2 读取超时释放单在途限制但旧任务仍在 Worker**：`load` 超时改为毒化会话（`lifecycle='closed'` + 终止
  Worker + 拒绝全部 pending），不伪造未确认 checkpoint，也不允许超时重试形成无界队列；继续以 `timeout`（读取）
  区分 `timeout_unconfirmed`（保存结果未知）。
- **P3 Pin 作用域校验缺口**：`pinSections` 在任何状态修改前对全部 key 做 `assertSectionKey`（worldId/dim/整数
  坐标），异世界 key 不能按当前地图坐标建立保护。回归测试「pinSections rejects a key from another world」。
