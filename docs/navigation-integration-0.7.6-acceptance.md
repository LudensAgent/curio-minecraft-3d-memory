# 0.7.6 导航后续整合与独立打包验收记录

> 本文件是本轮整合的独立验收记录，不覆盖、不修改设计文档或旧验收报告。历史背景见
> `docs/navigation-followups-acceptance.md`、`docs/known-walk-route-acceptance.md` 与
> `docs/phase-5e-package-host-integration-acceptance.md`。
>
> 结论级别为 **Fake 几何/身体 + 真实核心与 SQLite** 的库侧验收；不是 Minecraft 物理、
> mineflayer 控制或 Curio 宿主接线的证明。

## 结论

在隔离分支 `codex/spatial-library-followups-20261104` 上，已把两路已审查导航源码分支整合到
基线 `05417465a4542017e4cb6ea41177ec3de7503c6a` 之上，并完成 `0.7.6` 的全新构建、打包、独立安装与消费者验收。

`node acceptance/run.mjs --execute` 由协调员独立执行，顶层 exit 0；正向消费者全部断言通过，
两个负向对照均在预期断言处失败并被判定为 PASS，安装后公开类型 `tsc` exit 0。执行前后源码绑定
干净（`sourceBinding.clean = true`、`headChanged = false`、`releaseBlocked = false`）。
产物为保留在唯一运行目录中的不可变 `.tgz`，本报告及后续 docs-only 提交不改变其源码绑定。

## 整合范围与提交

- **基线**：`05417465a4542017e4cb6ea41177ec3de7503c6a`。
- **搜索分支原始链**：`12daaed3f2442178fb44403e20cd534647386f3c` →
  `fb186731f117ba57e78d1abcf2d49c6eee14b962` →
  `ebbd9fd7eb6a2956cc4d6d68607df2534eb457ce`。
- **已知路线分支原始链**：`6b5bed2e6cc4af235b63f8cf94f12189e6bf3586` →
  `85aeb6a61ea2e1cfadeb9ceebd582d4c8277a869`。
- **整合提交**：`b2cf40c`、`375ce04`、`ee8c835`、`765c96e`、`8eaa9a0`（`8eaa9a0` 为历史路线启动
  边界的修正），随后是 `d009194` 的包消费者验证提交。
- 两个 barrel 导出冲突在本地解决，旧导出与两路新导出均保留；实现、测试与文档文件与各自审查后的
  最终分支逐字节一致。
- 本报告加入前，相对 `05417465a4542017e4cb6ea41177ec3de7503c6a` 的差异为 **13 个文件，+3820 / -10**。

## 公共 API 与契约

根入口新增并完整导出值 `WalkRouteSearch`、`startKnownWalkRoute` 及两路新增的全部类型；没有新增
包子路径。新增能力仍属于库侧事实与执行辅助，不会把这些新增能力注册为 Curio 新动作。

### `WalkRouteSearch`

- 仅同高、固定格点的四邻 `walk` 搜索；有界、只读、增量 BFS，只沿当前评估为 `OPEN` 的边扩展。
- `FOUND` 只表示候选点列，候选 **不等于** `ARRIVED`；到达仍需执行器复验与实测位置确认。
- `exact` 目标要求固定格点；`near` 使用完整 XYZ 欧氏距离，不投影到 XZ。
- 未知边界候选只来自已被实际 `OPEN` 评估证明的 stance；已保存但未驻留/加载中/加载失败的
  Section 单独进入不可用历史输出，不冒充新探索前沿。
- 相关变化报告、证据过期、形状规则版本变化与驻留代次变化都会使派生搜索失效；不自动重试、
  不自动刷新观察。

### `startKnownWalkRoute`

- 从显式指定的 `FragmentStore` 历史片段读取原始有序 polyline，按原顺序交给既有
  `WalkRouteExecutor.start`。
- 只接受 `mode: 'walk'`、`exact` 到达条件与逐段同高、单位步长几何；不取整、不反转、不插值。
- `STARTED` 只表示执行器接受了委托，**不是** `OPEN`，更不是 `ARRIVED`；逐段复验、实测到达、
  观测报告、推进、超时与取消继续由同一个执行器负责。
- `legacy` / `built` 等来源不会写入 `TraversalEvidence`，不会变成亲自走过的路线；
  `parentActionId` 仅为元数据，不连接宿主取消句柄。

### 边界

