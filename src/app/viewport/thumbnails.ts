/**
 * Part thumbnails for the Parts tab: the same visual as the viewport
 * (`buildPartVisual`), seen from a three-quarter view, rendered by ONE shared
 * offscreen renderer (never one WebGL context per row), one part per frame.
 *
 * Kept in memory and, through the parts cache (`cacheGet`/`cacheSet`,
 * IndexedDB), across sessions, keyed by part id + model sha/uri + the
 * connector library + THUMB_VERSION. A part whose model is still loading gets
 * a placeholder at once and is re-rendered when the model arrives (only the
 * final image goes to the persistent cache).
 */
import { Box3, DirectionalLight, HemisphereLight, PerspectiveCamera, Scene, Vector3, WebGLRenderer, type Object3D } from 'three';
import type { ConnectorLibrary, Part } from '@core';
import { cacheDelete, cacheGet, cacheSet } from '../parts/store';
import { buildPartVisual, disposeObject } from './partVisual';

/** Bump when the look of thumbnails changes, to retire cached images. */
export const THUMB_VERSION = 2;
const SIZE = 112; // pixels: drawn at 56 CSS px on a 2x screen

const cache = (): Promise<{ cacheGet: typeof cacheGet; cacheSet: typeof cacheSet; cacheDelete: typeof cacheDelete }> => Promise.resolve({ cacheGet, cacheSet, cacheDelete });

/** FNV-1a of a string, 8 hex digits. */
function fnv(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Cache key of a part's thumbnail: everything the image shows. The part id,
 * the model (its sha256; the uri only when no sha is recorded), a hash of the
 * body, the ports (their markers are drawn), the model pose, and the
 * connector library's size, plus `THUMB_VERSION`.
 */
export function thumbKey(part: Part, connectors: ConnectorLibrary | null): string {
  const model = part.model ? (part.model.sha256 ?? part.model.uri) : 'none';
  const shape = fnv(JSON.stringify([part.body, part.ports, part.model?.pose ?? null]));
  return `thumb:${THUMB_VERSION}:${part.id}:${model}:${shape}:${connectors ? connectors.connectors.length : 0}`;
}

/** The radius to frame: the object's own, so a 0.3 mm wire fills the picture as a 30 mm one does (only an empty box gets a stand-in). */
export function frameRadius(box: Box3): number {
  const r = box.isEmpty() ? 0 : box.getSize(new Vector3()).length() / 2;
  return r > 1e-6 ? r : 1;
}

/** Images in memory, most recently used last; the oldest are let go past `MEMORY_LIMIT`. */
const MEMORY_LIMIT = 400;
const memory = new Map<string, string>();
const listeners = new Map<string, Set<(url: string) => void>>();
/** A job: a part (drawn with its model, which may arrive later), or any object built on demand (cable types). */
type Job = { key: string; part: Part; connectors: ConnectorLibrary | null } | { key: string; build: () => Object3D };
const queue: Job[] = [];
const queued = new Set<string>();
let renderer: WebGLRenderer | null = null;
let failed = false;
let pumping = false;

function publish(key: string, url: string): void {
  memory.delete(key);
  memory.set(key, url);
  if (memory.size > MEMORY_LIMIT) {
    for (const old of memory.keys()) {
      if (memory.size <= MEMORY_LIMIT) break;
      if (!listeners.has(old)) memory.delete(old); // an image still on screen stays
    }
  }
  for (const cb of listeners.get(key) ?? []) cb(url);
}

function renderOne(part: Part, connectors: ConnectorLibrary | null, key: string): void {
  if (failed) return;
  if (!renderer) {
    try {
      renderer = new WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true, canvas: document.createElement('canvas') });
      renderer.setPixelRatio(1);
      renderer.setSize(SIZE, SIZE, false);
      renderer.setClearColor(0x000000, 0);
    } catch {
      failed = true;
      return;
    }
  }
  // `final`: the second pass, once the model is in (or has failed). It waits
  // for the model and draws whatever it got; it never schedules another pass
  // (the model is swapped in asynchronously even when cached, so a check on
  // `kind()` alone would go round for ever).
  const draw = (final: boolean) => {
    const scene = new Scene();
    scene.add(new HemisphereLight(0xffffff, 0x3a3f46, 1.6));
    const sun = new DirectionalLight(0xffffff, 1.6);
    sun.position.set(1, -1.4, 2);
    scene.add(sun);
    const visual = buildPartVisual(part, { connectors });
    for (const m of visual.portMarkers) m.visible = false;
    scene.add(visual.group);
    const box = new Box3().setFromObject(visual.body);
    const centre = box.getCenter(new Vector3());
    const radius = frameRadius(box);
    const camera = new PerspectiveCamera(30, 1, radius * 0.05, radius * 20);
    camera.up.set(0, 0, 1);
    const dir = new Vector3(0.9, -1.25, 0.95).normalize();
    camera.position.copy(centre).addScaledVector(dir, (radius / Math.sin((15 * Math.PI) / 180)) * 1.02);
    camera.lookAt(centre);
    const finish = (persist: boolean) => {
      renderer!.setSize(SIZE, SIZE, false);
      renderer!.render(scene, camera);
      const url = renderer!.domElement.toDataURL('image/png');
      disposeObject(visual.group);
      publish(key, url);
      if (persist) void cache().then((c) => c.cacheSet(key, url));
    };
    if (visual.kind() === 'box' && part.model) {
      if (final) {
        void visual.ready.then(() => finish(true));
        return;
      }
      // The model is loading: a placeholder now, the real image when it is in (or fails).
      finish(false);
      void visual.ready.then(() => draw(true));
      return;
    }
    finish(true);
  };
  draw(false);
}

