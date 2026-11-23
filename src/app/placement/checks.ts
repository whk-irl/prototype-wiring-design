/**
 * Non-blocking placement checks, in the pose currently shown (joint preview
 * applied): a component's body intersecting the model or another component,
 * or lying partly outside the zone it was placed in. Contact at the mounting
 * face is ignored by shrinking the body 0.5 mm on every side.
 */
import { Box3, DoubleSide, Matrix4, Ray, Sphere, Vector3 } from 'three';
import type { MeshBVH } from 'three-mesh-bvh';
import { computeLinkPoses, findPart, meshPoseMatrix, type Design, type Library, type Pose } from '@core';
import { registry } from '../scene/registry';
import { runsContain } from '../state/designOps';
import { useApp } from '../state/store';
import { bodyBounds, boxesOverlap, partWorldMatrix, type OrientedBox } from './pose';

const INSET_MM = 0.5;
const SAMPLES = 5;

export function componentWarnings(design: Design, library: Library | null, jointValues: Record<string, number>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!library) return out;
  const poses = computeLinkPoses(design.scene, jointValues);
  const boxes = new Map<string, OrientedBox>();
  const linkName = (id: string) => design.scene.links.find((l) => l.id === id)?.name || id;

  for (const c of design.components) {
    const part = findPart(library, c.part);
    const linkWorld = poses.get(c.link);
    if (!part || !linkWorld) continue;
    const world = partWorldMatrix(linkWorld, c.pose);
    const { min, max } = bodyBounds(part.body.size_mm, INSET_MM);
    boxes.set(c.id, { matrix: world, min, max });
    const warn: string[] = [];

    // 1. Body against the model.
    const local = new Box3(min, max);
    const worldSphere = local.getBoundingSphere(new Sphere()).applyMatrix4(world);
    const hitMeshes: string[] = [];
    for (const link of design.scene.links) {
      const lw = poses.get(link.id);
      if (!lw) continue;
      for (const ref of link.meshes) {
        const entry = registry.get(ref.id);
        const bvh = entry?.geometry.boundsTree as unknown as MeshBVH | undefined;
        if (!entry || !entry.bvhReady || !bvh) continue;
        // Mesh geometry is in its imported frame: world = link world * mesh pose.
        const meshWorld = new Matrix4().multiplyMatrices(lw, meshPoseMatrix(ref));
        const bs = entry.geometry.boundingSphere;
        if (bs && bs.clone().applyMatrix4(meshWorld).distanceToPoint(worldSphere.center) > worldSphere.radius) continue;
        const boxToMesh = new Matrix4().copy(meshWorld).invert().multiply(world);
        if (bvh.intersectsBox(local, boxToMesh)) hitMeshes.push(`${ref.node || ref.id} (${linkName(link.id)})`);
      }
    }
    if (hitMeshes.length > 0) {
      warn.push(`Body intersects the model: ${hitMeshes.slice(0, 3).join(', ')}${hitMeshes.length > 3 ? ` and ${hitMeshes.length - 3} more` : ''}.`);
    }

    // 2. Zones under the footprint: outside its zone, on a keep-out zone, or in none.
    const [sx, sy] = part.body.size_mm;
    const samples: Array<SurfaceSample | null> = [];
    for (let i = 0; i < SAMPLES; i++) {
      for (let j = 0; j < SAMPLES; j++) {
        const x = (-0.5 + (i + 0.5) / SAMPLES) * sx;
        const y = (-0.5 + (j + 0.5) / SAMPLES) * sy;
        samples.push(surfaceBelow(design, c.link, linkWorld, world, x, y));
      }
    }
    const linkZones = design.zones.filter((z) => z.link === c.link);
    const keepOut = linkZones.filter((z) => z.kind === 'keep_out' && samples.some((h) => h && h.meshId === z.mesh && runsContain(z.triangles, h.triangle)));
    for (const z of keepOut) warn.push(`Sits on keep-clear area "${z.name}".`);
    const zone = c.zone ? design.zones.find((z) => z.id === c.zone) : undefined;
    if (zone) {
      const outside = samples.filter((h) => !h || h.meshId !== zone.mesh || !runsContain(zone.triangles, h.triangle)).length;
      if (outside > 0) warn.push(`Partly outside its area "${zone.name}" (${outside} of ${SAMPLES * SAMPLES} footprint points).`);
    } else if (keepOut.length === 0 && linkZones.some((z) => z.kind === 'mount_allowed')) {
      warn.push('Not inside an area where parts may go.');
    }
    if (warn.length) out[c.id] = warn;
  }

  // 3. Components against each other.
  const ids = [...boxes.keys()];
  for (let a = 0; a < ids.length; a++) {
    for (let b = a + 1; b < ids.length; b++) {
      if (!boxesOverlap(boxes.get(ids[a]!)!, boxes.get(ids[b]!)!)) continue;
      const name = (id: string) => design.components.find((c) => c.id === id)?.name ?? id;
      (out[ids[a]!] ??= []).push(`Overlaps component "${name(ids[b]!)}".`);
      (out[ids[b]!] ??= []).push(`Overlaps component "${name(ids[a]!)}".`);
    }
  }
  return out;
}