- 上述两个新 API 未接入 Curio 宿主动作目录、嵌套技能或仲裁注册；Curio 既有的 `walk_route`
  与共享宿主注册在其他工作中完成，本记录不否定其存在。
- 未做真实游戏 / Bot 对上述两个新 API 的物理验证。
- 上述新 API 不自动探索、不选目标、不采集/搭建、不增加材料支出，也不生成玩法策略。

## 版本与不可变产物

| 项 | 值 |
|---|---|
| 包名 / 版本 | `curio-minecraft-3d-memory` @ `0.7.6` |
| 不可变产品/源码提交 | `d0091948bc100e59d2fa98f28a9891669f670e40` |
| 精确 tag | 无（`null`） |
| 产物文件名 | `curio-minecraft-3d-memory-0.7.6.tgz` |
| 产物完整路径 | `C:/Users/Administrator/AppData/Local/Temp/curio-minecraft-3d-memory-acceptance/run-1793782625564-86968/curio-minecraft-3d-memory-0.7.6.tgz` |
| 大小 | `263394` bytes |
| SHA-256 | `f17cac0228ca381d9ac9880a9a2ddf892e0184946a6df7e22a8219c519cf5e27`（协调员独立 `Get-FileHash` 一致） |
| npm integrity | `sha512-4xFyERG9B6btTDwg+Itmf/4zPoiRuOOBfSpN952NybgVzlJFEknzZ4V13C1jNJe4AklrU8mPFbHUHxIv/eXV9w==` |
| npm shasum | `904b14f7b4ffaa24f141e661e2c80521ca07eec2` |
| 运行器哈希 | `cfaee09a6a5bcb72b1d1c29733986f522ac47d30651d3ce4dc91f584b610dc9d` |
| 消费者哈希 | `10c80040b020a286df464aaa64f9ca0d0d37ebdb83f5dd20f2cf20b7ad85d9f3` |

本次 docs-only 提交后 HEAD 会与产物源码提交不同，但**产物绑定仍为 `d009194`**，不重打包、
不移动 tag。旧 `0.7.5` 源码 `5682ea8`、旧报告 `05417465` 与原始 `0.7.5` `.tgz` 均保持不变；
不使用旧的 `0.7.4` 临时包作为证据。

`evidence.json` 与产物同目录；独立运行日志为
`C:/Users/Administrator/AppData/Local/Temp/curio-joint-library-followups-logs-20261104/final-acceptance.log`。

## 最终实际运行

- 命令：`node acceptance/run.mjs --execute`（协调员独立执行，exit 0）。
- runId：`1793782625564-86968`。
- 起止（UTC）：`2026-11-04T08:57:05.565Z` → `2026-11-04T08:57:20.630Z`。
- 环境：Node `v24.14.1`、npm `10.9.0`、TypeScript `5.9.3`。

| 阶段 | 退出码 | 结果 |
|---|---|---|
| build | 0 | `tsc -p tsconfig.build.json` |
| pack | 0 | `npm pack` 生成上述唯一 `.tgz` |
| install | 0 | 独立目录 `file:./<tgz>` 安装并显式安装 `better-sqlite3` |
| consumer:positive | 0 | 全部断言通过 |
| consumer:early-release-pin | 1 | 预期 `AssertionError: … stays pinned during the active walk` |
| consumer:skip-final-checkpoint | 1 | 预期 `AssertionError: reopen has the unique final fact` |
| tsc（安装后公开类型） | 0 | 安装包 `dist` 类型解析通过 |

所有命令的 `signal` 与 `error` 均为 `null`；`primaryError = null`、`cleanupError = null`，
临时消费者目录已实际删除。`--execute` 从干净 `dist` 构建并真实安装 `.tgz`，源码、运行器与
消费者输入绑定均被保留；没有仅凭声明类型的 PASS。

## 安装后消费者证据

### 新导航 API

安装后消费者 stdout 实际记录：

- 搜索：`state = FOUND`，候选点 `(0.5, 0, 0.5) → (1.5, 0, 0.5)`，`edgeCount = 1`。
- 空搜索：`INSUFFICIENT_EVIDENCE`，`frontiers = 0`。
- 已知路线：`STARTED` → 同一执行器以实际 Fake 身体确认 `ARRIVED`（在指定目标处断言）；
  历史库 revision 仍为 `1`，`traversals = 0` 未改变。
- 已安装 `dist` 可解析全部新类型，构造/调用均通过类型检查；只有 `consumer.mjs` 实际执行
  运行时 API，不声称仅经 `tsc` 检查的函数已运行。

