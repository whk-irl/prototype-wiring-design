/**
 * Joint editor logic: turning selected meshes into a new link behind a new
 * joint, re-picking or flipping an axis, deleting joints and moving meshes.
 * All structural changes go through the core (`splitLink`, `setJointAxis`,
 * `removeJoint`, `updateJoint`, `moveMeshes`); errors they throw are shown
 * to the user verbatim.
 *
 * Axes are shown and typed in WORLD coordinates at the pose on screen, and
 * converted to the parent link's frame with the parent's current world pose
 * (`computeLinkPoses` with the previewed joint values).
 */
import { Box3, Matrix3, Matrix4, Vector3 } from 'three';
import {
  cableEnvelope,
  computeLinkPoses,
  findCableType,
  jointAxisInParent,
  moveMeshes,
  removeJoint,
  findPart,
  flipJointAxis as coreFlipJointAxis,
  setJointAxis,
  splitLink,
  updateJoint,
  type Design,
  type JointType,
  type Library,
  type Vec3,
} from '@core';
import { fitAxisFromSeed } from '../placement/axisFit';
import { surfaceBelow } from '../placement/checks';
import { partWorldMatrix } from '../placement/pose';
import { meshPlacements } from '../scene/placement';
import { registry } from '../scene/registry';
import { topologyOf } from '../scene/topology';
import { nextId } from '../state/integrity';
import { useApp, type AxisDraft, type JointDraft } from '../state/store';
import type { RayHit } from '../tools/types';
import { RAD2DEG } from '../units';
import { redrapeRoute } from '../wires/drape';
import { reseatWires } from '../wires/reseat';

const app = () => useApp.getState();

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Run a core edit; show its error message as is. */
function tryCommit(title: string, recipe: (d: Design) => Design, reseatLinks?: (next: Design) => Iterable<string>): boolean {
  try {
    let next = recipe(app().design);
    // Wires drawn before the joint: put their points on the links their meshes are now on (same undo step).
    if (reseatLinks && next.routes.length > 0) {
      const r = reseatWires(next, reseatLinks(next));
      next = r.design;
      // The model under those wires changed: re-drape them (at the zero pose the re-seat used).
      if (r.changed.length && app().wireSettings.drape !== false) {
        const lib = app().cableLibrary;
        const zero = Object.fromEntries(next.scene.joints.map((j) => [j.id, 0]));
        const d0 = next;
        next = {
          ...d0,
          routes: d0.routes.map((route) => {
            const cable = d0.cables.find((c) => c.id === route.cable);
            const type = cable && lib ? findCableType(lib, cable.type) : undefined;
            if (!cable || !type || !r.changed.includes(cable.id)) return route;
            return redrapeRoute(d0, route, cableEnvelope(type, cable).height_mm / 2, zero);
          }),
        };
      }
      if (r.changed.length) {
        const names = r.changed.map((id) => next.cables.find((c) => c.id === id)?.name || id);
        app().notify('info', `${names.length} wire${names.length === 1 ? '' : 's'} re-seated on the new links`, [
          `${names.join(', ')}: points now lie on the link of the part under them, so they move with it and cross the joint.`,
        ]);
      }
    }
    app().commit(() => next);
    return true;
  } catch (e) {
    app().notify('error', title, [errorText(e)]);
    return false;
  }
}

function linkWorld(design: Design, linkId: string, jointValues: Record<string, number>): Matrix4 {
  return computeLinkPoses(design.scene, jointValues).get(linkId) ?? new Matrix4();
}

/** World axis (at the shown pose) -> point and direction in `linkId`'s frame. */
export function axisToLink(design: Design, jointValues: Record<string, number>, linkId: string, axis: { point: Vec3; dir: Vec3 }): { point_mm: Vec3; dir: Vec3 } {
  const inv = linkWorld(design, linkId, jointValues).invert();
  const p = new Vector3(...axis.point).applyMatrix4(inv);
  const d = new Vector3(...axis.dir).applyMatrix3(new Matrix3().setFromMatrix4(inv)); // keep the typed length: typing is per component
  return { point_mm: [p.x, p.y, p.z], dir: [d.x, d.y, d.z] };
}

