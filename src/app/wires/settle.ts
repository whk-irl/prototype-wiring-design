/**
 * The shape a wire really takes, from the core rod solver (`settleRod`).
 *
 * The wire is held only at its holds (`routeHolds`: the points the user
 * placed, ports, lead-out ends). The points the drape added between them are
 * the path first laid over the surface: where the stiff wire starts, never
 * where it is pinned.
 *
 * Runs (`holdRuns`): consecutive holds on one link, with the path between
 * them on that link, are laid stretches. A run is settled in one solve, in
 * the link's frame, laid mode, pinned at every hold; the contact is the
 * link's own meshes and the parts placed on it; no gravity (a laid wire is
 * held down; laid mode with gravity can run away). A run's ends are free to
 * turn (the loop beyond picks up the direction the run settles to), except a
 * port end, which leaves along its lead-out.
 *
 * Loops: between two runs the wire hangs free over the joint(s) between their
 * links, possibly across a link it is not held on. Cut mode, one fixed length
 * (the slack model's free length for that loop), from the end of one run's
 * settled line to the start of the next, each end held along the run's
 * settled end direction (a run of one hold: free to pivot). It starts from the
 * draped points between the two holds, each moved with its own link to the
 * pose (`relaxSpan` when there are none). Gravity (world +Z up) when the
 * cable's sag length is known. Contact: the meshes of every link and the parts
 * that can come within the loop's reach at that pose.
 *
 * The slack model and the crossing checks read a derived route (`WirePlan.
 * derived`): one segment per run, its points the settled centre line from
 * first hold to last.
 *
 * Never blocking the view: in the browser a shape that is not cached is
 * solved later, in slices of at most SLICE_MS, one slice per macrotask (a
 * solve restarts from where the last slice stopped). The draped shape is
 * drawn meanwhile; listeners are told when shapes arrive. In Node, and when
 * asked to (`solve`), everything runs at once.
 */
import { Matrix4, Sphere, Vector3 } from 'three';
import type { MeshBVH } from 'three-mesh-bvh';
import {
  computeLinkPoses,
  crossingEnds,
  findPart,
  LAY_OVER_BEND_LIMIT,
  meshPoseMatrix,
  poseToMatrix,
  segmentCentreLine,
  settleRod,
  type CableEnvelope,
  type CrossingEnds,
  type Design,
  type Library,
  type RodContact,
  type RodInput,
  type RodPin,
  type RodShape,
  type Route,
  type SpanEnds,
  type Vec3,
} from '@core';
import { registry } from '../scene/registry';
import { faceNormal, insideMesh } from './solid';
import { holdRuns, pointsOfRoute, type RoutePoint } from './routeEdit';

export { PIN_TURN_DEG, segmentPins } from './routeEdit';

/** What the solver is told about a cable. */
export interface RodCable {
  /** Half the cable's height: the centre line keeps this far from surfaces. */
  radius_mm: number;
  /** Natural bend length when laid snug (`cableStiffness().lay_length_mm`). */
  lay_length_mm: number;
  /** (B/w)^(1/3), when known: free stretches sag. */
  sag_length_mm?: number;
  flat: boolean;
}

/** A cable's rod figures from its envelope alone (lay length by the stiffness module's rule; no sag). */
export function rodOfEnvelope(env: CableEnvelope, sag_length_mm?: number): RodCable {
  return {
    radius_mm: env.height_mm / 2,
    lay_length_mm: Math.max(0.5, LAY_OVER_BEND_LIMIT * env.bend_static_mm),
    ...(sag_length_mm !== undefined && env.shape !== 'flat' ? { sag_length_mm } : {}),
    flat: env.shape === 'flat',
  };
}

export interface SettledLine {
  /** Centre line (link frame on a body, world over a joint). */
  points: Vec3[];
  /** Per point: the surface normal where the wire touches, carried smoothly between (a ribbon's face follows it). */
  normals: Vec3[];
  radius_mm: number[];
  min_radius_mm: number;
  length_mm: number;
  touching: boolean[];
  worst_penetration_mm: number;
  converged: boolean;
  reaches: boolean;
  /** Where the holds sit in `points`. */
  pin_indices: number[];
  solve_ms: number;
  /** Inputs the solver had to repair (coincident holds merged, a bad direction dropped), in its words; empty when none. */
  repaired: string[];
}

/** A run's (or a loop's) settled shape, or why the draped one is used instead. */
export type SegmentSettle = { ok: true; line: SettledLine } | { ok: false; reason: string; line?: SettledLine };

// ---------------------------------------------------------------- contact

interface MeshProbe {
  id: string;
  /** Bounding box in the mesh's own frame. */
  box: import('three').Box3;
  bvh: MeshBVH;
  geometry: import('three').BufferGeometry;
  toFrame: Matrix4;
  toMesh: Matrix4;
}

interface BoxProbe {
  id: string;
  toFrame: Matrix4;
  toBox: Matrix4;
  half: Vector3;
  centre: Vector3;
}

