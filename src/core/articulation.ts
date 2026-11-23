/**
 * Editing the joint structure of a scene: turning the single rigid body that a
 * CAD file imports as into links connected by joints, and changing or removing
 * joints afterwards.
 *
 * One rule governs every operation here:
 *
 *   With all joints at value 0, nothing moves in the world.
 *
 * The zero pose is the pose the model was imported in. Regrouping meshes,
 * moving a joint's axis or deleting a joint changes which frame things are
 * expressed in, never where they are at the zero pose. Everything attached to
 * a link is re-expressed when that link's frame changes: mesh poses, component
 * poses, route points and the origins of child joints. Zones are triangle
 * indices on a mesh and only need their `link` updated.
 *
 * All functions are pure: they return a new design and leave the input alone.
 * They throw an Error with a message fit for the user when asked for something
 * impossible (an unknown id, a mesh that is not on the stated link). They do
 * not run `validateDesign`; callers should.
 */
import { Matrix4, Quaternion, Vector3 } from 'three';
import { computeLinkPoses, matrixToPose, poseToMatrix } from './kinematics';
import type { Design, Joint, JointType, Link, MeshRef, Pose, Scene, Vec3 } from './schema';

const IDENTITY_Q = [0, 0, 0, 1] as const;

function clone(design: Design): Design {
  // A design is JSON by definition, so this is a faithful deep copy.
  return JSON.parse(JSON.stringify(design)) as Design;
}

/** Matrix of a mesh's `pose` (identity when absent). */
export function meshPoseMatrix(mesh: MeshRef, out = new Matrix4()): Matrix4 {
  return mesh.pose ? poseToMatrix(mesh.pose, out) : out.identity();
}

/** World pose of every link with all joints at 0: the pose the model was imported in. */
export function zeroLinkPoses(scene: Scene): Map<string, Matrix4> {
  const zeros: Record<string, number> = {};
  for (const j of scene.joints) zeros[j.id] = 0;
  return computeLinkPoses(scene, zeros);
}

/** The link and every link below it in the joint tree. */
export function subtreeLinks(scene: Scene, linkId: string): string[] {
  const out = [linkId];
  for (let head = 0; head < out.length; head++) {
    for (const j of scene.joints) {
      if (j.parent === out[head] && !out.includes(j.child)) out.push(j.child);
    }
  }
  return out;
}

/** A joint's axis as a point and unit direction in its PARENT link's frame. */
export function jointAxisInParent(joint: Joint): { point_mm: Vec3; dir: Vec3 } {
  const [qx, qy, qz, qw] = joint.origin.q;
  const dir = new Vector3(...joint.axis).applyQuaternion(new Quaternion(qx, qy, qz, qw).normalize());
  if (dir.lengthSq() > 0) dir.normalize();
  return { point_mm: [...joint.origin.p_mm], dir: [dir.x, dir.y, dir.z] };
}

// ---------------------------------------------------------------- internals

function linkOf(design: Design, id: string): Link {
  const link = design.scene.links.find((l) => l.id === id);
  if (!link) throw new Error(`There is no link "${id}".`);
  return link;
}

function jointOf(design: Design, id: string): Joint {
  const joint = design.scene.joints.find((j) => j.id === id);
  if (!joint) throw new Error(`There is no joint "${id}".`);
  return joint;
}

function transformPose(m: Matrix4, pose: Pose | undefined): Pose {
  const local = pose ? poseToMatrix(pose) : new Matrix4();
  return matrixToPose(new Matrix4().multiplyMatrices(m, local));
}

function transformPoint(m: Matrix4, p: Vec3): Vec3 {
  const v = new Vector3(...p).applyMatrix4(m);
  return [v.x, v.y, v.z];
}

/** Rotate a direction by the rotation part of `m` (a rigid transform). */
function transformDir(m: Matrix4, d: Vec3): Vec3 {
  const v = new Vector3(...d).transformDirection(m);
  // transformDirection normalises; keep a zero vector (a "no surface" marker) zero.
  return d[0] === 0 && d[1] === 0 && d[2] === 0 ? [0, 0, 0] : [v.x, v.y, v.z];
}