/** Render an object (its own frame, +Z up) once with the shared renderer and publish it under `key`. */
function renderObject(build: () => Object3D, key: string): void {
  if (failed) return;
  let object: Object3D;
  try {
    object = build();
  } catch {
    return;
  }
  const url = renderPreview(object, SIZE);
  disposeObject(object);
  if (!url) return;
  publish(key, url);
  void cache().then((c) => c.cacheSet(key, url));
}

function pump(): void {
  if (pumping) return;
  pumping = true;
  const step = () => {
    const job = queue.shift();
    if (!job) {
      pumping = false;
      return;
    }
    queued.delete(job.key);
    if (!memory.has(job.key)) {
      if ('part' in job) renderOne(job.part, job.connectors, job.key);
      else renderObject(job.build, job.key);
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/**
 * Ask for a part's thumbnail. `cb` gets the image (a data URL) now if it is
 * known, later otherwise, and again if it is re-rendered (a model arrived).
 * Returns a function that stops the updates.
 */
export function requestThumbnail(part: Part, connectors: ConnectorLibrary | null, cb: (url: string) => void): () => void {
  return request(thumbKey(part, connectors), () => ({ key: thumbKey(part, connectors), part, connectors }), cb);
}

/** Let an image go (memory and the cache on this PC), when what it showed no longer exists (an edited cable's old figures). */
export function forgetThumbnail(key: string): void {
  memory.delete(key);
  void cache().then((c) => c.cacheDelete(key));
}

/**
 * Ask for the image of any object, built by `build` only when it has to be
 * drawn (not in memory or the persistent cache under `key`). Same queue,
 * renderer and cache as part thumbnails. Returns a function that stops the
 * updates.
 */
export function requestObjectThumbnail(key: string, build: () => Object3D, cb: (url: string) => void): () => void {
  return request(key, () => ({ key, build }), cb);
}

function request(key: string, job: () => Job, cb: (url: string) => void): () => void {
  let set = listeners.get(key);
  if (!set) listeners.set(key, (set = new Set()));
  set.add(cb);
  const known = memory.get(key);
  if (known) cb(known);
  else if (!queued.has(key)) {
    queued.add(key);
    void cache()
      .then((c) => c.cacheGet(key))
      .catch(() => undefined)
      .then((hit) => {
        if (hit) {
          queued.delete(key);
          publish(key, hit);
        } else {
          queue.push(job());
          pump();
        }
      });
  }
  return () => {
    set!.delete(cb);
    if (set!.size === 0 && listeners.get(key) === set) listeners.delete(key);
  };
}

/**
 * Render any object (part frame, +Z up) the way thumbnails are, at `size`
 * pixels, with the shared renderer: for live previews (the orientation step
 * of "Add your own part"). Null when WebGL is not available.
 */
export function renderPreview(object: Object3D, size = 240): string | null {
  if (failed) return null;
  if (!renderer) {
    try {
      renderer = new WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true, canvas: document.createElement('canvas') });
      renderer.setPixelRatio(1);
      renderer.setClearColor(0x000000, 0);
    } catch {
      failed = true;
      return null;
    }
  }
  renderer.setSize(size, size, false);
  const scene = new Scene();
  scene.add(new HemisphereLight(0xffffff, 0x3a3f46, 1.6));
  const sun = new DirectionalLight(0xffffff, 1.6);
  sun.position.set(1, -1.4, 2);
  scene.add(sun);
  scene.add(object);
  const box = new Box3().setFromObject(object);
  const centre = box.getCenter(new Vector3());
  const radius = frameRadius(box);
  const camera = new PerspectiveCamera(30, 1, radius * 0.05, radius * 20);
  camera.up.set(0, 0, 1);
  camera.position.copy(centre).addScaledVector(new Vector3(0.9, -1.25, 0.95).normalize(), (radius / Math.sin((15 * Math.PI) / 180)) * 1.02);
  camera.lookAt(centre);
  renderer.render(scene, camera);
  const url = renderer.domElement.toDataURL('image/png');
  scene.remove(object);
  renderer.setSize(SIZE, SIZE, false);
  return url;
}
