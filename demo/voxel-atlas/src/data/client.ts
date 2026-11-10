import type { DatabaseSummary, RegionData, RegionQuery } from '../types';
import { ReaderError } from './errors';
import type { WorkerRequest, WorkerResponse } from './protocol';

export interface DatabaseProgress {
  stage: string;
  progress?: number;
}

export interface VoxelDatabaseClient {
  open(file: File): Promise<DatabaseSummary>;
  loadRegion(query: RegionQuery): Promise<RegionData>;
  clear(): Promise<void>;
  dispose(): void;
}

type Pending =
  | {
      kind: 'open';
      worker: Worker;
      generation: number;
      resolve: (summary: DatabaseSummary) => void;
      reject: (error: Error) => void;
    }
  | {
      kind: 'region';
      worker: Worker;
      generation: number;
      resolve: (data: RegionData) => void;
      reject: (error: Error) => void;
    }
  | {
      kind: 'clear';
      worker: Worker;
      generation: number;
      resolve: () => void;
      reject: (error: Error) => void;
    };

const STALE_REQUEST_MESSAGE = '数据库已切换或关闭，旧请求已取消。';
const WORKER_FAILURE_MESSAGE =
  '数据库 Worker 启动或运行失败。请刷新页面，并确认浏览器支持模块 Worker、WASM 与 OPFS，'
  + '且页面响应头包含 Cross-Origin-Opener-Policy: same-origin 与 Cross-Origin-Embedder-Policy: require-corp。';

export function createDatabaseClient(
  onProgress?: (progress: DatabaseProgress) => void,
): VoxelDatabaseClient {
  const pending = new Map<number, Pending>();
  let nextRequestId = 1;
  let generation = 0;
  let opened = false;
  let currentWorker: Worker | null = null;

  function rejectPending(error: Error): void {
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  }

  function failWorker(worker: Worker, message: string): void {
    const error = new ReaderError('read_failed', message);
    for (const [id, entry] of pending) {
      if (entry.worker !== worker) continue;
      pending.delete(id);
      entry.reject(error);
    }
    if (currentWorker === worker) {
      currentWorker = null;
      opened = false;
      worker.terminate();
    }
  }

  function handleMessage(event: MessageEvent<WorkerResponse>): void {
    const response = event.data;
    if (response.type === 'progress') {
      const entry = pending.get(response.id);
      if (
        entry === undefined
        || entry.worker !== currentWorker
        || entry.generation !== generation
      ) {
        return;
      }
      onProgress?.(
        response.progress === undefined
          ? { stage: response.stage }
          : { stage: response.stage, progress: response.progress },
      );
      return;
    }

    const entry = pending.get(response.id);
    if (entry === undefined) return;
    if (entry.worker !== currentWorker || entry.generation !== generation) {
      pending.delete(response.id);
      entry.reject(new ReaderError('read_failed', STALE_REQUEST_MESSAGE));
      return;
    }
    pending.delete(response.id);

    if (response.type === 'error') {
      entry.reject(new ReaderError(response.code, response.message));
      return;
    }
    if (response.type === 'opened') {
      if (entry.kind !== 'open') {
        entry.reject(new ReaderError('read_failed', 'Worker 返回了不匹配的打开结果。'));
        return;
      }
      opened = true;
      entry.resolve(response.summary);
      return;
    }
    if (response.type === 'region') {
      if (entry.kind !== 'region') {
        entry.reject(new ReaderError('read_failed', 'Worker 返回了不匹配的区域结果。'));
        return;
      }
      entry.resolve(response.data);
      return;
    }
    if (entry.kind !== 'clear') {
      entry.reject(new ReaderError('read_failed', 'Worker 返回了不匹配的清理结果。'));
      return;
    }
    opened = false;
    entry.resolve();
  }

  function spawnWorker(): Worker {
    const worker = new Worker(new URL('./database.worker.ts', import.meta.url), {
      type: 'module',
    });
    worker.addEventListener('message', handleMessage);
    worker.addEventListener('messageerror', () => {
      failWorker(worker, `${WORKER_FAILURE_MESSAGE} 无法解析 Worker 消息。`);
    });
    worker.addEventListener('error', (event) => {
      const detail = event.message.length > 0 ? `详细信息：${event.message}` : '';
      failWorker(worker, `${WORKER_FAILURE_MESSAGE}${detail}`);
    });
    return worker;
  }

  function open(file: File): Promise<DatabaseSummary> {
    generation += 1;
    const requestGeneration = generation;
    opened = false;
    rejectPending(new ReaderError('read_failed', STALE_REQUEST_MESSAGE));

    let worker = currentWorker;
    if (worker === null) {
      try {
        worker = spawnWorker();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return Promise.reject(
          new ReaderError('read_failed', `${WORKER_FAILURE_MESSAGE}${message}`),
        );
      }
    }
    currentWorker = worker;
    const id = nextRequestId;
    nextRequestId += 1;

    return new Promise<DatabaseSummary>((resolve, reject) => {
      pending.set(id, {
        kind: 'open',
        worker,
        generation: requestGeneration,
        resolve,
        reject,
      });
      const request: WorkerRequest = { type: 'open', id, file };
      try {
        worker.postMessage(request);
      } catch (error) {
        pending.delete(id);
        const message = error instanceof Error ? error.message : String(error);
        reject(new ReaderError('read_failed', `无法把文件交给数据库 Worker：${message}`));
      }
    });
  }

  function loadRegion(query: RegionQuery): Promise<RegionData> {
    const worker = currentWorker;
    if (worker === null || !opened) {
      return Promise.reject(
        new ReaderError('read_failed', '数据库尚未打开完成，无法加载区域。请先等待打开完成。'),
      );
    }
    const id = nextRequestId;
    nextRequestId += 1;
    return new Promise<RegionData>((resolve, reject) => {
      pending.set(id, {
        kind: 'region',
        worker,
        generation,
        resolve,
        reject,
      });
      const request: WorkerRequest = { type: 'loadRegion', id, query };
      try {
        worker.postMessage(request);
      } catch (error) {
        pending.delete(id);
        const message = error instanceof Error ? error.message : String(error);
        reject(new ReaderError('read_failed', `无法把区域查询交给数据库 Worker：${message}`));
      }
    });
  }

  function clear(): Promise<void> {
    generation += 1;
    opened = false;
    rejectPending(new ReaderError('read_failed', STALE_REQUEST_MESSAGE));
    const worker = currentWorker;
    if (worker === null) return Promise.resolve();

    const id = nextRequestId;
    nextRequestId += 1;
    const requestGeneration = generation;
    return new Promise<void>((resolve, reject) => {
      pending.set(id, {
        kind: 'clear',
        worker,
        generation: requestGeneration,
        resolve,
        reject,
      });
      const request: WorkerRequest = { type: 'clear', id };
      try {
        worker.postMessage(request);
      } catch (error) {
        pending.delete(id);
        const message = error instanceof Error ? error.message : String(error);
        reject(new ReaderError('read_failed', `无法请求清理数据库临时副本：${message}`));
      }
    });
  }

  function dispose(): void {
    generation += 1;
    opened = false;
    rejectPending(new ReaderError('read_failed', '数据库查看器已关闭。'));
    const worker = currentWorker;
    currentWorker = null;
    if (worker === null) return;
    try {
      const request: WorkerRequest = { type: 'dispose' };
      worker.postMessage(request);
    } catch {
      worker.terminate();
      return;
    }
    setTimeout(() => worker.terminate(), 1000);
  }

  return { open, loadRegion, clear, dispose };
}
