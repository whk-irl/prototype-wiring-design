/**
 * The way round the model between two holds at a pose: the drape between
 * them (a string pulled taut over what is in the way, at the cable's
 * radius), for the slack model's `detour_mm`. The model's bodies only: the
 * drape does not see placed parts, so neither does the clear-line test. The core then cuts a loop at
 * least that long, so a wire from a fixed base to a turret that turns half
 * way round is long enough to go round it.
 *
 * Each pose is one drape (5 to 80 ms on the demo arm), done through the
 * shapes' queue (one per macrotask in the browser) and remembered by what it
 * depends on: the two holds, the radius and where every body is at that pose.
 * A drape that takes longer than DETOUR_BUDGET_MS, or that cannot be made
 * (an end not on a surface: a port, a point in free space), gives no figure:
 * the length then does not account for the model at that pose, and the
 * crossing's report says so.
 */
import { Matrix4, Vector3 } from 'three';
import { computeLinkPoses, meshPoseMatrix, type Design, type Vec3 } from '@core';
import { registry } from '../scene/registry';
import { drapeLeg } from './drape';
import type { RoutePoint } from './routeEdit';
import { meshWorldContact, requestWork } from './settle';

/** Longest one drape may take before its figure is dropped (ms). */
export const DETOUR_BUDGET_MS = 250;

export type DetourResult =
  | { kind: 'clear' }
  | {
      kind: 'round';
      length_mm: number;
      ms: number;
      /** Links of the bodies it goes round. */ around: string[];
      /** The way round, world at that pose (centre line, from end to end). */ path: Vec3[];
    }
  | { kind: 'failed'; why: string };

const isSurface = (p: RoutePoint) => Math.hypot(p.n[0], p.n[1], p.n[2]) > 0.5;
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

/** True when every body of the model that is loaded has its BVH (the way round can be measured against all of them). */
export function bodiesReady(design: Design): boolean {
  return design.scene.links.every((l) =>
    l.meshes.every((m) => {
      const e = registry.get(m.id);
      return !e || !!e.geometry.boundsTree;
    }),
  );
}

/** What the way round depends on beyond the scene: which bodies can be seen. */
export function bodiesKey(design: Design): string {
  return design.scene.links
    .map((l) =>
      l.meshes
        .map((m) => {
          const e = registry.get(m.id);
          return `${m.id}:${e ? (e.geometry.boundsTree ? e.triCount : 'b') : '-'}`;
        })
        .join(','),
    )
    .join(';');
}

/** How far from a free end the surface under it is looked for (mm). */
const SURFACE_REACH_MM = 80;

/**
 * The nearest point of the model's surface to a point in free space (link
 * frame of its own link, as a route point on the body it lies on, its normal
 * pointing at the free point), within SURFACE_REACH_MM. Null when nothing is
 * that near, or when the point is inside a body.
 */
function surfaceUnder(design: Design, pt: RoutePoint, poses: Map<string, Matrix4>): RoutePoint | null {
  const at = new Vector3(...pt.p).applyMatrix4(poses.get(pt.link) ?? new Matrix4());
  let best: { d: number; link: string; point: Vector3 } | null = null;
  const local = new Vector3();
  for (const l of design.scene.links) {
    const lw = poses.get(l.id);
    if (!lw) continue;
    for (const ref of l.meshes) {
      const bvh = registry.get(ref.id)?.geometry.boundsTree as unknown as { closestPointToPoint(p: Vector3, t?: unknown, min?: number, max?: number): { point: Vector3; distance: number } | null } | undefined;
      if (!bvh) continue;
      const toWorld = lw.clone().multiply(meshPoseMatrix(ref));
      local.copy(at).applyMatrix4(toWorld.clone().invert());
      const c = bvh.closestPointToPoint(local, undefined, 0, best ? best.d : SURFACE_REACH_MM);
      if (c && (!best || c.distance < best.d)) best = { d: c.distance, link: l.id, point: c.point.clone().applyMatrix4(toWorld) };
    }
  }
  if (!best || best.d < 1e-6) return null;
  const n = at.clone().sub(best.point).normalize();
  const toLink = (poses.get(best.link) ?? new Matrix4()).clone().invert();
  const p = best.point.clone().applyMatrix4(toLink);
  const nl = n.transformDirection(toLink);
  return { link: best.link, p: [p.x, p.y, p.z], n: [nl.x, nl.y, nl.z] };
}