/** Point and direction in `linkId`'s frame -> world at the shown pose. */
export function axisToWorld(design: Design, jointValues: Record<string, number>, linkId: string, point: Vec3, dir: Vec3): { point: Vec3; dir: Vec3 } {
  const m = linkWorld(design, linkId, jointValues);
  const p = new Vector3(...point).applyMatrix4(m);
  const d = new Vector3(...dir).applyMatrix3(new Matrix3().setFromMatrix4(m));
  return { point: [p.x, p.y, p.z], dir: [d.x, d.y, d.z] };
}

/** World-space bounding-box centre of a mesh at the shown pose. */
function meshCentre(design: Design, jointValues: Record<string, number>, meshId: string): Vector3 | null {
  const pl = meshPlacements(design).get(meshId);
  const entry = registry.get(meshId);
  if (!pl || !entry?.geometry.boundingBox) return null;
  const m = linkWorld(design, pl.link, jointValues).multiply(pl.pose);
  return entry.geometry.boundingBox.getCenter(new Vector3()).applyMatrix4(m);
}

/**
 * Child joints of `parent` that should move with the new link by default: a
 * joint whose child-link meshes lie (on average) closer to the selected
 * meshes than to the meshes that stay.
 */
export function defaultTakeJoints(design: Design, jointValues: Record<string, number>, parent: string, selected: readonly string[]): string[] {
  const link = design.scene.links.find((l) => l.id === parent);
  if (!link) return [];
  const sel = new Set(selected);
  const near = (p: Vector3, ids: readonly string[]) =>
    Math.min(Infinity, ...ids.map((id) => meshCentre(design, jointValues, id)).filter((c): c is Vector3 => !!c).map((c) => c.distanceTo(p)));
  const moving = link.meshes.filter((m) => sel.has(m.id)).map((m) => m.id);
  const staying = link.meshes.filter((m) => !sel.has(m.id)).map((m) => m.id);
  const out: string[] = [];
  for (const j of design.scene.joints.filter((x) => x.parent === parent)) {
    const childLink = design.scene.links.find((l) => l.id === j.child);
    const centres = (childLink?.meshes ?? []).map((m) => meshCentre(design, jointValues, m.id)).filter((c): c is Vector3 => !!c);
    if (centres.length === 0) continue;
    const c = centres.reduce((a, b) => a.add(b), new Vector3()).divideScalar(centres.length);
    if (near(c, moving) < near(c, staying)) out.push(j.id);
  }
  return out;
}

/**
 * Components on `parent` that should go along with `meshIds`: those whose
 * mounting footprint mostly sits on those meshes. The footprint is sampled at
 * its corners, edge midpoints and centre; each sample finds the mesh just
 * below it; the part goes along when most samples that found a mesh found a
 * selected one.
 */
export function componentsOnMeshes(design: Design, library: Library | null, jointValues: Record<string, number>, parent: string, meshIds: readonly string[]): string[] {
  const ids = new Set(meshIds);
  const lw = linkWorld(design, parent, jointValues);
  return design.components
    .filter((c) => c.link === parent)
    .filter((c) => {
      const part = library ? findPart(library, c.part) : undefined;
      const [sx, sy] = part ? part.body.size_mm : [0, 0];
      const world = partWorldMatrix(lw, c.pose);
      let on = 0;
      let found = 0;
      for (const fx of [-0.5, 0, 0.5]) {
        for (const fy of [-0.5, 0, 0.5]) {
          const hit = surfaceBelow(design, parent, lw, world, fx * sx, fy * sy);
          if (!hit) continue;
          found++;
          if (ids.has(hit.meshId)) on++;
        }
      }
      return found > 0 && on * 2 > found;
    })
    .map((c) => c.id);
}

const DEFAULT_LIMITS: Record<JointType, [number, number]> = {
  revolute: [-90, 90],
  continuous: [-180, 180],
  prismatic: [0, 50],
  fixed: [0, 0],
};

export function defaultLimits(type: JointType): [number, number] {
  return DEFAULT_LIMITS[type];
}

