# 陆地路线几何验证增量：step / drop / jump / ladder

> 本文件是本任务新增的验收与接口说明，不覆盖、不修改
> `docs/spatial-memory-library-design.md`、README 或版本号。

## 结论

新增**纯只读、有界的陆地转换几何验证**：

- `evaluateLandTransition(map, query, rules, now, limits)`：验证一条显式声明、带精确
  `from`/`to` 脚位的陆地转换。
- `LandRouteVerifier`：在调用方已经选定并排序的转换列表上做有界只读复验。

两者都只回答“当前证据是否支持声明的连续几何通道/轨迹以及必要的支撑/攀爬接触”。
它们**不证明**实际可达、Minecraft 动力学、身体能力、授权、执行器支持、实际移动或到达。
因此每个转换结果与路线快照都固定带有：

```ts
assurance: 'geometry_only';
executable: false;
```

原有的 `evaluateWalkStep`、`TraversabilityCache`、`RouteVerifier`、路线搜索和执行器完全未改动；
本增量不执行移动、不挖、不放、不造船、不自动登梯/下梯，也不生成导航搜索或策略。

## 公共 API

```ts
import {
  DEFAULT_LAND_LIMITS,
  evaluateLandTransition,
  resolveLandLimits,
  LandRouteVerifier,
} from 'curio-minecraft-3d-memory';
import type {
  LandTransition, LandTransitionQuery, LandRules, LandLimits,
  LandTransitionEvaluation, LandMotionModel, ClimbRegionProvider,
  LandLimitGap, LandRouteBudgetGap, LandRouteLimitField, LandRouteRecovery,
  LandRouteRequest, LandRouteStatus, LandRouteSegmentState,
} from 'curio-minecraft-3d-memory';

const limits = resolveLandLimits({ maxWork: 4096 }); // 省略字段使用有限默认值

const evaluation = evaluateLandTransition(
  map,
  {
    worldId: 'world',
    dim: 'overworld',
    sessionId: 'session-1',
    body: { feet: { x: 0.5, y: 0, z: 0.5 }, width: 0.6, height: 1.8, pose: 'standing' },
    transition: {
      kind: 'step',
      from: { x: 0.5, y: 0, z: 0.5 },
      to: { x: 1.5, y: 1, z: 0.5 },
    },
  },
  {
    shapeProvider,          // 既有、版本化的碰撞/支撑形状规则
    jumpModel,              // 仅 jump 需要；测试模型只是几何曲线
    climbProvider,          // 仅 ladder 需要
  },
  now,
  limits,
);
```

`body.feet` 必须与 `transition.from` 精确相等。转换的 `kind` 由调用方显式给出，**绝不**从两个
点推断；坐标不取整、不吸附、不重写。非有限坐标、非正身体尺寸、非 `standing` 姿态或损坏的
limits 会在边界抛错；几何子集之外的范围返回 `UNSUPPORTED` / `unsupported_range`。

## 支持的四类几何子集

### 1. `step`

- 水平方向必须沿单一轴恰好移动 1 格，另一轴为 0；竖直上升 `0 < Δy ≤ 1`。
  “最多 1 格”是本增量显式的实现范围，不是 Minecraft 原生自动上台阶能力的声明。
- 规范通道：先在原 XZ 竖直抬升到目标脚高，再在目标脚高沿原轴水平移动到目标点。
- 起点与终点都必须在**精确脚高**上存在实际观测到的可站立顶面。
- 两段线性通道都必须连续无碰撞；不做端点采样。

### 2. `drop`

- 水平方向必须沿单一轴恰好移动 1 格，目标脚高严格低于起点脚高。
- 规范通道：先在原脚高水平移动到目标列，再在目标 XZ 竖直下降到目标脚高。
- 起点与调用方已选定的落点都必须有精确脚高的支撑；水平段不额外要求支撑。
- 不选择替代落点、不假设中间地面、不做跳跃救援、不从方块外观推断水面落点。
- 输出 `hazards: [{ kind: 'fall', ... }]`，内容是从起点到落点的实际高度差。
  这是事实，不是安全策略；`OPEN` 不会因为落差大而自动变成 `BLOCKED`。

### 3. `jump`