function unitAxis(dir: Vec3, what: string): Vector3 {
  const v = new Vector3(...dir);
  if (!dir.every(Number.isFinite) || v.lengthSq() < 1e-18) throw new Error(`${what} needs an axis direction that is not zero.`);
  return v.normalize();
}

function finitePoint(p: Vec3, what: string): void {
  if (!p.every(Number.isFinite)) throw new Error(`${what} needs a finite point on the axis.`);
}

function idTaken(design: Design, id: string): boolean {
  return design.scene.links.some((l) => l.id === id) || design.scene.joints.some((j) => j.id === id);
}

/**
 * Move everything attached to link `from` that `pick` selects onto link `to`,
 * re-expressing it with `m`, which maps coordinates in `from`'s frame to
 * coordinates in `to`'s frame.
 */
function moveContents(
  design: Design,
  from: string,
  to: string,
  m: Matrix4,
  pick: { meshes: ReadonlySet<string> | 'all'; components: ReadonlySet<string> | 'all'; routes: boolean },
): void {
  const fromLink = linkOf(design, from);
  const toLink = linkOf(design, to);

  const moved = new Set<string>();
  const staying: MeshRef[] = [];
  for (const mesh of fromLink.meshes) {
    if (pick.meshes === 'all' || pick.meshes.has(mesh.id)) {
      toLink.meshes.push({ ...mesh, pose: transformPose(m, mesh.pose) });
      moved.add(mesh.id);
    } else {
      staying.push(mesh);
    }
  }
  fromLink.meshes = staying;

  const movedZones = new Set<string>();
  for (const zone of design.zones) {
    if (zone.link === from && moved.has(zone.mesh)) {
      zone.link = to;
      movedZones.add(zone.id);
    }
  }

  for (const component of design.components) {
    if (component.link !== from) continue;
    const selected = pick.components === 'all' || pick.components.has(component.id);
    // A component recorded in a zone goes wherever that zone's mesh goes.
    const followsZone = component.zone !== undefined && movedZones.has(component.zone);
    if (selected || followsZone) {
      component.link = to;
      component.pose = transformPose(m, component.pose);
      // Taken along by request while its zone stayed behind: the zone link
      // would now point at another link, so it is dropped.
      if (!followsZone) delete component.zone;
    }
  }

  if (pick.routes) {
    for (const route of design.routes) {
      for (const segment of route.segments) {
        if (segment.link !== from) continue;
        segment.link = to;
        segment.points_mm = segment.points_mm.map((p) => transformPoint(m, p));
        if (segment.normals) segment.normals = segment.normals.map((d) => transformDir(m, d));
      }
    }
  }
}

// ---------------------------------------------------------------- operations

export interface MoveMeshesOptions {
  /**
   * Components to take along, besides those recorded in a zone on a moved
   * mesh. A component taken along this way whose zone stays behind loses its
   * `zone`, since a component cannot be in a zone on another link.
   */
  components?: readonly string[];
}

/**
 * Move meshes onto another existing link. They may come from several links.
 * Zones on the meshes follow them, and so do components recorded in those
 * zones and the components listed in `options`. Unlike `splitLink`, this does
 * not object to leaving a link, even the base, with no meshes.
 */
