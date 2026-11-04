# 第 5E 批验收记录：0.7.5 可追溯打包与独立消费者安装

> 本文件是本批次的独立验收记录，不覆盖、不修改 `docs/spatial-memory-library-design.md` 中用户已有的
> 未提交改动，也不迁移旧 `WorldMemory` 或容器账本。本次报告对应已实际执行并通过的 `0.7.5` 打包验收。

## 结论

**`0.7.5` 打包与独立消费者安装验收通过。** 在干净 HEAD 上完成全新构建、打包、独立安装，消费者正向通过、
两个负向对照各在预期断言处失败、安装后公开类型通过 `tsc --noEmit`。执行前后 Git 完全干净
（`sourceBinding.clean = true`），产物为不可变 `.tgz`，evidence 与产物保留在唯一运行目录。

这是 **Fake 身体 + 真实 SQLite** 的库侧组合验收，不是真实 mineflayer walk 验收；真实游戏控制与感知接线、
Curio 的 M2 / D 侧接入不在此范围内。

## 打包产物

| 项 | 值 |
|---|---|
| 包名 / 版本 | `curio-minecraft-3d-memory` @ `0.7.5` |
| 打包 HEAD | `5682ea82765256daeb9e0845ab082cba978b1e7e`（无精确 tag，记录 `null`） |
| 产物文件名 | `curio-minecraft-3d-memory-0.7.5.tgz` |
| 产物路径 | `C:/Users/Administrator/AppData/Local/Temp/curio-minecraft-3d-memory-acceptance/run-1793770157520-7548/curio-minecraft-3d-memory-0.7.5.tgz` |
| SHA-256 | `5542ba0f6cef942dd81667a6b72d6f4de10fc3ae16cf91aadadeb6073bce33ad`（协调员 `Get-FileHash` 独立一致） |
| 起止（UTC） | `2026-11-04T05:29:17.522Z` → `2026-11-04T05:29:32.071Z` |
| build 命令 | `tsc -p tsconfig.build.json` |
| Node / npm / TS | `v24.14.1` / `10.9.0` / `5.9.3` |

产物非 `dist` 入包项只有 `README.md` 与 `package.json`（`files: ["dist"]` 不排除这两者；无 `LICENSE`、
`README_ZH.md` 不入包）。SQLite Worker（`dist/storage/sqlite/worker.js`）在产物内；消费者须显式安装
`better-sqlite3`（可选 peer dependency）。

evidence 与命令日志：`evidence.json` 与产物同目录；命令日志
`C:/Users/Administrator/AppData/Local/Temp/curio-joint-library-logs-20261104/final-acceptance.log`。

## 独立消费者安装

运行器 `node acceptance/run.mjs --execute` 顶层 exit 0。各阶段退出码：

| 阶段 | 退出码 | 说明 |
|---|---|---|
| build | 0 | `tsc -p tsconfig.build.json` |
| pack | 0 | `npm pack --json --pack-destination <唯一输出目录>` |
| install | 0 | 独立目录 `file:./<tgz>` + 显式 `better-sqlite3` |
| consumer positive | 0 | 无 flag，全部断言通过 |
| consumer `--early-release-pin` | 1 | 预期 `AssertionError: … stays pinned during the active walk` |
| consumer `--skip-final-checkpoint` | 1 | 预期 `AssertionError: reopen has the unique final fact` |
| tsc（安装后公开类型） | 0 | `node_modules/typescript/lib/tsc.js -p tsconfig.json` |

两个负向退出 1 是**预期的断言失败**，被判定为 PASS 的对照证据，不是程序失败。所有命令无 `signal` /
spawn error；`cleanupError = null`，独立消费者安装目录已回收；安装后 `name`/`version` 与 manifest 及
实际 pack 三者一致（`curio-minecraft-3d-memory@0.7.5`）。

运行器元数据：`runnerVersion 0.7.5`；`runnerHash 3836278b1f1e89505ffe0f353751c1179f5f210763da5dbc55e777ba045e2608`
（组合 `run.mjs` + `provenance.mjs`）；`consumerHash 47f1846fa00f026aca692c1145b8cc116e9f0c41bd30f5b35b025c22c950797d`
（组合 `consumer.mjs` + `consumer-types.ts`）。源码 HEAD 固定所有验收输入。

## 消费者场景证据

