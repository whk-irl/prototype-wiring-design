/** Shared logic for placing and sliding parts on surfaces. */
import type { Ray } from 'three';
import type { Component, Design, Part, Pose } from '@core';
import { zonesAt } from '../state/designOps';
import type { RayHit } from '../tools/types';
import { normalisedPose, poseFromSurface } from './pose';

/** Make the hit normal face the viewer (meshes with inconsistent winding exist). */
export function facingHit(hit: RayHit, ray: Ray): RayHit {
  if (hit.world.normal.dot(ray.direction) <= 0) return hit;
  return {
    ...hit,
    world: { point: hit.world.point, normal: hit.world.normal.clone().negate() },
    link: { point: hit.link.point, normal: hit.link.normal.clone().negate() },
  };
}

export type SurfaceVerdict =
  | { ok: true; zone?: string; zoneName?: string }
  | { ok: false; reason: string };

/** May a part be mounted on this triangle? Keep-out wins over mount-allowed. */
export function surfaceVerdict(design: Design, hit: RayHit): SurfaceVerdict {
  const zones = zonesAt(design, hit.meshId, hit.triangle);
  const keepOut = zones.find((z) => z.kind === 'keep_out');
  if (keepOut) return { ok: false, reason: `This surface is in the keep-clear area "${keepOut.name}".` };
  const mount = zones.find((z) => z.kind === 'mount_allowed');
  return mount ? { ok: true, zone: mount.id, zoneName: mount.name } : { ok: true };
}

export function poseOnHit(hit: RayHit, spin: number): Pose {
  return normalisedPose(poseFromSurface(hit.link.point, hit.link.normal, spin));
}

const CATEGORY_LABEL: Record<Part['category'], string> = {
  controller: 'Controller',
  sensor: 'Sensor',
  driver: 'Driver',
  actuator: 'Actuator',
  power: 'Power',
  camera: 'Camera',
  display: 'Display',
  other: 'Part',
};

/** A new component with a unique id like `sensor-2` and a name like "Sensor 2". */
export function newComponent(design: Design, part: Part, linkId: string, pose: Pose, zone?: string): Component {
  const taken = new Set(design.components.map((c) => c.id));
  let n = 1;
  while (taken.has(`${part.category}-${n}`)) n++;
  const c: Component = { id: `${part.category}-${n}`, name: `${CATEGORY_LABEL[part.category]} ${n}`, part: part.id, link: linkId, pose };
  if (zone) c.zone = zone;
  return c;
}

/** Gap between a component and its duplicate, mm. */
export const DUPLICATE_GAP_MM = 5;

/**
 * A copy of a placed component: the same part on the same link, moved along
 * the surface it sits on (its own X axis, which lies in that surface) by its
 * width plus `DUPLICATE_GAP_MM`, so the two do not overlap. A new id and name;
 * wires are not copied. Undefined when the component is not there.
 */
export function duplicateOf(design: Design, part: Part, id: string): Component | undefined {
  const c = design.components.find((x) => x.id === id);
  if (!c) return undefined;
  const [qx, qy, qz, qw] = c.pose.q;
  // The component's X axis in its link frame (first column of its rotation).
  const ax = 1 - 2 * (qy * qy + qz * qz);
  const ay = 2 * (qx * qy + qz * qw);
  const az = 2 * (qx * qz - qy * qw);
  const d = part.body.size_mm[0] + DUPLICATE_GAP_MM;
  const pose = normalisedPose({ p_mm: [c.pose.p_mm[0] + ax * d, c.pose.p_mm[1] + ay * d, c.pose.p_mm[2] + az * d], q: c.pose.q });
  return newComponent(design, part, c.link, pose);
}
