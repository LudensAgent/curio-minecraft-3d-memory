# 空间记忆库

<p>
  <img src="https://img.shields.io/badge/version-0.11.0-blue.svg" alt="Version 0.11.0">
  <img src="https://img.shields.io/badge/node-%3E%3D18-339933.svg" alt="Node 18+">
  <img src="https://img.shields.io/badge/minecraft-1.20.1-62B47A.svg" alt="Minecraft 1.20.1">
  <img src="https://img.shields.io/badge/typescript-5.x-3178C6.svg" alt="TypeScript 5.x">
  <img src="https://img.shields.io/badge/sqlite-optional-003B57.svg" alt="Optional SQLite">
  <img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="Apache 2.0 License">
</p>

[English](README.md) | 简体中文

面向 Minecraft Java 1.20.1 Agent 的独立 TypeScript 库。它记录每个格最后观察到的状态，保存语义地点/资源/容器事实，在已观察体素地图上进行有界陆地路线搜索，验证陆地与水面几何，并通过显式 checkpoint 持久化工作集。目标、策略、资源投入与风险取舍仍由 Agent 决定。

范围是**陆地行走与水面移动**，包括跳跃、台阶、梯子、下落衔接、水面游泳、已乘船移动及上下岸。飞行、鞘翅和水下三维导航不在范围内。

**状态：v0.11 体素优先核心。** 库现在由已观察的 `VoxelMap`、语义事实、有界 `LandSearch`、陆地/水面验证器以及体素、事实、账本和 journal 的 SQLite 持久化组成。旧 fragment/topology store、历史路线规划、路线注册表、walk-path 绑定和库内 walk executor 已删除。宿主的 `navigate_to` / `advance` 与直接移动原语负责执行；本库只返回证据与候选路线，不声明到达。

`MemoryHostCapabilities` 只包含 `memory`、`query` 和 `persistence` 域，契约版本为 `memory-host-contract/2`；身体执行与路线规划不属于库能力。本包不验证真实 Minecraft / mineflayer / Curio 接入。

## 功能

- **证据化观察地图**（`voxel/`、`observation/`）：稀疏、带版本的 Section，逐格证据、新鲜度与会话处理；有界 `ObservationQueue`；局部化 `ChangeReport` 只使依赖它的工作失效。
- **语义事实**（`facts/`）：扁平的地点、资源、容器 anchor，保留稳定 id、真实观察时间、gone/revoked 状态与有界游标分页。资源 anchor 可携带精确来源格证据版本。容器内容仍由宿主账本管理。
- **有界体素陆地搜索**（`searchLandRoute` / `searchLandRouteAsync`）：在已观察支撑面上进行 A*，支持 walk/step/drop；调用方显式允许并提供 `LandMotionModel` 时生成水平 `jump` 边；显式允许并提供 `ClimbRegionProvider` 时生成 `ladder` 边。结果要求当前复验，且始终 `executable: false`。
- **陆地与水面验证**（`traversability/`、`water/`）：`evaluateLandTransition` / `LandRouteVerifier` 验证调用方声明的陆地转换与路线；`evaluateWaterRoute` / `checkWaterArrival` 验证水面游泳与已乘船几何。结果是几何/证据判断，不是执行。
- **显式 SQLite 持久化**（`storage/`、`curio-minecraft-3d-memory/storage/sqlite`）：单个 Worker 独占连接与事务。`checkpoint()` 是唯一显式保存触发点，在一个事务中提交体素 Section、放置/访问/门户账本、追加式 journal 与语义事实域。包含手动 Section 驻留、`WorkingSetManager`、有界脏批与事实迁移 receipt。
- **退役域只读为元数据。** `legacyStoreSummary` 报告旧路线表行数与旧 `curio:migration` 标记。Worker 从不加载、写入、恢复或删除旧路线表；全新数据库也不会创建它们。
- **与宿主解耦的集成面**：观察、事实、搜索、验证和持久化都消费调用方提供的证据、身体尺寸与版本化形状 Provider；库不 import 宿主源码。

## 要求

- 核心与 `water` 入口要求 **Node.js `>= 18`**。
- SQLite 入口要求 **Node.js `>= 20` 与 `better-sqlite3@^12`**。`better-sqlite3` 是可选 peer dependency，仅由 `curio-minecraft-3d-memory/storage/sqlite` 加载。
- 碰撞形状与流体解释采用 **Minecraft Java 1.20.1 语义**；库本身不依赖 Minecraft 客户端或服务端，由调用方注入版本化 Provider。
- ESM / NodeNext TypeScript 消费者。包从 `dist/` 发布运行时 JavaScript 与 `.d.ts` 声明。

## 安装与消费

```bash
npm install --no-audit --no-fund
npm run build
npm pack
```

消费者把实际 `.tgz` 安装到自己的项目，并按包名与公开子路径导入——不要使用源码路径、`../dist`、`npm link` 或开发机目录别名：

