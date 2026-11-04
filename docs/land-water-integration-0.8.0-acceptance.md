# 0.8.0 land/water integration acceptance

Integration of the two read-only validation branches into `main`. This record
contains only commands and results that were actually executed on
2026-11-04 in the integration worktree.

## Inputs

- Base: `main` @ `47b92bef469d199dc75b2f928f1b3aedd97cfd03`
- Land branch: `codex/land-route-validation-20261104` @ `35090d48837ebfb7c381a9de5cbf4c3181d77125`
- Water branch: `codex/water-boat-validation-20261104` @ `b9fa89fdba6a7f5f6ee07e2a4a499c6fb67cee1b`
- Both branches were based exactly on the base commit; `git merge-tree --write-tree`
  reported no conflicts for either branch or for the two branches against each other.

## Merge commits

| Order | Merge commit | Merged branch |
| --- | --- | --- |
| 1 | `940a079` | `codex/land-route-validation-20261104` |
| 2 | `470625b` | `codex/water-boat-validation-20261104` |

The merge used `--no-ff`; no feature commit was rewritten. Land adds
`src/traversability/land-geometry.ts`, `land-route.ts`, `land-transition.ts`,
root exports, and two test files. Water adds `src/water/`, the
`./water` package export, and `tests/water-validation.test.ts`.

## Boundary audit

The merged land and water modules were inspected for the repository's
development constraints:

- No `any` type appears in `src/traversability/`, `src/water/`, or
  `src/index.ts` (`grep` for `: any`, `<any>`, `as any`, `any[]`: none).
- The modules import only other library modules; no host source, filesystem,
  database, process, or network access.
- No world scanning, world/chunk loading, route search, body movement,
  block digging/placing, boat mount/dismount/build/recover, equipment change,
  timer, or rescue strategy is implemented.
- Land transition and route results carry `assurance: 'geometry_only'` and
  `executable: false`.
- Water results do not carry an `assurance` literal. Their bounded, read-only
  semantics are stated in the public type comments: `OPEN` covers only the
  declared geometry/evidence contract and never arrival, authorization,
  executor support, or absence of risk. `checkWaterArrival` returns only
  `ARRIVED` or `UNCONFIRMED`. This is a documentation-level difference, not a
  behavior change made during integration.

## Version

`package.json` and the two root `version` fields in `package-lock.json` were
bumped `0.7.7` -> `0.8.0`. Dependency ranges were unchanged. README.md and
README_ZH.md document the root land exports and the
`curio-minecraft-3d-memory/water` subpath.

## Build and type check

```text
npm run build            -> exit 0; dist/water/index.js and dist/water/index.d.ts present
npx tsc --noEmit         -> exit 0
```

The same `npx tsc --noEmit` was run on a detached clean worktree of `main` @
`47b92be` after `npm run build`; it also exited 0. No type errors are
pre-existing on main or introduced by the merge. (A fresh checkout must build
first because some tests import `../dist`.)

## Tests

Baseline, run on the unmodified base commit `47b92be` (same worktree before
merging):

```text
npm test (vitest run)
Test Files  3 failed | 23 passed (26)
     Tests  675 passed (675)
```

Merged result:

```text
npm test (vitest run)
Test Files  3 failed | 26 passed (29)
     Tests  810 passed (810)
```

The same three suites fail to load in both runs, with the pre-existing error
`No test suite found in file .../acceptance/{consumer-close,provenance,run}.test.mjs`;
those files are not vitest suites. No assertion was modified. The 135 added
tests account exactly for the increase.

Targeted run:

```text
npx vitest run tests/land-transition.test.ts tests/land-route.test.ts tests/water-validation.test.ts
Test Files  3 passed (3)
     Tests  135 passed (135)   (46 land-transition + 18 land-route + 71 water-validation)
```

## Package artifact

Packed into an isolated directory, not the worktree root and not any existing
artifact location:

```text
npm pack --pack-destination C:/Users/Administrator/AppData/Local/Temp/curio-lw-pack-080-20261104
```

- File: `curio-minecraft-3d-memory-0.8.0.tgz`
- Size: 364,617 bytes
- SHA-256: `f0d19fd50af324a1efa3e5051930c31218dd37a1b66965b41f3828906d3399dd`
- npm sha512 integrity: `sha512-eCgUR80rZ1JcbGCh1f5npfgmoOLH/25ax2u2lkTGDfFvTbKu7Ih9Irb69Vy7VbgfsUmB2zcsP/PQ3LVSmQT3PQ==`
- npm sha1 shasum: `290bd3f43827ab09f2aa1dee317ecec0f78c91c3`
- Packed files: 218; unpacked size 1.7 MB.

## Independent consumer

A fresh directory with `{"type":"module"}` installed the tarball by file path
(`npm install <tgz>`, no other network access). Installed version `0.8.0`.

Runtime:

```text
import('curio-minecraft-3d-memory')       -> 32 exports
import('curio-minecraft-3d-memory/water') -> 2 exports
evaluateLandTransition:function LandRouteVerifier:function
RouteVerifier:function evaluateWalkStep:function
evaluateWaterRoute:function checkWaterArrival:function
runtime_import_ok
```

Strict NodeNext type check of a consumer importing both entries and several
public types:

```text
tsc --strict --module NodeNext --moduleResolution NodeNext --noEmit consumer.ts
exit 0
```

## Repository acceptance runner

`node acceptance/run.mjs --execute` was run after the version/docs commit on a
clean tree. It used its own unique temp output directory and did not overwrite
existing artifacts.

```text
scenario positive               : PASS
scenario early-release-pin      : PASS
scenario skip-final-checkpoint  : PASS
typecheck                       : PASS
source binding                  : clean
outcome                         : PASS
artifact sha256                 : f0d19fd50af324a1efa3e5051930c31218dd37a1b66965b41f3828906d3399dd
```

The runner's independently packed artifact has the same SHA-256 as the pack
above. Evidence directory:
`C:\Users\ADMINI~1\AppData\Local\Temp\curio-minecraft-3d-memory-acceptance\run-1793805116877-97576\evidence.json`.

The runner still reports its own `runner version: 0.7.6`; that constant was not
changed by this integration.

## Not implemented or not verified

- No Minecraft motion model for jumps, no ladder/climb provider, and no fluid or
  water-surface provider is bundled. Callers must inject versioned
  `LandMotionModel`, `ClimbRegionProvider`, `CollisionShapeProvider`, and
  `FluidShapeProvider` implementations.
- No controller or execution loop is added for land transitions, swimming, or
  boats. `LandRouteVerifier` and `evaluateWaterRoute` only re-verify
  caller-selected geometry; they do not move the body.
- No boat mount/dismount/build/recover action, route search, shore selection,
  pathfinding, rescue strategy, or world scanning.
- No host wiring: no mineflayer adapter, Curio dispatcher, skill, prompt, or
  perception-loop integration for these validators.
- No real Minecraft or mineflayer acceptance was run. All evidence above comes
  from pure in-memory tests, a packed-package consumer, and the repository's
  Fake-based acceptance scenarios.
