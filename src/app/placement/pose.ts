/**
 * Pose mathematics for parts mounted on surfaces. Pure: three.js math only,
 * no DOM and no renderer, so it runs under vitest in Node.
 *
 * A part pose is the part frame in the frame of the link it sits on. The part
 * frame has its origin at the centre of the mounting face and +Z pointing away
 * from the surface (see `src/core/library.ts`). On a surface the pose is fully
 * described by:
 *   - the surface point and outward normal, in the link frame;
 *   - `spin`, the rotation about the normal in radians, measured from a
 *     reference tangent direction (`referenceTangent`).
 */
import { Matrix4, Quaternion, Vector3 } from 'three';
import { matrixToPose, poseToMatrix, type Pose } from '@core';

const X = new Vector3(1, 0, 0);
const Y = new Vector3(0, 1, 0);

/**
 * Tangent direction that `spin = 0` points the part's +X along: the link's +X
 * projected onto the surface plane, or the link's +Y projected when the normal
 * is (nearly) parallel to +X. A field like this must have a discontinuity
 * somewhere on the sphere of normals; this puts it at normals close to +-X.
 */
export function referenceTangent(normal: Vector3, out = new Vector3()): Vector3 {
  const n = normal;
  const ref = Math.abs(n.x) < 0.99 ? X : Y;
  out.copy(ref).addScaledVector(n, -ref.dot(n));
  return out.normalize();
}

export interface SurfacePlacement {
  /** Mounting point on the surface, link frame, mm. */
  point: Vector3;
  /** Outward unit normal, link frame. */
  normal: Vector3;
  /** Rotation about the normal, radians. */
  spin: number;
}

/** Rotation whose +Z is `normal` and whose +X is the reference tangent turned by `spin`. */
export function surfaceQuaternion(normal: Vector3, spin: number, out = new Quaternion()): Quaternion {
  const z = normal.clone().normalize();
  const x0 = referenceTangent(z);
  const y0 = new Vector3().crossVectors(z, x0);
  const c = Math.cos(spin);
  const s = Math.sin(spin);
  const x = x0.clone().multiplyScalar(c).addScaledVector(y0, s);
  const y = new Vector3().crossVectors(z, x);
  return out.setFromRotationMatrix(new Matrix4().makeBasis(x, y, z)).normalize();
}

/** Part pose in the link frame from a surface point, normal and spin. */
export function poseFromSurface(point: Vector3, normal: Vector3, spin: number): Pose {
  const q = surfaceQuaternion(normal, spin);
  return { p_mm: [point.x, point.y, point.z], q: [q.x, q.y, q.z, q.w] };
}

/** Inverse of `poseFromSurface`: recover point, normal (part +Z) and spin. */
export function surfaceFromPose(pose: Pose): SurfacePlacement {
  const q = new Quaternion(...pose.q).normalize();
  const normal = new Vector3(0, 0, 1).applyQuaternion(q).normalize();
  const x = new Vector3(1, 0, 0).applyQuaternion(q);
  const x0 = referenceTangent(normal);
  const spin = Math.atan2(new Vector3().crossVectors(x0, x).dot(normal), x0.dot(x));
  return { point: new Vector3(...pose.p_mm), normal, spin };
}

/** Same placement with the spin replaced. */
export function withSpin(pose: Pose, spin: number): Pose {
  const s = surfaceFromPose(pose);
  return poseFromSurface(s.point, s.normal, spin);
}

/** Round an angle to the nearest multiple of `stepRad`, then wrap to (-pi, pi]. */
export function snapAngle(angle: number, stepRad: number): number {
  return wrapAngle(Math.round(angle / stepRad) * stepRad);
}

export function wrapAngle(a: number): number {
  let r = a % (2 * Math.PI);
  if (r <= -Math.PI) r += 2 * Math.PI;
  if (r > Math.PI) r -= 2 * Math.PI;
  return r;
}

/** World matrix of a part: link world pose times the part pose. */
export function partWorldMatrix(linkWorld: Matrix4, pose: Pose, out = new Matrix4()): Matrix4 {
  return out.multiplyMatrices(linkWorld, poseToMatrix(pose));
}

/**
 * Express a pose given in one link's frame in another link's frame, keeping
 * the world pose. `fromLinkWorld` and `toLinkWorld` are the links' world poses.
 */
export function reparentPose(pose: Pose, fromLinkWorld: Matrix4, toLinkWorld: Matrix4): Pose {
  const world = partWorldMatrix(fromLinkWorld, pose);
  const local = new Matrix4().copy(toLinkWorld).invert().multiply(world);
  return normalisedPose(matrixToPose(local));
}

/** Clean a pose for the design file: unit quaternion with w >= 0. */
export function normalisedPose(pose: Pose): Pose {
  const q = new Quaternion(...pose.q).normalize();
  const sign = q.w < 0 ? -1 : 1;
  return { p_mm: [...pose.p_mm], q: [q.x * sign, q.y * sign, q.z * sign, q.w * sign] };
}

// ---------------------------------------------------------------- boxes

/** An oriented box: `matrix` (rigid) maps box-local to world; `min`/`max` are local bounds. */
export interface OrientedBox {
  matrix: Matrix4;
  min: Vector3;
  max: Vector3;
}

/** Local bounds of a part body (`size_mm`), shrunk by `inset` on every side. */
export function bodyBounds(size: readonly [number, number, number], inset = 0): { min: Vector3; max: Vector3 } {
  const [sx, sy, sz] = size;
  return {
    min: new Vector3(-sx / 2 + inset, -sy / 2 + inset, inset),
    max: new Vector3(sx / 2 - inset, sy / 2 - inset, sz - inset),
  };
}

/** Separating-axis test for two oriented boxes. Touching counts as not overlapping. */
export function boxesOverlap(a: OrientedBox, b: OrientedBox): boolean {
  const frame = (box: OrientedBox) => {
    const centreLocal = box.min.clone().add(box.max).multiplyScalar(0.5);
    const half = box.max.clone().sub(box.min).multiplyScalar(0.5);
    const axes = [new Vector3(), new Vector3(), new Vector3()] as const;
    box.matrix.extractBasis(axes[0], axes[1], axes[2]);
    for (const ax of axes) ax.normalize();
    return { centre: centreLocal.applyMatrix4(box.matrix), half, axes };
  };
  const A = frame(a);
  const B = frame(b);
  if ([A.half, B.half].some((h) => h.x < 0 || h.y < 0 || h.z < 0)) return false;
  const t = B.centre.clone().sub(A.centre);
  const ha = [A.half.x, A.half.y, A.half.z];
  const hb = [B.half.x, B.half.y, B.half.z];
  const test = (axis: Vector3): boolean => {
    const len = axis.length();
    if (len < 1e-9) return true; // parallel edges: covered by face axes
    const n = axis.clone().divideScalar(len);
    let ra = 0;
    let rb = 0;
    for (let i = 0; i < 3; i++) {
      ra += ha[i]! * Math.abs(A.axes[i]!.dot(n));
      rb += hb[i]! * Math.abs(B.axes[i]!.dot(n));
    }
    return Math.abs(t.dot(n)) < ra + rb;
  };
  for (const ax of A.axes) if (!test(ax)) return false;
  for (const ax of B.axes) if (!test(ax)) return false;
  for (const p of A.axes) for (const q of B.axes) if (!test(new Vector3().crossVectors(p, q))) return false;
  return true;
}
