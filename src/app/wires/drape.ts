/**
 * Draping: laying a leg between two clicked surface points ON the surface of
 * their link instead of along the straight chord, which on real geometry cuts
 * through whatever lies between them.
 *
 * Method, all in the link's frame against the link's own meshes:
 *  1. Sample the chord every `step` mm (0.5-2 mm). At each sample cast a ray
 *     down the interpolated normal from H = clamp(L/4, 5, 30) mm above the
 *     chord (and above the leg's higher end, and above the highest surface
 *     met within 4H going up) to max(2r + 3, L/4) below it (deeper is bridged),
 *     and take the first surface it
 *     meets: the top of the outer shell, so a bump is climbed, a dip followed,
 *     and a cavity or pocket inside a body never chosen. It is a ball of
 *     radius r that is dropped (rays across its width, see dropBall), so a
 *     hole or slot narrower than the cable is bridged. A miss drops the
 *     sample: the cable bridges straight across.
 *  2. Lift each surface point by r (half the cable's height) along its
 *     normal: that is the centre line.
 *  3. Seat: a centre point inside solid rises straight up out of it; one
 *     outside but nearer than r (a concave corner, the foot of a wall) is
 *     moved to distance r from its closest surface point, within the leg's
 *     plane (no sideways wandering), repeatedly. Any leg
 *     whose midpoint is nearer than r - tol is split there and the midpoint
 *     seated, recursively: over a convex edge this wraps the cable round the
 *     edge at radius r (so the bend check sees the edge as a tight corner),
 *     and at a step it climbs the riser instead of passing through it.
 *  4. Simplify (Douglas-Peucker on the centre line, tolerance tol), so a flat
 *     leg stays two points.
 *  5. Store each centre point as the surface point under it and the unit
 *     normal toward it: point = centre - r * normal.
 *
 * tol = max(0.03 mm, 1.5% of r): half the fit check's tolerance, so a draped
 * wire is not failed by the drape's own error. A leg to or from a free point
 * (zero normal) stays straight. A leg between links is draped in the world at
 * the shown pose over the bodies of every link between them, and each draped
 * point goes to the link of the body it rests on: crossings then appear only
 * where the wire really leaves one body for the next.
 */
import { DoubleSide, Matrix4, Ray, Vector3, type BufferGeometry } from 'three';
import type { MeshBVH } from 'three-mesh-bvh';
import { computeLinkPoses, jointsBetween, meshPoseMatrix, tautOverProfile, type Design, type Route } from '@core';
import { registry } from '../scene/registry';
import { pointsOfRoute, routeHolds, withPoints, type RoutePoint } from './routeEdit';
import { faceNormal, insideMesh } from './solid';

interface SurfaceMesh {
  id: string;
  /** The link the mesh is on. */
  link: string;
  bvh: MeshBVH;
  geometry: BufferGeometry;
  /** Mesh geometry -> link frame, and back. */
  toLink: Matrix4;
  toMesh: Matrix4;
}

/**
 * The meshes a leg is draped over, in one frame: a link's own frame for a leg
 * on one link, or the world at the shown pose for a leg between links (then
 * `linkWorld` maps each link's frame to the world).
 */
export interface LinkSurface {
  link: string;
  meshes: SurfaceMesh[];
  linkWorld?: Map<string, Matrix4>;
}

export function linkSurface(design: Design, linkId: string): LinkSurface {
  const link = design.scene.links.find((l) => l.id === linkId);
  const meshes: SurfaceMesh[] = [];
  for (const ref of link?.meshes ?? []) {
    const e = registry.get(ref.id);
    const bvh = e?.geometry.boundsTree as unknown as MeshBVH | undefined;
    if (!e || !bvh) continue;
    const toLink = meshPoseMatrix(ref);
    meshes.push({ id: ref.id, link: linkId, bvh, geometry: e.geometry, toLink, toMesh: toLink.clone().invert() });
  }
  return { link: linkId, meshes };
}

/** The meshes of every link on the joint path from one link to another, in the world at a pose. */
export function chainSurface(design: Design, from: string, to: string, values: Readonly<Record<string, number>>): LinkSurface | null {
  const path = jointsBetween(design.scene, from, to);
  if (path === null) return null;
  const links = new Set([from, to]);
  for (const id of path) {
    const j = design.scene.joints.find((x) => x.id === id);
    if (j) links.add(j.parent).add(j.child);
  }
  const poses = computeLinkPoses(design.scene, values);
  const meshes: SurfaceMesh[] = [];
  for (const l of design.scene.links) {
    if (!links.has(l.id)) continue;
    const lw = poses.get(l.id);
    if (!lw) continue;
    for (const ref of l.meshes) {
      const e = registry.get(ref.id);
      const bvh = e?.geometry.boundsTree as unknown as MeshBVH | undefined;
      if (!e || !bvh) continue;
      const toLink = lw.clone().multiply(meshPoseMatrix(ref));
      meshes.push({ id: ref.id, link: l.id, bvh, geometry: e.geometry, toLink, toMesh: toLink.clone().invert() });
    }
  }
  return { link: '', meshes, linkWorld: poses };
}

export interface SurfaceDistance {
  /** Signed distance to the link's solids (negative inside), link frame. */
  d: number;
  point: Vector3;
  /** The link of the mesh the closest point is on. */
  link: string;
}