### 既有 L1–L5 流

- **L1/L2**：实际共享会话示例与 15 项测试本轮重跑；独立旧验证器漏报/空报告无后续 frame 的取消
  通道、容量主错误、真实关闭与自然退出均保持正确。
- **L3（pin 保护，正向）**：实际在飞步 `activeStepIndex = 0`、`result = null`；`2000` 时干净
  checkpoint revision `12/12`，`3000` 时 revision `24/24`；两个依赖键
  `(overworld, 0, 0, 0)` 与 `(overworld, 0, 0, -1)` 在移动期间 `free()` 均返回 `pinned`；
  `ARRIVED` / `CANCELLED` 后回收；旧租约重叠释放仍 pinned，新租约释放后实际驱逐。
  早释放负向对照中依赖被实际驱逐，随后在预期断言处 FAIL。
- **L4（最终持久化，正向）**：最终 checkpoint
  `90705009-a287-408b-b2cd-319010d0be19`，`voxelRevision = confirmedVoxelRevision = 2`、
  `dirty = false`；`close()` 返回 `completed = true`、`unconfirmedRequest = false`、`error = null`；
  重开后独有事实为 `minecraft:oak_log`、`properties {axis: y}`、`observedAt = 2000`、
  `sessionId = live`、`stateComplete = true`、`freshness = STALE`。
  跳过最终 checkpoint 的负向对照 `close()` 为 `completed = true`、`dirty = true` 且无最终
  checkpoint，重开后该事实 `observed = false`，在预期断言处 FAIL。`completed` 是资源确认，
  不等于所有状态都已保存；`dirty` 可以为 `true`。
- **L5（打包）**：上述干净源码构建、打包、独立安装、类型检查、正负消费者、元数据一致性与
  清理均实际通过。

## 提交前验证

以下为整合完成、干净提交前由实现代理实际执行的结果（日志位于
`package-stream.jsonl`）；本次文档收尾未重跑：

| 命令 | 结果 |
|---|---|
| `npm run typecheck`（含 build） | exit 0 |
| `npx vitest run tests/walk-search.test.ts tests/known-walk-route.test.ts tests/walk-route-executor.test.ts tests/grounded-walk-route.test.ts tests/shared-session-lifecycle.test.ts --no-cache` | 5 个文件，176 项通过（43 + 26 + 74 + 18 + 15），exit 0 |
| `node --test acceptance/provenance.test.mjs acceptance/run.test.mjs acceptance/consumer-close.test.mjs` | 32/32 通过，exit 0 |
| `node --import tsx examples/shared-session-lifecycle.ts` | 自然 exit 0；正常 checkpoint + close/reopen；容量 `maxVoxelSections exceeds limit 1 (2)` 保留原 kind/message，`dirty = true`、`close completed = true` |
| `node acceptance/consumer.mjs` | exit 0（仅 provisionally 解析自身 `dist`） |

额外的 `consumer-types` 精确命令最初不在 CLI allowlist；协调员独立运行

```text
node node_modules/typescript/bin/tsc --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext --skipLibCheck --types node acceptance/consumer-types.ts
```

exit 0。最终安装后 `tsc` 的 exit 0 已覆盖此临时说明，没有未解决类型阻塞。

本次未重跑完整测试套件；旧报告中的 `604` / `561` 是历史数字，不代表本轮结果。

## 限制与未验证项

- 纯核心与验收使用 Fake 几何/身体，不是 Minecraft 1.20.1 真实碰撞、物理或流体证明。
- 包可安装不等于宿主已启用；消费者已演示手动 API 使用，但 Curio 当前仍是 eager 驻留，
  未接入 Curio 的自动 manual 驻留/按需加载。
- 未做旧 `WorldMemory` 迁移。
- 上述两个新 API（`WalkRouteSearch`、`startKnownWalkRoute`）未注册 Curio 宿主动作、参数校验、
  仲裁或嵌套技能；Curio 既有的 `walk_route` 与共享宿主注册不在本记录的否定范围内。也没有这两个
  新 API 的游戏内实测。

## 关键提交

| 轨道 | 提交 |
|---|---|
| 搜索与类型导出 | `b2cf40c`、`375ce04` |
| 已知历史路线启动 / 修正 | `765c96e`、`8eaa9a0` |
| 文档修正 | `ee8c835` |
| 0.7.6 包消费者验证 | `d009194` |