**宿主生命周期（L1/L2）**：见 `docs/shared-session-lifecycle-b1.md`。在真实 primary `session.voxel` 上
验证断连/重连（`conn-1` → `conn-2`）→ 最终 checkpoint → close → reopen，`conn-2` / `observedAt=3000` 的
证据以 STALE 恢复；旧的只读 `RouteVerifier` 漏报负对照、空 report 无后续 frame 的取消各有独立正/负对照；
真实 `snapshotLimits` 容量错误保留原 `kind`/`message`，所有会话有界关闭并报告次级错误，CLI 自然 exit 0
（无强行 `process.exit`）。

**Pin 保护（L3，正向）**：`dirty=false`，在飞步 `activeStepIndex=0` / `result=null`，两个真实依赖
`(overworld, 0, 0, 0)` 与 `(overworld, 0, 0, -1)` 各 `pinned`；`ARRIVED`、`cancel` 及两个重叠租约释放后
均实际回收。早释放 mutation 下实际 `free()` 会 evict 该依赖而触发断言（预期失败），所有 close 干净。

**最终持久化（L4，正向）**：最终 checkpoint `e58cfba2-afe5-4784-a684-0a676b80f5af`，
`voxelRevision = confirmedVoxelRevision = 2`、`dirty=false`；`close` 返回 `completed=true` /
`unconfirmedRequest=false` / `error=null`；重开后独有事实 `(4,0,0)` 为 `minecraft:oak_log`
`properties {axis:y}`、`sessionId=live` / `observedAt=2000` / `stateComplete=true` / `STALE`。跳过最后
checkpoint 的对照则 `close` 返回 `dirty=true`、重开 `observed=false`，在「reopen has the unique final fact」
处预期失败。

## 源码绑定与历史基线（历史说明）

- **运行时源码基线** `170debf93c6f2c09294dad9d8ee0deb7b3c498d2`：`src/` 本轮未改动。
- **旧 `0.7.4` 完整打包提交** `2e5c50194e952e534c1184674b114a0acaeb4830`：当初记录把 `170debf` 的 tag
  `v0.7.4` 与产物混记为「纯 HEAD 打包」，实际 manifest 与运行器在 `2e5c501` 才落地，是历史局限。
- 本次不移动旧 tag、不重打旧产物、不为旧产物补造干净 HEAD 校验；`0.7.5` 的打包 HEAD 与运行时源码基线
  分开记录，不互相替代。`sourceBinding.clean = true`，执行前后 Git 完全干净。

## 关键提交

| 轨道 | 提交 |
|---|---|
| B1（生命周期示例/测试） | `7eb4c1b`、`5682ea8` |
| B2a（消费者验收） | `e376453`、`911aa40`、`761356a` |
| L5（打包 / provenance 运行器） | `b9a5c50`、`63cbbd9` |

## 边界与限制

- Fake 身体 + 真实 SQLite 是库侧验收，未运行 Minecraft；不证明 Curio 的 M2 或 D 侧接入（其他 lane 负责）。
- close 故障是真实 Worker 关闭后的边界注入（返回 `completed:false` 或 throw），不是物理 Worker 故障。
- `shared-session-lifecycle` 示例用预算内 eager 加载；消费者另有一路真实 manual 会话，验证 clean Section 与
  在途 Pin。均不宣称 Curio 的 manual 按需驻留已接线。
- 本次只跑定向测试，未跑全 suite；「561 项全绿」是旧 `0.7.4` 记录的历史数字，不是本次重跑结果。

## 验证命令

本次实际执行（定向）：

```bash
node --test acceptance/provenance.test.mjs acceptance/run.test.mjs   # 27/27 全绿
node --test acceptance/consumer-close.test.mjs                       # 5/5 全绿
npm exec vitest run tests/shared-session-lifecycle.test.ts           # B1 15/15 全绿
node --import tsx examples/shared-session-lifecycle.ts               # 真实自然 exit 0（无强行 exit）
node --check acceptance/run.mjs                                      # 语法校验
node acceptance/run.mjs --execute                                    # 最终打包+安装验收（exit 0）
```

`npm run typecheck`（含 build）此前真实 exit 0，源代码其后未再改变（最后仅示例 budget 与日志命名）。
本次未重跑 `npm test` 全 suite，故不沿用旧「561 项」数字。

> 本次为 docs-only 收尾提交，晚于产物 source；不重打同名产物，也不把本文件的 HEAD 冒充为产物来源。
