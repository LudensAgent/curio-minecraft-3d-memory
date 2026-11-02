import { describe, expect, it } from 'vitest';

import type { NavResult } from '../src/navigation/types.js';
import type { Vec3Like } from '../src/types.js';

const pos: Vec3Like = { x: 0, y: 0, z: 0 };
const snapshot = {
  worldId: 'w',
  dim: 'overworld',
  sessionId: 's',
  observedAt: 1,
  onGround: true,
  inWater: false,
};

const arrived: NavResult = {
  outcome: 'ARRIVED',
  message: 'arrived',
  lastPosition: pos,
  lastObservation: snapshot,
  confirmed: true,
  trace: [],
};

const failed: NavResult = {
  outcome: 'NO_PATH',
  message: 'no path found',
  problem: { kind: 'no_path' },
  confirmed: false,
  trace: [],
};

describe('NavResult discriminated union', () => {
  it('ARRIVED carries position, observation and confirmation', () => {
    expect(arrived.confirmed).toBe(true);
    expect(arrived.lastPosition).toEqual(pos);
    expect(arrived.lastObservation.onGround).toBe(true);
  });

  it('failure carries a structured problem', () => {
    expect(failed.problem.kind).toBe('no_path');
  });
});

// --- Compile-time rejections: validated by `npm run typecheck` (tsc), not vitest. ---
// Each invalid shape below must FAIL to type-check, hence `@ts-expect-error`.

// @ts-expect-error ARRIVED must carry lastPosition
const _arrivedMissingPosition: NavResult = { outcome: 'ARRIVED', message: 'arrived', lastObservation: snapshot, confirmed: true, trace: [] };

// @ts-expect-error ARRIVED must carry lastObservation
const _arrivedMissingObservation: NavResult = { outcome: 'ARRIVED', message: 'arrived', lastPosition: pos, confirmed: true, trace: [] };

// @ts-expect-error ARRIVED must be confirmed: true
const _arrivedUnconfirmed: NavResult = { outcome: 'ARRIVED', message: 'arrived', lastPosition: pos, lastObservation: snapshot, confirmed: false, trace: [] };

// @ts-expect-error failure must carry a structured problem
const _failureWithoutProblem: NavResult = { outcome: 'BLOCKED', message: 'blocked', confirmed: false, trace: [] };

// @ts-expect-error ARRIVED must not carry a problem
const _arrivedWithProblem: NavResult = { outcome: 'ARRIVED', message: 'arrived', lastPosition: pos, lastObservation: snapshot, confirmed: true, problem: { kind: 'no_path' }, trace: [] };
