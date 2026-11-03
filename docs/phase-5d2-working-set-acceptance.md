# 第 5D2 批验收记录：有界工作集管理与路线 Pin 生命周期

> 本文件是本批次的独立验收记录。它是本任务新增的文件，不覆盖、不修改
> `docs/spatial-memory-library-design.md` 中用户已有的未提交改动。

## 结论

**阶段 5D2 完成。** 在保持 5D1 手动按需驻留与默认 eager 加载不变的前提下，新增**由调用方显式启用的有界
工作集管理器**，形成可验证闭环：

提交需求 → 保护请求集合 → 检查容量 → 安全淘汰（LRU）→ 有界加载 → 返回工作集与租约 → 合法观测与路线复验
→ 执行 → 完成/取消/替换后释放租约 → 后续请求复用或淘汰。

需求集合由调用方决定；加载历史数据不代表观察到当前世界，也不代表路线当前可通行。管理器不成为空间事实、
dirty 状态或保存确认的第二权威源。

## 交付内容

| 文件 | 内容 |
|---|---|
| `src/voxel/lru.ts` | `LruOrder`：确定性的 LRU 顺序（运行态缓存元数据，不持久化） |
| `src/voxel/snapshot.ts` | `estimateVoxelSectionResidentBytesFromCommitted`：未加载 Section 驻留成本保守上界（仅用于淘汰规划） |
| `src/voxel/voxel-map.ts` | `residentSectionKeys()`、`pinState()` 两个有界只读访问器（供 LRU 对齐与 Pin 统计） |
| `src/storage/sqlite/types.ts` | `SpatialSession` 新增 `voxelLoading`/`residencyLimits` 两个只读 getter |
| `src/storage/sqlite/spatial.ts` | 实现上述两个 getter（私有字段改名以避名冲突） |
| `src/storage/sqlite/working-set.ts` | `WorkingSetManager`（`prepare`/`free`/`stats`）、`resolveWorkingSetLimits` 与相关类型 |
| `src/storage/sqlite/index.ts`、`src/index.ts` | 公共导出 |
| `tests/working-set.test.ts` | 23 项契约测试（LRU + 估算 + 真实 SQLite 工作集 + Fake 路线闭环 + v2→v3 迁移回归） |
| `examples/working-set.ts` | 可运行示例（以公开包名与子路径导入，含 Fake 路线生命周期） |
| `README.md` / `README_ZH.md` | 中英文说明更新 |

## 公共 API

```ts
import { openSpatialSession, WorkingSetManager } from 'curio-minecraft-3d-memory/storage/sqlite';
import type { SectionKey } from 'curio-minecraft-3d-memory';

const session = await openSpatialSession({ databasePath, worldId, voxelLoading: 'manual' });
const manager = new WorkingSetManager(session, { maxEvictionCandidates: 1024, maxUnloadSections: 512, maxDiagnostics: 256 });

const r = await manager.prepare([key]);
r.prepared / r.alreadyResident / r.loaded / r.noRecord / r.notReady / r.evicted / r.evictionRejected / r.capacity / r.lease / r.diagnostics;

manager.free({ sections: 4 });  // 或 manager.free() 清空全部可淘汰项
manager.stats();                 // { residentSections, residentBytes, maxResidentSections, maxResidentBytes, lruTracked, pinnedLeases, pinnedSections }
```

`CapacityGap.kind` 覆盖：`request_too_large` / `no_eligible_candidates` / `candidate_budget_exhausted` /
`unload_budget_exhausted` / `count_capacity` / `byte_capacity` / `busy` / `closed` / `read_failed`。

## 租约与准备契约

- 在修改状态前完成整批校验（worldId/维度/整数坐标）与请求规模检查；`worldId`/坐标不合法直接抛
  `PersistenceError('invalid_argument')`，请求超 `maxLoadBatchSections` 返回 `request_too_large`，两者都不产生部分淘汰或泄漏租约。
- 先 `pinSections` 保护本次请求集合（已驻留 + 待加载），再选择淘汰对象；保护覆盖请求中已驻留与待加载的 Section，
  不会为装后半部分而淘汰前半部分。
- 成功将临时租约交给调用方；硬失败（busy/closed/读取失败/容量）释放本次临时租约。租约是独立 token，复用/释放
  他人租约不可能；旧任务迟到释放不影响新任务。
- 「准备成功」= 请求中的 Section 全部驻留且受返回租约保护；只说明数据可供读取，不说明 FRESH/OPEN/已满足执行条件。
  `no_record`/`notReady` 分别表达，缺记录绝不报为全部准备成功，也不创建虚构 Section、不填空气、不触发观察。

## LRU 与淘汰规则

- 简单确定 LRU：成功命中（已驻留）与成功加载都推进访问顺序；新驻留段有确定初始位置。LRU 序号是运行态缓存元数据，
  不替代 `observedAt`/`sequence`/`Section.revision`/`saveRevision`/保存批次，不作为空间事实持久化，不因缓存访问刷新证据时间。
- 普通只读查询（`stats`/`sectionResidency`/`cellAt`）不触发加载、淘汰、保存或扫世界。
- 只淘汰满足条件的 Section：有已确认提交记录、无未保存变化、无有效 Pin、无冲突在途操作、不属于本次请求集合。
  最终卸载仍经 `session.unloadSections` 安全检查；不凭此前缓存的候选状态绕过最新 dirty/Pin 保护。
- 直接调用既有 `loadSections`/`unloadSections`/`observe` 后，`stats()` 仍把 LRU 索引与真实驻留集合对齐，不要求放弃既有公开入口。
- 卸载只释放运行态数据，保留目录/历史/数据库记录与原证据；驻留变化继续经现有机制局部失效缓存与路线。

## 容量与有界处理