- 同高、沿单一轴的有限水平跨越；默认实现上限 `maxJumpDistance = 4` 格。
- **必须**显式提供版本化 `LandMotionModel`。缺失或模型返回不支持时，即使空间全空也返回
  `UNSUPPORTED` / `unsupported_model`。
- 模型只能返回连续二次轨迹：

  ```ts
  interface LandJumpTrajectory {
    // y(t) = y0 + 4 * apexHeight * t * (1 - t), x/z 线性插值
    apexHeight: number; // 正有限数
  }

  interface LandMotionModel {
    version: string;
    resolve(input: { from; to; body }): LandMotionResolution;
  }
  ```

  不接受“若干采样点/折线”作为跳跃扫掠证明。模型版本进入路线证明身份；结果中的
  `model: { kind: 'jump', version }` 明确写出假设来源。
- 身体整个 AABB 使用解析二次不等式与 X/Y/Z 同时时间区间求交。包围盒中身体从未占据的
  角落只用于候选格过滤，不会误报碰撞。
- 候选包围盒中还可能包含身体**从未以正体积占据**的格（例如 X 区间已结束、身体顶部才刚
  超过该格底面的真实角落）。这类格在要求任何证据之前，先用同一套连续整格命中判断排除：
  已知实心不会误报碰撞，未观测也不会误报 `UNKNOWN`。这不是采样，也不替换解析碰撞。
- 起点与落点支撑必需；空中弧段不要求、也不假设支撑。
- **本库不附带、也不验证真实 Minecraft 运动模型。** 测试里的二次模型只标为 test model；
  几何曲线成立不代表身体真的能完成该跳跃。

### 4. `ladder`

- XZ 必须固定，只允许竖直向上或向下移动。
- **必须**显式提供版本化 `ClimbRegionProvider`。缺失即 `UNSUPPORTED`；不根据方块名称、
  空碰撞或距离推断梯子。
- 攀爬来源候选是**整个连续扫掠身体**实际重叠的格，而不只是脚高行程 `[lo, hi]` 内的格：
  高身体可以在脚位低于某格时仍与其上身接触。来源候选与碰撞净空复用同一次有界枚举，
  不额外分配或重复计入候选枚举工作。
- Provider 会收到每个来源格的 `cell`、该格完整观测状态、固定 `body`（width/height/pose），
  并通过受控 `NeighborRead` 读取必要邻格。它返回世界脚高区间 `[minFeetY, maxFeetY]`，
  或显式 unsupported。这些区间是 provider 在当前证据下对允许脚高范围的断言；本库不会
  把它裁剪到 `[cellY, cellY + 1]`（脚位可以低于所接触的格），也不会据方块名称或接近程度
  推断梯子。返回区间必须是有限且 `minFeetY <= maxFeetY`。
- 竖直行程必须被已证明的脚高区间**连续覆盖**；窄到 `1e-9` 以上的缺口也不能跳过。
  同一竖直行程还需要身体碰撞净空连续无碰撞。只有在所有来源格都已观测且 provider 没有
  返回不支持结果时，未覆盖区间才记为 `BLOCKED` / `missing_climb_contact`；来源证据缺失
  仍优先表达为 `UNKNOWN` / `STALE`。
- 只读验证不自动挂载、下梯或斜向攀爬；这些转换返回显式的范围不支持结果。
- 高行程会逐格读取所需 Section；`maxCandidateCells`、`maxNeighborReads`、`maxClimbRegions`
  与 `maxWork` 共同限制实际工作。

## 支持、接触与证据

- 形状/支撑完全由版本化 `CollisionShapeProvider` 决定；核心没有方块名表、不会把非空气格
  一律当立方体，也不会从空 `properties` 推断完整状态。
- 支撑顶面位于精确脚高；允许支撑面位于脚格内（例如下半砖）。只有顶面实际矩形与身体
  XZ footprint 的**正面积**重叠才算支撑；边/点接触的零面积重叠不算。
- 已观测的“没有支撑”与“未观测、仍可能支撑”分开：
  - 所有候选格都已观测且没有匹配顶面 → `BLOCKED` / `missing_support`；
  - 仍有候选格未知/不完整/非驻留 → `UNKNOWN`；过期/会话不符 → `STALE`。