/** Meshes of the given links (each link's frame given). `near`: only meshes whose bounding sphere comes within it. */
function meshProbes(design: Design, links: ReadonlyArray<{ id: string; frame: Matrix4 }>, near?: Sphere): MeshProbe[] {
  const out: MeshProbe[] = [];
  for (const { id, frame } of links) {
    const link = design.scene.links.find((l) => l.id === id);
    for (const ref of link?.meshes ?? []) {
      const e = registry.get(ref.id);
      const bvh = e?.geometry.boundsTree as unknown as MeshBVH | undefined;
      if (!e || !bvh) continue;
      const toFrame = frame.clone().multiply(meshPoseMatrix(ref));
      if (!e.geometry.boundingBox) e.geometry.computeBoundingBox();
      if (near) {
        if (!e.geometry.boundingSphere) e.geometry.computeBoundingSphere();
        if (!e.geometry.boundingSphere!.clone().applyMatrix4(toFrame).intersectsSphere(near)) continue;
      }
      out.push({ id: ref.id, box: e.geometry.boundingBox!, bvh, geometry: e.geometry, toFrame, toMesh: toFrame.clone().invert() });
    }
  }
  return out;
}

function boxProbes(design: Design, library: Library | null, frameOfLink: (link: string) => Matrix4 | null, exclude: ReadonlySet<string>, near?: Sphere): BoxProbe[] {
  const out: BoxProbe[] = [];
  for (const c of design.components) {
    if (exclude.has(c.id)) continue;
    const lw = frameOfLink(c.link);
    const part = library ? findPart(library, c.part) : (design.parts.find((p) => p.id === c.part) ?? undefined);
    if (!lw || !part) continue;
    const [sx, sy, sz] = part.body.size_mm;
    const toFrame = lw.clone().multiply(poseToMatrix(c.pose));
    const half = new Vector3(sx / 2, sy / 2, sz / 2);
    const centre = new Vector3(0, 0, sz / 2);
    if (near && !new Sphere(centre.clone().applyMatrix4(toFrame), half.length()).intersectsSphere(near)) continue;
    out.push({ id: c.id, toFrame, toBox: toFrame.clone().invert(), half, centre });
  }
  return out;
}

/**
 * Signed distance to the nearest mesh or part box (negative inside) and the
 * outward normal there. Inside or out of a mesh by ray parity (`insideMesh`:
 * winding number, a majority of rays where the mesh is open), so nested and
 * overlapping bodies are judged right. Inside any body is inside (`inside`
 * is set, as the solver asks): the deepest body the point lies in is the one
 * it is pushed out of, an approximation of the boundary of the union. A mesh
 * whose bounding box is farther than the reach is not looked at; beyond the
 * reach a mesh is looked at only when the point is inside it.
 */
function contactOf(meshes: readonly MeshProbe[], boxes: readonly BoxProbe[]): RodContact {
  const local = new Vector3();
  const fn = new Vector3();
  const v = new Vector3();
  return (p, reach) => {
    let best: { d: number; n: Vector3 } | null = null;
    let inAny = false;
    for (const m of meshes) {
      local.set(p[0], p[1], p[2]).applyMatrix4(m.toMesh);
      const inBox = m.box.containsPoint(local);
      if (!inBox && m.box.distanceToPoint(local) > reach) continue;
      // Inside or out by ray parity (winding number where the mesh is closed), not by the nearest face's
      // normal: that misjudges points near edges and in nested or overlapping bodies.
      const inside = inBox && insideMesh(m.bvh, m.geometry, local).inside;
      let c: { point: Vector3; distance: number; faceIndex: number } | null = m.bvh.closestPointToPoint(local, undefined, 0, reach + 1e-9);
      if (!c) {
        if (!inside) continue;
        c = m.bvh.closestPointToPoint(local);
        if (!c) continue;
      }
      if (inside) inAny = true;
      const d = inside ? -c.distance : c.distance;
      if (best && d >= best.d) continue;
      v.copy(local).sub(c.point);
      let n: Vector3;
      if (c.distance > 1e-6) n = v.clone().normalize().multiplyScalar(inside ? -1 : 1);
      else n = faceNormal(m.geometry, c.faceIndex, fn).clone();
      best = { d, n: n.transformDirection(m.toFrame) };
    }
    for (const b of boxes) {
      local.set(p[0], p[1], p[2]).applyMatrix4(b.toBox).sub(b.centre);
      const q = new Vector3(Math.abs(local.x) - b.half.x, Math.abs(local.y) - b.half.y, Math.abs(local.z) - b.half.z);
      const outside = new Vector3(Math.max(q.x, 0), Math.max(q.y, 0), Math.max(q.z, 0));
      const d = outside.length() + Math.min(Math.max(q.x, q.y, q.z), 0);
      if (d < 0) inAny = true;
      if (d > reach || (best && d >= best.d)) continue;
      let n: Vector3;
      if (outside.lengthSq() > 0) n = new Vector3(Math.sign(local.x) * outside.x, Math.sign(local.y) * outside.y, Math.sign(local.z) * outside.z).normalize();
      else {
        // Inside: out through the nearest face.
        n = q.x >= q.y && q.x >= q.z ? new Vector3(Math.sign(local.x) || 1, 0, 0) : q.y >= q.z ? new Vector3(0, Math.sign(local.y) || 1, 0) : new Vector3(0, 0, Math.sign(local.z) || 1);
      }
      best = { d, n: n.transformDirection(b.toFrame) };
    }
    if (!best || best.d > reach) return null;
    // (A negative distance deeper than the reach is kept: the point is inside solid.)
    return { distance_mm: best.d, normal: [best.n.x, best.n.y, best.n.z], inside: inAny || best.d < 0 };
  };
}