```json
{
  "dependencies": {
    "curio-minecraft-3d-memory": "file:./curio-minecraft-3d-memory-0.11.0.tgz",
    "better-sqlite3": "^12.0.0"
  }
}
```

| 入口 | 内容 | 原生依赖 |
|---|---|---|
| `curio-minecraft-3d-memory` | 根入口：观察、体素、通行性、陆地搜索、事实、持久化类型与水面验证 | 无 |
| `curio-minecraft-3d-memory/memory` | 纯记忆核心：观察、体素、查询与能力报告；无导航或身体入口 | 无 |
| `curio-minecraft-3d-memory/navigation` | 有界体素陆地搜索（`searchLandRoute`、`searchLandRouteAsync`） | 无 |
| `curio-minecraft-3d-memory/water` | 水面与已乘船验证 | 无 |
| `curio-minecraft-3d-memory/storage/sqlite` | SQLite 会话、账本、journal、事实与工作集 | `better-sqlite3@^12` |

## 快速开始

### 打开空间会话

```ts
import { openSpatialSession } from 'curio-minecraft-3d-memory/storage/sqlite';

const session = await openSpatialSession({
  databasePath,
  worldId: 'world',
  // 可选：'manual' 打开时只读已提交的 Section 目录。
  voxelLoading: 'eager',
});

session.voxel.beginSession('session-a');
session.voxel.observe({ /* 已确认观察 */ });
session.facts.upsertPlace({ /* 语义地点事实 */ });

await session.checkpoint(); // 唯一显式保存触发点
await session.close();
```

恢复的格保留原始证据时间与来源，但读作 `STALE`；新观察只刷新实际观察到的格。恢复的事实域保留精确 id、时间与 gone/revoked 状态。

### 搜索有界陆地路线

```ts
import { searchLandRoute } from 'curio-minecraft-3d-memory/navigation';

const result = searchLandRoute({
  map: session.voxel,
  scope: { worldId, dim, sessionId },
  start: measuredFeet,
  target: { kind: 'exact', pos: destinationFeet },
  body,
  shapeProvider,
  allowed: ['walk', 'step', 'drop'],
  limits: { maxNodes: 4096, maxExpandedEdges: 16384, maxWork: 65536 },
  now: Date.now,
});
// result.status: FOUND | NO_PATH | INSECURE | BUDGET_EXHAUSTED | CANCELLED | ...
// result.executable 恒为 false：当前证据不是授权。
```

`searchLandRouteAsync` 以协作切片执行同一有界搜索。宿主自行用 `navigate_to` / `advance` 验证并执行选定路线；本库不移动身体。

### 查询体素与事实

```ts
import { createVoxelFactsQueryPort } from 'curio-minecraft-3d-memory';

const port = createVoxelFactsQueryPort({
  worldId,
  voxel: session.voxel,
  facts: session.facts,
});

const cells = port.query({ kind: 'cells', dim, positions: [cell] });
const places = port.query({ kind: 'places', dim, limit: 50 });
```

支持的查询 kind：`cells`、`nodes`、`places`、`resourceAnchors`、`containerAnchors`、`containerContents`、`snapshot`、`capabilities`。`nodes` 是 facts-backed 语义视图，不是旧拓扑图；`containerContents` 始终返回宿主账本边界而不是空列表；旧路线 kind 会被当作未知请求拒绝。

### 验证陆地与水面几何

```ts
import { evaluateLandTransition, LandRouteVerifier } from 'curio-minecraft-3d-memory';
import { checkWaterArrival, evaluateWaterRoute } from 'curio-minecraft-3d-memory/water';
```

陆地验证支持 `step`、`drop`、`jump`、`ladder`；`jump` 需要注入版本化 `LandMotionModel`，`ladder` 需要版本化 `ClimbRegionProvider`。水面路线必须是固定 90° 朝向的等高路线。验证器不搜索路线、不移动身体、不挖掘/放置、不操控船，也不执行救援策略。

### 管理工作集

```ts
import { WorkingSetManager } from 'curio-minecraft-3d-memory/storage/sqlite';

const manager = new WorkingSetManager(session);
const prepared = await manager.prepare(dependencySections);
// prepared.status: 'ready' | 'incomplete' | 'failed'
// 仅 ready 时 lease 有效，由调用方负责释放。
```

`prepare` 先验证整个请求，用临时 pin lease 保护，只淘汰已提交、干净、未固定且 LRU 可淘汰的 Section，其余通过会话的单一 Worker 加载。`free()` 为新观察腾出空间，`stats()` 返回只读快照。

## 持久化与迁移

- `checkpoint()` 提交每个已变化域的捕获 revision；干净域不会被重写。
- 体素脏批有界；ACK 只确认实际捕获的 Section key，之后的新变化保持 pending。
- 事实仅在其引用的来源格版本已存在于同一事务时提交；否则返回结构化 `factsDeferred` 缺口并保持 pending。
- journal 只追加；空批次不会删除已提交行。
- `legacyStoreSummary` 是旧路线表唯一读取路径。旧行在新 checkpoint 后保持逐字节不变，不会 `DROP`/`DELETE`。
- `runLegacySemanticMigrationDryRun` / `applyLegacySemanticMigration` 是独立纯数据函数，用于离线语义事实迁移，不 import 已删除的旧 store。

