import { simulateRoute } from './simulate';
import type { SimulationRequest, SimulationReply } from './types';

const scope = self as DedicatedWorkerGlobalScope;
scope.onmessage = ({ data }: MessageEvent<SimulationRequest>) => {
  try {
    scope.postMessage({ ok: true, result: simulateRoute(data.region, data.options) } satisfies SimulationReply);
  } catch (error) {
    scope.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) } satisfies SimulationReply);
  }
};
