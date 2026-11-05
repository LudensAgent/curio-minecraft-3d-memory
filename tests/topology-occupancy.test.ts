import { describe, expect, it } from 'vitest';

import { TransientOccupancy } from '../src/topology/index.js';

describe('TransientOccupancy — short-lived entity placeholders', () => {
  it('expires by TTL and never stays a permanent obstacle', () => {
    let now = 1000;
    const occupancy = new TransientOccupancy({ now: () => now, defaultTtlMs: 500 });
    occupancy.observe({
      key: 'player-1',
      dim: 'overworld',
      pos: { x: 1.5, y: 64, z: 1.5 },
      source: 'entity_scan',
    });

    expect(occupancy.isOccupied('overworld', { x: 1.5, y: 64, z: 1.5 })).toBe(true);
    expect(occupancy.isOccupied('nether', { x: 1.5, y: 64, z: 1.5 })).toBe(false);
    // Outside the occupancy radius.
    expect(occupancy.isOccupied('overworld', { x: 5.5, y: 64, z: 1.5 })).toBe(false);

    now = 1499;
    expect(occupancy.isOccupied('overworld', { x: 1.5, y: 64, z: 1.5 })).toBe(true);
    now = 1500;
    expect(occupancy.isOccupied('overworld', { x: 1.5, y: 64, z: 1.5 })).toBe(false);
    expect(occupancy.size()).toBe(0);
  });

  it('replaces a stable occupant key and respects per-observation TTL', () => {
    let now = 1000;
    const occupancy = new TransientOccupancy({ now: () => now });
    occupancy.observe({
      key: 'player-1',
      dim: 'overworld',
      pos: { x: 0.5, y: 64, z: 0.5 },
      source: 'entity_scan',
      ttlMs: 100,
    });
    occupancy.observe({
      key: 'player-1',
      dim: 'overworld',
      pos: { x: 1.5, y: 64, z: 0.5 },
      source: 'entity_scan',
      ttlMs: 1000,
    });
    expect(occupancy.size()).toBe(1);
    expect(occupancy.occupants('overworld', { x: 0.5, y: 64, z: 0.5 })).toEqual([]);
    expect(occupancy.occupants('overworld', { x: 1.5, y: 64, z: 0.5 })).toHaveLength(1);
    now = 1999;
    expect(occupancy.isOccupied('overworld', { x: 1.5, y: 64, z: 0.5 })).toBe(true);
    now = 2000;
    expect(occupancy.isOccupied('overworld', { x: 1.5, y: 64, z: 0.5 })).toBe(false);
  });

  it('is bounded, evicting the nearest-to-expiry record first', () => {
    let now = 1000;
    const occupancy = new TransientOccupancy({ now: () => now, maxEntries: 1 });
    occupancy.observe({
      key: 'short',
      dim: 'overworld',
      pos: { x: 0, y: 64, z: 0 },
      source: 'entity_scan',
      ttlMs: 100,
    });
    occupancy.observe({
      key: 'long',
      dim: 'overworld',
      pos: { x: 1, y: 64, z: 0 },
      source: 'entity_scan',
      ttlMs: 1000,
    });
    expect(occupancy.size()).toBe(1);
    expect(occupancy.isOccupied('overworld', { x: 0, y: 64, z: 0 })).toBe(false);
    expect(occupancy.isOccupied('overworld', { x: 1, y: 64, z: 0 })).toBe(true);
  });

  it('validates inputs, supports an explicit sweep, and clears on teardown', () => {
    let now = 1000;
    const occupancy = new TransientOccupancy({ now: () => now });
    expect(() => occupancy.observe({ dim: '', pos: { x: 0, y: 0, z: 0 }, source: 'x' })).toThrow(/dim/);
    expect(() => occupancy.observe({ dim: 'overworld', pos: { x: 0, y: 0, z: 0 }, source: '' })).toThrow(
      /source/,
    );
    expect(() =>
      occupancy.observe({ dim: 'overworld', pos: { x: Number.NaN, y: 0, z: 0 }, source: 'x' }),
    ).toThrow(/finite/);

    occupancy.observe({ dim: 'overworld', pos: { x: 0, y: 64, z: 0 }, source: 'x', ttlMs: 50 });
    now = 1050;
    expect(occupancy.sweep()).toBe(1);
    occupancy.observe({ dim: 'overworld', pos: { x: 0, y: 64, z: 0 }, source: 'x' });
    occupancy.clear();
    expect(occupancy.size()).toBe(0);
  });
});