/**
 * Signed distance from a link-frame point to the union of the link's meshes,
 * the sign taken from the face normal at the closest point (behind the face
 * = inside). Draping uses this rather than ray parity because imported CAD
 * bodies are often not watertight, where parity flips at random; it needs
 * outward-facing triangles, which CAD tessellation gives per body.
 */
export function surfaceDistance(surf: LinkSurface, p: Vector3): SurfaceDistance | null {
  let best: SurfaceDistance | null = null;
  const local = new Vector3();
  const n = new Vector3();
  for (const m of surf.meshes) {
    local.copy(p).applyMatrix4(m.toMesh);
    const c = m.bvh.closestPointToPoint(local, undefined, 0, best && best.d > 0 ? best.d : Infinity);
    if (!c) continue;
    faceNormal(m.geometry, c.faceIndex, n);
    const d = local.clone().sub(c.point).dot(n) < 0 ? -c.distance : c.distance;
    if (!best || d < best.d) best = { d, point: c.point.clone().applyMatrix4(m.toLink), link: m.link };
  }
  return best;
}

/** The first place a ray (link frame) meets the surface, with the surface normal turned toward the ray's origin. */
function surfaceHit(surf: LinkSurface, origin: Vector3, dir: Vector3, far: number): { p: Vector3; n: Vector3 } | null {
  const hits: Array<{ t: number; p: Vector3; n: Vector3 }> = [];
  const ray = new Ray();
  for (const m of surf.meshes) {
    ray.origin.copy(origin).applyMatrix4(m.toMesh);
    ray.direction.copy(dir).transformDirection(m.toMesh);
    // Poses are rigid: distances along the ray are the same in mesh and link units.
    for (const h of m.bvh.raycast(ray, DoubleSide, 0, far)) {
      const p = h.point.clone().applyMatrix4(m.toLink);
      const n = faceNormal(m.geometry, h.faceIndex ?? 0).transformDirection(m.toLink);
      if (n.dot(dir) > 0) n.negate(); // face the side the ray comes from
      hits.push({ t: p.clone().sub(origin).dot(dir), p, n });
    }
  }
  hits.sort((x, y) => x.t - y.t);
  // The first surface met from above, whichever way its triangles are wound (imported CAD is not consistent).
  const h = hits[0];
  return h ? { p: h.p, n: h.n } : null;
}

interface CentrePoint {
  /** Centre-line point. */
  c: Vector3;
  /** Normal of the surface it lies over (the direction "up" there). */
  n: Vector3;
}

/**
 * How far above `p` along `n` the downward casts start: at least `h`, and
 * above the highest surface met going up from `p` within 4h (so a body that
 * rises higher than `h` over the chord is cast onto from above, not from a
 * slot inside it). A lid further up than 4h is not seen.
 */
function startHeight(surf: LinkSurface, p: Vector3, n: Vector3, h: number): number | null {
  const ray = new Ray();
  let top = -Infinity;
  for (const m of surf.meshes) {
    ray.origin.copy(p).applyMatrix4(m.toMesh);
    ray.direction.copy(n).transformDirection(m.toMesh);
    for (const hit of m.bvh.raycast(ray, DoubleSide, 0, 4 * h)) top = Math.max(top, hit.distance);
  }
  return Math.max(h, top + 0.5);
}

/** Does any surface lie above `p` along `n` within `far`? */
function somethingAbove(surf: LinkSurface, p: Vector3, n: Vector3, far: number): boolean {
  const ray = new Ray();
  for (const m of surf.meshes) {
    ray.origin.copy(p).applyMatrix4(m.toMesh);
    ray.direction.copy(n).transformDirection(m.toMesh);
    if (m.bvh.raycastFirst(ray, DoubleSide, 0, far)) return true;
  }
  return false;
}

/** Ray offsets across the ball, as fractions of r: the centre and rings at 0.4, 0.75 and 1. */
const BALL: Array<[number, number]> = [[0, 0]];
for (const [rho, k] of [
  [0.4, 6],
  [0.75, 8],
  [1, 8],
] as const) {
  for (let i = 0; i < k; i++) BALL.push([rho * Math.cos((2 * Math.PI * i) / k), rho * Math.sin((2 * Math.PI * i) / k)]);
}

/**
 * Drop a ball of radius r down `n` onto the surface under `p` and return
 * where its centre comes to rest and the direction from the touching point
 * to the centre. Rays across the ball find the surface under each part of
 * it; the ball rests where the highest requirement puts it. So a hole or a
 * groove narrower than the cable is bridged, not entered, and the cable rides
 * over the rim of an edge.
 */
function dropBall(surf: LinkSurface, p: Vector3, n: Vector3, r: number, h: number, below: number): CentrePoint | null {
  const H = startHeight(surf, p, n, h);
  if (H === null) return null;
  const u = new Vector3().crossVectors(n, Math.abs(n.x) < 0.9 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0)).normalize();
  const v = new Vector3().crossVectors(n, u);
  const down = n.clone().negate();
  let best = -Infinity;
  let contact: Vector3 | null = null;
  let contactN: Vector3 | null = null;
  for (const [a, b] of BALL) {
    const origin = p.clone().addScaledVector(n, H).addScaledVector(u, a * r).addScaledVector(v, b * r);
    const hit = surfaceHit(surf, origin, down, H + below);
    if (!hit) continue;
    const height = hit.p.clone().sub(p).dot(n) + r * Math.sqrt(Math.max(0, 1 - a * a - b * b));
    if (height > best + 1e-9) {
      best = height;
      contact = hit.p;
      contactN = hit.n;
    }
  }
  if (!contact) return null;
  const c = p.clone().addScaledVector(n, best);
  const dir = c.clone().sub(contact);
  const len = dir.length();
  return { c, n: len > 1e-6 ? dir.divideScalar(len) : contactN! };
}