/** The parts a wire's ends plug into: the wire is meant to touch them. */
function endParts(route: Route): Set<string> {
  return new Set([route.from?.component, route.to?.component].filter((x): x is string => !!x));
}

/** Contact in a link's frame: its meshes and the parts placed on it (except `exclude`, the parts the wire's ends plug into). */
export function linkContact(design: Design, library: Library | null, linkId: string, exclude: ReadonlySet<string> = new Set()): RodContact {
  const id = new Matrix4();
  return contactOf(meshProbes(design, [{ id: linkId, frame: id }]), boxProbes(design, library, (l) => (l === linkId ? id : null), exclude));
}

/** What a loop at a pose is checked against: every mesh and part that can come within `near` (all of them without it). */
function worldBodies(design: Design, library: Library | null, values: Readonly<Record<string, number>>, near?: Sphere, exclude: ReadonlySet<string> = new Set()): { meshes: MeshProbe[]; boxes: BoxProbe[] } {
  const poses = computeLinkPoses(design.scene, values);
  const links = design.scene.links.flatMap((l) => {
    const m = poses.get(l.id);
    return m ? [{ id: l.id, frame: m }] : [];
  });
  return { meshes: meshProbes(design, links, near), boxes: boxProbes(design, library, (l) => poses.get(l) ?? null, exclude, near) };
}

/** Contact with the model's bodies only (no placed parts), in the world at a pose. */
export function meshWorldContact(design: Design, values: Readonly<Record<string, number>>): RodContact {
  return contactOf(worldBodies(design, null, values).meshes, []);
}

/** Contact in the world at a pose: every link's meshes and every placed part. */
export function worldContact(design: Design, library: Library | null, values: Readonly<Record<string, number>>): RodContact {
  const b = worldBodies(design, library, values);
  return contactOf(b.meshes, b.boxes);
}

// ---------------------------------------------------------------- directions

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3): Vec3 | undefined => {
  const l = len(a);
  return l > 1e-9 ? [a[0] / l, a[1] / l, a[2] / l] : undefined;
};

/**
 * The direction a line runs at one of its ends, judged over `baseline_mm`
 * of its length (or all of it when shorter): from the point that far back to
 * the end (arrive), or from the end to the point that far on (leave).
 */
export function endDirection(points: readonly Vec3[], way: 'arrive' | 'leave', baseline_mm: number): Vec3 | undefined {
  const n = points.length;
  if (n < 2) return undefined;
  const end = way === 'arrive' ? points[n - 1]! : points[0]!;
  let far = end;
  let walked = 0;
  for (let k = 1; k < n; k++) {
    const q = way === 'arrive' ? points[n - 1 - k]! : points[k]!;
    walked += len(sub(q, far));
    far = q;
    if (walked >= baseline_mm) break;
  }
  return way === 'arrive' ? unit(sub(end, far)) : unit(sub(far, end));
}

