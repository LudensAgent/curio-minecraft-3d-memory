# 第 5E 批验收记录：可追溯打包、独立消费者安装与宿主共享会话接线

> 本文件是本批次的独立验收记录。它不覆盖、不修改 `docs/spatial-memory-library-design.md` 中
> 用户已有的未提交改动，也不迁移旧 `WorldMemory` 或容器账本。

## 结论

**阶段 5E 完成。** 在既有观测地图、通行验证、受控 walk 执行、SQLite 单 Worker 持久化、Section
按需驻留与工作集管理之上，补齐三件库侧配套：

1. **可追溯打包**：把 `package.json` 版本从长期滞后的 `0.1.0` 对齐到当前 HEAD 的 tag
   `v0.7.4`，使包名、产物文件名与源码版本一致，并记录产物 SHA-256。
2. **独立消费者安装验收**：在独立临时目录安装实际 `.tgz`（不用源码路径、`../dist`、`npm link`
   或开发机目录别名），以包名和 `storage/sqlite` 子路径验证入口、Worker 启动、保存/恢复、
   恢复后 STALE 通行边界、执行与路线保护、最终持久化。
3. **宿主共享会话接线参考**：新增可运行的宿主生命周期示例，明确启动、共享地图、连接/重连、
   感知更新、路线生命周期、保存/关闭与恢复的接线顺序。

Fake 身体 + 真实 SQLite 的组合验收，不是真实 mineflayer walk 验收；真实游戏控制与感知接线继续由
Curio 负责。

## 交付内容

| 文件 | 内容 |
|---|---|
| `package.json` | 版本 `0.1.0` → `0.7.4`，对齐 HEAD tag |
| `package-lock.json` | 同步版本字段；保留既有 peer dependency 声明（`better-sqlite3` 可选） |
| `.gitignore` | 忽略打包产物 `*.tgz` |
| `acceptance/run.mjs` | 打包 → 临时安装 → 运行消费者 + 类型检查 → 汇总（失败非零退出） |
| `acceptance/consumer.mjs` | 安装后包名的运行时断言（硬 `node:assert`） |
| `acceptance/consumer-types.ts` | 安装后包类型的 `tsc --noEmit` 检查 |
| `examples/shared-session-lifecycle.ts` | 宿主共享会话生命周期参考示例 |
| `README.md` / `README_ZH.md` | 接入命令、宿主生命周期接线与示例目录更新 |

## 交付一：可追溯的实际安装包

### 版本对齐

仓库 tag `v0.7.4` 指向当前 HEAD `170debf`，但 `package.json` 长期停留在 `0.1.0`，导致 `npm pack`
产出的 tarball 文件名（`curio-minecraft-3d-memory-0.1.0.tgz`）无法辨认内容版本。本批把包版本对齐到
`0.7.4`，不移动既有 tag、不覆盖已交付旧产物、不发布到远端。

### 产物摘要

| 项 | 值 |
|---|---|
| 源码 commit | `170debf93c6f2c09294dad9d8ee0deb7b3c498d2` |
| 源码 tag | `v0.7.4` |
| 包名 | `curio-minecraft-3d-memory` |
| 包版本 | `0.7.4` |
| 产物文件名 | `curio-minecraft-3d-memory-0.7.4.tgz` |
| SHA-256 | `5b5bbfa2a4ef3ea5556c709ff80c3c0a65b3bbe8bb52ec758939af4944929970` |

产物由 `npm pack` 生成，包含 `files: ["dist"]` 下的全部 JS、类型声明、source map，以及
`dist/storage/sqlite/worker.js`（SQLite Worker）。**产物不含未提交的运行时代码**：`dist/` 由已提交的
`src/` 经 `npm run build`（`tsc -p tsconfig.build.json`）生成，`dist/` 本身被 `.gitignore` 排除、不入库。

- 根入口 `curio-minecraft-3d-memory` → `dist/index.js` + `dist/index.d.ts`，无原生依赖、不启动 Worker。
- 子入口 `curio-minecraft-3d-memory/storage/sqlite` → `dist/storage/sqlite/index.js`，在单个 Worker 线程内
  使用 `better-sqlite3`（可选 peer dependency，消费者须显式安装）。
- 运行时要求：`engines.node >= 18`；使用 SQLite 的消费者安装 `better-sqlite3@^12`。

## 交付二：独立消费者安装验收

### 命令

```bash
npm run build
node acceptance/run.mjs
```

`run.mjs` 在独立临时目录内完成：`npm pack` → 复制产物与消费者脚本 → 写 `package.json`（依赖
`file:./<tgz>` + `better-sqlite3` + `typescript`）→ `npm install` → `node consumer.mjs` →
`tsc --noEmit`。任一步失败均非零退出；缺失 SQLite 驱动或 Worker 无法启动会明确报失败，不会跳过后宣称通过。

### 覆盖项

