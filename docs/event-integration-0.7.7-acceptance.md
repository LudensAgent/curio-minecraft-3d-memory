# 0.7.7 journal 独立消费者接入验收记录

> 本文件是本轮 `0.7.7` 的独立验收记录，不改写设计文档或既有验收报告。
> 结论级别为 **Fake 库侧 fixture + 真实隔离打包/安装入口与 SQLite/Worker** 的消费者验收，
> 独立执行已 PASS；它不是 Minecraft 物理、mineflayer 控制、Curio 宿主接线或真实游戏动作的
> 证明，也不证明宿主已经生成 journal。

## 结论与当前状态

- 包版本由 `0.7.6` 升为 `0.7.7`，`package-lock.json` 顶层与根包版本同步为 `0.7.7`；
  最终隔离安装实测包版本为 `0.7.7`。验收 runner 自身仍为 `0.7.6`，这是未改动的
  `runnerVersion`，不是包版本。
- 协调员已在干净 `3334e17916e4521d98bb724b4a50247dcc6357f9` 执行
  `node acceptance/run.mjs --execute`，自然 exit 0，`outcome` 为 **PASS**。
  `sourceBinding` 为 `clean=true`、`headChanged=false`、`releaseBlocked=false`。
- 唯一的新包已生成：`curio-minecraft-3d-memory-0.7.7.tgz`（287202 bytes，解包
  1289051 bytes）。SHA-256 为
  `6e41c763150ecbde01b5234df2a0915408bfb58c53a894ccdcbe036327e7b32d`，npm integrity
  为 `sha512-Ry3/NkWEN9nwMuMXiqLH0U6zvHraJLcVNW4x3LTnYpeCyI5fWKXz05gsvQFVBXMnRkwm03i1ns1u/7D4yD9AHQ==`，
  npmShasum 为 `687785a2145f447a29af9584274ff433a32e53c5`。`packedNonDist` 仅
  `README.md` 与 `package.json`，没有 unexpected 或 missing。
- 该产物固定绑定上述 source commit。后续本 docs 收尾提交与该 commit 不同，但不会重新
  pack，也不会改变源码绑定；本文件不把 docs commit 当作 artifact 来源。
- 本轮未执行 `publish`、`push`、`merge`、`tag` 或 `rebase`；原有 `0.7.6` / `0.7.5`
  产物与报告保留。

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
- v3 → v4 的升级在打开时先执行 `VACUUM INTO <database>.pre-v4-<uuid>` 备份，再在单个
  事务内新增 journal 表与 checkpoint 判别列并更新 schema 版本；旧世界、history 与 voxel
  事实保持，升级后的 journal 初始为空，不会从旧数据合成 journal 历史。
- v1/v2 按 worker 既有路径逐级迁移，而不是把整条旧版本链放进一次 v4 事务：v1 → v2
  先写 `<database>.pre-v2-<uuid>` 备份再在单个事务内升级；v2 → v3 先写
  `<database>.pre-v3-<uuid>` 备份再在单个事务内升级；之后才进入上述 pre-v4 备份与事务。
  每个阶段各自备份、各自提交或回滚。
- 不支持版本降级。任一升级阶段失败时该阶段事务回滚并保留对应备份。

## 协调员独立执行结果（最终证据，2026-11-04）

- runId `1793792566838-52844`；`runnerVersion` 为 `0.7.6`，runnerHash 为
  `cfaee09a6a5bcb72b1d1c29733986f522ac47d30651d3ce4dc91f584b610dc9d`；consumerHash 为
  `0e66fa739d5fcd429151674aa9d7109d80dbabe5d970124a7f08557cba6ae085`。运行环境为
  node `v24.14.1`、npm `10.9.0`、typescript `5.9.3`。
- 步骤退出码：`build` 0、`pack` 0、`install` 0、`consumer:positive` 0、
  `consumer:early-release-pin` 1（预期）、`consumer:skip-final-checkpoint` 1（预期）、
  安装包上的 `tsc` 0。主 `outcome` 为 PASS，`primaryError` 与 `cleanupError` 均为 `null`。
- 负对照仍在原指定 assertion 处失败：early-release-pin 为
  `dependency (overworld, 0, 0, 0) stays pinned during the active walk`；
  skip-final-checkpoint 为 `reopen has the unique final fact`。
- 三次消费者进程的最终资源收尾均为 `completed=true`、`error=null`、
  `unconfirmedRequest=false`，`cleanupError=null`；其中故意未保存场景的 close 为
  `dirty=true`，不称其为 saved。
- positive journal evidence：accept revision 3、pending 3 条/2653 bytes、confirmed 0、
  committed 0、dirty true；三次 checkpoint 的 captured/confirmed prefix 为 1 → 2 → 3，
  前两次仍 pending/dirty，第三次后 pending 0、dirty false、committed 3，原
  `memoryWrite` 仍为 `pending`。reopen 后 revision/confirmed 均为 3，action 分页 1 条，
  event 分页 `hasMore=true → false`（`nextCursor="1" → null`），current/previous 保持原
  session 与时间（2000/500），voxel cell 未写入。
- 运行证据：`C:/Users/Administrator/AppData/Local/Temp/curio-minecraft-3d-memory-acceptance/run-1793792566838-52844/evidence.json`；
  完整 artifact 同目录；命令日志为
  `C:/Users/Administrator/AppData/Local/Temp/curio-memory-release-01a1a486-20261104/independent-release-execute.log`。

## 已复用的既有证据

以下结果在本阶段之前已由独立运行产生，本轮不重复全库或未变更导航套件：

- 主协调员在 `455d543` 的标准配置运行：event 28、incremental 23、spatial 33、storage 50、
  working-set 44，合计 **178/178** 自然 exit 0。
- current scope 一致性修复后，协调员在 `3eaf621` 运行 typecheck（含 build）exit 0；event
  套件 **30/30** 自然 exit 0（3.69s）。日志：
  `Temp/curio-memory-release-01a1a486-20261104/independent-typecheck.log`、
  `Temp/curio-memory-release-01a1a486-20261104/independent-event.log`。
- 未变更的导航 43/26/74/18 组合未在本轮重跑。

## 本树先行自检结果（2026-11-04，非隔离安装）

以下结果为最终独立执行之前的本树自检，保留作为过程证据，不替代上面的隔离安装结果：

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
- 本轮消费者 fixture 是 `fake-library-only`（evidence 中 `hostEnabled=false`），不是宿主
  journal producer，也不声称真实游戏动作发生。host supply 本阶段尚未完成，不宣称宿主接线
  通过。
- 分页验证使用有限的小数据集，不是大容量压力测试。
- self `dist` smoke 只证明本树构建产物可被自引用消费；最终隔离安装、打包内容、类型解析与
  负向对照已由上面的协调员执行覆盖。
- 最终 hash 属于 source `3334e17916e4521d98bb724b4a50247dcc6357f9` 生成的 artifact；
  后续 docs 收尾提交不重新 pack，也不改变该绑定。
