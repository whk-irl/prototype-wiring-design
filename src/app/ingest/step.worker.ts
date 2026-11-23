/// <reference lib="webworker" />
/**
 * Web Worker that runs occt-import-js. Receives `{ kind, data }`, answers with
 * `{ ok: true, tessellation }` (typed arrays transferred) or `{ ok: false, error }`.
 */
import occtFactory from 'occt-import-js';
import type { OcctModule } from 'occt-import-js';
import wasmUrl from 'occt-import-js/dist/occt-import-js.wasm?url';
import { tessellate, transferListOf, type OcctKind, type OcctTessellation } from './occt';

export interface StepWorkerRequest {
  kind: OcctKind;
  data: ArrayBuffer;
}
export type StepWorkerResponse = { ok: true; tessellation: OcctTessellation } | { ok: false; error: string };

let occt: Promise<OcctModule> | null = null;

self.onmessage = async (event: MessageEvent<StepWorkerRequest>) => {
  try {
    occt ??= occtFactory({ locateFile: (name: string) => (name.endsWith('.wasm') ? wasmUrl : name) });
    const module = await occt;
    const tessellation = tessellate(module, event.data.kind, new Uint8Array(event.data.data));
    const response: StepWorkerResponse = { ok: true, tessellation };
    (self as unknown as Worker).postMessage(response, transferListOf(tessellation));
  } catch (e) {
    const response: StepWorkerResponse = { ok: false, error: e instanceof Error ? e.message : String(e) };
    (self as unknown as Worker).postMessage(response);
  }
};