export function drapeTolerance(r: number): number {
  return Math.max(0.03, 0.015 * r);
}


function simplify(points: readonly Vector3[], tol: number): Vector3[] {
  if (points.length <= 2) return [...points];
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  const ab = new Vector3();
  const ap = new Vector3();
  while (stack.length) {
    const [i, j] = stack.pop()!;
    const a = points[i]!;
    ab.copy(points[j]!).sub(a);
    const l2 = ab.lengthSq();
    let worst = -1;
    let wd = tol;
    for (let k = i + 1; k < j; k++) {
      ap.copy(points[k]!).sub(a);
      const t = l2 > 0 ? Math.max(0, Math.min(1, ap.dot(ab) / l2)) : 0;
      const d = ap.addScaledVector(ab, -t).length();
      if (d > wd) {
        wd = d;
        worst = k;
      }
    }
    if (worst >= 0) {
      keep[worst] = true;
      stack.push([i, worst], [worst, j]);
    }
  }
  return points.filter((_, k) => keep[k]);
}

const isSurface = (p: RoutePoint) => Math.hypot(...p.n) > 0.5;

/**
 * The fallback for a leg that is not one height profile (its end normals turn
 * by more than TAUT_MAX_TURN_DEG): the point-by-point settling described in
 * the header (steps 1-5), which follows the surface closely.
 */