## 宿主接入生命周期

1. **启动**：宿主提供绝对数据库路径与 `worldId`；使用 `session.voxel` 前等待 `openSpatialSession()`。不要每个动作重建地图。
2. **共享地图**：持续感知、陆地搜索与宿主导航复用 `session.voxel`。
3. **连接/重连**：观察 `sessionId` 来自真实连接生命周期；同世界重连保留 `worldId`，用 `map.beginSession(sessionId)` 切换。旧会话的迟到证据会被拒绝。
4. **感知更新**：先写 `map.observe(...)`，再把返回的 `ChangeReport` 交给宿主控制循环。库不扫描世界。
5. **搜索与执行**：宿主保护所需 Section（`WorkingSetManager.prepare` + lease），调用 `searchLandRoute`，复验后用自身原语执行。取消一个委托不会关闭共享会话。
6. **保存与关闭**：`checkpoint()` 捕获并提交当前变化；`flush()` 只等待已接受的保存；`close()` 在有界时间内关闭。
7. **恢复**：原始证据时间与事实记录会恢复；当前可通行性必须重新建立，不能把磁盘数据当作新观察。

## 能力契约

`MemoryHostCapabilities` 只报告：

- `memory`：观察/会话写入与 checkpoint/flush/close 生命周期；
- `query`：cells、facts-backed nodes/places/anchors 与 snapshot/capabilities；
- `persistence`：SQLite、手动驻留、工作集与迁移权威切换。

`memory-host-contract/2` 不存在 `execute` 与 `plan` 块。接线时应使用 `composeCapabilities` 与宿主自身接线求交集；`false` 或未声明的能力是明确的 `unsupported` 拒绝，不是静默回退。

## 项目结构

```
src/
├── index.ts            # 公共 API 入口（最小、明确）
├── constants.ts        # 共享配置常量
├── types.ts            # 基础原语（Vec3Like / BlockState / WorldScope / MoveMode）
├── observation/        # Observation / 证据 / 新鲜度与有界队列
├── voxel/              # 稀疏 Section、palette、位打包、驻留与快照
├── traversability/     # 通行性、陆地转换与 LandRouteVerifier
├── water/              # 水面与已乘船验证（/water 子路径）
├── facts/              # 语义事实、分页、持久化与离线迁移
├── navigation/         # 有界体素 LandSearch 与共享委托契约
├── query/              # 只读体素 + facts 投影
├── adapter/            # WorldAdapter 目标接口
└── storage/            # SQLite 持久化、账本、journal、事实与 Worker
```

## 开发

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run build       # 输出 dist/（NodeNext ESM + 类型声明）
```

测试使用 Fake 感知、Fake 身体与 Fake 形状 Provider；持久化测试使用真实 SQLite 与真实 Worker。任何测试都不启动 Minecraft 服务端或连接 mineflayer bot；游戏内验收仍未完成。

## 文档

- [AGENTS.md](AGENTS.md)：仓库开发规范与边界。
- [v0.11.0 升级方案](docs/v0.11.0-upgrade-plan.md) 与[实施计划](docs/v0.11.0-implementation-plan.md)：体素优先设计与实施记录。
- [空间记忆库设计](docs/spatial-memory-library-design.md)：目标契约、数据模型与实现顺序。
- [宿主接口契约](docs/memory-host-interface-contract.md)：能力协商与宿主边界。
- [旧数据迁移门禁](docs/legacy-migration-gate.md)：离线迁移权威规则。

`docs/` 中的旧审计保留为历史记录，描述的是本分支已退役的实现。

## 已知限制

- **无真实游戏验收。** 身体样本、世界适配器与形状/流体 Provider 均由调用方提供；测试证明库内逻辑，不证明 mineflayer 控制或 Minecraft 物理。
- **只搜索，不执行。** `searchLandRoute` 只返回有界候选；到达、移动、挖掘、放置、搭柱与材料支出都是宿主决策和宿主动作。
- **陆地/水面验证器仅几何。** 不搜索路线、不移动身体、不管理船、不执行救援策略；结果标记 `assurance: 'geometry_only'` 与 `executable: false`。
- **持久化是显式的。** 没有自动保存或后台重试；只有 `checkpoint()` 提交。恢复的观察是 `STALE`，当前可通行性需重新建立。
- **感知由宿主负责。** 库不扫描客户端世界、不加载区块，也不把原始 `blockUpdate` 当证据；只记录宿主合法提供的观察。
- **容器与库存仍由宿主管理。** 库关联位置、身份与可达证据，不复制或维护物品数量。
- **不含飞行、鞘翅或水下三维导航。**
- **旧路线数据不再参与当前事实。** 旧表可被统计用于诊断，但不会向当前查询提供地点、边、路线或可通行性。

## 许可证

Apache License 2.0，见 [LICENSE](LICENSE)。