export function moveMeshes(design: Design, meshIds: readonly string[], toLinkId: string, options: MoveMeshesOptions = {}): Design {
  const next = clone(design);
  linkOf(next, toLinkId);
  const wanted = new Set(meshIds);
  const found = new Set<string>();
  const world = zeroLinkPoses(next.scene);
  const toWorld = world.get(toLinkId);
  if (!toWorld) throw new Error(`Link "${toLinkId}" is not connected to the rest of the model.`);
  const toInverse = toWorld.clone().invert();
  const extra = new Set(options.components ?? []);

  for (const link of [...next.scene.links]) {
    const here = new Set(link.meshes.filter((m) => wanted.has(m.id)).map((m) => m.id));
    for (const id of here) found.add(id);
    if (link.id === toLinkId || here.size === 0) continue;
    const fromWorld = world.get(link.id);
    if (!fromWorld) throw new Error(`Link "${link.id}" is not connected to the rest of the model.`);
    const m = new Matrix4().multiplyMatrices(toInverse, fromWorld);
    moveContents(next, link.id, toLinkId, m, { meshes: here, components: extra, routes: false });
  }
  for (const id of wanted) if (!found.has(id)) throw new Error(`There is no mesh "${id}".`);
  return next;
}

export interface JointSpec {
  id: string;
  name: string;
  type: JointType;
  /** A point on the joint axis, in the PARENT link's frame. Ignored for fixed joints. */
  axis_point_mm: Vec3;
  /** Direction of the axis, in the PARENT link's frame. Need not be unit length. */
  axis_dir: Vec3;
  /** Radians for revolute, mm for prismatic. Required for both. */
  limit?: { lower: number; upper: number };
}

export interface SplitLinkSpec {
  /** The link the meshes are on now; it becomes the parent of the new link. */
  parent: string;
  link: { id: string; name: string };
  joint: JointSpec;
  /** Meshes of `parent` that move with the new link. */
  meshes: readonly string[];
  /** Existing joints whose parent is `parent` and that should hang off the new
   *  link instead, taking their subtrees with them. */
  joints?: readonly string[];
  /** Components on `parent` to take along (see `moveMeshes`). */
  components?: readonly string[];
}

/**
 * Split some meshes of a link off into a new child link connected by a new
 * joint. The new link's frame has its origin on the joint axis and the same
 * orientation as the parent's frame.
 */
export function splitLink(design: Design, spec: SplitLinkSpec): Design {
  const next = clone(design);
  const parent = linkOf(next, spec.parent);
  if (spec.link.id === spec.joint.id) throw new Error('The new link and the new joint need different ids.');
  if (idTaken(next, spec.link.id)) throw new Error(`The id "${spec.link.id}" is already in use.`);
  if (idTaken(next, spec.joint.id)) throw new Error(`The id "${spec.joint.id}" is already in use.`);
  if (spec.meshes.length === 0) throw new Error('Choose at least one mesh for the new link.');
  const onParent = new Set(parent.meshes.map((m) => m.id));
  for (const id of spec.meshes) {
    if (!onParent.has(id)) throw new Error(`Mesh "${id}" is not on link "${spec.parent}".`);
  }
  const isRoot = next.scene.joints.every((j) => j.child !== spec.parent);
  const allMeshesMove = onParent.size === new Set(spec.meshes).size;
  const takenJoints = new Set(spec.joints ?? []);
  const allJointsMove = next.scene.joints.every((j) => j.parent !== spec.parent || takenJoints.has(j.id));
  if (isRoot && allMeshesMove && allJointsMove) {
    // Legal, but worth refusing: nothing would stay on the base, so the whole
    // model would hang off an empty link and move as one piece. (Emptying a
    // link that is not the base is allowed: a two-axis joint needs one.)
    throw new Error('Leave at least one mesh on the base link: something has to stay still.');
  }

  const fixed = spec.joint.type === 'fixed';
  if (!fixed) finitePoint(spec.joint.axis_point_mm, 'The joint');
  // A fixed joint has no axis. Storing zero makes that explicit: it cannot be
  // made movable later without being given a real one (see `updateJoint`).
  const dir = fixed ? new Vector3(0, 0, 0) : unitAxis(spec.joint.axis_dir, 'The joint');
  if ((spec.joint.type === 'revolute' || spec.joint.type === 'prismatic') && !spec.joint.limit) {
    throw new Error(`A ${spec.joint.type} joint needs a lower and an upper limit.`);
  }
  if (spec.joint.limit && !(spec.joint.limit.lower <= spec.joint.limit.upper)) {
    throw new Error('The lower limit must not be greater than the upper limit.');
  }

  const origin: Pose = { p_mm: fixed ? [0, 0, 0] : [...spec.joint.axis_point_mm], q: [...IDENTITY_Q] };
  const toChild = poseToMatrix(origin).invert(); // parent-frame coordinates -> child-frame coordinates

  for (const id of spec.joints ?? []) {
    const joint = jointOf(next, id);
    if (joint.parent !== spec.parent) throw new Error(`Joint "${id}" does not hang off link "${spec.parent}".`);
    joint.parent = spec.link.id;
    joint.origin = transformPose(toChild, joint.origin);
  }

  next.scene.links.push({ id: spec.link.id, name: spec.link.name, user_defined: true, meshes: [] });
  next.scene.joints.push({
    id: spec.joint.id,
    name: spec.joint.name,
    type: spec.joint.type,
    parent: spec.parent,
    child: spec.link.id,
    origin,
    // The child frame has the parent's orientation, so the direction is the same in both.
    axis: [dir.x, dir.y, dir.z],
    ...(spec.joint.limit ? { limit: { ...spec.joint.limit } } : {}),
    value: 0,
  });

  moveContents(next, spec.parent, spec.link.id, toChild, {
    meshes: new Set(spec.meshes),
    components: new Set(spec.components ?? []),
    routes: false,
  });
  return next;
}

