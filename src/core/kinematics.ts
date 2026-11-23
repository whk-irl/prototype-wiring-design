/**
 * Forward kinematics on the design's scene. This is the single source of truth
 * for where links are: the viewport, the router and the exporters all take
 * link poses from `computeLinkPoses`.
 */
import { Matrix4, Quaternion, Vector3 } from 'three';
import type { Joint, Pose, Scene } from './schema';

const ONE = new Vector3(1, 1, 1);

export function poseToMatrix(pose: Pose, out = new Matrix4()): Matrix4 {
  const [x, y, z] = pose.p_mm;
  const [qx, qy, qz, qw] = pose.q;
  return out.compose(new Vector3(x, y, z), new Quaternion(qx, qy, qz, qw).normalize(), ONE);
}

/** Inverse of `poseToMatrix`. The matrix must be a rigid transform. */
export function matrixToPose(m: Matrix4): Pose {
  const p = new Vector3();
  const q = new Quaternion();
  const s = new Vector3();
  m.decompose(p, q, s);
  return { p_mm: [p.x, p.y, p.z], q: [q.x, q.y, q.z, q.w] };
}

export const IDENTITY_POSE: Pose = Object.freeze({
  p_mm: [0, 0, 0],
  q: [0, 0, 0, 1],
}) as Pose;

/** The joint's own motion at `value` (radians, or mm for prismatic), in the child frame. */
export function jointMotion(joint: Joint, value: number, out = new Matrix4()): Matrix4 {
  if (joint.type === 'fixed') return out.identity();
  const axis = new Vector3(...joint.axis);
  if (axis.lengthSq() === 0) return out.identity();
  axis.normalize();
  if (joint.type === 'prismatic') {
    return out.makeTranslation(axis.x * value, axis.y * value, axis.z * value);
  }
  return out.makeRotationAxis(axis, value);
}

/** Clamp a value to the joint's limit. Continuous and unlimited joints pass through. */
export function clampJointValue(joint: Joint, value: number): number {
  if (joint.type === 'fixed') return 0;
  if (joint.type === 'continuous' || !joint.limit) return value;
  return Math.min(joint.limit.upper, Math.max(joint.limit.lower, value));
}

/** Links that are not the child of any joint. */
export function rootLinks(scene: Scene): string[] {
  const children = new Set(scene.joints.map((j) => j.child));
  return scene.links.filter((l) => !children.has(l.id)).map((l) => l.id);
}

/**
 * World pose of every link, in mm. Root links sit at the world origin.
 *
 * `values` overrides `joint.value` per joint id. Values are used as given, not
 * clamped. Links that cannot be reached from a root (a malformed, cyclic
 * scene; `validateDesign` reports it) are left out of the result.
 */
export function computeLinkPoses(scene: Scene, values: Readonly<Record<string, number>> = {}): Map<string, Matrix4> {
  const byParent = new Map<string, Joint[]>();
  for (const j of scene.joints) {
    const list = byParent.get(j.parent);
    if (list) list.push(j);
    else byParent.set(j.parent, [j]);
  }

  const poses = new Map<string, Matrix4>();
  const queue: string[] = [];
  for (const id of rootLinks(scene)) {
    poses.set(id, new Matrix4());
    queue.push(id);
  }

  const origin = new Matrix4();
  const motion = new Matrix4();
  for (let head = 0; head < queue.length; head++) {
    const parentId = queue[head]!;
    const parentPose = poses.get(parentId)!;
    for (const j of byParent.get(parentId) ?? []) {
      if (poses.has(j.child)) continue;
      poseToMatrix(j.origin, origin);
      jointMotion(j, values[j.id] ?? j.value, motion);
      poses.set(j.child, new Matrix4().multiplyMatrices(parentPose, origin).multiply(motion));
      queue.push(j.child);
    }
  }
  return poses;
}

/** Joint values of the saved pose, keyed by joint id. */
export function savedJointValues(scene: Scene): Record<string, number> {
  const out: Record<string, number> = {};
  for (const j of scene.joints) out[j.id] = j.value;
  return out;
}