- 碰撞是连续的：
  - step/drop 的每段线性平移使用解析扫掠区间；
  - jump 使用二次 Y 区间与线性 X/Z 区间求交；
  - 精确边界接触没有正体积，不算碰撞。
- 已知障碍只来自接受的观测证据；不会为未看见的格编造方块名。
- Provider 在解析形状或攀爬区间时读取的每个邻格都会记录 Section 依赖。即使 provider
  在读到缺失/过期邻格后仍返回形状/区间，碰撞/通道所必需的证据缺口也会保留并使结论无法
  成为 `OPEN`。
- **仅用于支撑检查的候选**逐个候选隔离诊断：每个候选自身的读取、其 shape provider 的
  受控邻读以及 `neighbor_gap` 先写入该候选自己的局部缓冲。只有该候选自身证据完整
  （自身读取与 provider 邻读都没有缺口）且在精确脚高给出正面积可站立面，才算一个完整
  支撑见证；找到后立即停止扫描并丢弃其他候选的可选缺口。provider 即使仍返回形状，也不能
  用返回面掩盖它已经读取到的缺失邻格：这类候选只是不完整的断言，不能证明支撑。反过来，
  其他候选的可选缺口也不会污染一个独立的完整见证。仅在无法得到任何完整见证时，才把所有
  候选缓冲并回全局原因；只有全观测且无缺口的候选都没有匹配面才是 `missing_support`。
  Section 依赖与 TTL 仍始终全局记录，碰撞/通道必需的 provider 缺口不受影响。

## Section 依赖、驻留与有效期

每个被读取的 Section 都记录：

```ts
interface LandSectionDependency {
  key: { worldId; dim; cx; cz; sy };
  revision: number;          // 读取时的活动 Section revision；无驻留载荷时为 0
  residency: SectionResidency;// resident / not_resident / loading / load_failed / no_record
  generation: number;        // unload/reload 会改变，但不一定改变 revision
  validUntil: number;        // 该 Section 内仍有效证据的最小 validUntil；无则为 Infinity
}
```

因此：

- 负坐标与 Section 边界使用既有 `blockToSection` 数学，不按整格猜测。
- 已提交但未驻留（`not_resident` / `loading` / `load_failed`）与从未观测（`no_record`）
  分开表达；前者产生 `UNKNOWN` / `nonresident` 原因。
- 状态读取不会刷新证据时间、revision、新鲜度或地图内容。
- 过期/来源会话不符/`STALE` 证据都不能产生 `OPEN`。

## 有限硬上限与工作预算

`LandLimits` 的所有字段必须为有限正数；计数类必须为正安全整数：

| 字段 | 默认值 | 作用 |
| --- | ---: | --- |
| `maxTransitions` | 1024 | 单条注册路线的转换数 |
| `maxCandidateCells` | 8192 | 单次扫掠/攀爬候选格 |
| `maxNeighborReads` | 16384 | 单次评估的受控 provider 邻读 |
| `maxShapeBoxes` | 4096 | 单次评估检查的碰撞盒总数 |
| `maxSupportFaces` | 2048 | 单次评估检查的支撑面总数 |
| `maxClimbRegions` | 4096 | 单次评估接受的攀爬区间总数 |
| `maxJumpDistance` | 4 | jump 水平距离实现范围（格） |
| `maxWork` | 65536 | 单次评估同步工作单位上限 |

候选枚举先计算精确格数，再在**分配任何数组之前**把枚举工作计入 `maxWork`；两段走廊、
并集、支撑候选与攀爬候选都走同一条路径。因此 `maxWork = 1` 或调用方把
`maxCandidateCells` 设得很大时，也不会先分配/遍历完整候选集。工作单位包括：候选枚举、
格读取、受控邻读、形状解析、碰撞盒、支撑面、攀爬区间与运动模型调用。

越界结果严格区分：

- **可配置容量**（`maxCandidateCells` / `maxNeighborReads` / `maxShapeBoxes` /
  `maxSupportFaces` / `maxClimbRegions`）不足 → `INCOMPLETE`，并返回
  `limitGap: { field, value, requiredAtLeast? }`。`field` 是具体配置名，`value` 是当前
  配置值，`requiredAtLeast` 是“如已知”的更大配置值下界。它们不是
  `UNSUPPORTED` / `unsupported_range`，也不是地形 `BLOCKED`。