function settleLeg(design: Design, a: RoutePoint, b: RoutePoint, r: number, surf?: LinkSurface, values: Readonly<Record<string, number>> = {}): RoutePoint[] {
  if (!isSurface(a) || !isSurface(b)) return [];
  // One link: work in its frame on its meshes. Two links: in the world at the shown pose, on the meshes of
  // every link between them; each draped point then goes to the link of the body it rests on.
  const s = surf ?? (a.link === b.link ? linkSurface(design, a.link) : chainSurface(design, a.link, b.link, values));
  if (!s || s.meshes.length === 0) return [];
  const toFrame = (pt: RoutePoint) => s.linkWorld?.get(pt.link) ?? null;
  const tol = drapeTolerance(r);
  const mA = toFrame(a);
  const mB = toFrame(b);
  if (s.linkWorld && (!mA || !mB)) return [];
  const A = new Vector3(...a.p);
  const B = new Vector3(...b.p);
  const nA = new Vector3(...a.n);
  const nB = new Vector3(...b.n);
  if (mA) {
    A.applyMatrix4(mA);
    nA.transformDirection(mA);
  }
  if (mB) {
    B.applyMatrix4(mB);
    nB.transformDirection(mB);
  }
  nA.normalize();
  nB.normalize();
  const L = A.distanceTo(B);
  if (L < 1e-6) return [];
  const step = Math.max(0.5, Math.min(2, r), L / 400);
  const nSamples = Math.ceil(L / step);
  // Start the downward casts this far above the chord, and look this far below it.
  const H = Math.min(30, Math.max(5, 0.25 * L));
  // A cable bridges a deep, narrow gap rather than dropping to its bottom: look only this far below the chord.
  const below = Math.max(2 * r + 3, 0.25 * L);
  const lerpN = (t: number) => {
    const N = nA.clone().lerp(nB, t);
    return N.lengthSq() < 1e-6 ? (t < 0.5 ? nA : nB).clone() : N.normalize();
  };
  // The plane of the leg: along the chord and up. Draping moves points only within it.
  const t = B.clone().sub(A).divideScalar(L);
  const sideRaw = new Vector3().crossVectors(t, nA.clone().add(nB));
  const side = sideRaw.lengthSq() > 1e-8 ? sideRaw.normalize() : null;
  // Everything happens in the leg's plane: a point is found by dropping a ball down `up` onto the
  // surface under a point of the chord, so the drape never wanders sideways or into a groove beside it.
  const upAt = (u: number) => lerpN(Math.max(0, Math.min(1, u)));
  // Where a point lies along the leg, measured across `up` (dropping it straight down onto the chord).
  const upMean = nA.clone().add(nB).lengthSq() > 1e-8 ? nA.clone().add(nB).normalize() : nA.clone();
  const w = B.clone().sub(A).addScaledVector(upMean, -B.clone().sub(A).dot(upMean));
  const wLen2 = w.lengthSq();
  const along = (c: Vector3) => (wLen2 > 1e-9 ? Math.max(0, Math.min(1, c.clone().sub(A).dot(w) / wLen2)) : 0.5);
  // Start each cast H above the higher of the chord there and the leg's higher end, so a steep leg
  // (climbing a wall) still casts from above the top it climbs to, not from inside the body.
  const hA = A.dot(upMean);
  const hB = B.dot(upMean);
  const drop = (u: number): CentrePoint | null => {
    const P = A.clone().lerp(B, u);
    const lift = Math.max(0, Math.max(hA, hB) - P.dot(upMean));
    return dropBall(s, P, upAt(u), r, H + lift, below + lift);
  };
  const sdOf = (c: Vector3) => surfaceDistance(s, c)?.d ?? Infinity;
  /**
   * Seat a centre point at r: inside solid, drop the ball at its place on the chord; outside but nearer
   * than r (a concave corner, an edge the leg cuts), move it away from the closest surface point within
   * the leg's plane. Returns the point and whether it ended at least r - tol from the solid.
   */
  const seat = (pt: CentrePoint, uMin: number, uMax: number): { pt: CentrePoint; ok: boolean } => {
    const c = pt.c.clone();
    for (let k = 0; k < 6; k++) {
      const sd = surfaceDistance(s, c);
      if (!sd || sd.d >= r - tol * 0.5) break;
      if (sd.d < 0) {
        // Inside solid: rise straight up out of it (never tunnel sideways into a pocket under a lip).
        const up = upAt(along(c));
        const stepUp = Math.max(0.2, r / 2);
        let k2 = 0;
        while (k2++ < 400 && sdOf(c) < 0) c.addScaledVector(up, stepUp);
        // Risen into a pocket under a lip (solid still above): rest the ball from above there instead.
        if (somethingAbove(s, c, up, 4 * H)) {
          const ball = drop(along(c));
          if (ball) c.copy(ball.c);
        }
        continue;
      }
      // Near the solid: away from the closest surface point, within the leg's plane only.
      const away = c.clone().sub(sd.point);
      const len = away.length();
      if (len < 1e-9) break;
      if (side) away.addScaledVector(side, -away.dot(side));
      const inPlane = away.length();
      if (inPlane < 0.3 * len) break; // the nearest surface is beside the leg: a clearance question for the fit check
      c.addScaledVector(away, (r - sd.d) / inPlane);
    }
    // It must stay where it was along the leg (between its neighbours, give or take r: a point climbing
    // a wall sits right above the one at its foot), or the line would fold back.
    const u = along(c);
    const slack = r / L;
    const ok = sdOf(c) >= r - tol && u >= uMin - slack && u <= uMax + slack;
    const n = surfaceDistance(s, c);
    const dir = n ? c.clone().sub(n.point) : null;
    return { pt: { c, n: dir && dir.lengthSq() > 1e-12 ? dir.normalize() : pt.n }, ok };
  };
  // 1-2. Drop the ball along the chord: the centre line.
  const centres: Array<CentrePoint & { u: number }> = [{ c: A.clone().addScaledVector(nA, r), n: nA, u: 0 }];
  for (let i = 1; i < nSamples; i++) {
    const ball = drop(i / nSamples);
    if (ball) centres.push({ ...ball, u: i / nSamples });
  }
  centres.push({ c: B.clone().addScaledVector(nB, r), n: nB, u: 1 });
  // 3. Seat the points at r (keeping the ball's rest where that fails), then split legs that still cut in.
  for (let i = 1; i + 1 < centres.length; i++) {
    const cur = centres[i]!;
    const seated = seat(cur, centres[i - 1]!.u, centres[i + 1]!.u);
    if (seated.ok) centres[i] = { ...seated.pt, u: along(seated.pt.c) };
  }
  const out: Vector3[] = [centres[0]!.c];
  let budget = 400;
  const refine = (p: CentrePoint & { u: number }, q: CentrePoint & { u: number }, depth: number) => {
    if (depth >= 8 || budget <= 0 || p.c.distanceTo(q.c) <= Math.max(2 * tol, 0.1)) return;
    const mid = p.n.clone().add(q.n);
    const m: CentrePoint = { c: p.c.clone().add(q.c).multiplyScalar(0.5), n: mid.lengthSq() < 1e-6 ? p.n.clone() : mid.normalize() };
    if (sdOf(m.c) >= r - tol) return;
    budget--;
    const seated = seat(m, Math.min(p.u, q.u), Math.max(p.u, q.u));
    // Only where seating worked; a gap the cable cannot fit is left straight, for the fit check to report.
    if (!seated.ok) return;
    const mm = { ...seated.pt, u: along(seated.pt.c) };
    refine(p, mm, depth + 1);
    out.push(mm.c);
    refine(mm, q, depth + 1);
  };
  for (let i = 1; i < centres.length; i++) {
    refine(centres[i - 1]!, centres[i]!, 0);
    out.push(centres[i]!.c);
  }
  // 4-5. Simplify and store as surface point + normal.
  const kept = simplify(out, tol).slice(1, -1);
  const result: RoutePoint[] = [];
  for (const c of kept) {
    const sd = surfaceDistance(s, c);
    if (!sd) continue;
    const n = c.clone().sub(sd.point);
    const len = n.length();
    if (len < 1e-9) continue;
    n.multiplyScalar((sd.d >= 0 ? 1 : -1) / len);
    // Keep the normal in the leg's plane: a contact on a rim beside the leg would otherwise tilt it
    // sideways, and a flat cable would be told to turn in its own plane where the route runs straight.
    if (side) {
      const inPlane = n.clone().addScaledVector(side, -n.dot(side));
      if (inPlane.lengthSq() > 0.25) n.copy(inPlane.normalize());
    }
    const p = c.clone().addScaledVector(n, -r);
    if (s.linkWorld) {
      // World -> the frame of the link whose body it rests on.
      const inv = s.linkWorld.get(sd.link)?.clone().invert();
      if (!inv) continue;
      p.applyMatrix4(inv);
      n.transformDirection(inv);
    }
    result.push({ link: s.linkWorld ? sd.link : a.link, p: [p.x, p.y, p.z], n: [n.x, n.y, n.z] });
  }
  return result;
}