分别受限并验证：驻留数量/计费字节（`ResidencyLimits`）、单次需求集合（`maxLoadBatchSections`）、候选检查数
（`maxEvictionCandidates`）、单次卸载数（`maxUnloadSections`）、诊断结果规模（`maxDiagnostics`）。不靠扫整份历史或
反复加载失败试探容量。

- `committed.bytes`（落盘 payload 字节）与 `residentSize().bytes`（驻留计费）不能互换；`prepare` 用
  `estimateVoxelSectionResidentBytesFromCommitted`（保守上界）做淘汰规划，权威驻留核算仍在 `installLoadedSections`。
- 能在淘汰前判定整请求即使清空可淘汰缓存也无法容纳时，返回 `byte_capacity`/`count_capacity`；没有合格候选、达到候选
  检查上限、达到卸载上限返回不同结构化原因。全部候选 dirty/被 Pin 时返回容量缺口，保存仍由调用方显式 `checkpoint`。

## 新观测与部分失败

- `observe`/`observeBatch` 保持同步证据入口，不隐式查库或跑淘汰循环；向已保存未驻留 Section 写入仍遵守 `requires_load`；
  新 Section 创建与观测增长继续由地图容量边界检查。
- 允许部分安全卸载后加载失败：如实报告已卸载/已加载/未完成，不声称无副作用或全部成功，不自动重载旧段伪装回滚，
  不删除数据库事实、不清除无关 dirty；单批加载仍保持校验失败不部分发布的既有契约。
- 展示显式腾空间后重投观测的用法，保留原 `observedAt`/`sessionId`/`sequence`/来源（测试覆盖）。

## I/O 与生命周期

复用现有单在途 I/O；`prepare` 的显式加载与 `checkpoint` 共享互斥/拒绝语义（`busy`）。继续：同步合法观测按既有规则、
`busy` 明确返回不建隐藏无界队列、读取超时不伪造未知写入、关闭/超时/迟到响应不安装到失效请求、旧任务清理不影响新任务、
`flush` 只等已接受保存、`close` 不隐式捕获新 checkpoint。不重新引入自动重试/自动保存/额外 Worker。

## 路线 Pin 闭环

`examples/working-set.ts` 与测试用真实 SQLite + Fake 执行器跑通：提供短同高 walk 点列 → 准备已保存 Section → 合法新观测
恢复当前证据 → 通过 `RouteVerifier` 复验 → 按实际依赖（跨 Section 的支撑/净空/读取邻格）Pin → Fake 执行到 `ARRIVED` →
完成/取消/替换后释放租约 → 释放后可淘汰。工作集压力下受保护依赖不被淘汰；旧任务迟到释放不解除新任务保护；未准备好/未知/
过期不启动移动。路线保护由明确的调用方组合层实现，执行器不改造成存储管理器。

## 迁移回归

`tests/working-set.test.ts` 补齐 5D1 已发现但尚未固化的真实迁移回归（沿用当前已通过的 `selectMigrationBatch` 算法）：

- **跨 100 行元信息窗口**：130 段跨两个 100 行窗口，`rowid` 游标翻页回填全部成功，schema 升到 v3，元数据列正确。
- **后批回填失败整体回滚**：第 120 段（第二个窗口）payload 损坏，整个 v2→v3 事务回滚，数据库仍为 v2、无回填列。
- **跨字节子批**：继续由既有纯函数测试 `tests/migration-batch.test.ts` 覆盖（55 段 × ~1.25 MB 缩小分批而非拒绝）。

## 运行结果

```text
node --version  → v24.14.1
npm  --version  → 10.9.0
better-sqlite3  → 12.11.1（native binding 实测通过）

npm run typecheck  → 通过
npm run build      → 通过
npm test           → 516 passed（18 个测试文件；新增 23 项 working-set 测试）
npx tsx examples/working-set.ts → 正常运行（以公开包名与子路径导入，Fake 路线 ARRIVED）
git diff --check   → 通过
```

验证过的关键契约（`tests/working-set.test.ts`）：

1. 默认模式与既有 5A/5B/5C/5D1 行为兼容（既有 493 项测试保持通过）。
2. eager 会话在构造管理器时被拒绝。
3. 请求去重、作用域校验失败前无部分修改、无租约泄漏。
4. LRU 命中改变正确候选，相同条件下结果确定。
5. 请求集合自身不会被腾空间过程淘汰。
6. dirty、未提交、被 Pin 候选以结构化原因上报。
7. 数量预算足够但字节不足（`byte_capacity`）与反向（`count_capacity`）。
8. 请求过大（`request_too_large`）、候选预算耗尽（`candidate_budget_exhausted`）。
9. `no_record` 与读取失败（`read_failed` → `load_failed`）区分。
10. 普通只读查询零隐式 I/O；直接使用旧公开入口后索引仍一致。
11. `busy`（checkpoint 在途）、保存 ACK 期间新变化仍保持 dirty。
12. 新观测容量拒绝、显式腾空间、原证据重投。
13. 长期循环访问更大已保存集合后段数/计费/Pin/索引无漂移。
14. 完成/释放后的 Fake 路线租约闭环；受保护依赖不被淘汰。
15. v2→v3 跨窗口回填与后批失败整体回滚。

## 本轮未实现

- 预测预取、后台定时淘汰；自动 checkpoint、后台重试、自动保存策略；
- 观察 overlay、隐藏缓存重投；新寻路、跳跃、台阶、梯子、水面及船；
- Curio 源码修改与真实 mineflayer 接线；旧 JSON 账本迁移、历史增量化、事件日志及压缩。

本轮只根据调用方明确需求管理缓存资源，不选择 Agent 的目的地或行动策略；不宣称已完成大世界自动缓存或真实游戏验收。
