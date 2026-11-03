/**
 * Runnable example for manual on-demand Section residency (phase 5D1).
 *
 * Shows the full closed loop: establish a saved record → reopen in manual mode →
 * read the committed directory → explicitly load a section → accept an observation
 * → checkpoint → pin/release → safe unload → reload → verify the original fact and
 * time survived. The loaded evidence reads as STALE (a past observation), never a
 * fresh observation or a current OPEN.
 *
 * This example imports the built package by its public name and subpath (not the
 * source path), so it exercises the package `exports` entry. Build first, then run:
 *
 *   npm run build
 *   npx tsx examples/spatial-residency.ts
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSpatialSession } from 'curio-minecraft-3d-memory/storage/sqlite';
import type { SectionKey } from 'curio-minecraft-3d-memory';

const WORLD = 'world';
const DIM = 'overworld';
const stone = { name: 'minecraft:stone', properties: {} };
const dirt = { name: 'minecraft:dirt', properties: {} };

function key(x: number, y: number, z: number): SectionKey {
  return { worldId: WORLD, dim: DIM, cx: Math.floor(x / 16), cz: Math.floor(z / 16), sy: Math.floor(y / 16) };
}

function cellInfo(map: { cellAt(dim: string, x: number, y: number, z: number): unknown }, x: number, y: number, z: number): string {
  const view = map.cellAt(DIM, x, y, z) as {
    observed: boolean;
    evidence?: { observation: { state: { name: string }; observedAt: number }; freshness: string };
  };
  if (!view.observed) return 'unobserved';
  const e = view.evidence!;
  return `${e.observation.state.name}@${e.observation.observedAt} (${e.freshness})`;
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'spatial-residency-'));
  const databasePath = join(dir, 'spatial.db');

  try {
    // 1. Establish a saved record in the default (eager) mode.
    const setup = await openSpatialSession({ databasePath, worldId: WORLD });
    setup.voxel.beginSession('setup');
    setup.voxel.observe({
      worldId: WORLD, dim: DIM, sessionId: 'setup', observedAt: 1000, sequence: 1,
      source: 'vision', evidence: 'seen', stateComplete: true, state: stone, pos: { x: 0, y: 64, z: 0 },
    });
    setup.voxel.observe({
      worldId: WORLD, dim: DIM, sessionId: 'setup', observedAt: 1000, sequence: 2,
      source: 'vision', evidence: 'seen', stateComplete: true, state: stone, pos: { x: 1, y: 64, z: 0 },
    });
    await setup.checkpoint();
    await setup.close();

    // 2. Reopen in manual mode: only the directory is read, not the payloads.
    const session = await openSpatialSession({ databasePath, worldId: WORLD, voxelLoading: 'manual' });
    const section = key(0, 64, 0);
    console.log('residency before load:', session.sectionResidency(section).residency); // not_resident

    // 3. Explicitly load, then accept a fresh observation with its original time.
    const load = await session.loadSections([section]);
    console.log('loaded:', load.loaded.length, '| missing:', load.missing.length);
    console.log('residency after load:', session.sectionResidency(section).residency); // resident
    console.log('cell after load:', cellInfo(session.voxel, 0, 64, 0)); // stone@1000 (STALE)

    session.voxel.beginSession('live');
    session.voxel.observe({
      worldId: WORLD, dim: DIM, sessionId: 'live', observedAt: 2000, sequence: 1,
      source: 'vision', evidence: 'seen', stateComplete: true, state: dirt, pos: { x: 0, y: 64, z: 0 },
    });
    await session.checkpoint();
    console.log('cell after observe + checkpoint:', cellInfo(session.voxel, 0, 64, 0)); // dirt@2000 (FRESH)

    // 4. Pin → unload is refused; release → unload succeeds → reload preserves facts.
    const lease = session.pinSections([section]);
    console.log('unload while pinned:', session.unloadSections([section]).rejected[0]?.reason); // pinned
    session.releasePins([lease.token]);
    console.log('unload after release:', session.unloadSections([section]).unloaded.length); // 1

    await session.loadSections([section]);
    console.log('cell after reload:', cellInfo(session.voxel, 0, 64, 0)); // dirt@2000 (STALE)
    console.log('sibling cell after reload:', cellInfo(session.voxel, 1, 64, 0)); // stone@1000 (STALE)

    await session.close();
    console.log('note: no world scan, no current OPEN/BLOCKED, and no move was produced above.');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

void main();