/**
 * Move a joint's axis. `axis_point_mm` and `axis_dir` are in the PARENT link's
 * frame. The child link's frame moves onto the new axis and everything on the
 * child link is re-expressed, so the zero pose is unchanged. The joint keeps
 * its value, so at a non-zero value the child does move: it now turns about
 * the new axis.
 */
export function setJointAxis(design: Design, jointId: string, axis_point_mm: Vec3, axis_dir: Vec3): Design {
  const next = clone(design);
  const joint = jointOf(next, jointId);
  if (joint.type === 'fixed') throw new Error('A fixed joint has no axis. Change its type and give it an axis in one step.');
  applyAxis(next, joint, axis_point_mm, axis_dir);
  return next;
}

/** Shared by `setJointAxis` and `updateJoint`. Mutates `next`. */
function applyAxis(next: Design, joint: Joint, axis_point_mm: Vec3, axis_dir: Vec3): void {
  finitePoint(axis_point_mm, 'The joint');
  const dir = unitAxis(axis_dir, 'The joint');

  const oldOrigin = poseToMatrix(joint.origin);
  const newOrigin: Pose = { p_mm: [...axis_point_mm], q: [...joint.origin.q] };
  // old child-frame coordinates -> new child-frame coordinates
  const m = poseToMatrix(newOrigin).invert().multiply(oldOrigin);

  const child = linkOf(next, joint.child);
  child.meshes = child.meshes.map((mesh) => ({ ...mesh, pose: transformPose(m, mesh.pose) }));
  for (const component of next.components) {
    if (component.link === joint.child) component.pose = transformPose(m, component.pose);
  }
  for (const route of next.routes) {
    for (const segment of route.segments) {
      if (segment.link !== joint.child) continue;
      segment.points_mm = segment.points_mm.map((p) => transformPoint(m, p));
      if (segment.normals) segment.normals = segment.normals.map((d) => transformDir(m, d));
    }
  }
  for (const other of next.scene.joints) {
    if (other.parent === joint.child) other.origin = transformPose(m, other.origin);
  }

  joint.origin = newOrigin;
  const [qx, qy, qz, qw] = newOrigin.q;
  const inChild = dir.applyQuaternion(new Quaternion(qx, qy, qz, qw).normalize().invert());
  joint.axis = [inChild.x, inChild.y, inChild.z];
}

/**
 * Reverse a joint's axis direction without moving anything: the saved value
 * changes sign and the limits are mirrored, so the same physical range and the
 * same pose are described with the opposite sign convention. A caller holding
 * a previewed value for this joint should negate it too.
 */