/** Direction from the nearest distinct earlier point to point i (arrival), or from i to the nearest distinct later one (departure). */
function directionAt(points: readonly Vec3[], i: number, way: 'arrive' | 'leave'): Vec3 | undefined {
  if (way === 'arrive') {
    for (let j = i - 1; j >= 0; j--) {
      const d = unit(sub(points[i]!, points[j]!));
      if (d) return d;
    }
  } else {
    for (let j = i + 1; j < points.length; j++) {
      const d = unit(sub(points[j]!, points[i]!));
      if (d) return d;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------- normals along a settled line

/** Normals for a settled line: the contact normal where it touches, carried smoothly between (perpendicular to the line), the holds' normals at the ends. */
function carryNormals(points: readonly Vec3[], touching: readonly boolean[], contact: RodContact | undefined, r: number, start?: Vec3, end?: Vec3): Vec3[] {
  const n = points.length;
  const known: Array<Vector3 | null> = points.map((p, i) => {
    if (!contact || !touching[i]) return null;
    const c = contact(p, r * 1.5 + 0.5);
    return c ? new Vector3(...c.normal).normalize() : null;
  });
  if (start && len(start) > 0.5 && !known[0]) known[0] = new Vector3(...start).normalize();
  if (end && len(end) > 0.5 && !known[n - 1]) known[n - 1] = new Vector3(...end).normalize();
  const idx = known.map((k, i) => (k ? i : -1)).filter((i) => i >= 0);
  const out: Vec3[] = [];
  // The known normals either side of each point, found in one pass (the line can have thousands of points).
  let q = 0;
  for (let i = 0; i < n; i++) {
    let v: Vector3;
    while (q < idx.length && idx[q]! < i) q++;
    if (idx.length === 0) v = new Vector3();
    else {
      const after = q < idx.length ? idx[q] : undefined;
      const before = after === i ? i : q > 0 ? idx[q - 1] : undefined;
      if (before === undefined) v = known[after!]!.clone();
      else if (after === undefined || after === before) v = known[before]!.clone();
      else v = known[before]!.clone().lerp(known[after]!, (i - before) / (after - before));
    }
    // Perpendicular to the line there.
    const t = new Vector3(...sub(points[Math.min(n - 1, i + 1)]!, points[Math.max(0, i - 1)]!));
    if (t.lengthSq() > 0 && v.lengthSq() > 0) {
      t.normalize();
      v.addScaledVector(t, -v.dot(t));
    }
    if (v.lengthSq() > 1e-9) v.normalize();
    out.push([v.x, v.y, v.z]);
  }
  return out;
}

function lineOf(shape: RodShape, normals: Vec3[], ms: number): SettledLine {
  return {
    points: shape.points,
    normals,
    radius_mm: shape.radius_mm,
    min_radius_mm: shape.min_radius_mm,
    length_mm: shape.length_mm,
    touching: shape.touching,
    worst_penetration_mm: shape.worst_penetration_mm,
    converged: shape.converged,
    reaches: shape.reaches,
    pin_indices: shape.pin_indices,
    solve_ms: ms,
    repaired: shape.repaired ?? [],
  };
}

/** A lone hold: a point the wire pivots at. */
function pointLine(p: Vec3, n: Vec3 | undefined): SettledLine {
  return { points: [p], normals: [n ?? [0, 0, 0]], radius_mm: [Infinity], min_radius_mm: Infinity, length_mm: 0, touching: [false], worst_penetration_mm: 0, converged: true, reaches: true, pin_indices: [0], solve_ms: 0, repaired: [] };
}

// ---------------------------------------------------------------- solving in slices

/** Longest one slice of a solve may block (ms): the solve restarts from where it stopped in the next macrotask. */
export const SLICE_MS = 100;
/** Total time a run may take before the draped shape is kept instead (ms). Flat cables settle more slowly. */
export const RUN_BUDGET_MS = { round: 2500, flat: 2000 } as const;
/** Total time a loop may take (ms). */
export const LOOP_BUDGET_MS = 400;

interface Stepper<R = SegmentSettle> {
  /** One slice of at most `slice_ms`; the result when finished, else null (call again). */
  step(slice_ms: number): R | null;
}

type JobKind = 'run' | 'loop' | 'detour';

interface Job<R = SegmentSettle> {
  key: string;
  kind: JobKind;
  make: () => Stepper<R>;
  /** The result to keep when the work throws: a failure with its reason (the queue goes on). */
  fail: (reason: string) => R;
  /**
   * False when what the key was made from has changed since it was asked for
   * (a body's BVH arrived): the work is dropped unstarted, never cached under
   * a key it does not match; whoever still needs it asks again with the new key.
   */
  stillValid?: () => boolean;
}

const failText = (e: unknown) => `the shape could not be worked out (${e instanceof Error ? e.message : String(e)})`;

/**
 * A solve that can stop and restart: each slice runs `settleRod` for at most
 * the slice, from the shape the last one reached. `finish` turns the final
 * shape into the result.
 */
function slicedSolve(
  input: Omit<RodInput, 'contact'>,
  makeContact: () => RodContact,
  total_ms: number,
  spacing_mm: number | undefined,
  finish: (shape: RodShape, ms: number, contact: RodContact) => SegmentSettle,
): Stepper {
  let path = input.path;
  let pins = input.pins;
  let spent = 0;
  let contact: RodContact | null = null;
  return {
    step(slice_ms) {
      contact ??= makeContact();
      const t0 = performance.now();
      let shape: RodShape;
      try {
        shape = settleRod({ ...input, path, pins, contact }, { time_budget_ms: Math.max(5, Math.min(slice_ms, total_ms - spent)), ...(spacing_mm !== undefined ? { spacing_mm } : {}) });
      } catch (e) {
        return { ok: false, reason: `the shape could not be worked out (${e instanceof Error ? e.message : String(e)})` };
      }
      spent += performance.now() - t0;
      if (shape.converged || spent >= total_ms * 0.98) return finish(shape, spent, contact);
      // Not there yet: go on from here next time (the pins move with the resampled line).
      path = shape.points;
      pins = pins.map((pin, j) => ({ ...pin, index: shape.pin_indices[j] ?? pin.index }));
      return null;
    },
  };
}

function runToEnd<R>(s: Stepper<R>): R {
  for (;;) {
    const r = s.step(Infinity);
    if (r) return r;
  }
}

// ---------------------------------------------------------------- the plan of a wire

type Segment = Route['segments'][number];

export interface PlanRun {
  link: string;
  /** Flat indices (into `pointsOfRoute`) of its holds, in order. */
  holds: number[];
  /** The stored points from its first hold to its last (link frame, with their normals): the drape, where the solve starts. */
  drape: Segment;
  /** Where its holds sit in `drape.points_mm`. */
  pins: number[];
}

export interface PlanLoop {
  /** The stored points strictly between the two holds, each in its own link's frame: the loop's starting path. */
  between: RoutePoint[];
}

export interface WirePlan {
  route: Route;
  rod: RodCable;
  runs: PlanRun[];
  /** Between run k and run k + 1. */
  loops: PlanLoop[];
  /** Per run: its settled shape; null while it is being worked out. A run of one hold is a point at once. */
  settles: Array<SegmentSettle | null>;
  /**
   * The route as the slack model and the crossing checks read it: one segment
   * per run, its points the settled centre line from first hold to last (the
   * drape's centre line while unsettled or when the solve failed), normals
   * zero except at the two ends, where the hold's surface normal is kept and
   * the point put back on the surface (the slack model lifts it again by the
   * same radius). So nothing is lifted twice, the loop's ends run the way the
   * settled wire does, and they know which way the surface faces.
   */
  derived: Route;
}

function runsOf(route: Route): { runs: PlanRun[]; loops: PlanLoop[] } {
  const pts = pointsOfRoute(route);
  const runs: PlanRun[] = holdRuns(pts).map((r) => {
    const first = r.holds[0]!;
    const last = r.holds[r.holds.length - 1]!;
    const slice = pts.slice(first, last + 1);
    return {
      link: r.link,
      holds: r.holds,
      drape: { link: r.link, points_mm: slice.map((p) => p.p), normals: slice.map((p) => p.n) },
      pins: r.holds.map((h) => h - first),
    };
  });
  const loops: PlanLoop[] = [];
  for (let k = 0; k + 1 < runs.length; k++) loops.push({ between: pts.slice(runs[k]!.holds.at(-1)! + 1, runs[k + 1]!.holds[0]!) });
  return { runs, loops };
}

/** Spacing of the solver's pieces on a run: an eighth of the lay length (0.3 to 3 mm), and at least two pieces between the closest holds. */
function runSpacing(path: readonly Vec3[], pins: readonly number[], rod: RodCable): number {
  let shortest = Infinity;
  for (let j = 1; j < pins.length; j++) {
    let l = 0;
    for (let i = pins[j - 1]!; i < pins[j]!; i++) l += len(sub(path[i + 1]!, path[i]!));
    if (l > 1e-6) shortest = Math.min(shortest, l);
  }
  return Math.max(0.3, Math.min(3, rod.lay_length_mm / 8, shortest / 2));
}

function runJob(design: Design, library: Library | null, route: Route, run: PlanRun, k: number, nRuns: number, rod: RodCable): Job | null {
  if (run.holds.length < 2) return null;
  const path = segmentCentreLine(run.drape, rod.radius_mm);
  const last = path.length - 1;
  const tangents = new Map<number, Vec3>();
  // A port end leaves along its lead-out; every other end is free to turn.
  if (k === 0 && route.from) {
    const t = directionAt(path, 0, 'leave');
    if (t) tangents.set(0, t);
  }
  if (k === nRuns - 1 && route.to) {
    const t = directionAt(path, last, 'arrive');
    if (t) tangents.set(last, t);
  }
  const pins: RodPin[] = run.pins.map((i) => (tangents.has(i) ? { index: i, tangent: tangents.get(i)! } : { index: i }));
  const spacing = runSpacing(path, run.pins, rod);
  const exclude = endParts(route);
  const link = design.scene.links.find((l) => l.id === run.link);
  // The parts as the contact will see them: their body size from the library (or the design's own parts), null when not known.
  const partOf = (id: string) => (library ? findPart(library, id) : design.parts.find((x) => x.id === id));
  const comps = design.components.filter((c) => c.link === run.link && !exclude.has(c.id)).map((c) => [c.id, c.part, c.pose, partOf(c.part)?.body.size_mm ?? null]);
  const key = JSON.stringify([
    'run',
    run.link,
    path,
    pins,
    rod,
    spacing,
    link?.meshes.map((m) => [m.id, m.pose ?? null]) ?? [],
    link?.meshes.map((m) => registry.get(m.id)?.triCount ?? 0) ?? [],
    link?.meshes.every((m) => !!registry.get(m.id)?.geometry.boundsTree),
    comps,
  ]);
  const total = rod.flat ? RUN_BUDGET_MS.flat : RUN_BUDGET_MS.round;
  const bodies = () => JSON.stringify(link?.meshes.map((m) => [registry.get(m.id)?.triCount ?? 0, !!registry.get(m.id)?.geometry.boundsTree]) ?? []);
  const asked = bodies();
  return {
    key,
    kind: 'run',
    stillValid: () => bodies() === asked,
    fail: (reason) => ({ ok: false, reason }),
    make: () =>
      slicedSolve(
        { path, pins, radius_mm: rod.radius_mm, mode: { kind: 'laid', bend_length_mm: rod.lay_length_mm } },
        () => linkContact(design, library, run.link, exclude),
        total,
        spacing,
        (shape, ms, contact) => {
          const ns = carryNormals(shape.points, shape.touching, contact, rod.radius_mm, run.drape.normals?.[0], run.drape.normals?.[last]);
          const line = lineOf(shape, ns, ms);
          if (shape.converged) return { ok: true, line };
          return {
            ok: false,
            reason:
              ms >= total * 0.95
                ? `the stiff-wire shape did not settle within ${(total / 1000).toFixed(1)} s, so the draped shape (glued to the surface) is drawn and checked instead`
                : 'the stiff-wire shape did not settle, so the draped shape (glued to the surface) is drawn and checked instead',
            line,
          };
        },
      ),
  };
}

function derivedSegment(run: PlanRun, settle: SegmentSettle | null, rod: RodCable): Segment {
  const pts: Vec3[] = settle?.ok ? settle.line.points.map((p) => [p[0], p[1], p[2]] as Vec3) : segmentCentreLine(run.drape, rod.radius_mm);
  const normals: Vec3[] = pts.map(() => [0, 0, 0]);
  const keep = (i: number, n: Vec3 | undefined) => {
    if (!n || !(len(n) > 0.5)) return;
    const u = unit(n)!;
    pts[i] = [pts[i]![0] - u[0] * rod.radius_mm, pts[i]![1] - u[1] * rod.radius_mm, pts[i]![2] - u[2] * rod.radius_mm];
    normals[i] = u;
  };
  keep(0, run.drape.normals?.[0]);
  if (pts.length > 1) keep(pts.length - 1, run.drape.normals?.[run.drape.points_mm.length - 1]);
  return { link: run.link, points_mm: pts, normals };
}

interface PlanMemo {
  keys: Array<string | null>;
  settles: Array<SegmentSettle | null>;
  plan: WirePlan;
}

const plans = new WeakMap<Route, Map<string, PlanMemo>>();
const shapes = new WeakMap<Route, { runs: PlanRun[]; loops: PlanLoop[] }>();

/**
 * The wire's runs, loops and the settled shape of each run. `how`: 'queue'
 * (the browser: cached shapes, the rest worked out later), 'solve' (work out
 * what is missing now) or 'none' (no settled shapes: the drape).
 */
export function wirePlan(design: Design, library: Library | null, route: Route, rod: RodCable, how: 'queue' | 'solve' | 'none' = 'queue'): WirePlan {
  let rl = shapes.get(route);
  if (!rl) {
    rl = runsOf(route);
    shapes.set(route, rl);
  }
  const { runs, loops } = rl;
  const jobs = how === 'none' ? runs.map(() => null) : runs.map((run, k) => runJob(design, library, route, run, k, runs.length, rod));
  const settles = runs.map((run, k): SegmentSettle | null => {
    if (run.holds.length < 2) {
      const c = segmentCentreLine(run.drape, rod.radius_mm)[0]!;
      return { ok: true, line: pointLine(c, run.drape.normals?.[0]) };
    }
    const job = jobs[k];
    return job ? request(job, how === 'solve') : null;
  });
  // The same shapes give the same plan object (the slack model remembers its analysis per route object).
  const memoKey = JSON.stringify([rod, how === 'none']);
  let byRod = plans.get(route);
  if (!byRod) {
    byRod = new Map();
    plans.set(route, byRod);
  }
  // A lone hold's point is made afresh each call: it is the same while its key (the hold) is, so it is compared by key.
  const keys = jobs.map((j, k) => j?.key ?? (runs[k]!.holds.length < 2 ? `lone:${JSON.stringify(runs[k]!.drape)}` : null));
  const hit = byRod.get(memoKey);
  if (
    hit &&
    hit.keys.length === keys.length &&
    hit.keys.every((x, i) => x === keys[i]) &&
    hit.settles.every((x, i) => runs[i]!.holds.length < 2 || x === settles[i])
  )
    return hit.plan;
  const derived: Route = { ...route, segments: runs.map((run, k) => derivedSegment(run, settles[k] ?? null, rod)) };
  const plan: WirePlan = { route, rod, runs, loops, settles, derived };
  byRod.set(memoKey, { keys, settles, plan });
  return plan;
}

/** Run k's settled shape (k counts runs: `holdRuns`). For tests and callers that look at one run. */
export function segmentSettle(design: Design, library: Library | null, route: Route, k: number, rod: RodCable, solve = false): SegmentSettle | null {
  return wirePlan(design, library, route, rod, solve ? 'solve' : 'queue').settles[k] ?? null;
}

// ---------------------------------------------------------------- loops

/** Where loop k ends at a pose, read off the derived route (the settled runs either side). */
export function loopEnds(design: Design, plan: WirePlan, k: number, values: Readonly<Record<string, number>>): CrossingEnds {
  return crossingEnds(design, plan.derived, plan.rod.radius_mm, k, values);
}

/** The loop's starting path at a pose: its ends and the draped points between, each moved with its own link. Null when there are none between. */
export function loopStart(design: Design, plan: WirePlan, k: number, ends: SpanEnds, values: Readonly<Record<string, number>>): Vec3[] | null {
  const between = plan.loops[k]?.between ?? [];
  if (between.length === 0) return null;
  const poses = computeLinkPoses(design.scene, values);
  const r = plan.rod.radius_mm;
  const mid = between.map((pt): Vec3 => {
    const v = new Vector3(pt.p[0] + pt.n[0] * r, pt.p[1] + pt.n[1] * r, pt.p[2] + pt.n[2] * r).applyMatrix4(poses.get(pt.link) ?? new Matrix4());
    return [v.x, v.y, v.z];
  });
  return [ends.a, ...mid, ends.b];
}

const round4 = (x: number) => Math.round(x * 1e4) / 1e4;

/**
 * The free cable between two holds at a pose: cut mode with its fixed length,
 * from `start`, both ends held along their directions when they have one,
 * gravity when the sag length is known, contact with every mesh and part that
 * can come within its reach at that pose (a rope of length L between a and b
 * stays within L / 2 of their midpoint). World frame. Null while it is being
 * worked out (the browser; `solve` works it out now).
 */
export function crossingSettle(
  design: Design,
  library: Library | null,
  ends: SpanEnds,
  start: readonly Vec3[],
  length_mm: number,
  rod: RodCable,
  values: Readonly<Record<string, number>>,
  solve = false,
  exclude: ReadonlySet<string> = new Set(),
): SettledLine | null {
  const mid = new Vector3((ends.a[0] + ends.b[0]) / 2, (ends.a[1] + ends.b[1]) / 2, (ends.a[2] + ends.b[2]) / 2);
  const near = new Sphere(mid, length_mm / 2 + rod.radius_mm + 1);
  const bodies = worldBodies(design, library, values, near, exclude);
  // Keyed by everything the loop is checked against, where it is: a body that moves near it re-solves it.
  const where = (m: Matrix4) => m.elements.map(round4);
  const r6 = (v: Vec3 | undefined) => (v ? v.map(round4) : null);
  const key = JSON.stringify([
    'loop',
    r6(ends.a),
    r6(ends.b),
    r6(ends.ta),
    r6(ends.tb),
    start.map((p) => p.map((x) => Math.round(x * 100) / 100)),
    length_mm,
    rod,
    bodies.meshes.map((m) => [m.id, where(m.toFrame), registry.get(m.id)?.triCount ?? 0]),
    bodies.boxes.map((b) => [b.id, where(b.toFrame), b.half.toArray()]),
  ]);
  const pins: RodPin[] = [ends.ta ? { index: 0, tangent: ends.ta } : { index: 0 }, ends.tb ? { index: start.length - 1, tangent: ends.tb } : { index: start.length - 1 }];
  const job: Job = {
    key,
    kind: 'loop',
    fail: (reason) => ({ ok: false, reason }),
    make: () =>
      slicedSolve(
        {
          path: [...start],
          pins,
          radius_mm: rod.radius_mm,
          mode: { kind: 'cut', lengths_mm: [length_mm] },
          ...(rod.sag_length_mm !== undefined ? { gravity: { up: [0, 0, 1] as Vec3, sag_length_mm: rod.sag_length_mm } } : {}),
        },
        () => contactOf(bodies.meshes, bodies.boxes),
        LOOP_BUDGET_MS,
        undefined,
        (shape, ms, contact) => {
          const line = lineOf(shape, carryNormals(shape.points, shape.touching, contact, rod.radius_mm), ms);
          return shape.converged ? { ok: true, line } : { ok: false, reason: 'the loop did not settle', line };
        },
      ),
  };
  const st = request(job, solve);
  return st?.line ?? null;
}

/**
 * A piece of work that cannot be sliced (one call), done through the same
 * queue as the solves: from the cache; else now (`solve`, or in Node); else
 * queued (one per macrotask) and null meanwhile.
 */
export function requestWork<R>(key: string, kind: 'detour', compute: () => R, fail: (reason: string) => R, solve = false): R | null {
  return request<R>({ key, kind, make: () => ({ step: () => compute() }), fail }, solve);
}

// ---------------------------------------------------------------- the queue

const cache = new Map<string, unknown>();
const CACHE_LIMIT = 3000;
interface QueueItem {
  job: Job<unknown>;
  stepper: Stepper<unknown> | null;
  /** Time spent on it so far (ms). */
  spent: number;
  slices: number;
  max: number;
  /** When it was last asked for: the most recently asked work goes first, and work nobody has asked for lately is dropped. */
  asked: number;
}
const queue: QueueItem[] = [];
/** Work not asked for again within this long (ms) is dropped before it starts (a pose passed, a wire deleted, a design closed). */
const STALE_MS = 3000;
const queued = new Set<string>();
const listeners = new Set<() => void>();
const idle: Array<() => void> = [];
let pumping = false;
let mode: 'sync' | 'async' = typeof window === 'undefined' ? 'sync' : 'async';

/** What the slices cost (the browser): the longest one, and the last jobs finished. */
export const settleStats = {
  maxSliceMs: 0,
  slices: 0,
  done: [] as Array<{ kind: JobKind; ms: number; slices: number; maxSliceMs: number; ok: boolean }>,
  reset(): void {
    this.maxSliceMs = 0;
    this.slices = 0;
    this.done = [];
  },
};

/** Tests and the comparison table: solve at once instead of later. */
export function setSettleMode(m: 'sync' | 'async'): void {
  mode = m;
}

export function settleMode(): 'sync' | 'async' {
  return mode;
}

/** Be told when settled shapes arrive (to redraw and re-check). Returns an unsubscribe. */
export function onSettled(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Resolves once nothing is waiting to be worked out. */
export function whenSettled(): Promise<void> {
  if (queue.length === 0) return Promise.resolve();
  return new Promise((r) => idle.push(r));
}

/** Shapes still waiting to be worked out. */
export function settlePending(): number {
  return queue.length;
}

function remember<R>(key: string, v: R): R {
  cache.delete(key);
  cache.set(key, v);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  return v;
}

function request<R>(job: Job<R>, solve: boolean): R | null {
  if (cache.has(job.key)) return cache.get(job.key) as R;
  if (solve || mode === 'sync') {
    let r: R;
    try {
      r = runToEnd(job.make());
    } catch (e) {
      r = job.fail(failText(e));
    }
    return remember(job.key, r);
  }
  const now = performance.now();
  if (!queued.has(job.key)) {
    queued.add(job.key);
    queue.push({ job: job as Job<unknown>, stepper: null, spent: 0, slices: 0, max: 0, asked: now });
    pump();
  } else {
    const item = queue.find((x) => x.job.key === job.key);
    if (item) item.asked = now;
  }
  return null;
}

function notify(): void {
  for (const cb of listeners) cb();
  for (const r of idle.splice(0)) r();
}

let lastNotify = 0;

function pump(): void {
  if (pumping) return;
  pumping = true;
  const step = () => {
    const now = performance.now();
    // Work nobody has asked for lately (a pose passed, a wire deleted) is dropped before it starts.
    for (let i = queue.length - 1; i >= 0; i--) {
      const q = queue[i]!;
      if ((!q.stepper && now - q.asked > STALE_MS) || cache.has(q.job.key)) {
        queue.splice(i, 1);
        queued.delete(q.job.key);
      }
    }
    // Work whose key no longer matches what it would read (a BVH arrived since) is dropped before it starts.
    for (let i = queue.length - 1; i >= 0; i--) {
      const q = queue[i]!;
      if (!q.stepper && q.job.stillValid && !q.job.stillValid()) {
        queue.splice(i, 1);
        queued.delete(q.job.key);
      }
    }
    // Work already started goes on; otherwise the most recently asked for (the pose shown) goes first.
    let at = queue.findIndex((q) => q.stepper);
    if (at < 0) at = queue.reduce((b, q, i) => (q.asked > queue[b]!.asked ? i : b), 0);
    const item = queue[at];
    if (!item) {
      pumping = false;
      notify();
      return;
    }
    {
      // One slice per macrotask, so the view keeps drawing in between.
      const t = performance.now();
      let r: unknown;
      try {
        item.stepper ??= item.job.make();
        r = item.stepper.step(SLICE_MS);
      } catch (e) {
        // A job that throws is kept as failed (its shape approximate, with the reason); the queue goes on.
        r = item.job.fail(failText(e));
      }
      const ms = performance.now() - t;
      item.spent += ms;
      item.slices++;
      item.max = Math.max(item.max, ms);
      settleStats.slices++;
      settleStats.maxSliceMs = Math.max(settleStats.maxSliceMs, ms);
      if (r) {
        queue.splice(queue.indexOf(item), 1);
        queued.delete(item.job.key);
        remember(item.job.key, r);
        settleStats.done.push({ kind: item.job.kind, ms: item.spent, slices: item.slices, maxSliceMs: item.max, ok: (r as { ok?: boolean }).ok !== false });
        if (settleStats.done.length > 200) settleStats.done.shift();
      }
    }
    if (queue.length === 0) {
      pumping = false;
      lastNotify = performance.now();
      notify();
      return;
    }
    // A long queue: show what has arrived every so often.
    if (performance.now() - lastNotify > 600) {
      lastNotify = performance.now();
      for (const cb of listeners) cb();
    }
    setTimeout(step, 0);
  };
  setTimeout(step, 0);
}

/** Forget every settled shape (tests). */
export function clearSettled(): void {
  cache.clear();
  queue.length = 0;
  queued.clear();
}

