/**
 * Inside or outside a mesh, and the signed distance to it. Used by the fit
 * check (a probe inside solid always fails, by its true depth) and by draping.
 *
 * Inside test, first by winding number: three rays in fixed, skewed directions
 * from the point, each summing its crossings WITH SIGN from the triangle's
 * winding (+1 leaving through a face, -1 entering; hits at the same distance
 * with the same sign, where a ray passes exactly through an edge, count once).
 * The sum is the number of shells the point is inside, so a mesh made of
 * overlapping closed shells (a body and a boss pushed into it) is handled:
 * parity would count two crossings there and call the point outside. When the
 * three sums agree and none is negative the answer is certain.
 *
 * Fallback, by parity, where the winding is not consistent (a negative or
 * disagreeing sum: inconsistent triangle orientation, which imported CAD often
 * has, or an open mesh): odd = inside. Three rays; when they disagree two more
 * are cast, the majority of five decides, and the result is marked
 * `certain: false` so callers can say which mesh it was. An open mesh whose
 * walls every ray happens to cross an odd number of times (a closed-looking
 * cup) is taken as solid. A point outside the mesh's bounding box is outside,
 * certainly. */
import { DoubleSide, Ray, Vector3, type BufferGeometry } from 'three';
import type { MeshBVH } from 'three-mesh-bvh';

const DIRS = [new Vector3(0.5773, 0.5774, 0.5775), new Vector3(-0.7071, 0.0123, 0.7069), new Vector3(0.0151, -0.8944, -0.4469)].map((d) => d.normalize());
/** Tie-breakers when the first three disagree. */
const MORE = [new Vector3(0.1, 0.2, 0.97), new Vector3(-0.25, -0.1, 0.96)].map((d) => d.normalize());

export interface InsideResult {
  inside: boolean;
  certain: boolean;
}

const ray = new Ray();
const va = new Vector3();
const vb = new Vector3();
const vc = new Vector3();

const fn = new Vector3();

/** Sum of crossings with sign along a ray (+1 leaving a face, -1 entering): the winding number at `p`. */
function winding(bvh: MeshBVH, geometry: BufferGeometry, p: Vector3, dir: Vector3): number {
  ray.origin.copy(p);
  ray.direction.copy(dir);
  const hits = bvh.raycast(ray, DoubleSide).map((h) => ({ d: h.distance, sign: faceNormal(geometry, h.faceIndex ?? 0, fn).dot(dir) > 0 ? 1 : -1 }));
  hits.sort((a, b) => a.d - b.d);
  let w = 0;
  let last = { d: -Infinity, sign: 0 };
  for (const h of hits) {
    if (!(h.sign === last.sign && h.d - last.d <= 1e-6 * Math.max(1, h.d))) w += h.sign;
    last = h;
  }
  return w;
}

function crossings(bvh: MeshBVH, p: Vector3, dir: Vector3): number {
  ray.origin.copy(p);
  ray.direction.copy(dir);
  const hits = bvh.raycast(ray, DoubleSide).map((h) => h.distance);
  hits.sort((a, b) => a - b);
  let n = 0;
  let last = -Infinity;
  for (const d of hits) {
    if (d - last > 1e-6 * Math.max(1, d)) n++;
    last = d;
  }
  return n;
}

/** Outward normal of a triangle by its winding (geometry space). */
export function faceNormal(geometry: BufferGeometry, face: number, target = new Vector3()): Vector3 {
  const pos = geometry.getAttribute('position');
  const idx = geometry.getIndex();
  const i0 = idx ? idx.getX(face * 3) : face * 3;
  const i1 = idx ? idx.getX(face * 3 + 1) : face * 3 + 1;
  const i2 = idx ? idx.getX(face * 3 + 2) : face * 3 + 2;
  va.fromBufferAttribute(pos, i0);
  vb.fromBufferAttribute(pos, i1);
  vc.fromBufferAttribute(pos, i2);
  return target.crossVectors(vb.sub(va), vc.sub(va)).normalize();
}

/** Is `p` (geometry space) inside the solid the mesh bounds? */
export function insideMesh(bvh: MeshBVH, geometry: BufferGeometry, p: Vector3): InsideResult {
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  if (!geometry.boundingBox!.containsPoint(p)) return { inside: false, certain: true };
  const w = DIRS.map((d) => winding(bvh, geometry, p, d));
  if (w.every((x) => x === w[0]) && w[0]! >= 0) return { inside: w[0]! > 0, certain: true };
  // Not consistently oriented here: parity.
  const yes = DIRS.filter((d) => crossings(bvh, p, d) % 2 === 1).length;
  if (yes === 0 || yes === 3) return { inside: yes === 3, certain: true };
  // Open or not watertight here: two more rays, majority of five.
  const all = yes + MORE.filter((d) => crossings(bvh, p, d) % 2 === 1).length;
  return { inside: all >= 3, certain: false };
}

export interface SignedDistance {
  /** Distance to the surface; negative inside. */
  d: number;
  /** Closest surface point (geometry space). */
  point: Vector3;
  faceIndex: number;
  certain: boolean;
}

/** Signed distance from `p` to the mesh surface (geometry space). Null when the mesh is empty. */
export function signedDistance(bvh: MeshBVH, geometry: BufferGeometry, p: Vector3, maxDistance = Infinity): SignedDistance | null {
  const c = bvh.closestPointToPoint(p, undefined, 0, maxDistance);
  if (!c) {
    // Nothing within maxDistance: only an inside point can matter.
    const ins = insideMesh(bvh, geometry, p);
    if (!ins.inside) return null;
    const far = bvh.closestPointToPoint(p);
    return far ? { d: -far.distance, point: far.point.clone(), faceIndex: far.faceIndex, certain: ins.certain } : null;
  }
  const ins = insideMesh(bvh, geometry, p);
  return { d: ins.inside ? -c.distance : c.distance, point: c.point.clone(), faceIndex: c.faceIndex, certain: ins.certain };
}
