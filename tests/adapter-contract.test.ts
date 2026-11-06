import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type {
  AgentState,
  BodyAdapter,
  ObservationBatch,
  ObservationSource,
  PerceptionEvent,
  PerceptionSource,
  Vec3Like,
  WorldAdapter,
} from '../src/index.js';

const state: AgentState = {
  pos: { x: 0.5, y: 64, z: 0.5 },
  dim: 'overworld',
  worldId: 'world',
  sessionId: 's1',
  observationId: 1,
  observedAt: 1000,
  alive: true,
  connected: true,
  observationReady: true,
  onGround: true,
  inWater: false,
  inLava: false,
  oxygen: 300,
  effects: [],
  riding: null,
  worldAgeTicks: 100,
};

function perceptionOnly(): PerceptionSource {
  return {
    state: () => state,
    observeBatch: (_positions: Vec3Like[]): ObservationBatch => ({ observations: [], unobserved: [] }),
    capabilities: () => ({ fullBlockState: true, movementModes: ['walk'] }),
    subscribe: (_cb: (event: PerceptionEvent) => void) => () => {},
  };
}

function bodyOnly(): BodyAdapter {
  return {
    moveTo: async () => {},
    stopAll: () => {},
    dig: async () => ({ ok: true, effects: [] }),
    placeBlockAt: async () => ({ ok: true, effects: [] }),
  };
}

describe('adapter split — PerceptionSource / BodyAdapter', () => {
  it('separates perception from body actions at the type level', () => {
    type BodyKeys =
      | 'moveTo'
      | 'swimTo'
      | 'stopAll'
      | 'dig'
      | 'placeBlockAt'
      | 'recentDug'
      | 'recentPlaced';
    type PerceptionKeys = 'state' | 'observeBatch' | 'capabilities' | 'subscribe';

    // Neither face leaks the other's methods.
    type BodyInPerception = Extract<keyof PerceptionSource, BodyKeys>;
    type PerceptionInBody = Extract<keyof BodyAdapter, PerceptionKeys>;
    const noBodyInPerception: BodyInPerception extends never ? true : false = true;
    const noPerceptionInBody: PerceptionInBody extends never ? true : false = true;

    // The compatibility type is exactly the composition of both faces.
    type WorldIsComposition =
      keyof WorldAdapter extends keyof PerceptionSource | keyof BodyAdapter
        ? keyof PerceptionSource | keyof BodyAdapter extends keyof WorldAdapter
          ? true
          : false
        : false;
    const worldIsComposition: WorldIsComposition = true;

    // The legacy body fields must remain visible on WorldAdapter.state().
    type WorldState = ReturnType<WorldAdapter['state']>;
    type WorldStateIsAgentState = WorldState extends AgentState
      ? AgentState extends WorldState
        ? true
        : false
      : false;
    const worldStateIsAgentState: WorldStateIsAgentState = true;
    expect(worldStateIsAgentState).toBe(true);

    expect(noBodyInPerception).toBe(true);
    expect(noPerceptionInBody).toBe(true);
    expect(worldIsComposition).toBe(true);
  });

  it('keeps WorldAdapter source-compatible while the memory face stays perception-only', () => {
    // The compatibility face keeps the legacy `AgentState` return.
    const full: WorldAdapter = {
      ...perceptionOnly(),
      ...bodyOnly(),
      state: () => state,
    };

    const perception: PerceptionSource = full;
    const body: BodyAdapter = full;
    expect(perception.capabilities().movementModes).toEqual(['walk']);
    expect(typeof body.stopAll).toBe('function');

    // A perception-only object is a valid memory input.
    const memoryInput: PerceptionSource = perceptionOnly();
    expect(memoryInput.state().worldId).toBe('world');

    // @ts-expect-error a perception input is not a body adapter
    const bodyFromPerception: BodyAdapter = perceptionOnly();
    // @ts-expect-error a body adapter is not a perception input
    const perceptionFromBody: PerceptionSource = bodyOnly();
    expect(bodyFromPerception).toBeDefined();
    expect(perceptionFromBody).toBeDefined();
  });

  it('leaves the existing ObservationSource evidence-origin union unchanged', () => {
    const origins: ObservationSource[] = ['vision', 'agent_action', 'local_rescan'];
    expect(origins).toEqual(['vision', 'agent_action', 'local_rescan']);
  });

  it('keeps src/memory free of navigation, execution and adapter-body imports', () => {
    const memoryDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'memory');
    const files = readdirSync(memoryDir).filter((file) => file.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);

    const forbiddenModule = /(?:^|\/)(?:adapter|navigation|execution)(?:\/|$|\.js)/;
    const forbiddenIdentifier = /\b(?:BodyAdapter|MoveExecutor|WalkRouteExecutor|MoveOpts)\b/;

    for (const file of files) {
      const source = readFileSync(join(memoryDir, file), 'utf8');
      const specifiers = [...source.matchAll(/(?:import|export)\s[^;]*?from\s*'([^']+)'/g)].map(
        (match) => match[1] ?? '',
      );
      for (const specifier of specifiers) {
        expect(
          forbiddenModule.test(specifier),
          `${file} must not import ${specifier}`,
        ).toBe(false);
      }
      expect(forbiddenIdentifier.test(source), `${file} must not mention body APIs`).toBe(false);
    }
  });
});