/** Inside any mesh of the surface (winding number, parity where the mesh is not consistent). */
function insideSurface(surf: LinkSurface, p: Vector3): boolean {
  const local = new Vector3();
  return surf.meshes.some((m) => insideMesh(m.bvh, m.geometry, local.copy(p).applyMatrix4(m.toMesh)).inside);
}

/** The first surface met going from `p` along `dir` within `far`. */
function firstHit(surf: LinkSurface, p: Vector3, dir: Vector3, far: number): Vector3 | null {
  const ray = new Ray();
  let best: Vector3 | null = null;
  let bestT = Infinity;
  for (const m of surf.meshes) {
    ray.origin.copy(p).applyMatrix4(m.toMesh);
    ray.direction.copy(dir).transformDirection(m.toMesh);
    const h = m.bvh.raycastFirst(ray, DoubleSide, 0, far);
    if (h && h.distance < bestT) {
      bestT = h.distance;
      best = h.point.clone().applyMatrix4(m.toLink);
    }
  }
  return best;
}

/**
 * A centre-line point lifted along `up` from where it starts until it is r
 * clear of what lies under it. Inside solid it first rises to where it leaves
 * the solid. Something beside it (the nearest point less than 60 degrees from
 * "up" away) or above it does not lift it: a leg at the foot of a wall stays at
 * the foot, a leg under an overhang stays under it (the fit check judges those
 * clearances). Returns the point, the direction from the nearest surface point
 * to it, and that surface's link.
 */
function liftClear(surf: LinkSurface, start: Vector3, up: Vector3, r: number, tol: number, far: number): { c: Vector3; n: Vector3; link: string } | null {
  const c = start.clone();
  for (let k = 0; k < 40; k++) {
    if (insideSurface(surf, c)) {
      const exit = firstHit(surf, c, up, far);
      if (!exit) return null;
      c.copy(exit).addScaledVector(up, 1e-3);
      continue;
    }
    const near = nearest(surf, c);
    if (!near) return { c, n: up.clone(), link: surf.link };
    const v = c.clone().sub(near.point);
    const dir = near.d > 1e-9 ? v.clone().divideScalar(near.d) : up.clone();
    if (near.d >= r - tol * 0.5 || dir.dot(up) < 0.5) return { c, n: dir, link: near.link };
    // Rise along up until r from that point: |v + h up| = r.
    const vu = v.dot(up);
    const h = -vu + Math.sqrt(Math.max(0, vu * vu - v.lengthSq() + r * r));
    c.addScaledVector(up, Math.max(h, 1e-4));
  }
  const near = nearest(surf, c);
  return near ? { c, n: c.clone().sub(near.point).normalize(), link: near.link } : null;
}

/**
 * A clicked surface point moved sideways, away from a wall it is closer to
 * than the cable's radius, by the shortfall (so the cable lies beside the
 * wall instead of being pushed up onto it). Points not that close come back
 * unchanged. Link frame of the point's own link.
 */
export function clearOfWalls(design: Design, pt: RoutePoint, r: number, surf?: LinkSurface): RoutePoint {
  if (!isSurface(pt)) return pt;
  const s = surf ?? linkSurface(design, pt.link);
  if (s.meshes.length === 0) return pt;
  const N = new Vector3(...pt.n).normalize();
  const c = new Vector3(...pt.p).addScaledVector(N, r);
  const tol = drapeTolerance(r);
  let moved = false;
  let lastDir: Vector3 | null = null;
  for (let k = 0; k < 4; k++) {
    const near = nearest(s, c);
    if (!near || near.d >= r - tol * 0.5) break;
    if (near.d < 1e-6) return pt; // pushed against the far wall: a slot narrower than the cable
    const side = c.clone().sub(near.point);
    side.addScaledVector(N, -side.dot(N));
    if (side.length() < 0.3 * near.d) break; // what is near lies under it, not beside
    side.normalize();
    if (lastDir && side.dot(lastDir) < 0) return pt; // walls on both sides: a slot, not a wall
    c.addScaledVector(side, r - near.d);
    lastDir = side;
    moved = true;
  }
  if (!moved) return pt;
  const p = c.addScaledVector(N, -r);
  return { link: pt.link, p: [p.x, p.y, p.z], n: [...pt.n] };
}

/** End normals turning by more than this: the leg is not one height profile and is settled instead. */
export const TAUT_MAX_TURN_DEG = 60;
/** A leg climbing more steeply than this (chord against the surface) is settled instead too. */
export const TAUT_MAX_CLIMB_DEG = 60;

/** What draping did, for the wire's notes. */
export interface DrapeInfo {
  /** Legs settled point by point because their end normals turn by more than TAUT_MAX_TURN_DEG. */
  settled: number;
}

