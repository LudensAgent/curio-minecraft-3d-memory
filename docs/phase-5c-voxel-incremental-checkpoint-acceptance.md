# 第 5C 批验收记录：体素 Section 的有界、显式增量 checkpoint

> 本文件是本批次的独立验收记录。它是本任务新增的文件，不覆盖、不修改
> `docs/spatial-memory-library-design.md` 中用户已有的未提交改动。

## 结论

**阶段 5C 体素 Section 的增量 checkpoint 完成。**

在保持 5B「全量启动恢复、全部 Section 驻留内存」的前提下，本轮把体素保存改为**有界、显式增量**：
第一次没有体素保存基线时建立完整基线，之后 `checkpoint()` 只复制、编码、传递和写入**内部已记录发生
变化（dirty）的 Section**，未变化的 Section 体素 payload 不再被复制或编码。历史路径、经过证据、节点
和边继续沿用 5A/5B 的完整快照保存，不在本轮增量化。

调用者仍通过 `openSpatialSession` 与 `checkpoint()` 使用本能力；`checkpoint()` 仍是**唯一**显式保存
触发点，其逻辑承诺不变：成功确认调用时捕获的三类 Store 状态形成一个原子提交。本轮只改变体素的复制、
传输和 SQL 写入方式，没有把原接口悄悄改成「只保存了任意一部分」。

## 公共调用方式

```ts
import { openSpatialSession } from 'curio-minecraft-3d-memory/storage/sqlite';

const session = await openSpatialSession({ databasePath, worldId });
session.voxel.beginSession(sessionId);
session.voxel.observe(o);      // 同步进入内存，立即可用；同时内部记录该 Section 待保存
await session.checkpoint();    // 有基线后：只传输并写入待保存 Section
await session.close();
```

`VoxelMap` 新增四个最小受控接口（不暴露内部 `Map`/`Set`/`Section` 引用）：

- `checkpointCounts()`：廉价全图计数（sections / observedCells / paletteEntries），无序列化，用于完整
  数据集容量检查；
- `checkpointDirtyMeasure(maxBytes?)`：仅估算待保存（dirty）Section 的转义字节数，带廉价下界早停；
- `captureDirtySections()`：深拷贝仅待保存 Section 的隔离快照；
- `confirmSections(capturedRevision)`：ACK 后按捕获修订清理待保存集合。

## 完整基线与增量提交的关系

- 会话内部维护 `voxelBaselineEstablished`：打开时取 `voxelBaselineCheckpointId !== null`，首次成功
  checkpoint 后置真。首次保存用 `voxelMode: 'full'`（`DELETE` 该世界全部 `spatial_sections` 后全量
  插入），之后用 `voxelMode: 'incremental'`（仅 `INSERT … ON CONFLICT DO UPDATE` 本批 Section）。
- 三种基线情况均已测试：无记录（首存完整基线）、已保存空体素（基线存在但 0 行，后续更新走增量）、
  已有非空基线（只更新 A 时 B 不变）。
- 空增量（无 dirty Section）表示「没有体素变化」，绝不表示清空体素数据；未出现在增量里的 Section 一律
  保留，未包含某个 key 不解释为删除。

## 待保存版本与 ACK 规则

`VoxelMap` 用「按 Section 对象索引的待保存集合」跟踪变化：每个待保存 Section 记录它**最近一次变化时的
全局 `saveRevision`**。这独立于 `Section.revision`，因为 refresh-only 更新推进 `saveRevision` 而不推进
`Section.revision`。`recordSaveChange` 在所有实际改变待保存事实的路径上调用：`observe`、`observeBatch`、
同状态 refresh、`markStale`、`beginSession` 导致的 STALE 变化、新增 Section；被拒绝的旧观察、真正幂等
输入、只读查询、失败操作不调用；`restoreSnapshot` 清空待保存集合并建立干净基线。

`checkpoint()` 捕获全局 `saveRevision` 与各待保存 Section 的隔离快照；ACK 到达后 `confirmSections(捕获
修订)` 只清除「最近变化修订 ≤ 捕获修订」的 Section。因此：

- 保存 A 的 v1 期间 A 又更新为 v2 → ACK 不清除 A（v2 > v1）；
- 保存期间新增 B → B 不在捕获集，保留；
- 保存期间 refresh / 会话切换 / markStale → 对应的更新修订 > 捕获修订，保留 dirty。

`confirmedVoxelRevision` 仍只推进到**捕获**修订，绝不在 ACK 到达时直接取当前修订；旧的全局 dirty 判断
`saveRevision !== confirmedVoxelRevision` 不变。

## 批次预算与完整数据集预算

区分两个概念：

- **本次批次（捕获/复制/传输/编码）**：仅待保存 Section。主线程在深复制与 `postMessage` 前用
  `checkpointCounts()` + `checkpointDirtyMeasure()` 完成有界预检，超限整批拒绝，不复制、不发送；保留
  worldId 长度早停、转义成本、属性成本、二进制编码成本与结构分隔符的既有计量。Worker 用真实
  `Buffer.byteLength` 复核本批编码体积。
- **提交后完整可恢复事实集合**：本轮仍全量启动恢复，因此不能靠连续小增量累积出一个用相同配置无法
  重新打开的数据库。Worker 在增量事务内 `upsert` 后、提交前，用 `COUNT(*)` + `octet_length` 复核更新
  后的完整 `spatial_sections` 数量与字节数，超限抛错回滚整批（含历史与元数据）。