/** Open the editor for a new joint from the selected meshes. */
export function startNewJoint(): void {
  const s = app();
  const meshes = s.selectedMeshes.length ? s.selectedMeshes : s.selection?.kind === 'mesh' ? [s.selection.id] : [];
  if (meshes.length === 0) {
    s.notify('info', 'Select the parts that move together first', ['Click a part, Ctrl+click to add more, or Shift+drag a rectangle; then choose New joint.']);
    return;
  }
  const placements = meshPlacements(s.design);
  const links = new Set(meshes.map((id) => placements.get(id)?.link));
  if (links.size !== 1 || links.has(undefined)) {
    s.notify('error', 'The selected parts are on different links', [
      'A new joint splits one link. Select parts from a single link (the one they hang from now), then choose New joint.',
    ]);
    return;
  }
  const parent = [...links][0]!;
  const n = s.design.scene.joints.length + 1;
  const draft: JointDraft = {
    mode: 'new',
    parent,
    meshes: [...meshes],
    components: componentsOnMeshes(s.design, s.library, s.jointValues, parent, meshes),
    takeJoints: defaultTakeJoints(s.design, s.jointValues, parent, meshes),
    name: `Joint ${n}`,
    type: 'revolute',
    lower: -90,
    upper: 90,
    axis: null,
    preview: 0,
    picking: true,
  };
  s.setJointDraft(draft);
  s.setActiveTool('axis');
}

/** Start re-picking the axis of an existing joint. */
export function startEditAxis(jointId: string): void {
  const s = app();
  const joint = s.design.scene.joints.find((j) => j.id === jointId);
  if (!joint) return;
  const a = jointAxisInParent(joint);
  s.setJointDraft({
    mode: 'edit',
    jointId,
    parent: joint.parent,
    meshes: [],
    components: [],
    takeJoints: [],
    name: joint.name,
    type: joint.type,
    lower: 0,
    upper: 0,
    axis: { point: [...a.point_mm], dir: [...a.dir] },
    preview: 0,
    picking: true,
  });
  s.setActiveTool('axis');
}

export function cancelDraft(): void {
  app().setJointDraft(null);
  useApp.setState({ axisHover: null });
  if (app().activeTool === 'axis') app().setActiveTool('select');
}

/**
 * Store an axis given in WORLD coordinates at the pose shown NOW (a pick, or
 * typed world values) in the draft, converted to the parent link's frame. The
 * draft then no longer depends on preview joint values.
 */
export function setDraftAxisFromWorld(world: AxisDraft): void {
  const s = app();
  const d = s.jointDraft;
  if (!d) return;
  const a = axisToLink(s.design, s.jointValues, d.parent, world);
  s.setJointDraft((x) => ({ ...x, axis: { point: a.point_mm, dir: a.dir, fit: world.fit }, picking: false }));
}

/** Change one typed WORLD component of the draft axis (at the pose shown now). */
export function setDraftAxisWorldComponent(which: 'point' | 'dir', k: 0 | 1 | 2, v: number): void {
  const s = app();
  const w = draftAxisWorld(s.design, s.jointValues, s.jointDraft);
  if (!w) return;
  const vec = [...w[which]] as Vec3;
  vec[k] = v;
  // A typed axis is no longer a fitted or suggested one.
  setDraftAxisFromWorld({ point: which === 'point' ? vec : w.point, dir: which === 'dir' ? vec : w.dir });
}

/** Start typing an axis: a vertical line through the world origin at the pose shown. */
export function startTypedAxis(): void {
  setDraftAxisFromWorld({ point: [0, 0, 0], dir: [0, 0, 1] });
}

/** Adopt a suggested axis (already in the parent link's frame). */
export function adoptSuggestion(it: { point: Vec3; dir: Vec3; label: string; features: number; radius: number; grade: 'likely' | 'possible' }): void {
  const s = app();
  s.setJointDraft((x) => ({
    ...x,
    preview: 0,
    axis: {
      point: [...it.point],
      dir: [...it.dir],
      fit: {
        kind: 'cylinder',
        radius: it.radius,
        rmsRelative: 0,
        maxNormalDot: 0,
        quality: 'good',
        position: 'determined',
        meshId: '',
        suggested: `${it.grade === 'likely' ? 'likely joint' : 'possible joint (could be a fastener)'}: ${it.label} (${it.features} features)`,
      },
    },
    picking: false,
  }));
  useApp.setState({ axisHover: null });
  if (s.activeTool === 'axis') s.setActiveTool('select');
}

/** The draft axis in WORLD coordinates at the pose shown (for display and the gizmo). */
export function draftAxisWorld(design: Design, jointValues: Record<string, number>, d: JointDraft | null): { point: Vec3; dir: Vec3 } | null {
  if (!d?.axis) return null;
  return axisToWorld(design, jointValues, d.parent, d.axis.point, d.axis.dir);
}

