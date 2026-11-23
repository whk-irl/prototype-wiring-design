/**
 * Re-seating wires after the joint editor moves meshes between links.
 *
 * The core keeps route segments on the link they were drawn on when a link
 * is split or meshes move (`splitLink`, `moveMeshes` use routes: false). A
 * wire drawn before its joints were defined would then float on the parent
 * link at every other pose, with no crossing and a constant length. This
 * reassigns each point on the links involved to the link of the mesh it lies
 * on (the nearest mesh at the zero pose), keeping its world position at the
 * zero pose, and rebuilds the segments, so a crossing appears wherever the
 * wire now changes link.
 */
import { Matrix4, Vector3 } from 'three';
import type { MeshBVH } from 'three-mesh-bvh';
import { computeLinkPoses, meshPoseMatrix, type Design } from '@core';
import { registry } from '../scene/registry';
import { pointsOfRoute, withPoints, type RoutePoint } from './routeEdit';

function zeroPoses(design: Design): Map<string, Matrix4> {
  return computeLinkPoses(design.scene, Object.fromEntries(design.scene.joints.map((j) => [j.id, 0])));
}

/**
 * Re-seat every wire with points on `links` in `design` (the design after the
 * edit). Returns the new design and the ids of the cables whose route changed.
 */
export function reseatWires(design: Design, links: Iterable<string>): { design: Design; changed: string[] } {
  const involved = new Set(links);
  const poses = zeroPoses(design);
  const meshes: Array<{ link: string; bvh: MeshBVH; toMesh: Matrix4 }> = [];
  for (const l of design.scene.links) {
    if (!involved.has(l.id)) continue;
    const lw = poses.get(l.id);
    if (!lw) continue;
    for (const ref of l.meshes) {
      const bvh = registry.get(ref.id)?.geometry.boundsTree as unknown as MeshBVH | undefined;
      if (bvh) meshes.push({ link: l.id, bvh, toMesh: lw.clone().multiply(meshPoseMatrix(ref)).invert() });
    }
  }
  const changed: string[] = [];
  const routes = design.routes.map((route) => {
    const pts = pointsOfRoute(route);
    let moved = false;
    const next: RoutePoint[] = pts.map((pt) => {
      if (!involved.has(pt.link) || meshes.length === 0) return pt;
      const from = poses.get(pt.link);
      if (!from) return pt;
      const world = new Vector3(...pt.p).applyMatrix4(from);
      let best = Infinity;
      let link = pt.link;
      const local = new Vector3();
      for (const m of meshes) {
        local.copy(world).applyMatrix4(m.toMesh);
        const hit = m.bvh.closestPointToPoint(local, undefined, 0, best);
        if (hit && hit.distance < best) {
          best = hit.distance;
          link = m.link;
        }
      }
      if (link === pt.link) return pt;
      moved = true;
      const to = poses.get(link)!.clone().invert();
      const p = world.applyMatrix4(to);
      const n = new Vector3(...pt.n);
      const nl = n.lengthSq() > 0 ? n.transformDirection(from).transformDirection(to) : n;
      return { link, p: [p.x, p.y, p.z], n: [nl.x, nl.y, nl.z], ...(pt.tie !== undefined ? { tie: pt.tie } : {}) };
    });
    // Rebuild segments even when nothing moved: a merged link leaves neighbouring segments on one link.
    const rebuilt = withPoints(route, next);
    if (moved || rebuilt.segments.length !== route.segments.length) {
      changed.push(route.cable);
      return rebuilt;
    }
    return route;
  });
  return changed.length ? { design: { ...design, routes }, changed } : { design, changed };
}
