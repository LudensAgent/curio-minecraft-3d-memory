import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InMemoryFactStore,
  VoxelMap,
  createVoxelFactsQueryPort,
} from '../src/index.js';
import { openSpatialSession } from '../dist/storage/sqlite/index.js';

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function factsPort(facts: InMemoryFactStore) {
  return createVoxelFactsQueryPort({ worldId: 'w', voxel: new VoxelMap('w'), facts });
}

it('queries facts exclusively and observes revocation before persistence', () => {
  const facts = new InMemoryFactStore();
  const port = factsPort(facts);
  facts.upsertResource({ id: 'ore', worldId: 'w', dim: 'overworld', label: 'iron_ore', sourceCell: { x: -1, y: 64, z: 0 }, observedAt: 100, source: { source: 'vision' }, revoked: false });
  const found = port.query({ kind: 'resourceAnchors' });
  expect(found.data?.kind === 'resourceAnchors' && found.data.items.map(item => item.id)).toEqual(['ore']);
  facts.revokeResource('ore', { observedAt: 200, source: { source: 'vision' } });
  expect(port.query({ kind: 'resourceAnchors' }).total).toBe(0);
  expect(port.query({ kind: 'resourceAnchors', includeGone: true }).total).toBe(1);
  // Retired route reads are rejected by the request boundary, not answered by a
  // compatibility store.
  expect(port.query({ kind: 'fragments' } as never).status).toBe('invalid_request');
});

it('queries live containers without a topology classifier and keeps cursors stable', () => {
  const facts = new InMemoryFactStore();
  const port = factsPort(facts);
  for (const id of ['b', 'a']) facts.upsertContainer({ id, worldId: 'w', dim: 'overworld', pos: { x: 0, y: 64, z: 0 }, externalRef: id, observedAt: 100, source: { source: 'vision' }, gone: false });
  expect(port.query({ kind: 'containerAnchors', limit: 1 }).nextAfter).toBe('a');
  facts.markContainerGone('a', { observedAt: 200, source: { source: 'vision' } });
  expect(port.query({ kind: 'containerAnchors' }).total).toBe(1);
});

it('distinguishes saving facts from committing the legacy migration receipt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'facts-cutover-'));
  directories.push(dir);
  const options = { databasePath: join(dir, 'memory.sqlite'), worldId: 'w', voxelLoading: 'manual' as const };
  const first = await openSpatialSession(options);
  first.facts.upsertPlace({ id: 'base', kind: 'base', label: 'home', worldId: 'w', dim: 'overworld', location: { kind: 'exact', pos: { x: 0, y: 64, z: 0 } }, observedAt: 100, source: { source: 'agent' }, gone: false });
  await first.checkpoint();
  expect(first.legacyFactsMigrationVersion).toBe(0);
  await first.checkpoint({ completeLegacyFactsMigration: true });
  expect(first.legacyFactsMigrationVersion).toBe(1);
  await first.close();
  const restored = await openSpatialSession(options);
  try {
    expect(restored.legacyFactsMigrationVersion).toBe(1);
    expect(restored.facts.places().items[0]!.observedAt).toBe(100);
  } finally { await restored.close(); }
});