/** Nearest surface point to `p` (unsigned distance), and its link. */
function nearest(surf: LinkSurface, p: Vector3): { d: number; point: Vector3; link: string } | null {
  let best: { d: number; point: Vector3; link: string } | null = null;
  const local = new Vector3();
  for (const m of surf.meshes) {
    local.copy(p).applyMatrix4(m.toMesh);
    const c = m.bvh.closestPointToPoint(local, undefined, 0, best ? best.d : Infinity);
    if (c && (!best || c.distance < best.d)) best = { d: c.distance, point: c.point.clone().applyMatrix4(m.toLink), link: m.link };
  }
  return best;
}

/**
 * The points to insert between `a` and `b` so the leg rests on the surface
 * the way a cable under light tension does (link frame of the result points,
 * excluding a and b; empty when the leg stays straight). `r` is half the
 * cable's height.
 *
 * Taut drape: "up" is the mean of the two end normals; the profile runs
 * along the chord with its "up" component taken out (so a wall stays a wall in
 * the profile, not an overhang). A ball of radius r is dropped onto the surface at samples along
 * the chord (every min(r/2, 1) mm); its resting centre, raised until it is r
 * from the nearest surface within tolerance, gives the centre-line height
 * there. `tautOverProfile` pulls a string tight over that profile; the
 * samples it touches are the contacts, kept as route points (surface point
 * and normal). The clicked ends always stay. So the wire rests on the high
 * points and bridges the hollows, touches at zero clearance, and its length
 * is the taut length. The profile depends on r only through the lift, so a
 * type change re-seats the same contacts; a leg is re-draped when its ends
 * move or the model under it changes.
 *
 * A leg whose end normals turn by more than TAUT_MAX_TURN_DEG (round the side
 * of a body, opposite faces), or that climbs more steeply than
 * TAUT_MAX_CLIMB_DEG, is not one height profile: it is settled point by point
 * instead (`info.settled` counts those, for the wire's notes).
 */
export function drapeLeg(
  design: Design,
  a: RoutePoint,
  b: RoutePoint,
  r: number,
  surf?: LinkSurface,
  values: Readonly<Record<string, number>> = {},
  info?: DrapeInfo,
): RoutePoint[] {
  if (!isSurface(a) || !isSurface(b)) return [];
  const s = surf ?? (a.link === b.link ? linkSurface(design, a.link) : chainSurface(design, a.link, b.link, values));
  if (!s || s.meshes.length === 0) return [];
  const mA = s.linkWorld?.get(a.link) ?? null;
  const mB = s.linkWorld?.get(b.link) ?? null;
  if (s.linkWorld && (!mA || !mB)) return [];
  const A = new Vector3(...a.p);
  const B = new Vector3(...b.p);
  const nA = new Vector3(...a.n);
  const nB = new Vector3(...b.n);
  if (mA) {
    A.applyMatrix4(mA);
    nA.transformDirection(mA);
  }
  if (mB) {
    B.applyMatrix4(mB);
    nB.transformDirection(mB);
  }
  nA.normalize();
  nB.normalize();
  const L = A.distanceTo(B);
  if (L < 1e-6) return [];
  // "Up" is the mean of the end normals. The profile runs along the chord with that component taken out
  // (so a wall stays a wall in it, never an overhang). A leg whose normals turn too far, or that climbs
  // more steeply than TAUT_MAX_CLIMB_DEG, is not one height profile: it is settled point by point.
  const up = nA.clone().add(nB);
  const chord = B.clone().sub(A);
  const w = up.lengthSq() > 1e-6 ? chord.clone().addScaledVector(up.clone().normalize(), -chord.dot(up.clone().normalize())) : chord.clone();
  const tooSteep = w.length() < L * Math.cos((TAUT_MAX_CLIMB_DEG * Math.PI) / 180);
  if (nA.dot(nB) < Math.cos((TAUT_MAX_TURN_DEG * Math.PI) / 180) || up.lengthSq() < 1e-6 || tooSteep) {
    if (info) info.settled++;
    return settleLeg(design, a, b, r, s, values);
  }
  up.normalize();
  const wLen = w.length();
  const t = w.divideScalar(wLen);
  const tol = drapeTolerance(r);
  const step = Math.max(0.25, Math.min(r / 2, 1), L / 600);
  const nSamples = Math.ceil(L / step);
  // Profile of the centre line: [distance along the chord, height along up above A].
  const profile: Array<[number, number]> = [];
  const centres: Array<{ c: Vector3; n: Vector3; link: string } | null> = [];
  const push = (x: number, c: Vector3, n: Vector3, link: string) => {
    profile.push([x, c.clone().sub(A).dot(up)]);
    centres.push({ c, n, link });
  };
  const xOf = (c: Vector3) => c.clone().sub(A).dot(t);
  const startA = A.clone().addScaledVector(nA, r);
  const startB = B.clone().addScaledVector(nB, r);
  push(xOf(startA), startA, nA, a.link);
  for (let i = 1; i < nSamples; i++) {
    const u = i / nSamples;
    // Start at the height the leg itself is at (the straight line between the two lifted ends) and lift
    // only as far as what lies UNDER it requires; nothing beside or above the leg lifts it.
    const c = liftClear(s, startA.clone().lerp(startB, u), up, r, tol, L + 50);
    if (!c) continue;
    push(u * wLen, c.c, c.n, c.link);
  }
  push(xOf(B.clone().addScaledVector(nB, r)), B.clone().addScaledVector(nB, r), nB, b.link);
  // Ends lifted along a tilted normal can step outside [0, wLen]: keep the profile's distances increasing.
  for (let i = 1; i < profile.length; i++) if (profile[i]![0] <= profile[i - 1]![0]) profile[i]![0] = profile[i - 1]![0] + 1e-6;
  // Pull tight. The samples started at the chord, so an edge the taut line now passes over (lower than
  // the line but within r of it) was not seen: lift samples taken ON the taut line and pull tight again.
  let hull = tautOverProfile(profile);
  for (let pass = 0; pass < 4; pass++) {
    const added: Array<{ x: number; c: Vector3; n: Vector3; link: string }> = [];
    for (let k = 1; k < hull.length; k++) {
      const p0 = centres[hull[k - 1]!]!.c;
      const p1 = centres[hull[k]!]!.c;
      const len = p0.distanceTo(p1);
      const m = Math.floor(len / step);
      for (let j = 1; j < m; j++) {
        const q = p0.clone().lerp(p1, j / m);
        const lifted = liftClear(s, q, up, r, tol, L + 50);
        if (lifted && lifted.c.clone().sub(q).dot(up) > tol * 0.5) added.push({ x: xOf(lifted.c), c: lifted.c, n: lifted.n, link: lifted.link });
      }
    }
    if (added.length === 0) break;
    const all = profile.map((pr, i) => ({ x: pr[0], c: centres[i]!.c, n: centres[i]!.n, link: centres[i]!.link }));
    const first = all[0]!;
    const last = all.at(-1)!;
    const mid = [...all.slice(1, -1), ...added.filter((x) => x.x > first.x && x.x < last.x)].sort((x, y) => x.x - y.x);
    const merged = [first, ...mid, last];
    profile.length = 0;
    centres.length = 0;
    for (const e of merged) push(e.x, e.c, e.n, e.link);
    for (let i = 0; i < profile.length; i++) profile[i]![0] = merged[i]!.x;
    for (let i = 1; i < profile.length; i++) if (profile[i]![0] <= profile[i - 1]![0]) profile[i]![0] = profile[i - 1]![0] + 1e-6;
    hull = tautOverProfile(profile);
  }
  // Drop contacts the taut line passes within tolerance anyway (collinear tops, sampling noise).
  const keptC = new Set(simplify(hull.map((i) => centres[i]!.c), tol));
  const touched = hull.filter((i) => keptC.has(centres[i]!.c));
  const side = new Vector3().crossVectors(t, up).normalize();
  const result: RoutePoint[] = [];
  for (const i of touched.slice(1, -1)) {
    const cp = centres[i]!;
    // Keep the normal in the leg's plane (a contact on a rim beside the leg would tilt it sideways).
    const n = cp.n.clone().addScaledVector(side, -cp.n.dot(side));
    if (n.lengthSq() < 0.25) n.copy(up);
    n.normalize();
    const p = cp.c.clone().addScaledVector(n, -r);
    if (s.linkWorld) {
      const inv = s.linkWorld.get(cp.link)?.clone().invert();
      if (!inv) continue;
      p.applyMatrix4(inv);
      n.transformDirection(inv);
    }
    result.push({ link: s.linkWorld ? cp.link : a.link, p: [p.x, p.y, p.z], n: [n.x, n.y, n.z], tie: false });
  }
  return result;
}