`maxBytes` 同时约束批次与完整数据集（批次是完整集的子集）；`maxVoxelSections` / `maxObservedCells` /
`maxPaletteEntries` 约束完整数据集。主线程不为了估算一个小增量而重新序列化完整地图；历史部分本轮仍全量
处理，其成本如实保留，不宣称整个 checkpoint 已与历史数据量无关。

## Worker 协议与事务

`WorkerRequest.checkpoint` 用显式 `voxelMode: 'none' | 'full' | 'incremental'` 区分三种语义，不再用
「可能为空的 sections 数组」猜测操作：

- `none`：历史保存，不触碰 `spatial_sections`；
- `full`：完整体素替换（首存基线）；
- `incremental`：只 `upsert` 本批 Section，空增量不写、不清库。

历史完整快照、体素增量（或全量）与 checkpoint 元数据在同一事务内成功或回滚。schema 仍为 v2，无需
升级；`spatial_sections` 表结构、稳定 Section 身份（`JSON.stringify([dim,cx,cz,sy])`）与 `seq` 顺序语义
不变。单 Worker、单连接、单持久化权威源不变。

## 失败、超时与关闭语义

- 失败（含增量事务内完整集超限导致的回滚）保留全部未确认变化；内存事实与 dirty 不回滚。
- 提交结果未知沿用 `timeout_unconfirmed`；不自动重试、不把未知当明确未提交。
- `busy` 在测量、复制与 `postMessage` 前拒绝；`flush()` 只等待已接受的保存；`close()` 不隐式 checkpoint。
- 单批超限在复制/发送前拒绝；连续小增量不能绕过完整恢复容量上限。

## 运行结果

```text
node --version  → v24.14.1
npm  --version  → 10.9.0
better-sqlite3  → 12.11.1（native binding 实测通过）

npm run typecheck  → 通过
npm run build      → 通过
npm test           → 456 passed（15 个测试文件；新增 23 项 spatial-checkpoint-incremental 测试）
npx tsx examples/spatial-checkpoint-incremental.ts → 正常运行（以公开包名与子路径导入）
git diff --check   → 通过
```

验证过的关键契约（`tests/spatial-checkpoint-incremental.test.ts`）：

1. 首次保存建立完整基线，重开完整恢复；
2. 基线含多个 Section、只更新 A：B 的 SQL payload 字节级不变、事实与原时间保留；
3. 同状态 refresh 进入增量保存；
4. 属性变化、已观察空气、负坐标、不同维度正确保存；
5. 旧观察、幂等输入、只读查询不增加待保存集合；
6. 保存期间同 Section 新变化 / 新 Section / refresh / markStale 不被旧 ACK 清除；
7. 空增量不清库；历史单独变化仍正确提交且不触碰体素行；
8. 历史保存与组合保存交替，两个领域的基线正确；
9. SQL 失败整批回滚，内存事实与 dirty 保留；
10. busy 保持既有语义；
11. 单批超限在复制前拒绝（`captureDirtySections` 未被调用）；
12. 连续小增量不能绕过完整恢复容量上限（数量与字节两个口径）；
13. 未修改 Section 不因增量遗漏而消失。

`tests/spatial-checkpoint.test.ts` 的世界 ID 早停测试已加强：补充对 `jsonEscapedByteLength`（完整字符串
扫描）的 spy，断言超大 worldId 在廉价长度检查处被拒绝、未进入完整扫描；已手动临时移除长度早停并确认该
测试确实失败（测试变得对早停敏感），再用 `git diff --check` 等确认恢复。

## 本轮未实现

- Section 按需加载、LRU、Pin、运行时卸载；加载旧快照与新观测的运行时合并；
- 自动保存、定时保存、后台重试与自动拆批；历史与拓扑增量化；
- 事件溯源、动作日志、压缩、分布式存储；Curio 旧 JSON 迁移、双写、JSON 回退；
- Curio/mineflayer 真实接线；新寻路、跳跃、水面或其他移动能力；
- 当前通行结论、路线缓存和执行任务的持久化。

本轮仍是有界全量启动恢复；增量只针对体素保存的复制/传输/SQL 写入，不宣称已完成大世界按需缓存。未进行
真实 mineflayer/Curio 游戏验收。

## 评审修正（P1/P2）

- **P1 空基线后再次恢复会漏存**：`restoreSnapshot` 原本只按「无 Section / 无会话 / 无中断边界」判断
  pristine，已交付但尚未激活的空地图仍可再次恢复，其恢复清空待保存集合却不 dirty，导致内存有数据、dirty
  为真、待保存集合为空，`checkpoint()` 以空增量「成功」却漏存。现新增 `VoxelMap.initialized` 与
  `sealInitialization()`，组合会话在初始化完成后调用，交付后的地图（含空基线交付）一律拒绝再次
  `restoreSnapshot`（报 `only available during initialization`）。新增同会话空基线、重开空基线、纯
  `sealInitialization` 三项回归测试。
- **P2 增量更新改写 Section 稳定顺序**：增量 `upsert` 原先用每批局部索引回写 `seq`，已有行被覆盖，导致
  「仅更新后段 Section 后重开顺序改变、数据库出现重复序号」。现改为已有行只更新 `payload`、保留原 `seq`；
  新 Section 从该世界现有 `MAX(seq)+1` 起按批内顺序分配。新增「更新后段 Section 顺序不变」「新增＋更新
  混合批次追加到最大序号之后」两项回归测试（直接断言 `ORDER BY seq` 的 id 序列与 seq 无重复）。
