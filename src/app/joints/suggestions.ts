/**
 * Running axis suggestions for the joint editor: chooses S and R from the
 * draft, fits features (in a worker when there is one; synchronously in
 * Node), matches on the main thread (cheap), and keeps the results in the
 * PARENT link's frame, so they do not depend on preview joint values. They
 * are converted to world only for display.
 *
 * Feature caches are tied to the geometry actually loaded: a WeakMap keyed by
 * the BufferGeometry object, and in the worker by a per-geometry token that
 * is dropped on every new load.
 */
import { Matrix4, Vector3, type BufferGeometry } from 'three';
import { meshPoseMatrix, zeroLinkPoses, type Design } from '@core';
import { registry } from '../scene/registry';
import { topologyOf } from '../scene/topology';
import { useApp, type JointDraft } from '../state/store';
import { bodySizes, extractFeatures, scaleOf, seedBoxes, suggestFromFeatures, tolerancesFor, toFrame, type Box, type Feature, type FrameFeature, type MeshInput, type Tolerances } from './suggest';

export interface AxisSuggestionView {
  /** In the PARENT link's frame. */
  point: [number, number, number];
  dir: [number, number, number];
  label: string;
  radius: number;
  features: number;
  shaftInHole: boolean;
  grade: 'likely' | 'possible';
}

export interface SuggestionState {
  key: string;
  status: 'running' | 'done' | 'error';
  /** 0..1 */
  progress: number;
  items: AxisSuggestionView[];
  bolted: boolean;
  note?: string;
  ms?: number;
}

// ---------------------------------------------------------------- feature cache and worker

const cache = new WeakMap<BufferGeometry, Map<string, Feature[]>>();
const tokens = new WeakMap<BufferGeometry, number>();
let tokenSeq = 0;
let workerGeneration = -1;
let worker: Worker | null = null;
let workerBroken = false;
let seq = 0;
const pending = new Map<number, { resolve: (f: Feature[]) => void; reject: (e: Error) => void; onProgress?: (d: number, t: number) => void }>();

function failAll(message: string): void {
  for (const p of pending.values()) p.reject(new Error(message));
  pending.clear();
}