/** Re-drape every leg of a route (after its model changed under it). */
export function redrapeRoute(design: Design, route: Route, r: number, values: Readonly<Record<string, number>> = {}, info?: DrapeInfo): Route {
  // Draped points are contacts of a straight, taut line: re-draping between neighbours keeps them where the
  // surface is unchanged and adds or drops contacts where it changed.
  return withPoints(route, drapePoints(design, pointsOfRoute(route), r, values, info));
}

/** Drape every leg of a list of clicked points. */
export function drapePoints(design: Design, points: readonly RoutePoint[], r: number, values: Readonly<Record<string, number>> = {}, info?: DrapeInfo): RoutePoint[] {
  if (points.length === 0) return [];
  // A click closer to a wall than the cable's radius moves away from it by the shortfall. The points given hold the
  // wire unless they say otherwise; the contacts added between them do not.
  const pts = points.map((p) => ({ ...clearOfWalls(design, p, r), tie: p.tie ?? true }));
  const out: RoutePoint[] = [pts[0]!];
  const cache = new Map<string, LinkSurface>();
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    let surf = a.link === b.link ? cache.get(a.link) : undefined;
    if (!surf && a.link === b.link) {
      surf = linkSurface(design, a.link);
      cache.set(a.link, surf);
    }
    out.push(...drapeLeg(design, a, b, r, surf, values, info), b);
  }
  return out;
}

// ---------------------------------------------------------------- editing a draped wire

/**
 * The points that shape the wire (shown as handles): its holds (`routeHolds`:
 * the points the user placed, ports and lead-outs). Draped points in between
 * are re-made when a hold moves.
 */
export function anchorsOf(route: Route): number[] {
  return routeHolds(route).flatMap((h, i) => (h ? [i] : []));
}

export type DrapeEdit = { kind: 'move'; index: number; point: RoutePoint } | { kind: 'delete'; index: number } | { kind: 'insert'; after: number; point: RoutePoint };

