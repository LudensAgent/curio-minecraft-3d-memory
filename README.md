# Spatial Memory Library

Spatial facts, historical geometry, traversability verification, and composable navigation helpers for a Minecraft Java 1.20.1 agent — scoped to **land walking** and **surface-water movement** (jumping, steps, ladders, drop transitions, surface swimming, boating, and shore in/out).

> 中文说明见 [README_ZH.md](README_ZH.md).

## Overview

- **Facts and execution assistance only.** Answers *what was last observed here, how it was traversed before, whether current evidence supports passage, and which segment needs re-verification*. Goals, strategy, resource spend, and risk trade-offs remain the agent's decision.
- **Three-layer data separation.** Historical geometry (never deleted on blockage), recent observation state (versioned, evidence-backed), derived traversability (invalidation-friendly cache).
- **No host coupling.** Consumes mineflayer/Curio perception and execution through a `WorldAdapter` abstraction; never imports host source.

See [`docs/spatial-memory-library-design.md`](docs/spatial-memory-library-design.md) and [`AGENTS.md`](AGENTS.md) for the design rationale and development constraints. Interfaces in the design doc are **target contracts**; this repository lands behavior per design §10.

### Implemented so far

- **Voxel map** (`voxel/`): sparse, versioned observation state with per-cell evidence, session/interruption handling and localized `ChangeReport`s.
- **Traversability** (`traversability/`): read-only single-step walk evaluation, an invalidation-friendly cache, and bounded route verification over an ordered point list.
- **Controlled walk-route execution** (`execution/`): `WalkRouteExecutor` connects a verified route to an injectable single-step `MoveExecutor` with measured body feedback. It only executes the caller's ordered points (same height, ±1 along X/Z), never starts a step without current OPEN evidence, requires a measured `exact` position for `ARRIVED`, and revokes an in-flight segment when its evidence changes.

These are validated **in-memory with a Fake executor** (see `tests/walk-route-executor.test.ts` and the runnable `examples/walk-route-execution.ts`). They do **not** yet wire a real mineflayer/Curio body, pathfinding, or SQLite persistence.

## Project structure

```
src/
├── index.ts            # public API entry (minimal, explicit export surface)
├── constants.ts        # single-source config constants (section size, PASSAGE_LINK, …)
├── types.ts            # base primitives (Vec3Like / BlockState / WorldScope / MoveMode)
├── observation/        # World Observer: Observation / evidence / freshness (§3.2)
├── voxel/              # Spatial Mapper: Section / Palette / bit-packing (§4)
├── traversability/     # derived traversability: Traversability / HazardFact (§3.3)
├── topology/           # Topology Manager: path fragments / nodes / edges (§3.1, §5)
├── adapter/            # WorldAdapter target surface (§2.1)
├── navigation/         # L2 navigation primitives and result envelope (§7)
├── execution/          # controlled walk-route execution loop (§7 first step, phase 3)
├── store/              # SpatialMemoryStore runtime interface (§9)
├── storage/            # SQLite persistence and worker (§9, phase 5)
└── compat/             # legacy WorldMemory entry compatibility layer (§8, §9.1)

examples/
└── walk-route-execution.ts  # runnable Fake demo of the execution loop
```

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run build       # emits dist/ (NodeNext ESM + type declarations)
npx tsx examples/walk-route-execution.ts  # run the Fake execution demo
```

> The persistence driver (`better-sqlite3`) is wired in at phase 5 (design §9.2); `storage/` currently holds only the schema contract and worker interface, with no native dependency.

## License

UNLICENSED (private).