function getWorker(): Worker | null {
  if (workerBroken || typeof Worker === 'undefined') return null;
  if (!worker) {
    worker = new Worker(new URL('./features.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent) => {
      const m = e.data as { type: string; req: number; features?: Feature[]; message?: string; done?: number; total?: number };
      const p = pending.get(m.req);
      if (!p) return;
      if (m.type === 'progress') p.onProgress?.(m.done ?? 0, m.total ?? 1);
      else if (m.type === 'result') {
        pending.delete(m.req);
        p.resolve(m.features ?? []);
      } else if (m.type === 'error') {
        pending.delete(m.req);
        p.reject(new Error(m.message));
      }
    };
    worker.onerror = (e) => {
      // A crashed worker: fail what is waiting and fall back to the main thread next time.
      failAll(`The background fitter stopped: ${e.message || 'unknown error'}`);
      worker?.terminate();
      worker = null;
      workerBroken = true;
    };
  }
  // A new load: the worker forgets every mesh it was sent.
  if (workerGeneration !== registry.generation) {
    worker.postMessage({ type: 'reset' });
    workerGeneration = registry.generation;
  }
  return worker;
}

const boxKey = (boxes: readonly Box[]) => boxes.map((b) => [...b.min, ...b.max].map((x) => x.toPrecision(4)).join(',')).join(';');

/** Features of one loaded mesh seeded in `boxes` (mesh-local). Cached on the geometry object itself. */
export async function featuresForMesh(meshId: string, boxes: readonly Box[], tol: Tolerances, onProgress?: (d: number, t: number) => void): Promise<Feature[]> {
  const entry = registry.get(meshId);
  if (!entry) return [];
  const g = entry.geometry;
  const key = `${boxKey(boxes)}|${tol.scale.toPrecision(4)}`;
  let perGeometry = cache.get(g);
  if (!perGeometry) {
    perGeometry = new Map();
    cache.set(g, perGeometry);
  }
  const hit = perGeometry.get(key);
  if (hit) return hit;
  const w = getWorker();
  let result: Feature[];
  if (!w) {
    result = extractFeatures(meshId, topologyOf(g), boxes, undefined, tol);
  } else {
    let token = tokens.get(g);
    if (token === undefined) {
      token = ++tokenSeq;
      tokens.set(g, token);
      const pos = (g.getAttribute('position').array as Float32Array).slice();
      const idx = g.getIndex();
      const index = idx ? (idx.array as Uint32Array | Uint16Array).slice() : null;
      w.postMessage({ type: 'mesh', id: String(token), positions: pos, index }, index ? [pos.buffer, index.buffer] : [pos.buffer]);
    }
    const req = ++seq;
    result = await new Promise<Feature[]>((resolve, reject) => {
      pending.set(req, { resolve, reject, onProgress });
      w.postMessage({ type: 'features', req, id: String(token), meshId, boxes, tol });
    });
  }
  perGeometry.set(key, result);
  return result;
}

/** Forget a geometry's worker token (the worker was reset on a new load). */
export function resetFeatureWorker(): void {
  workerGeneration = -1;
}

// ---------------------------------------------------------------- S, R and frames

/** Which meshes move (S) and which stay (R), and the parent link, for a draft. */
export function groupsFor(design: Design, d: JointDraft): { S: string[]; R: string[]; parent: string } | null {
  if (d.mode === 'new') {
    const parent = design.scene.links.find((l) => l.id === d.parent);
    if (!parent) return null;
    const S = d.meshes;
    return { S, R: parent.meshes.map((m) => m.id).filter((id) => !S.includes(id)), parent: d.parent };
  }
  const joint = design.scene.joints.find((j) => j.id === d.jointId);
  if (!joint) return null;
  const child = design.scene.links.find((l) => l.id === joint.child);
  const parent = design.scene.links.find((l) => l.id === joint.parent);
  if (!child || !parent) return null;
  return { S: child.meshes.map((m) => m.id), R: parent.meshes.map((m) => m.id), parent: joint.parent };
}

/** Identifies what suggestions were computed for. Joint values are NOT part of it: results are in the parent frame. */
export function draftKey(d: JointDraft | null): string {
  if (!d) return '';
  return `${registry.generation}:${d.mode}:${d.jointId ?? ''}:${d.parent}:${d.meshes.join(',')}`;
}

/** Inputs in the common frame: world at the ZERO pose (mesh pose and link zero pose applied). */
function meshInputs(design: Design, ids: readonly string[]): MeshInput[] {
  const zero = zeroLinkPoses(design.scene);
  const out: MeshInput[] = [];
  for (const link of design.scene.links) {
    const lw = zero.get(link.id);
    if (!lw) continue;
    for (const ref of link.meshes) {
      if (!ids.includes(ref.id)) continue;
      const g = registry.get(ref.id)?.geometry;
      if (!g) continue;
      if (!g.boundingBox) g.computeBoundingBox();
      const bb = g.boundingBox!;
      out.push({
        id: ref.id,
        bounds: { min: [bb.min.x, bb.min.y, bb.min.z], max: [bb.max.x, bb.max.y, bb.max.z] },
        toFrame: new Matrix4().multiplyMatrices(lw, meshPoseMatrix(ref)),
      });
    }
  }
  return out;
}

/** Overall size of the model at the zero pose, mm (bounding-box diagonal). */
function modelSize(design: Design): number {
  const all = meshInputs(
    design,
    design.scene.links.flatMap((l) => l.meshes.map((m) => m.id)),
  );
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const v = new Vector3();
  for (const m of all) {
    for (let i = 0; i < 8; i++) {
      v.set(i & 1 ? m.bounds.max[0] : m.bounds.min[0], i & 2 ? m.bounds.max[1] : m.bounds.min[1], i & 4 ? m.bounds.max[2] : m.bounds.min[2]).applyMatrix4(m.toFrame);
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k]!, v.getComponent(k));
        max[k] = Math.max(max[k]!, v.getComponent(k));
      }
    }
  }
  return Math.hypot(max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!);
}

