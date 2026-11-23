/**
 * Part models: bundled ones from `parts/<uri>` under the app's base URL, the
 * user's own (`custom:<sha256>`) from the parts store on this PC, decoded with
 * `decodePartGlb` and turned into three.js meshes (normals computed, the mesh
 * colours kept). One load per uri, shared by every visual
 * and thumbnail; the geometries are shared too (marked `userData.shared`, so
 * disposing a visual leaves them alone).
 */
import { BufferAttribute, BufferGeometry, Color, Group, Mesh, MeshStandardMaterial } from 'three';
import { poseToMatrix, type PartModel } from '@core';

import { decodePartGlb } from '../parts/glb';
import { loadCustomModel } from '../parts/store';

/** A `custom:` model whose file is not on this PC. */
export class MissingModelError extends Error {}

const cache = new Map<string, Promise<Group>>();
const failed = new Set<string>();

/** URL of a bundled model. */
export function modelUrl(uri: string): string {
  return `${import.meta.env.BASE_URL}parts/${uri}`;
}

/** A model worth trying to draw: present and not already failed to load. */
export function isDrawableModel(model: PartModel | undefined): model is PartModel {
  return !!model && !failed.has(model.uri);
}

/**
 * The model as a group in the PART frame (its pose applied), shared: clone
 * it before adding to a scene. Rejects when it cannot be fetched or decoded;
 * `onFail` is told once per uri.
 */
export function loadPartModel(model: PartModel, onFail?: (uri: string, message: string, missing: boolean) => void): Promise<Group> {
  let p = cache.get(model.uri);
  if (!p) {
    p = (async () => {
      let data: ArrayBuffer;
      if (model.uri.startsWith('custom:')) {
        const found = await loadCustomModel(model.uri.slice('custom:'.length));
        if (!found) throw new MissingModelError('the model file is not on this PC');
        data = found;
      } else {
        const res = await fetch(modelUrl(model.uri));
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        data = await res.arrayBuffer();
      }
      const { meshes } = decodePartGlb(data);
      const group = new Group();
      for (const m of meshes) {
        const g = new BufferGeometry();
        g.setAttribute('position', new BufferAttribute(m.positions, 3));
        g.setIndex(new BufferAttribute(m.indices, 1));
        g.computeVertexNormals();
        g.computeBoundingBox();
        g.userData.shared = true;
        const mat = new MeshStandardMaterial({ color: m.color ? new Color(...m.color) : new Color(0x6b7280), roughness: 0.6, metalness: 0.05 });
        const mesh = new Mesh(g, mat);
        mesh.name = m.name;
        group.add(mesh);
      }
      if (model.pose) {
        group.matrixAutoUpdate = false;
        poseToMatrix(model.pose, group.matrix);
      }
      return group;
    })();
    p.catch((e: unknown) => {
      if (failed.has(model.uri)) return;
      failed.add(model.uri);
      onFail?.(model.uri, e instanceof Error ? e.message : String(e), e instanceof MissingModelError);
    });
    cache.set(model.uri, p);
  }
  return p;
}

/** Forget a model so it is loaded again (a part file was imported that brings it). */
export function forgetPartModel(uri: string): void {
  cache.delete(uri);
  failed.delete(uri);
}

/** A copy of a loaded model for one visual: shared geometry, its own materials (so it can be highlighted). */
export function instanceModel(template: Group): Group {
  const copy = template.clone(true);
  copy.traverse((o) => {
    const m = o as Mesh;
    if (m.isMesh) m.material = (m.material as MeshStandardMaterial).clone();
  });
  return copy;
}