/** The way round from hold `a` to hold `b` (each in its own link's frame) at a pose, for a cable of half height `r`. Null while it is being worked out. */
export function detourBetween(design: Design, a: RoutePoint, b: RoutePoint, r: number, values: Readonly<Record<string, number>>, solve = false): DetourResult | null {
  // A body whose BVH is still being built cannot be seen yet: the answer is not known (not "clear").
  if (!bodiesReady(design)) return null;
  const poses = computeLinkPoses(design.scene, values);
  const key = JSON.stringify([
    'detour',
    [a.link, a.p, a.n],
    [b.link, b.p, b.n],
    r,
    design.scene.links.map((l) => [
      l.id,
      poses.get(l.id)?.elements.map(r4) ?? null,
      l.meshes.map((m) => [m.id, m.pose ?? null, registry.get(m.id)?.triCount ?? 0, !!registry.get(m.id)?.geometry.boundsTree]),
    ]),
  ]);
  return requestWork<DetourResult>(
    key,
    'detour',
    () => {
      const t0 = performance.now();
      const contact = meshWorldContact(design, values);
      const lift = (p: RoutePoint) => new Vector3(p.p[0] + p.n[0] * r, p.p[1] + p.n[1] * r, p.p[2] + p.n[2] * r).applyMatrix4(poses.get(p.link) ?? new Matrix4());
      // The straight line clear of the model (within a tenth of the radius): nothing in the way.
      const A = lift(a);
      const B = lift(b);
      const n = Math.min(400, Math.max(2, Math.ceil(A.distanceTo(B) / Math.max(0.25, r / 2))));
      let clear = true;
      for (let i = 1; i < n && clear; i++) {
        const q = A.clone().lerp(B, i / n);
        const c = contact([q.x, q.y, q.z], r);
        if (c && c.distance_mm < 0.9 * r) clear = false;
      }
      if (clear) return { kind: 'clear' };
      // The drape lays a string between two surface points. An end in free space (a port's lead-out, a point
      // in the air) is joined to the nearest surface point under it: the wire goes from the end straight to
      // there (along the surface normal, so clear of the model) and on round the model from there.
      const ea = isSurface(a) ? a : surfaceUnder(design, a, poses);
      const eb = isSurface(b) ? b : surfaceUnder(design, b, poses);
      if (!ea || !eb) return { kind: 'failed', why: 'an end of the loop is in free space with no surface near it, so the way round was not worked out' };
      const leg = drapeLeg(design, ea, eb, r, undefined, values, { settled: 0 });
      const ms = performance.now() - t0;
      if (ms > DETOUR_BUDGET_MS) return { kind: 'failed', why: `the way round took longer than ${DETOUR_BUDGET_MS} ms to work out` };
      if (leg.length === 0 && ea === a && eb === b) return { kind: 'clear' };
      const ends = (end: RoutePoint, near: RoutePoint) => (end === near ? [] : [near]);
      const world = [a, ...ends(a, ea), ...leg, ...ends(b, eb).reverse(), b].map((p) => (isSurface(p) ? lift(p) : lift({ ...p, n: [0, 0, 0] })));
      let length_mm = 0;
      for (let i = 1; i < world.length; i++) length_mm += world[i]!.distanceTo(world[i - 1]!);
      // A drape squeezed where there is no room (bodies folded onto each other) can run through them: then there
      // is no way round to measure, only a wire that would be crushed.
      // (At its own points: between them a straight piece round a faceted body cuts corners by a fraction of a mm.)
      const tol = Math.max(1, r);
      let worst = Infinity;
      for (const v of world) {
        const c = contact([v.x, v.y, v.z], r + 1);
        if (c) worst = Math.min(worst, c.distance_mm - r);
      }
      if (worst < -tol)
        return { kind: 'failed', why: `no way round the model was found (the bodies leave no room: the shortest path found runs ${worst.toFixed(1)} mm into them)` };
      return { kind: 'round', length_mm, ms, around: [...new Set(leg.map((p) => p.link))], path: world.map((v): Vec3 => [v.x, v.y, v.z]) };
    },
    (why) => ({ kind: 'failed', why }),
    solve,
  );
}