export function flipJointAxis(design: Design, jointId: string): Design {
  const next = clone(design);
  const joint = jointOf(next, jointId);
  if (joint.type === 'fixed') throw new Error('A fixed joint has no axis.');
  // `0 - x` rather than `-x`, so a zero never becomes -0 (which JSON drops).
  joint.axis = [0 - joint.axis[0], 0 - joint.axis[1], 0 - joint.axis[2]];
  joint.value = 0 - joint.value;
  if (joint.limit) joint.limit = { lower: 0 - joint.limit.upper, upper: 0 - joint.limit.lower };
  return next;
}

/**
 * Remove a joint and merge its child link into the parent, as it sits at the
 * zero pose. Meshes, zones, components, route segments and the child's own
 * joints all move to the parent. Route crossings of the removed joint are
 * dropped.
 */
export function removeJoint(design: Design, jointId: string): Design {
  const next = clone(design);
  const joint = jointOf(next, jointId);
  const toParent = poseToMatrix(joint.origin); // child-frame coordinates -> parent-frame coordinates

  for (const other of next.scene.joints) {
    if (other.parent === joint.child) {
      other.parent = joint.parent;
      other.origin = transformPose(toParent, other.origin);
    }
  }
  moveContents(next, joint.child, joint.parent, toParent, { meshes: 'all', components: 'all', routes: true });

  next.scene.joints = next.scene.joints.filter((j) => j.id !== jointId);
  next.scene.links = next.scene.links.filter((l) => l.id !== joint.child);
  for (const route of next.routes) {
    route.crossings = route.crossings.filter((c) => c.joint !== jointId);
  }
  return next;
}

export interface JointPatch {
  name?: string;
  type?: JointType;
  /** `null` removes the limit (allowed for continuous and fixed joints only). */
  limit?: { lower: number; upper: number } | null;
  /** A new axis, in the PARENT link's frame, as for `setJointAxis`. Required
   *  when a fixed joint becomes movable. */
  axis?: { point_mm: Vec3; dir: Vec3 };
}

/**
 * Change a joint's name, type, limit or axis in one step. The saved value is
 * reset to 0 when the joint becomes fixed, and clamped into the limit when the
 * patch changes the type or the limit. A patch that only renames the joint or
 * moves its axis leaves the saved value alone, like `setJointAxis`, even if
 * that value is outside the limit.
 *
 * A fixed joint has no meaningful axis, whatever its `axis` field holds, so
 * making one movable requires `patch.axis`: otherwise the joint would turn
 * about a line nobody chose.
 */
export function updateJoint(design: Design, jointId: string, patch: JointPatch): Design {
  const next = clone(design);
  const joint = jointOf(next, jointId);
  const wasFixed = joint.type === 'fixed';
  if (patch.name !== undefined) joint.name = patch.name;
  if (patch.type !== undefined) joint.type = patch.type;
  if (joint.type !== 'fixed') {
    if (patch.axis) applyAxis(next, joint, patch.axis.point_mm, patch.axis.dir);
    else if (wasFixed) throw new Error('Pick an axis for this joint before making it movable.');
  }
  if (patch.limit === null) delete joint.limit;
  else if (patch.limit !== undefined) joint.limit = { ...patch.limit };

  if (joint.limit && !(joint.limit.lower <= joint.limit.upper)) {
    throw new Error('The lower limit must not be greater than the upper limit.');
  }
  if ((joint.type === 'revolute' || joint.type === 'prismatic') && !joint.limit) {
    throw new Error(`A ${joint.type} joint needs a lower and an upper limit.`);
  }
  if (joint.type !== 'fixed' && new Vector3(...joint.axis).lengthSq() < 1e-18) {
    throw new Error('Set the joint axis before making this joint movable.');
  }
  if (joint.type === 'fixed') joint.value = 0;
  else if ((patch.type !== undefined || patch.limit !== undefined) && joint.limit && joint.type !== 'continuous') {
    joint.value = Math.min(joint.limit.upper, Math.max(joint.limit.lower, joint.value));
  }
  return next;
}
