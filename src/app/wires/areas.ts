/**
 * Keep-clear areas and wires: a wire whose on-surface points, or the surface
 * points between them (sampled every 2 mm along each leg that lies on the
 * surface), fall on a keep-clear area gets a warning naming the area.
 * Free points (zero normal: ports, points in the air) do not count.
 */
import { Vector3 } from 'three';
import type { MeshBVH } from 'three-mesh-bvh';
import { decodeTriangles, meshPoseMatrix, type Design, type Route } from '@core';
import { registry } from '../scene/registry';

const STEP_MM = 2;
/** A sample this close to the area's mesh counts as lying on it. */
const ON_SURFACE_MM = 0.5;

const isSurface = (n: readonly number[] | undefined) => !!n && Math.hypot(n[0]!, n[1]!, n[2]!) > 0.5;

/** Names of the keep-clear areas the route lies on, each once. */
export function keepClearHits(design: Design, route: Route): string[] {
  const zones = design.zones.filter((z) => z.kind === 'keep_out' && z.triangles.length > 0);
  if (zones.length === 0) return [];
  const hits: string[] = [];
  for (const zone of zones) {
    const segs = route.segments.filter((s) => s.link === zone.link);
    if (segs.length === 0) continue;
    const link = design.scene.links.find((l) => l.id === zone.link);
    const ref = link?.meshes.find((m) => m.id === zone.mesh);
    const entry = registry.get(zone.mesh);
    const bvh = entry?.geometry.boundsTree as unknown as MeshBVH | undefined;
    if (!ref || !bvh) continue;
    const toMesh = meshPoseMatrix(ref).invert();
    const tris = new Set(decodeTriangles(zone.triangles));
    const on = (p: Vector3) => {
      const c = bvh.closestPointToPoint(p.clone().applyMatrix4(toMesh), undefined, 0, ON_SURFACE_MM);
      return !!c && tris.has(c.faceIndex);
    };
    let found = false;
    for (const s of segs) {
      for (let i = 0; i < s.points_mm.length && !found; i++) {
        if (!isSurface(s.normals?.[i])) continue;
        const a = new Vector3(...s.points_mm[i]!);
        if (on(a)) found = true;
        const next = s.points_mm[i + 1];
        if (found || !next || !isSurface(s.normals?.[i + 1])) continue;
        const b = new Vector3(...next);
        const n = Math.floor(a.distanceTo(b) / STEP_MM);
        for (let k = 1; k <= n && !found; k++) if (on(a.clone().lerp(b, k / (n + 1)))) found = true;
      }
      if (found) break;
    }
    if (found) hits.push(zone.name || zone.id);
  }
  return hits;
}
