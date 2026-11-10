import type { RegionData } from '../types';
import type { SimulationOptions, SimulationReply, SimulationRequest, SimulationResult } from './types';

/** A task owns its worker: cancellation stops CPU work and prevents late region results. */
export function createPathfindingClient() {
  let active: { worker: Worker; reject: (reason: Error) => void } | null = null;
  const cancel = () => {
    if (!active) return;
    active.worker.terminate();
    const error = new Error('寻路已取消。');
    error.name = 'AbortError';
    active.reject(error);
    active = null;
  };
  return {
    search(region: RegionData, options: SimulationOptions): Promise<SimulationResult> {
      cancel();
      return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./search.worker.ts', import.meta.url), { type: 'module' });
        active = { worker, reject };
        worker.onmessage = ({ data }: MessageEvent<SimulationReply>) => {
          if (active?.worker !== worker) return;
          worker.terminate();
          active = null;
          if (data.ok) resolve(data.result);
          else reject(new Error(data.error));
        };
        worker.onerror = (event) => {
          if (active?.worker !== worker) return;
          worker.terminate();
          active = null;
          reject(new Error(event.message || '寻路 Worker 运行失败。'));
        };
        worker.postMessage({ region, options } satisfies SimulationRequest);
      });
    },
    cancel,
    dispose: cancel,
  };
}

export default createPathfindingClient;