/**
 * Apply an edit to a wire and re-drape the legs it touches: between the
 * anchors either side of the edited point. Returns the new route and the
 * index of the edited point (for a delete: -1), or null when the wire would
 * keep fewer than two points.
 */
export function editDraped(
  design: Design,
  route: Route,
  edit: DrapeEdit,
  r: number,
  drape: boolean,
  values: Readonly<Record<string, number>> = {},
  info?: DrapeInfo,
): { route: Route; index: number } | null {
  const pts = pointsOfRoute(route);
  // What the user moves or adds holds the wire.
  if (edit.kind !== 'delete') edit = { ...edit, point: { ...edit.point, tie: true } };
  const anchors = anchorsOf(route);
  const prevAnchor = (i: number) => Math.max(0, ...anchors.filter((a) => a < i));
  const nextAnchor = (i: number) => Math.min(pts.length - 1, ...anchors.filter((a) => a > i));
  const leg = (a: RoutePoint, b: RoutePoint) => (drape ? drapeLeg(design, a, b, r, undefined, values, info) : []);
  let out: RoutePoint[];
  let index: number;
  if (edit.kind === 'move') {
    const i = edit.index;
    const p0 = i > 0 ? prevAnchor(i) : -1;
    const p1 = i < pts.length - 1 ? nextAnchor(i) : -1;
    const head = p0 >= 0 ? pts.slice(0, p0 + 1) : [];
    const tail = p1 >= 0 ? pts.slice(p1) : [];
    const inA = p0 >= 0 ? leg(pts[p0]!, edit.point) : [];
    const inB = p1 >= 0 ? leg(edit.point, pts[p1]!) : [];
    out = [...head, ...inA, edit.point, ...inB, ...tail];
    index = head.length + inA.length;
  } else if (edit.kind === 'delete') {
    const i = edit.index;
    if (pts.length <= 2) return null;
    if (i === 0 || i === pts.length - 1) {
      // An end: drop it and the draped points up to the next anchor.
      out = i === 0 ? pts.slice(nextAnchor(0)) : pts.slice(0, prevAnchor(i) + 1);
    } else {
      const p0 = prevAnchor(i);
      const p1 = nextAnchor(i);
      out = [...pts.slice(0, p0 + 1), ...leg(pts[p0]!, pts[p1]!), ...pts.slice(p1)];
    }
    if (out.length < 2) return null;
    index = -1;
  } else {
    // Insert after point `after` (between it and the next point).
    const p0 = anchors.includes(edit.after) ? edit.after : prevAnchor(edit.after);
    const p1 = nextAnchor(edit.after);
    const head = pts.slice(0, p0 + 1);
    const inA = leg(pts[p0]!, edit.point);
    const inB = leg(edit.point, pts[p1]!);
    out = [...head, ...inA, edit.point, ...inB, ...pts.slice(p1)];
    index = head.length + inA.length;
  }
  return { route: withPoints(route, out), index };
}


/**
 * Where a cable of half height r actually rests at a clicked surface point:
 * a ball dropped there along the point's normal. A click into a gap or a pit
 * narrower than the cable comes back moved up onto the rims (the cable cannot
 * reach the bottom); a click on open surface comes back unchanged. `moved`
 * says which.
 */
export function restingPoint(design: Design, pt: RoutePoint, r: number): { point: RoutePoint; moved: boolean } {
  if (!isSurface(pt)) return { point: pt, moved: false };
  const s = linkSurface(design, pt.link);
  if (s.meshes.length === 0) return { point: pt, moved: false };
  // Beside a wall: move away from it by the shortfall, never up onto it.
  const cleared = clearOfWalls(design, pt, r, s);
  if (cleared !== pt) return { point: cleared, moved: true };
  const P = new Vector3(...pt.p);
  const N = new Vector3(...pt.n).normalize();
  const tol = drapeTolerance(r);
  // Clear already (nothing within r): stays.
  const here = nearest(s, P.clone().addScaledVector(N, r));
  if (!here || here.d >= r - tol * 0.5) return { point: pt, moved: false };
  // In a slot or pit narrower than the cable: rest it on the rims.
  const ball = dropBall(s, P, N, r, Math.max(10, 4 * r), r);
  if (!ball) return { point: pt, moved: false };
  const c = ball.c.clone();
  let near = nearest(s, c);
  for (let k = 0; k < 8 && near && near.d < r - tol * 0.5; k++) {
    c.addScaledVector(N, r - near.d);
    near = nearest(s, c);
  }
  if (!near || c.clone().sub(P).dot(N) <= r + 2 * tol) return { point: pt, moved: false };
  const n = c.clone().sub(near.point).normalize();
  const p = c.clone().addScaledVector(n, -r);
  return { point: { link: pt.link, p: [p.x, p.y, p.z], n: [n.x, n.y, n.z] }, moved: true };
}

/**
 * The points of a draped route the user placed: its holds (`routeHolds`).
 * Contacts the drape added are left out, to be found again for another
 * cable size.
 */
export function clickAnchors(route: Route): RoutePoint[] {
  return pointsOfRoute(route).filter((p) => p.tie);
}

/** Re-drape a route for another cable size (half height `r`) from its user-placed points. */
export function redrapeForSize(design: Design, route: Route, r: number, values: Readonly<Record<string, number>> = {}, info?: DrapeInfo): Route {
  return withPoints(route, drapePoints(design, clickAnchors(route), r, values, info));
}
