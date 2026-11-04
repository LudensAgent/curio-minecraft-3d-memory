# 0.7.7 journal 独立消费者接入验收记录

> 本文件是本轮 `0.7.7` 的独立验收记录，不改写设计文档或既有验收报告。
> 结论级别为 **Fake 库侧 fixture + 真实公开安装入口与 SQLite/Worker** 的消费者验收；
> 不是 Minecraft 物理、mineflayer 控制、Curio 宿主接线或真实游戏动作的证明。

## 结论与当前状态

- 包版本由 `0.7.6` 升为 `0.7.7`，`package-lock.json` 顶层与根包版本同步为 `0.7.7`。
- 本阶段只准备可审的本地 code commit。**尚未生成本版本的 `.tgz`**，也没有覆盖既有
  `0.7.6` 产物；未执行 `pack`、`publish`、`push`、`merge`、`tag` 或 `rebase`。
- `node acceptance/run.mjs --execute` 仍待协调员在干净 HEAD 上独立执行。该次运行才会生成
  唯一的新包与不可变来源；固定源码 hash、真实 `.tgz` 元数据和最终 PASS 结论均在执行后
  单独报告。本文件不预写这些结果。

## 与 0.7.6 的关系

- 原库 `main`/`0.7.6` 已完成导航、历史与搜索能力；本增量的消费者没有重做已摘取的
  旧分支 `search` / `known` 源码，只沿既有正向流程追加 journal 场景。
- journal 运行时来自本提交之前的三个提交：`455d543`（journal 持久化）、`6d767e8`
  （current scope 一致性修复）、`3eaf621`（journal 边界测试断言）。本阶段不修改任何
  runtime 源码、现有 L1-L5 runner、两个 mutation、final 资源收尾或 provenance 规则。
- 当前宿主**不会自动生成 journal**，也没有注册新的 journal 动作。库只提供公开的显式记录、
  查询与保存确认接口；宿主是否接入由调用方决定。

## 本阶段改动

- `package.json`、`package-lock.json`：版本与 lock 同步到 `0.7.7`。
- `acceptance/consumer.mjs`：在原有导航 API smoke 之后、原 L1-L4 场景之前加入一个有限
  journal 场景。场景使用同一 mkdtemp 目录下的独立 `journal.db`，通过既有 `open` / `close`
  资源登记 helper 顺序打开和关闭；没有另造资源框架，也没有两个 Worker 同时写同一数据库。
- `acceptance/consumer-types.ts`：从安装包的根入口与 `storage/sqlite` 入口消费公共 journal
  类型与函数（`ActionRecord`、`SpatialEvent`、`JournalPage`、接受结果、pending、checkpoint
  结果及 persistence state 的 journal 字段）；不使用相对 `src` 导入或 `as any` 绕过。
- 本文件。没有修改运行时或既有验收标准；原负对照仍在原指定 assertion 处失败。

## 覆盖的公共契约

- 公开同步入口：`session.journal.recordAction` / `recordEvent` / `recordBatch` /
  `readPending` / `withdraw`；异步 `queryActions` / `queryEvents`。
- 结构化 Fake fixture：一条完整 `ActionRecord` 携带原始 `NavResult`（`CANCELLED`、
  部分效果、原 `memoryWrite: 'pending'` 标记），以及两条合法 `SpatialEvent`：
  `observed_cell_change` 的外层与 `current` 的 session/时间严格一致，`previous` 保留更早的
  真实时间与不同 session；另一条为 `observation_gap`。
- 公开负例：`current.sessionId` 不同、`current.observedAt` 不同，均得到
  `PersistenceError`，kind 为 `invalid_argument`；另有一个 `recordBatch` 先含合法事件再含
  错配事件，整体被拒绝。拒绝后 pending 内容、字节数、revision 与 dirty 均不变，原记录不被
  改写。
- `journalLimits.maxBatchRecords = 1` 让三次 checkpoint 分别确认 prefix：
  - 接受仅进入 pending/dirty，不是保存；此时 confirmed revision 为基线。
  - 第一次 checkpoint 的 `journalRevision` 等于实际 ACK 确认的 prefix revision，且小于当前
    队列 revision；仍有 later pending，session 保持 dirty。后续记录不会被旧 ACK 确认。
  - 有限已知条数全部保存后 pending 为 0、dirty 为 false；原 `result.memoryWrite` 不因保存
    被改写为 confirmed。