/**
 * Suggestions for a draft, in the parent link's frame. Pure apart from the
 * registry (geometry) and the feature cache; runs in Node without a worker.
 */
export async function computeSuggestions(
  design: Design,
  d: JointDraft,
  onProgress?: (fraction: number) => void,
): Promise<Omit<SuggestionState, 'key' | 'status' | 'progress'>> {
  const g = groupsFor(design, d);
  if (!g || g.S.length === 0 || g.R.length === 0) return { items: [], bolted: false };
  const SI = meshInputs(design, g.S);
  const RI = meshInputs(design, g.R);
  const tol = tolerancesFor(scaleOf([...SI, ...RI]));
  const boxes = seedBoxes(SI, RI, tol.boxGrow);
  const jobs = [...boxes.entries()];
  const fs: FrameFeature[] = [];
  const fr: FrameFeature[] = [];
  const inputs = new Map([...SI, ...RI].map((m) => [m.id, m]));
  const sSet = new Set(g.S);
  for (const [k, [id, b]] of jobs.entries()) {
    const feats = await featuresForMesh(id, b, tol, (done, total) => onProgress?.((k + done / Math.max(1, total)) / jobs.length));
    const m = inputs.get(id)!;
    for (const f of feats) (sSet.has(id) ? fs : fr).push(toFrame(f, m.toFrame, sSet.has(id) ? 'S' : 'R'));
    onProgress?.((k + 1) / jobs.length);
  }
  const res = suggestFromFeatures(fs, fr, { tol, bodySize: bodySizes([...SI, ...RI]) });
  // Common frame (zero-pose world) -> parent link frame.
  const toParent = new Matrix4().copy(zeroLinkPoses(design.scene).get(g.parent) ?? new Matrix4()).invert();
  const items: AxisSuggestionView[] = res.suggestions.slice(0, 6).map((x) => {
    const p = new Vector3(...x.point).applyMatrix4(toParent);
    const dd = new Vector3(...x.dir).transformDirection(toParent);
    return { point: [p.x, p.y, p.z], dir: [dd.x, dd.y, dd.z], label: x.label, radius: x.radius, features: x.features, shaftInHole: x.shaftInHole, grade: x.grade };
  });
  let note = res.note;
  if (items.length === 0) {
    const size = modelSize(design);
    if (size < 5 || size > 20000) {
      note = `The whole model is ${size < 5 ? `only ${size.toPrecision(2)} mm` : `${(size / 1000).toPrecision(3)} m`} across, which is unusual: it may have been imported in the wrong unit.`;
    }
  }
  return { items, bolted: res.bolted, note };
}

let running = '';

/** Compute suggestions for the current draft and put them in the store. */
export async function runSuggestions(): Promise<void> {
  const s = useApp.getState();
  const d = s.jointDraft;
  const key = draftKey(d);
  if (!d || !key || running === key) return;
  if (s.axisSuggestions?.key === key && s.axisSuggestions.status === 'done') return;
  running = key;
  const t0 = performance.now();
  const set = (patch: Partial<SuggestionState>) => {
    if (draftKey(useApp.getState().jointDraft) !== key) return; // the draft changed: drop stale results
    const cur = useApp.getState().axisSuggestions;
    useApp.setState({ axisSuggestions: { ...(cur?.key === key ? cur : { key, status: 'running', progress: 0, items: [], bolted: false }), ...patch } });
  };
  set({ status: 'running', progress: 0, items: [] });
  try {
    const res = await computeSuggestions(s.design, d, (progress) => set({ progress }));
    set({ status: 'done', progress: 1, ...res, ms: performance.now() - t0 });
  } catch (e) {
    set({ status: 'error', progress: 1, note: e instanceof Error ? e.message : String(e) });
  } finally {
    running = '';
  }
}
