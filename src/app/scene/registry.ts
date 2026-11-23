/**
 * Geometry registry: the triangle meshes of the current model, keyed by mesh
 * id. Kept outside the store because BufferGeometry is large and mutable.
 * Every change bumps `geometryVersion` in the store so the viewport rebuilds.
 */
import type { BufferGeometry } from 'three';
import { useApp } from '../state/store';
import { buildBVHs } from './bvh';

export interface MeshEntry {
  id: string;
  link: string;
  geometry: BufferGeometry;
  /** Linear RGB 0..1. */
  color: [number, number, number];
  triCount: number;
  /** True once `geometry.boundsTree` exists. Picking skips meshes without one. */
  bvhReady: boolean;
}

const entries = new Map<string, MeshEntry>();
let generation = 0;

export function triangleCountOf(geometry: BufferGeometry): number {
  const index = geometry.getIndex();
  if (index) return Math.floor(index.count / 3);
  const pos = geometry.getAttribute('position');
  return pos ? Math.floor(pos.count / 3) : 0;
}

export const registry = {
  get: (id: string): MeshEntry | undefined => entries.get(id),
  all: (): IterableIterator<MeshEntry> => entries.values(),
  get size() {
    return entries.size;
  },
  /** Changes on every load: caches of derived data key on it. */
  get generation() {
    return generation;
  },

  /** Replace every mesh. Disposes the old geometry and starts BVH builds. */
  replace(meshes: ReadonlyArray<{ id: string; link: string; geometry: BufferGeometry; color: [number, number, number] }>): void {
    for (const e of entries.values()) {
      e.geometry.disposeBoundsTree?.();
      e.geometry.dispose();
    }
    entries.clear();
    const gen = ++generation;
    let tris = 0;
    for (const m of meshes) {
      if (!m.geometry.getAttribute('normal')) m.geometry.computeVertexNormals();
      m.geometry.computeBoundingBox();
      m.geometry.computeBoundingSphere();
      const triCount = triangleCountOf(m.geometry);
      tris += triCount;
      entries.set(m.id, { ...m, triCount, bvhReady: false });
    }
    useApp.setState((s) => ({ geometryVersion: s.geometryVersion + 1, triangleCount: tris, bvhPending: entries.size }));

    const list = [...entries.values()];
    void buildBVHs(list, (entry) => {
      if (gen !== generation) return;
      entry.bvhReady = true;
      useApp.setState((s) => ({ bvhPending: Math.max(0, s.bvhPending - 1) }));
    }, () => gen !== generation);
  },
};
