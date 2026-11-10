import { describe, expect, it } from 'vitest';
import {
  evaluateWalkSegment, evaluateLandTransition, resolveLandLimits, VoxelMap,
  type CollisionShapeProvider, type Vec3Like,
} from '../src/index.js';
import { AIR, STONE, bodyAt, fakeProvider, obs, stepQuery } from './fakes.js';

const limits = resolveLandLimits();
const rules = { shapeProvider: fakeProvider };

function fixture(kind: 'walk' | 'step' | 'drop', omitted?: Vec3Like) {
  const map = new VoxelMap('world', { validityWindowMs: 60_000 });
  const plannedFrom = { x: 0.5, y: kind === 'drop' ? 1 : 0, z: 0.5 };
  const from = { ...plannedFrom, x: 0.468, z: 0.51 };
  const to = { x: 1.5, y: kind === 'step' ? 1 : 0, z: 0.5 };
  for (let x = -1; x <= 2; x++) for (let z = -1; z <= 1; z++) for (let y = -1; y <= 3; y++) {
    if (omitted?.x === x && omitted.y === y && omitted.z === z) continue;
    const floor = kind === 'step' && x >= 1 || kind === 'drop' && x <= 0 ? 0 : -1;
    map.observe(obs(y <= floor ? STONE : AIR, { x, y, z }));
  }
  const evaluate = (actual = from, shapeProvider = fakeProvider) => kind === 'walk'
    ? evaluateWalkSegment(map, stepQuery({ body: bodyAt(actual.x, actual.y, actual.z) }), to, shapeProvider, 2000, 0.05)
    : evaluateLandTransition(map, {
      worldId: 'world', dim: 'overworld', sessionId: 's1',
      body: bodyAt(actual.x, actual.y, actual.z), transition: { kind, from: actual, to }, plannedFrom,
    }, { shapeProvider }, 2000, limits);
  return { map, plannedFrom, from, to, evaluate };
}

describe.each(['walk', 'step', 'drop'] as const)('measured %s execution corridor', (kind) => {
  it('verifies a 0.032-block residual and tiny lateral offset against the unchanged endpoint', () => {
    const { evaluate, from, to } = fixture(kind);
    const result = evaluate();
    expect(result.status).toBe('OPEN');
    expect(result.from).toEqual(from);
    expect(result.to).toEqual(to);
    expect(result.dependencies.length).toBeGreaterThan(0);
  });

  it('checks the actual swept body, including an obstacle outside the old planned corridor', () => {
    const { map, evaluate, plannedFrom } = fixture(kind);
    map.observe(obs({ name: 'test:edge', properties: {} }, { x: 0, y: plannedFrom.y + 1, z: 0 }, { sequence: 2, observedAt: 1500 }));
    const provider: CollisionShapeProvider = {
      version: 'drift-edge-shape',
      resolve(state, cell, read) {
        if (state.name !== 'test:edge') return fakeProvider.resolve(state, cell, read);
        return { kind: 'shape', shape: {
          boxes: [{ minX: 0, maxX: 1, minY: 0, maxY: 1, minZ: 0.805, maxZ: 1 }], supportFaces: [],
        } };
      },
    };
    expect(evaluate(plannedFrom, provider).status).toBe('OPEN');
    const result = evaluate(undefined, provider);
    expect(result.status).toBe('BLOCKED');
    expect(result.obstacles.length).toBeGreaterThan(0);
  });

  it('does not turn missing or stale evidence into an executable corridor', () => {
    const { evaluate } = fixture(kind, { x: 0, y: kind === 'drop' ? 2 : 1, z: 0 });
    expect(evaluate().status).toBe('UNKNOWN');
    const stale = fixture(kind);
    stale.map.beginSession('s2');
    expect(stale.evaluate().status).toBe('STALE');
  });

  it('refuses a residual outside the supported correction distance', () => {
    const { evaluate, plannedFrom } = fixture(kind);
    expect(evaluate({ ...plannedFrom, x: plannedFrom.x - 0.13 }).status).toBe('UNSUPPORTED');
  });
});

it('keeps strict unit step/drop semantics unless the original planned start is explicit', () => {
  for (const kind of ['step', 'drop'] as const) {
    const { map, from, to } = fixture(kind);
    const result = evaluateLandTransition(map, {
      worldId: 'world', dim: 'overworld', sessionId: 's1',
      body: bodyAt(from.x, from.y, from.z), transition: { kind, from, to },
    }, rules, 2000, limits);
    expect(result.status).toBe('UNSUPPORTED');
  }
});

it('requires actual support and retains the one-block step rise limit with plannedFrom', () => {
  for (const kind of ['step', 'drop'] as const) {
    const { evaluate, plannedFrom } = fixture(kind);
    expect(evaluate({ ...plannedFrom, y: plannedFrom.y + 0.03 }).status).toBe('BLOCKED');
    expect(evaluate({ ...plannedFrom, y: plannedFrom.y + 0.06 }).status).toBe('UNSUPPORTED');
  }
  const { evaluate, plannedFrom } = fixture('step');
  expect(evaluate({ ...plannedFrom, y: plannedFrom.y - 0.03 }).status).toBe('UNSUPPORTED');
});

it('rejects a non-unit planned edge and does not grant jump/ladder correction support', () => {
  const { map, plannedFrom, from, to } = fixture('step');
  for (const kind of ['step', 'drop', 'jump', 'ladder'] as const) {
    const result = evaluateLandTransition(map, {
      worldId: 'world', dim: 'overworld', sessionId: 's1',
      body: bodyAt(from.x, from.y, from.z),
      transition: { kind, from, to: { ...to, x: to.x + 1 } }, plannedFrom,
    }, rules, 2000, limits);
    expect(result.status).toBe('UNSUPPORTED');
  }
});

it('validates public continuous walk endpoints and tolerances before reading cells', () => {
  const map = new VoxelMap('world');
  expect(() => evaluateWalkSegment(map, stepQuery(), { x: Infinity, y: 0, z: 0 }, fakeProvider, 2000, 0.05)).toThrow(/finite/);
  expect(() => evaluateWalkSegment(map, stepQuery(), { x: 1.5, y: 0, z: 0.5 }, fakeProvider, 2000, 0.5)).toThrow(/feetTolerance/);
  expect(evaluateWalkSegment(map, stepQuery(), { x: 1.5, y: 0.06, z: 0.5 }, fakeProvider, 2000, 0.05).status).toBe('UNSUPPORTED');
});