/** Fit an axis to the smooth surface under a hit; world coordinates at the shown pose. */
export function axisFromHit(hit: RayHit, meshWorld: Matrix4): AxisDraft | null {
  const entry = registry.get(hit.meshId);
  if (!entry) return null;
  // Grown from the click so the fit uses one surface (see fitAxisFromSeed).
  const fit = fitAxisFromSeed(topologyOf(entry.geometry), hit.triangle);
  if (!fit) return null;
  const p = new Vector3(...fit.point).applyMatrix4(meshWorld);
  const d = new Vector3(...fit.dir).transformDirection(meshWorld);
  return {
    point: [p.x, p.y, p.z],
    dir: [d.x, d.y, d.z],
    fit: {
      kind: fit.kind,
      radius: fit.radius,
      rmsRelative: fit.rmsRelative,
      maxNormalDot: fit.maxNormalDot,
      quality: fit.quality,
      position: fit.position,
      note: fit.note,
      meshId: hit.meshId,
    },
  };
}

function limitFor(d: JointDraft): { lower: number; upper: number } | undefined {
  if (d.type === 'revolute') return { lower: d.lower / RAD2DEG, upper: d.upper / RAD2DEG };
  if (d.type === 'prismatic') return { lower: d.lower, upper: d.upper };
  return undefined;
}

/** Create the joint described by the draft (one undo step). */
export async function createJointFromDraft(): Promise<boolean> {
  const s = app();
  const d = s.jointDraft;
  if (!d || d.mode !== 'new') return false;
  if (d.type !== 'fixed' && !d.axis) {
    s.notify('error', 'The joint has no axis yet', ['Pick a pin, shaft, hole or round face on the model, or type the axis point and direction.']);
    return false;
  }
  const warn = d.type === 'fixed' ? null : axisNeedsConfirmation(d.axis);
  if (warn && !(await s.askConfirm('Create the joint with this axis?', warn, 'Create anyway'))) return false;
  const taken = [...s.design.scene.links.map((l) => l.id), ...s.design.scene.joints.map((j) => j.id)];
  const jointId = nextId('joint', taken);
  const linkId = nextId('link', [...taken, jointId]);
  // The draft axis is already in the parent link's frame: no pose is involved.
  const axis = d.axis ? { point_mm: [...d.axis.point] as Vec3, dir: [...d.axis.dir] as Vec3 } : { point_mm: [0, 0, 0] as Vec3, dir: [0, 0, 1] as Vec3 };
  const linkName = d.name.replace(/^Joint\b/i, 'Link') || linkId;
  const ok = tryCommit('The joint was not created', (design) =>
    splitLink(design, {
      parent: d.parent,
      link: { id: linkId, name: linkName === d.name ? `${d.name} link` : linkName },
      joint: { id: jointId, name: d.name, type: d.type, axis_point_mm: axis.point_mm, axis_dir: axis.dir, limit: limitFor(d) },
      meshes: d.meshes,
      joints: d.takeJoints,
      components: d.components,
    }),
    () => [d.parent, linkId],
  );
  if (!ok) return false;
  s.setJointDraft(null);
  s.setActiveTool('select');
  s.select({ kind: 'joint', id: jointId });
  return true;
}

/** Apply a re-picked or typed axis to an existing joint. */
export async function applyEditAxis(): Promise<boolean> {
  const s = app();
  const d = s.jointDraft;
  if (!d || d.mode !== 'edit' || !d.jointId || !d.axis) return false;
  const joint = s.design.scene.joints.find((j) => j.id === d.jointId);
  if (!joint) return false;
  const warn = axisNeedsConfirmation(d.axis);
  if (warn && !(await s.askConfirm('Use this axis anyway?', warn, 'Use it'))) return false;
  const a = { point_mm: [...d.axis.point] as Vec3, dir: [...d.axis.dir] as Vec3 };
  const retype = d.retype;
  const ok = retype
    ? tryCommit('The joint was not changed', (design) =>
        updateJoint(design, joint.id, { type: retype, limit: limitFor(d) ?? null, axis: { point_mm: a.point_mm, dir: a.dir } }),
      )
    : tryCommit('The axis was not changed', (design) => setJointAxis(design, joint.id, a.point_mm, a.dir));
  if (ok) cancelDraft();
  return ok;
}

export function flipJointAxis(jointId: string): void {
  const s = app();
  const joint = s.design.scene.joints.find((j) => j.id === jointId);
  if (!joint) return;
  // Reverses the sign convention only: the core mirrors the saved value and
  // limits, and the previewed value is negated here, so nothing moves.
  const preview = s.jointValues[jointId] ?? joint.value;
  if (!tryCommit('The axis was not flipped', (design) => coreFlipJointAxis(design, jointId))) return;
  useApp.setState((st) => ({ jointValues: { ...st.jointValues, [jointId]: 0 - preview } }));
}

