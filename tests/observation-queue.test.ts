import { describe, expect, it } from 'vitest';

import { ObservationQueue } from '../src/observation/queue.js';
import type { Observation, ObservationBatch } from '../src/observation/types.js';

function obs(overrides: Partial<Observation> = {}): Observation {
  return {
    worldId: 'world',
    dim: 'overworld',
    sessionId: 's1',
    observedAt: 1000,
    sequence: 1,
    source: 'vision',
    evidence: 'seen',
    stateComplete: true,
    state: { name: 'minecraft:stone', properties: {} },
    pos: { x: 0, y: 0, z: 0 },
    ...overrides,
  };
}

function batch(observations: Observation[], gaps: ObservationBatch['unobserved'] = []): ObservationBatch {
  return { observations, unobserved: gaps };
}

describe('ObservationQueue bounds', () => {
  it('accepts a batch atomically or refuses it with an explicit count overflow', () => {
    const queue = new ObservationQueue({ maxItems: 3 });
    const result = queue.enqueue(batch([obs(), obs(), obs(), obs()]));

    expect(result).toMatchObject({ accepted: false, observations: 0, gaps: 0, bytes: 0 });
    expect(result.overflow).toMatchObject({ observations: 4, gaps: 0, reason: 'max_items' });
    expect(queue.backlog()).toEqual({ observations: 0, gaps: 0, bytes: 0 });
  });

  it('refuses a batch that would exceed the byte budget and reports it', () => {
    const queue = new ObservationQueue({ maxBytes: 100, estimateBytes: () => 60 });
    expect(queue.enqueue(batch([obs()])).accepted).toBe(true);

    const refused = queue.enqueue(batch([obs()]));
    expect(refused.accepted).toBe(false);
    expect(refused.overflow).toMatchObject({ observations: 1, reason: 'max_bytes' });
    expect(queue.backlog()).toEqual({ observations: 1, gaps: 0, bytes: 60 });

    const drained = queue.drain(10);
    expect(drained.observations).toHaveLength(1);
    expect(drained.backlog).toEqual({ observations: 0, gaps: 0, bytes: 0 });
    expect(drained.overflow).toMatchObject({ observations: 1, reason: 'max_bytes' });
  });

  it('drains at most maxItems in FIFO order and reports the remaining backlog', () => {
    const queue = new ObservationQueue();
    queue.enqueue(
      batch([1, 2, 3, 4, 5].map((sequence) => obs({ sequence, pos: { x: sequence, y: 0, z: 0 } }))),
    );

    const first = queue.drain(2);
    expect(first.observations.map((o) => o.sequence)).toEqual([1, 2]);
    expect(first.backlog).toEqual({ observations: 3, gaps: 0, bytes: expect.any(Number) });
    expect(first.overflow).toBeNull();

    const second = queue.drain(10);
    expect(second.observations.map((o) => o.sequence)).toEqual([3, 4, 5]);
    expect(second.backlog.observations).toBe(0);
  });

  it('never turns gaps into observations and keeps them separate', () => {
    const queue = new ObservationQueue();
    queue.enqueue(
      batch([obs()], [
        { pos: { x: 1, y: 0, z: 0 }, reason: 'occluded' },
        { pos: { x: 2, y: 0, z: 0 }, reason: 'budget_not_scanned' },
      ]),
    );

    const drained = queue.drain(10);
    expect(drained.observations).toHaveLength(1);
    expect(drained.gaps).toEqual([
      { pos: { x: 1, y: 0, z: 0 }, reason: 'occluded' },
      { pos: { x: 2, y: 0, z: 0 }, reason: 'budget_not_scanned' },
    ]);
  });

  it('clones enqueued items so later caller mutation cannot change queued facts', () => {
    const queue = new ObservationQueue();
    const input = obs({ state: { name: 'minecraft:dirt', properties: { a: '1' } } });
    queue.enqueue(batch([input]));

    input.state.name = 'minecraft:air';
    input.pos.x = 99;

    const drained = queue.drain(1);
    expect(drained.observations[0]!.state.name).toBe('minecraft:dirt');
    expect(drained.observations[0]!.pos).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('refuses an unbounded or invalid drain request', () => {
    const queue = new ObservationQueue();
    expect(() => queue.drain(0)).toThrow(/positive safe integer/);
    expect(() => queue.drain(Number.POSITIVE_INFINITY)).toThrow(/positive safe integer/);
    expect(() => queue.drain(1.5)).toThrow(/positive safe integer/);
  });
});