| 项 | 验证方式 |
|---|---|
| 包入口 | 根入口 `RouteVerifier`/`WalkRouteExecutor` 与子路径 `openSpatialSession`/`WorkingSetManager` 可用；Worker 随 `openSpatialSession` 成功启动（`lifecycle === 'open'`） |
| 公开类型 | `consumer-types.ts` 经安装后包的 `*.d.ts` 通过 `tsc --noEmit`（`SpatialSession` 等类型从 `storage/sqlite` 子路径导出） |
| 保存与恢复 | 临时库 + 明确 `worldId`，写入方块与空气，`checkpoint` 返回确认 id，`close` 干净，重开后核对内容与原始 `observedAt`，恢复证据为 `STALE` |
| 恢复后通行边界 | 恢复的旧证据不产出 `OPEN`（`RouteVerifier` verdict 为 `STALE`）；新会话只刷新实际重观察的格，邻格仍 `STALE` |
| 执行与路线保护 | `manual` 驻留 + `WorkingSetManager.prepare` 保护路线实际依赖，执行期间 `free()` 不淘汰被 Pin 的 Section，释放后 `checkpoint`/`close` 正常 |
| 最终持久化 | 执行后的新观测经显式 `checkpoint` 保存，`close` 返回 `completed: true`，重开后核对最终内容 |

### 结果

```
consumer acceptance: PASS (all assertions held)
type-check: PASS (public types resolve from the installed package)
source commit : 170debf93c6f2c09294dad9d8ee0deb7b3c498d2
source tag    : v0.7.4
package version: 0.7.4 (packed as 0.7.4)
artifact      : curio-minecraft-3d-memory-0.7.4.tgz
sha256        : 5b5bbfa2a4ef3ea5556c709ff80c3c0a65b3bbe8bb52ec758939af4944929970
```

## 交付三：宿主共享会话接线

`examples/shared-session-lifecycle.ts` 是可运行参考（`npm run build` 后
`npx tsx examples/shared-session-lifecycle.ts`）。接线顺序与语义：

1. **宿主启动**：宿主提供数据库绝对路径和 `worldId`，`await openSpatialSession({ databasePath, worldId })`
   完成后再使用返回的 `session.voxel`；不要每个动作新建地图。
2. **共享地图**：持续感知与多个 walk 委托共用 `session.voxel`。共享地图不代表共享各委托的执行所有权——
   每个 `WalkRouteExecutor` 编排自己的委托，取消其一不影响其它或整个会话。
3. **连接与重连**：观测 `sessionId` 来自宿主实际连接生命周期（如 `conn-1` → 重连后 `conn-2`）；正常重连同一
   世界不更换 `worldId`。用 `map.beginSession(sessionId)` 切换观测会话，旧会话的迟到观测被拒绝
  （`ChangeReport` 空），不能把旧观测重新标 FRESH。
4. **感知更新**：宿主先 `map.observe(...)` 写入合法观测，再把返回的 `ChangeReport` 交给活跃路线
  （`RouteVerifier.apply(report, budget)` / `WalkRouteExecutor.observe(report, budget)`）。库不主动扫描
  世界、不读宿主隐藏事件补事实。
5. **路线生命周期**：加载、准备并保护实际路线依赖（`WorkingSetManager.prepare` + 租约），动作结束后
  `releasePins`；取消某个动作不关闭整个共享会话。
6. **保存与关闭**：`checkpoint()` 捕获并提交当前变化（唯一保存触发）；`flush()` 只等待已接受的保存，不捕获
  新变化；`close()` 做有界关闭。停止接收写入 → 最终 `checkpoint` → 检查确认 → `close`，并处理保存/关闭失败。
7. **恢复**：恢复的是历史记录与原证据时间；当前通行性必须重新建立（新观测会话 + 重验证），不能把读回数据库
  当作重新观察，也不能复用恢复前的 `OPEN`。

本参考示例采用默认 `eager` 加载（打开时全量恢复已提交 Section），只适用于世界规模落在会话预算内的情况；
不暗示所有场景都应全量加载。需要按需驻留与路线 Pin 保护时见 `examples/working-set.ts` 与 README 的
“手动按需 Section 驻留 / 有界工作集管理”章节。

## 职责边界与仍需 Curio 完成

空间库负责公开契约、证据处理、验证、执行编排与存储机制。本轮不向空间库引入 Curio 环境配置，不反向导入
Curio 源码，不把制动系数、按键时序或服务器连接逻辑放进库核心。

仍需 Curio 侧完成（不在本批库侧范围内）：

- `test/local/live` 配置与 Minecraft 实际连接、视锥/接触感知；
- 身体控制、物理帧适配、经仲裁器的窄 `MoveExecutor`（保留父 task/delegation、取消、期限传递）；
- 共享 `SpatialSession` 的宿主接线与生命周期（按上文 7 点）；
- 真实 Java 1.20.1 服务器上的 walk 执行与稳定落脚验收。

真实游戏集成验收尚未运行；本批证据是 Fake 身体 + 真实 SQLite 的组合验收，不是真实 mineflayer walk 验收。

## 验证命令

```bash
npm run typecheck              # tsc --noEmit（含 src 与 tests）
npm test                       # vitest run（561 项，全绿）
npm run build                  # 产出 dist/
node acceptance/run.mjs        # 独立消费者安装验收（非零退出即失败）
npx tsx examples/shared-session-lifecycle.ts   # 宿主生命周期参考示例
```
