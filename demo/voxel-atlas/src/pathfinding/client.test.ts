import { afterEach, expect, it, vi } from 'vitest';
import type { RegionData } from '../types';
import { createPathfindingClient } from './client';
import type { SimulationOptions, SimulationReply } from './types';

afterEach(() => vi.unstubAllGlobals());

it('terminates superseded work, rejects cancellation, and ignores a late old-region message', async () => {
  class FakeWorker {
    static instances: FakeWorker[] = [];
    onmessage: ((event: { data: SimulationReply }) => void) | null = null;
    terminate = vi.fn();
    postMessage = vi.fn();
    constructor() { FakeWorker.instances.push(this); }
  }
  vi.stubGlobal('Worker', FakeWorker);
  const client = createPathfindingClient();
  const region = {} as RegionData;
  const options: SimulationOptions = { from: { x: 0, y: 0, z: 0 }, to: { x: 1, y: 0, z: 0 }, maxDrop: 2, evidenceMode: 'remembered' };
  const first = client.search(region, options);
  const firstRejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
  const second = client.search(region, options);
  const secondRejected = expect(second).rejects.toThrow('current worker');
  await firstRejected;
  const [oldWorker, currentWorker] = FakeWorker.instances;
  expect(oldWorker!.terminate).toHaveBeenCalledOnce();
  oldWorker!.onmessage!({ data: { ok: false, error: 'late old region' } });
  expect(currentWorker!.terminate).not.toHaveBeenCalled();
  currentWorker!.onmessage!({ data: { ok: false, error: 'current worker' } });
  await secondRejected;
  const third = client.search(region, options);
  const thirdRejected = expect(third).rejects.toMatchObject({ name: 'AbortError' });
  client.dispose();
  await thirdRejected;
  expect(FakeWorker.instances[2]!.terminate).toHaveBeenCalledOnce();
});