- 实际 `maxWork` 用完 → `INCOMPLETE` / `budget`，并返回
  `work: { used, limit, requiredAtLeast, exhausted: true }`；`requiredAtLeast` 是完成
  本次评估所需工作的下界，不是保证值。
- 若容量/预算截断发生在**已经确认实际碰撞之后**，状态可以是已知的 `BLOCKED`，但结果仍
  带有 `limitGap`（或 `work.exhausted`），表示其余证据未完整枚举；不得据此宣称完整评估。
- 连续坐标/包围盒无法用安全整数精确表示（例如超出 `Number.MAX_SAFE_INTEGER`，或正体积
  包围盒因浮点表示退化不出任何格）→ `UNSUPPORTED` / `unsupported_range`。这不是调用方
  可以靠调大上限解决的容量问题，也绝不会静默变成 `OPEN`/空候选。
- 真正的移动几何超出子集（step 范围、jump 距离/同高单轴、ladder 固定 XZ）或缺少
  model/provider → `UNSUPPORTED`，分别使用 `unsupported_range` / `unsupported_model` /
  `unsupported_provider`。

`maxTransitions` 在读取/克隆任何元素之前按 `transitions.length` 先校验；超长路线不会
遍历后续元素。所有库内循环都受上述候选与工作预算约束；provider 自身的内部执行时间仍由
provider 负责，本库不宣称限制其硬 wall time。

## `LandRouteVerifier` 生命周期

```ts
const verifier = new LandRouteVerifier(map, { now, limits });

verifier.register({
  worldId, dim, sessionId,
  body,                    // width/height/pose 固定；feet = 第一条 from
  rules,                   // shapeProvider (+ jumpModel / climbProvider)
  transitions,             // 显式、已排序、精确首尾相接
});

verifier.advance(workBudget);      // 有界处理 pending；返回状态
verifier.apply(report, workBudget); // 消费 ChangeReport，局部失效后有界复验
verifier.invalidate(report);        // 只失效，不立即复验
verifier.invalidateSections(keys);  // 消费 unload/load 驻留变化
verifier.status();                  // 隔离只读快照；未注册时为 null
verifier.clear();                   // 丢弃追踪路线，不修改地图
```

注册规则：

- 第一条 `from` 必须与 `body.feet` **精确相等**；第 `i` 条 `from` 必须与第 `i-1` 条
  `to` 精确相等。不插入点、不取整、不跳过重复点。
- 注册会快照请求中的 body 与转换；之后修改调用方数组/对象不会影响已注册路线。
- 校验全部在替换现有路线之前完成；无效注册保留旧路线及其结果。
- 状态返回原始转换、pending/verified 索引、`openPrefix`、最早问题与逐段诊断。

有界推进与预算缺口：

- `advance` / `apply` 的 `workBudget` 是**一次调用**的总工作单位上限；每段实际下传的
  `maxWork` 为 `min(构造时的 limits.maxWork, 本次剩余预算)`。
- 被容量或工作预算截断、且尚未形成确定否定的段**不会**被存成结果，也不会算作 `OPEN`
  或已验证完成；本次调用停止，这些段保持 `pending`，路线判为 `INCOMPLETE`。下一次调用
  从该段**重新开始**评估。若截断前已经确认实际碰撞（已知否定），该段可作为 `BLOCKED`
  保留，但仍不得宣称其余证据已被完整枚举。
- `budgetGap` 保留具体停止原因，而不只是一个笼统数字：

  ```ts
  interface LandRouteBudgetGap {
    used: number;                // 本次调用实际消耗
    requiredAtLeast: number;     // 完成下一 pending 段所需预算的下界
    transitionIndex: number;     // 停止的段
    limit: 'advance_budget' | 'maxWork'
         | 'maxCandidateCells' | 'maxNeighborReads' | 'maxShapeBoxes'
         | 'maxSupportFaces' | 'maxClimbRegions';
    limitValue: number;          // 该限制的实际值
    requiredLimitAtLeast?: number; // 需要更大配置值时的下界（如已知）
    recovery: 'increase_advance_budget' | 'raise_configured_limits';
    diagnostic: { kind; detail; cells }; // 被截断评估的原始诊断
    transitionWork: LandWorkReport;      // 该段实际工作
  }
  ```