- 真实 `close()` 走既有 close 登记与 `finalizeResources`；重新打开后通过分页
  `queryActions` / `queryEvents` 读回，校验原 scope、时间、来源、`previous` / `current`、
  `NavResult`、`nextCursor` / `hasMore`。查询不刷新时间、不新增 voxel 事实，读前后
  dirty 与 journal revision 不变。
- journal 记录不修改 voxel/history/topology，因此不影响原 L4 unique fact 断言。

## Schema 与迁移语义

- 当前 schema 版本为 **4**。v4 只是新增 journal 表与 checkpoint 元数据；`0.7.7` 不是纯版本号
  变更。
- 已验证的 v1/v2/v3 → v4 升级会在打开时先写 `VACUUM INTO` 备份
  （`<database>.pre-v4-<uuid>`），再在单个事务内完成 schema 升级；旧世界、history 与 voxel
  事实保持，升级后的 journal 初始为空，不会从旧数据合成 journal 历史。
- 不支持版本降级。升级失败时事务回滚并保留备份。

## 已复用的既有证据

以下结果在本阶段之前已由独立运行产生，本轮不重复全库或未变更导航套件：

- 主协调员在 `455d543` 的标准配置运行：event 28、incremental 23、spatial 33、storage 50、
  working-set 44，合计 **178/178** 自然 exit 0。
- current scope 一致性修复后，协调员在 `3eaf621` 运行 typecheck（含 build）exit 0；event
  套件 **30/30** 自然 exit 0（3.69s）。日志：
  `Temp/curio-memory-release-01a1a486-20261104/independent-typecheck.log`、
  `Temp/curio-memory-release-01a1a486-20261104/independent-event.log`。
- 未变更的导航 43/26/74/18 组合未在本轮重跑。

## 本阶段实际运行结果（2026-11-04）

- `npm run typecheck`：`pretypecheck` 构建 exit 0，`tsc --noEmit` exit 0。
- `node --test acceptance/provenance.test.mjs acceptance/run.test.mjs acceptance/consumer-close.test.mjs`：
  **32/32** 通过，0 失败。
- `npx vitest run tests/shared-session-lifecycle.test.ts --no-cache`：**15/15** 通过。
- `node node_modules/typescript/bin/tsc --noEmit --strict --target ES2022 --module NodeNext
  --moduleResolution NodeNext --skipLibCheck --types node acceptance/consumer-types.ts`：exit 0。
- `node acceptance/consumer.mjs`（本树 self `dist` smoke，**不是隔离安装验收**）：exit 0，
  journal evidence 实际值包括：acceptance revision 3、pending 3 条/2653 bytes、confirmed 0；
  三次 checkpoint 分别 captured/confirmed 为 1、2、3，前两次仍 pending/dirty；全部保存后
  pending 0、dirty false、committed 3，`memoryWrite` 仍为 `pending`；reopen 后事件分页
  第一页 `hasMore=true`、`nextCursor="1"`，第二页 `hasMore=false`、`nextCursor=null`，
  current session/time 与 previous session/time 保持原值，voxel cell 仍未被写入。

## 未证明与已知边界

- `record*` 返回 accepted **不等于** saved；只有 checkpoint ACK 确认对应 prefix。`flush()` 与
  `close()` 不会隐式捕获并保存新的 dirty 状态。
- 上一次 save ACK 丢失但事务实际已经提交的完整组合，本阶段与既有测试都没有单独证明。
- 本轮消费者 fixture 是 Fake/library-only，不声称真实游戏动作发生，也不声称宿主已经接入
  journal。
- 分页验证使用有限的小数据集，不是大容量压力测试。
- self `dist` smoke 只证明本树构建产物可被自引用消费；真正的隔离安装、打包内容、类型解析与
  负向对照需由协调员在干净 HEAD 执行 `node acceptance/run.mjs --execute`。
- 最终 `.tgz` 的 SHA-256、npm integrity、文件清单与固定源码 hash 尚未生成，不得提前引用。
