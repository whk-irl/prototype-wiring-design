/// <reference lib="webworker" />
/**
 * Cylinder feature extraction off the main thread. Meshes are sent once per
 * loaded geometry (keyed by a token) and dropped on `reset` (a new load).
 */
import { BufferAttribute, BufferGeometry } from 'three';
import { topologyOf } from '../scene/topology';
import { extractFeatures, type Box, type Tolerances } from './suggest';

type Msg =
  | { type: 'reset' }
  | { type: 'mesh'; id: string; positions: Float32Array; index: Uint32Array | Uint16Array | null }
  | { type: 'features'; req: number; id: string; meshId: string; boxes: Box[]; tol: Tolerances };

let meshes = new Map<string, BufferGeometry>();
const post = (m: unknown) => (self as unknown as Worker).postMessage(m);

self.onmessage = (e: MessageEvent<Msg>) => {
  const m = e.data;
  if (m.type === 'reset') {
    meshes = new Map();
    return;
  }
  if (m.type === 'mesh') {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(m.positions, 3));
    if (m.index) g.setIndex(new BufferAttribute(m.index, 1));
    meshes.set(m.id, g);
    return;
  }
  const g = meshes.get(m.id);
  if (!g) {
    post({ type: 'error', req: m.req, message: `mesh ${m.meshId} was not sent to the background fitter` });
    return;
  }
  try {
    const features = extractFeatures(m.meshId, topologyOf(g), m.boxes, (done, total) => post({ type: 'progress', req: m.req, done, total }), m.tol);
    post({ type: 'result', req: m.req, features });
  } catch (err) {
    post({ type: 'error', req: m.req, message: err instanceof Error ? err.message : String(err) });
  }
};