- `limit: 'advance_budget'` 表示本次调用的剩余预算先于构造上限耗尽；增大下一次
  `workBudget` 可继续。
- `limit: 'maxWork'` 表示本段预算已被构造时的 `limits.maxWork` 硬性截断；即使把
  `workBudget` 调得更大也不会越过该上限，必须用更大的配置限制重新创建 verifier。
- `limit: 'maxCandidateCells'` 等容量字段同理：`recovery` 为
  `raise_configured_limits`，仅增大单次预算无效。
- `requiredAtLeast` / `requiredLimitAtLeast` 都只是**下界**，不是保证值；调用方应按实测
  继续调整，而不是让路线永久 pending。
- 若在容量截断前已经确认了实际碰撞，该段仍可作为一个已知的 `BLOCKED` 否定结论保留；
  这不表示其余证据已被完整枚举，也不能把“每段都有结论”解释为“整个评估未被截断”。

局部失效与恢复：

- `apply(report, budget)` 通过 Section → transition 反向索引只丢弃依赖被修改 Section 的段；
  无关 Section 的已有证明保留。
- 刷新型报告（`invalidated: false`，内容未变但有效期延长）可以恢复依赖该 Section 的
  `STALE` 和 `UNSUPPORTED` 结论，即使 `Section.revision` 没有变化。覆盖
  “provider 读取过期邻格后返回 unsupported” 这类证据驱动的 `UNSUPPORTED`；有效的
  `OPEN` 不会被无关 Section 的刷新撤销。重新评估后若仍不支持，会得到相同结论。
- shape provider、jump model 或 climb provider 的 `version` 变化会撤销全部已验证证明并按
  新版本重新排队；结果中的 `ruleVersions` 反映当前版本。
- 证据 TTL 到期后，旧 `OPEN` 不会仅因再次 `status()` 而继续有效；快照时会重新检查时钟。
- Section unload/reload 通过 residency generation 撤销旧结论；未驻留使结论变为
  `nonresident`，重新载入的旧证据为 `STALE`，只有当前证据才能恢复 `OPEN`。
- 所有快照深拷贝；调用方修改返回对象不会污染内部状态。

## 本次验证

在修复提交前实际执行并通过：

- `npm run build`：TypeScript 构建成功。
- `npx tsc --noEmit`：全库类型检查成功。
- `npx vitest run tests/land-transition.test.ts tests/land-route.test.ts`：63 个陆地几何/路线
  测试全部通过，覆盖安全整数边界与数值不可表示、容量与工作预算区分、预分配计数、路线
  `budgetGap` 的 per-call/固定上限/容量恢复、jump 真实包围盒角落、支撑候选逐候选局部
  诊断（可选缺口不污染独立完整见证，且 provider 不能用返回面掩盖自身邻读缺口）、
  上身接触的高于脚高行程的攀爬来源、刷新型 `UNSUPPORTED` 恢复。
- `npx vitest run tests/step-evaluator.test.ts tests/traversability-cache.test.ts
  tests/route-verifier.test.ts`：88 个既有 step/cache/route 回归测试全部通过。

未运行真实 Minecraft 客户端或服务器，也未接线 mineflayer/pathfinder、动作注册或执行器；
上文 `OPEN` 仍只是当前证据对声明几何的支持结论。

## 未实现与未验证

- 没有执行器接线、没有移动、没有 `ARRIVED`、没有动作结果确认，也没有真实游戏服务器验收。
- 没有真实 Minecraft 跳跃/攀爬动力学模型；`test-quadratic-*` 与 `test-climb-*` 只是测试几何
  提供者。
- 没有真实 mineflayer/pathfinder 或宿主动作注册验证。
- 没有自动选择落点、自动搭桥/挖/放、自动登梯/下梯、自动救援或风险策略。
- `OPEN` 只代表当前证据支持声明的连续几何通道/轨迹与必要支撑/接触；不代表无风险、已授权
  或执行器一定支持。