/** Start picking (or re-picking) the axis. The trial preview goes back to zero first, so the pick reads the real pose. */
export function startPicking(): void {
  const s = app();
  if (s.jointDraft && s.jointDraft.preview !== 0) s.setJointDraft((d) => ({ ...d, preview: 0 }));
  s.setActiveTool('axis');
}

/**
 * Making a fixed joint movable needs an axis: open the axis editor with the
 * new type; Apply sends type, limit and axis in one `updateJoint`.
 */
export function startMakeMovable(jointId: string, type: JointType): void {
  const s = app();
  const joint = s.design.scene.joints.find((j) => j.id === jointId);
  if (!joint) return;
  const [lower, upper] = defaultLimits(type);
  s.setJointDraft({
    mode: 'edit',
    jointId,
    retype: type,
    parent: joint.parent,
    meshes: [],
    components: [],
    takeJoints: [],
    name: joint.name,
    type,
    lower,
    upper,
    axis: null,
    preview: 0,
    picking: true,
  });
  s.setActiveTool('axis');
}

/** Why this axis needs the user's explicit go-ahead (poor fit, or position only guessed), or null. */
export function axisNeedsConfirmation(axis: AxisDraft | null): string | null {
  const f = axis?.fit;
  if (!f) return null;
  if (f.position === 'guess') return f.note ?? 'The axis position is only a guess.';
  if (f.quality === 'poor') return `The axis fit is poor. ${f.note ?? ''}`.trim();
  return null;
}

export function editJoint(jointId: string, patch: Parameters<typeof updateJoint>[2]): void {
  tryCommit('The joint was not changed', (design) => updateJoint(design, jointId, patch));
}

export async function deleteJoint(jointId: string): Promise<void> {
  const s = app();
  const joint = s.design.scene.joints.find((j) => j.id === jointId);
  if (!joint) return;
  const child = s.design.scene.links.find((l) => l.id === joint.child);
  const parent = s.design.scene.links.find((l) => l.id === joint.parent);
  const ok = await s.askConfirm(
    `Delete joint "${joint.name || joint.id}"?`,
    `Link "${child?.name || joint.child}" merges into "${parent?.name || joint.parent}", with everything on it (parts, placed components, zones), as it sits at the zero pose. Joints below it are kept and then hang from "${parent?.name || joint.parent}". Undo brings the joint back.`,
    'Delete joint',
  );
  if (!ok) return;
  if (
    tryCommit(
      'The joint was not deleted',
      (design) => removeJoint(design, jointId),
      () => [],
    )
  )
    s.select({ kind: 'link', id: joint.parent });
}

export function moveSelectedMeshesTo(linkId: string): void {
  const s = app();
  const ids = s.selectedMeshes.length ? s.selectedMeshes : s.selection?.kind === 'mesh' ? [s.selection.id] : [];
  if (ids.length === 0) return;
  const comps = new Set<string>();
  const placements = meshPlacements(s.design);
  for (const from of new Set(ids.map((id) => placements.get(id)?.link))) {
    if (!from) continue;
    for (const c of componentsOnMeshes(s.design, s.library, s.jointValues, from, ids)) comps.add(c);
  }
  const fromLinks = new Set([...ids].map((id) => placements.get(id)?.link).filter((x): x is string => !!x));
  tryCommit(
    'The parts were not moved',
    (design) => moveMeshes(design, ids, linkId, { components: [...comps] }),
    () => [...fromLinks, linkId],
  );
}

export function renameLink(linkId: string, name: string): void {
  app().commit((d) => ({ ...d, scene: { ...d.scene, links: d.scene.links.map((l) => (l.id === linkId ? { ...l, name } : l)) } }));
}

/** World-space bounding box of meshes at the shown pose, for sizing helpers. */
export function meshesBox(design: Design, jointValues: Record<string, number>, ids: readonly string[]): Box3 {
  const box = new Box3();
  for (const id of ids) {
    const pl = meshPlacements(design).get(id);
    const bb = registry.get(id)?.geometry.boundingBox;
    if (!pl || !bb) continue;
    box.union(bb.clone().applyMatrix4(linkWorld(design, pl.link, jointValues).multiply(pl.pose)));
  }
  return box;
}

