# Spatial Memory Library

Spatial facts, historical geometry, traversability verification, and composable navigation helpers for a Minecraft Java 1.20.1 agent — scoped to **land walking** and **surface-water movement** (jumping, steps, ladders, drop transitions, surface swimming, boating, and shore in/out).

> 中文说明见 [README_ZH.md](README_ZH.md).

## Overview

- **Facts and execution assistance only.** Answers *what was last observed here, how it was traversed before, whether current evidence supports passage, and which segment needs re-verification*. Goals, strategy, resource spend, and risk trade-offs remain the agent's decision.
- **Three-layer data separation.** Historical geometry (never deleted on blockage), recent observation state (versioned, evidence-backed), derived traversability (invalidation-friendly cache).
- **No host coupling.** Consumes mineflayer/Curio perception and execution through a `WorldAdapter` abstraction; never imports host source.

See [`docs/spatial-memory-library-design.md`](docs/spatial-memory-library-design.md) and [`AGENTS.md`](AGENTS.md) for the design rationale and development constraints. Interfaces in the design doc are **target contracts**; this repository is currently the **initial directory architecture** — types and structure are in place, behavior lands per design §10.

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
├── store/              # SpatialMemoryStore runtime interface (§9)
├── storage/            # SQLite persistence and worker (§9, phase 5)
└── compat/             # legacy WorldMemory entry compatibility layer (§8, §9.1)
```

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run build       # emits dist/ (NodeNext ESM + type declarations)
```

> The persistence driver (`better-sqlite3`) is wired in at phase 5 (design §9.2); `storage/` currently holds only the schema contract and worker interface, with no native dependency.

## License

UNLICENSED (private).