export interface SurfaceSample {
  meshId: string;
  triangle: number;
}

/**
 * The model surface just below a point of a part's mounting face (part frame
 * x, y), among the meshes of the part's link: the nearest hit of a short ray
 * from 2 mm above the face along the part's -Z.
 */
export function surfaceBelow(design: Design, linkId: string, linkWorld: Matrix4, partWorld: Matrix4, x: number, y: number): SurfaceSample | null {
  const link = design.scene.links.find((l) => l.id === linkId);
  if (!link) return null;
  const toLink = new Matrix4().copy(linkWorld).invert().multiply(partWorld);
  const ray = new Ray(new Vector3(x, y, 2).applyMatrix4(toLink), new Vector3(0, 0, -1).transformDirection(toLink));
  let best: SurfaceSample | null = null;
  let bestDist = Infinity;
  for (const ref of link.meshes) {
    const entry = registry.get(ref.id);
    const bvh = entry?.geometry.boundsTree as unknown as MeshBVH | undefined;
    if (!entry || !bvh) continue;
    // Into the mesh's imported frame (rigid, so distances are unchanged).
    const toMesh = meshPoseMatrix(ref).invert();
    const hit = bvh.raycastFirst(ray.clone().applyMatrix4(toMesh), DoubleSide, 0, 6);
    if (hit && hit.faceIndex != null && hit.distance < bestDist) {
      bestDist = hit.distance;
      best = { meshId: ref.id, triangle: hit.faceIndex };
    }
  }
  return best;
}

/**
 * The mount-allowed zone under the centre of a component placed at `pose`
 * on `linkId`, or undefined when the centre is not on one (or is on a
 * keep-out zone). Used to keep `component.zone` current after a move.
 */
export function zoneUnderPose(design: Design, linkId: string, pose: Pose, jointValues: Record<string, number>): string | undefined {
  const linkWorld = computeLinkPoses(design.scene, jointValues).get(linkId);
  if (!linkWorld) return undefined;
  const hit = surfaceBelow(design, linkId, linkWorld, partWorldMatrix(linkWorld, pose), 0, 0);
  if (!hit) return undefined;
  const zones = design.zones.filter((z) => z.link === linkId && z.mesh === hit.meshId && runsContain(z.triangles, hit.triangle));
  if (zones.some((z) => z.kind === 'keep_out')) return undefined;
  return zones.find((z) => z.kind === 'mount_allowed')?.id;
}

/** Recompute warnings (debounced) whenever something they depend on changes. */
export function watchComponentWarnings(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const run = () => {
    timer = null;
    const s = useApp.getState();
    const next = s.design.components.length ? componentWarnings(s.design, s.library, s.jointValues) : {};
    if (JSON.stringify(next) !== JSON.stringify(s.componentWarnings)) useApp.setState({ componentWarnings: next });
  };
  return useApp.subscribe((s, prev) => {
    if (
      s.design.components === prev.design.components &&
      s.design.zones === prev.design.zones &&
      s.design.scene === prev.design.scene &&
      s.jointValues === prev.jointValues &&
      s.geometryVersion === prev.geometryVersion &&
      s.bvhPending === prev.bvhPending &&
      s.library === prev.library
    ) {
      return;
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, 120);
  });
}

/**
 * What would be wrong with placing `partId` at `pose` on `linkId`, for the
 * preview while placing: the body intersecting the model or another part, a
 * keep-clear area, and a footprint wider than the face under it (points of
 * the mounting face with no surface within 2 mm below). Empty when it is fine.
 */
export function placementPreviewWarnings(design: Design, library: Library | null, partId: string, linkId: string, pose: Pose, jointValues: Record<string, number>): string[] {
  const part = library ? findPart(library, partId) : undefined;
  if (!part) return [];
  const id = '__placing__';
  const trial: Design = { ...design, components: [...design.components, { id, name: part.name, part: partId, link: linkId, pose }] };
  const warn = (componentWarnings(trial, library, jointValues)[id] ?? []).filter((w) => !w.startsWith('Not inside an area'));
  const linkWorld = computeLinkPoses(design.scene, jointValues).get(linkId);
  if (linkWorld) {
    const world = partWorldMatrix(linkWorld, pose);
    const [sx, sy] = part.body.size_mm;
    let missing = 0;
    for (let i = 0; i < SAMPLES; i++)
      for (let j = 0; j < SAMPLES; j++) {
        if (!surfaceBelow(design, linkId, linkWorld, world, (-0.5 + (i + 0.5) / SAMPLES) * sx, (-0.5 + (j + 0.5) / SAMPLES) * sy)) missing++;
      }
    if (missing > 0) warn.push(`Wider than the face under it: ${missing} of ${SAMPLES * SAMPLES} points of its base have nothing under them.`);
  }
  return warn;
}
