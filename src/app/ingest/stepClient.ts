/** Browser side of the STEP worker. Only loaded (dynamically) when there is no Node. */
import type { OcctKind, OcctTessellation } from './occt';
import type { StepWorkerRequest, StepWorkerResponse } from './step.worker';

export function tessellateInWorker(kind: OcctKind, data: ArrayBuffer): Promise<OcctTessellation> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./step.worker.ts', import.meta.url), { type: 'module' });
    const done = () => worker.terminate();
    worker.onmessage = (event: MessageEvent<StepWorkerResponse>) => {
      done();
      if (event.data.ok) resolve(event.data.tessellation);
      else reject(new Error(event.data.error));
    };
    worker.onerror = (event) => {
      done();
      reject(new Error(`The STEP import worker failed: ${event.message || 'unknown error'}`));
    };
    // Copy, so the caller's buffer is not detached by the transfer.
    const copy = data.slice(0);
    const request: StepWorkerRequest = { kind, data: copy };
    worker.postMessage(request, [copy]);
  });
}
