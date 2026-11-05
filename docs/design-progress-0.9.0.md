# 空间记忆库设计 §3–§9 实现进度（0.9.0）

> 基线：库 `main` 合并 `codex/integration-lib-20261105`（代码提交 `9668ad4`，合并提交 `de516d6`）。
> 证据：本仓 955 项离线测试通过、`tsc --noEmit` 通过、独立消费者运行时与严格 NodeNext 类型通过。
> 本文件只登记设计 §3–§9 的实现程度与仍不声称的能力；不是真实 Minecraft / mineflayer 验收。

## 完成度矩阵

| 章节 | 估算完成度 | 本轮落地 | 明确仍不声称 |
|---|---:|---|---|
| §3 数据模型 | 92% | 观测来源/证据/完整性边界校验；`pending_effect` 失效；`ObservationBatch.unobserved` 进入有界缺口报告；`StepEvaluation.hazards/contextKey`；历史/当前/派生三层与四态通行；逐方向、模式、身体依赖；支撑面与脚格分离；水/岩浆四层契约 | 斜行/潜行/攀爬/游泳没有新的执行器；水陆/船舶为几何验证与证据，不是物理控制器；形状仍需注入版本化提供器 |
| §4 稀疏存储 | 92% | Chunk/Section/Cell 稀疏分配、负坐标、Palette 位打包与扩容；`explored/stale` 与 `traversed/modified` 写入并持久化；历史位不推进方块内容 revision；版本化体素载荷不再重复完整 blockstate；旧 v1/0.8.x v2 载荷可迁移；LRU/驻留/检查点容量有界 | `risk` 位图保留为派生索引，当前风险由查询时证据计算，不单独持久化全图风险；eager 地图容量由驻留上限约束，不承诺全图实时同步 |
| §5 拓扑与垂直连接 | 90% | 运行时边验证（方向 × 模式，BLOCKED/STALE/OPEN/UNKNOWN，依赖与有效期）；阻塞不删历史；门户边独立于步行图，保留原始去回程证据并派生 `returnVerified`；Agent/程序节点分命名空间与淘汰策略；`recordNode`、`markGone`、`goneNear`；union-find 碎片分量、分段、仅凭实际遍历证据合并；可达分量内的 surface/deepest 锚点；瞬时占位 TTL | 床/箱子/熔炉/农田的容器内容与语义仍归宿主精确账本；库只提供锚点、精度与外部引用，不复制容器内容；自动发现锚点仍由宿主观察驱动 |
| §6 动态更新 | 90% | 视锥/接触来源的观测差分；名称+属性比较；Section/格 revision；局部依赖失效与复验；执行器在途段撤销；有限 TTL；有界 `ObservationQueue`；同步 `onChange` 失效钩子；空气/移除需正面证据；实体占位不落永久地形 | 实际扫描/空气证据由宿主的合法感知产生；库不模拟流体传播；宿主仍需把 `ChangeReport` 接到缓存/路线失效（库提供同步入口，不代持感知循环） |
| §7 导航接口 | 90%（首版 walk 范围） | 集成 `navigateTo`：实测起点 → 有界搜索 → 复验执行 → 实测到达；`followKnownPath` 支持 pathId/fragmentId；`inspectRoute` 与 `inspectKnownRoute` 只读；`frontierCandidates` 可注入历史连接查询；`NavResult`/`ActionRecord`/PARTIAL/取消/超时保留实测位置；显式拒绝未实现模式、near/reach_block、施工、材料、avoid | 只执行同高、沿 X/Z 单轴、普通干燥整块的 walk；near 到达、跳跃/台阶/梯子/游泳/船、挖放搭柱与材料额度仍显式拒绝；不是宿主动作注册或真实寻路服务 |
| §8 心智接缝 | 90% | 结构化 `NavResult`/problem/证据；节点/路径稳定引用与观测时间；只读投影；`Frontier` 不选目标；能力表如实区分 implemented/read_only/host_approximation/not_implemented；宿主的 `SkillResult.data.nav` 由 Curio 侧接线 | 库不导入 Curio 类型，`SkillResult` 映射属于宿主适配层；`recall_route` 仍不是公开运行时入口；危险区/容器账本的语义历史仍归宿主 |
| §9 持久化 | 90% | `SpatialMemoryStoreImpl` 组合内存地图/历史/拓扑并做世界作用域守卫；真实 SQLite Worker、WAL、事务、批量 checkpoint、close 确认；Section/历史/拓扑/事件/动作/放置/访问/门户穿越表；旧账本迁移演练保留 ID/时间/LRU/删除语义；异步加载不刷新观测时间，恢复证据为 STALE | 本轮按设计 §9.1 只做离线迁移演练，不执行 JSON→SQLite 权威切换、不删除旧写入路径；不声称重启后可直接复用 OPEN |

## 验证记录

```text
npx vitest run --exclude 'acceptance/**'
-> 37 files passed; 955 tests passed

npx tsc --noEmit            (integration worktree)
-> exit 0

独立消费者（临时目录安装 0.9.0 tgz）
-> 根入口运行时导入 PASS
-> 严格 NodeNext 类型 PASS
```

0.9.0 制品：`curio-minecraft-3d-memory-0.9.0.tgz`，SHA256 `54e688590690a5cfc9ae36da1bbd977ecd7d47d2ca9a73334fd2cfe7053fd424`，来源提交 `9668ad49c2f37f96c0e3173a67a525dc5006fa67`。真实 Java 1.20.1 / mineflayer 联机验收未在本次执行。
