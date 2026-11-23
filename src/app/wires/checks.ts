/**
 * Wire checks at true size: the centre line at a pose, the fit against the
 * model, placed parts and other wires, bends, and lengths. No DOM; uses the
 * registry's geometry and BVHs, so it runs in Node too.
 *
 * Fit. The cable's real cross-section is tested: a round cable is a tube of
 * radius r around its centre line; a flat cable is its width by its height,
 * lying flat on the surface (its width across the route, in the surface
 * plane given by the route's normals), tested as a row of tubes of radius
 * h/2 spaced at most h/2 apart across the width (at most 25 across;
 * the two edges always). The centre line on links is
 * sampled and, for every probe, every model triangle within r + margin is
 * measured. The surface a lifted point sits on is expected at exactly r: a
 * triangle that lies the way the point's surface normal says it should
 * (within 50 degrees) and is not closer than r - tol is that seat and is not
 * counted. Any triangle closer than r - tol is a collision. A probe whose
 * centre is INSIDE a mesh (see solid.ts: ray parity, a majority of five rays
 * where the mesh is not watertight) always fails, by its true depth:
 * distance to the surface plus r. The tightest clearance reported is to
 * anything that is not the seat. tol = max(0.05 mm, 3% of r).
 *
 * Crossings between links (the free cable over a joint) are checked
 * separately, in crossings.ts: reach, bend, and where the loop would press
 * into the model.
 */
import { Matrix4, Triangle, Vector3, type Box3, type BufferGeometry } from 'three';
import type { MeshBVH } from 'three-mesh-bvh';
import {
  inPlaneTurns,
  computeLinkPoses,
  cornerRadii,
  findPart,
  meshPoseMatrix,
  poseToMatrix,
  relaxSpan,
  segmentCentreLine,
  type CrossingEnds,
  type CrossingSlack,
  type CableEnvelope,
  type Design,
  type Library,
  type Route,
  type RouteSlack,
  type Vec3,
} from '@core';
import { registry } from '../scene/registry';
import { roundedLine, type LinePoint } from './geometry';
import { slackOf } from './slackCache';
import { bodiesKey, detourBetween } from './detour';
import { pointsOfRoute } from './routeEdit';
import { insideMesh } from './solid';
import { crossingSettle, loopEnds, loopStart, rodOfEnvelope, wirePlan, type RodCable, type SegmentSettle, type SettledLine, type WirePlan } from './settle';

export interface WireShape {
  /** One drawn line per segment, world at the pose: the settled stiff-wire shape, or the drape (corners rounded) until it is known. */
  segments: Array<{ link: string; line: LinePoint[]; settled?: boolean }>;
  /**
   * One per loop: the free cable's shape at this pose (settled at the loop's one free
   * length), from the end of one segment's centre line to the start of the next. `normals` turn
   * smoothly from the surface normal at one end to the other's (a ribbon's flat side follows them).
   * `reaches` false: too short at this pose, drawn straight.
   */
  crossings: Array<{ points: Vector3[]; normals: Vector3[]; reaches: boolean; short_by_mm: number; chord_mm: number; length_mm: number; joints: string[]; pending: boolean }>;
}

/** How the shape is arrived at. */
export interface ShapeOptions {
  /** The cable as a rod (radius, lay length, sag). Default: from the envelope, no sag. */
  rod?: RodCable;
  /** Parts placed on the model are surfaces too. */
  library?: Library | null;
  /** The wire's runs and loops with the runs' settled shapes, worked out already (see `wirePlan`). Absent: from the cache, or the drape. */
  plan?: WirePlan;
  /** Work out the loops now instead of later (the comparison table, tests). */
  solve?: boolean;
}

/** A run's or segment's line in its link's frame: the settled shape when it settled, else the drape with its corners rounded. */
export function segmentLine(seg: Route['segments'][number], env: CableEnvelope, settle: SegmentSettle | null | undefined): LinePoint[] {
  if (settle?.ok) return settle.line.points.map((p, i) => ({ p: new Vector3(...p), n: new Vector3(...(settle.line.normals[i] ?? [0, 0, 0])) }));
  const centre = segmentCentreLine(seg, env.height_mm / 2);
  return roundedLine(
    centre.map((p, i) => {
      const n = seg.normals?.[i] ?? [0, 0, 0];
      return { p: new Vector3(...p), n: new Vector3(...n).multiplyScalar(Math.hypot(...n) > 0 ? 1 : 0) };
    }),
    env.bend_static_mm,
  );
}

/** What the way round the model told the slack model for one loop: poses where it could not be worked out, and how many are still being worked out. */
export interface DetourNotes {
  failed: Array<{ values: Record<string, number>; why: string }>;
  pending: number;
}

const detourNotes = new WeakMap<CrossingSlack, DetourNotes>();

/** The detour notes of a loop of `planSlack`'s result (none when it was worked out without). */
export function detourNotesOf(c: CrossingSlack): DetourNotes | undefined {
  return detourNotes.get(c);
}

/**
 * The slack model of the plan's derived route, with each loop's way round the
 * model at every sampled pose (`detour_mm`: the drape between its two holds at
 * that pose, detour.ts). Figures still being worked out count as clear for
 * now (`DetourNotes.pending`; the result is worked out again once they arrive).
 */
export function planSlack(design: Design, plan: WirePlan, env: CableEnvelope, solve = false): RouteSlack {
  const pts = pointsOfRoute(plan.route);
  const notes = new Map<number, DetourNotes>();
  let pending = false;
  const note = (k: number) => {
    let n = notes.get(k);
    if (!n) {
      n = { failed: [], pending: 0 };
      notes.set(k, n);
    }
    return n;
  };
  const slack = slackOf(design, plan.derived, env, {
    detour_mm: (k, values) => {
      const a = pts[plan.runs[k]?.holds.at(-1) ?? -1];
      const b = pts[plan.runs[k + 1]?.holds[0] ?? -1];
      if (!a || !b) return undefined;
      const d = detourBetween(design, a, b, plan.rod.radius_mm, values, solve);
      if (!d) {
        pending = true;
        note(k).pending++;
        return undefined;
      }
      if (d.kind === 'failed') {
        note(k).failed.push({ values: { ...values }, why: d.why });
        return undefined;
      }
      return d.kind === 'round' ? d.length_mm : undefined;
    },
    pending: () => pending,
    key: bodiesKey(design),
  });
  for (const c of slack.crossings) {
    const n = notes.get(c.after_segment);
    if (n && !detourNotes.has(c)) detourNotes.set(c, n);
  }
  return slack;
}

/** The plan to use: the one given, else from the cache (worked out later in the browser). */
export function planOf(design: Design, route: Route, env: CableEnvelope, opts: ShapeOptions = {}): WirePlan {
  return opts.plan ?? wirePlan(design, opts.library ?? null, route, opts.rod ?? rodOfEnvelope(env), opts.solve ? 'solve' : 'queue');
}

export interface LoopShape {
  ends: CrossingEnds;
  /** The quick loop (`relaxSpan`): reach, and the shape drawn when the ends cannot be joined. */
  span: ReturnType<typeof relaxSpan>;
  /** Where the settled loop starts: the draped points between the holds at this pose, or the quick loop. */
  start: Vec3[];
  /** The settled loop; null while it is being worked out or when the length does not reach. */
  settled: SettledLine | null;
  /** Still being worked out (it, or a run either side of it). */
  pending: boolean;
}

/**
 * Loop `after` (between run `after` and the next) at a pose: the settled
 * stiff wire (cut length, gravity, contact), from the draped points between
 * its holds. Worked out only once both runs either side have settled (their
 * end directions hold it).
 */
export function crossingLoop(design: Design, plan: WirePlan, library: Library | null, after: number, free: number, values: Readonly<Record<string, number>>, solve = false): LoopShape {
  const ends = loopEnds(design, plan, after, values);
  const span = relaxSpan(ends, free);
  // Start from the way round the model at this pose when something is in the way (it is outside the model), else
  // from the draped points between the holds moved with their links, else from the quick loop.
  const pts = pointsOfRoute(plan.route);
  const ha = pts[plan.runs[after]?.holds.at(-1) ?? -1];
  const hb = pts[plan.runs[after + 1]?.holds[0] ?? -1];
  const way = ha && hb ? detourBetween(design, ha, hb, plan.rod.radius_mm, values, solve) : null;
  const round = way?.kind === 'round' ? [ends.a, ...way.path.slice(1, -1), ends.b] : null;
  const start = round ?? loopStart(design, plan, after, ends, values) ?? span.points;
  if (!span.reaches) return { ends, span, start: span.points, settled: null, pending: false };
  if (!plan.settles[after] || !plan.settles[after + 1]) return { ends, span, start, settled: null, pending: true };
  const exclude = new Set([plan.route.from?.component, plan.route.to?.component].filter((x): x is string => !!x));
  const settled = crossingSettle(design, library, ends, start, free, plan.rod, values, solve, exclude);
  return { ends, span, start, settled, pending: settled === null };
}

/** The wire as drawn at a pose. `slack` is the slack model of the plan's derived route (`slackOf(design, plan.derived, env)`): each loop's free length. */
export function wireShape(design: Design, route: Route, env: CableEnvelope, values: Readonly<Record<string, number>>, slack: RouteSlack, opts: ShapeOptions = {}): WireShape {
  const poses = computeLinkPoses(design.scene, values);
  const library = opts.library ?? null;
  const plan = planOf(design, route, env, opts);
  const segments = plan.runs.map((run, k) => {
    const m = poses.get(run.link) ?? new Matrix4();
    const line = segmentLine(run.drape, env, plan.settles[k]).map((x) => ({ p: x.p.clone().applyMatrix4(m), n: x.n.clone().transformDirection(m).multiplyScalar(x.n.lengthSq() > 0 ? 1 : 0) }));
    return { link: run.link, line, settled: !!plan.settles[k]?.ok };
  });
  const crossings = slack.crossings.map((c) => {
    const { ends, span, start, settled, pending } = crossingLoop(design, plan, library, c.after_segment, c.free_length_mm, values, opts.solve ?? false);
    // A loop that did not settle cleanly (still pressing in, or unconverged) is drawn as solved so far; the check says so.
    // Until it is worked out, the path it starts from.
    const points = (settled ? settled.points : span.reaches ? start : span.points).map((p) => new Vector3(...p));
    const na = ends.na ? new Vector3(...ends.na) : new Vector3();
    const nb = ends.nb ? new Vector3(...ends.nb) : new Vector3();
    const normals = points.map((_, k) => {
      const n = na.clone().lerp(nb, k / Math.max(1, points.length - 1));
      return n.lengthSq() > 1e-6 ? n.normalize() : na.lengthSq() > 0.5 ? na.clone() : nb.clone();
    });
    const chord = points[0]!.distanceTo(points.at(-1)!);
    return { points, normals, reaches: span.reaches, short_by_mm: span.short_by_mm, chord_mm: chord, length_mm: c.free_length_mm, joints: c.joints, pending };
  });
  return { segments, crossings };
}

// ---------------------------------------------------------------- fit

export interface FitStretch {
  /** Along the drawn wire from its start, mm. */
  from_mm: number;
  to_mm: number;
  clearance_mm: number;
  point: Vec3;
  /** What it hits: a mesh id, a component id or a wire id. */
  what: string;
}

export interface FitResult {
  fits: boolean;
  /** Tightest clearance to anything that is not the surface the wire sits on (mm); `margin` when nothing is that near. */
  tightest_mm: number;
  tightestAt: Vec3 | null;
  tightestWhat: string;
  /** Stretches that do not fit. */
  failing: FitStretch[];
  tolerance_mm: number;
  margin_mm: number;
  probes: number;
  /** Meshes near the wire that are not watertight there: inside/outside was judged from the face normal. */
  uncertainMeshes: string[];
}

export interface OtherWire {
  id: string;
  points: Vector3[];
  radius: number;
}

/**
 * Length at each end of a wire left out of the check against placed parts:
 * the wire leaves a connector there, so it is meant to touch that part. One
 * rule for the status, the range check and the comparison table.
 */
export function leadOutOf(env: CableEnvelope): number {
  return Math.max(6, 4 * env.height_mm);
}

/**
 * Another wire as tubes to keep clear of: its lines on links (its free
 * loops over joints are left out: they move with the pose), one tube for a round cable, a row of tubes of radius h/2
 * across the width for a flat one, lying in the surface plane.
 */
export function wireTubes(id: string, shape: WireShape, env: CableEnvelope): OtherWire[] {
  if (env.shape !== 'flat') return shape.segments.map((s) => ({ id, points: s.line.map((x) => x.p), radius: env.width_mm / 2 }));
  const r = env.height_mm / 2;
  const across = Math.max(0, env.width_mm / 2 - r);
  const n = Math.max(1, Math.min(25, Math.ceil((2 * across) / r) + 1));
  const out: OtherWire[] = [];
  for (const s of shape.segments) {
    const sides = s.line.map((x, k) => {
      const a = s.line[Math.max(0, k - 1)]!.p;
      const b = s.line[Math.min(s.line.length - 1, k + 1)]!.p;
      const t = b.clone().sub(a).normalize();
      const up = x.n.lengthSq() > 0.5 ? x.n : Math.abs(t.z) < 0.9 ? new Vector3(0, 0, 1) : new Vector3(1, 0, 0);
      return new Vector3().crossVectors(t, up).normalize();
    });
    for (let q = 0; q < n; q++) {
      const o = n === 1 ? 0 : -across + (2 * across * q) / (n - 1);
      out.push({ id, points: s.line.map((x, k) => x.p.clone().addScaledVector(sides[k]!, o)), radius: r });
    }
  }
  return out;
}

interface Probe {
  p: Vector3;
  seat: Vector3;
  r: number;
  s: number;
  nearEnd: boolean;
}

function probesOf(shape: WireShape, env: CableEnvelope, leadOut: number): Probe[] {
  const flat = env.shape === 'flat';
  const r = flat ? env.height_mm / 2 : env.width_mm / 2;
  // Along: half the smaller size, but at least a quarter of the larger (a wide ribbon need not be probed every 0.5 mm).
  const step = Math.max(0.2, Math.min(2, Math.max(Math.min(env.width_mm, env.height_mm) / 2, Math.max(env.width_mm, env.height_mm) / 4)));
  const across = flat ? Math.max(0, env.width_mm / 2 - r) : 0;
  // Across: at most h/2 apart up to 25 probes; wider ribbons get 25 (the edges are always probed).
  const nAcross = flat ? Math.max(1, Math.min(25, Math.ceil((2 * across) / r) + 1)) : 1;
  const out: Probe[] = [];
  let s = 0;
  const pieces: Array<{ pts: LinePoint[]; skip?: number; nodes?: boolean }> = [];
  // Crossings are checked on their own (crossings.ts); their length still counts in the distance along the wire.
  shape.segments.forEach((seg, i) => {
    pieces.push({ pts: seg.line, ...(seg.settled ? { nodes: true } : {}) });
    const c = shape.crossings[i];
    if (c) pieces.push({ pts: [], skip: c.length_mm });
  });
  const total = pieces.reduce((t, pc) => t + (pc.skip ?? 0) + pc.pts.reduce((u, x, k) => (k ? u + x.p.distanceTo(pc.pts[k - 1]!.p) : u), 0), 0);
  for (const pc of pieces) {
    s += pc.skip ?? 0;
    for (let k = 1; k < pc.pts.length; k++) {
      const a = pc.pts[k - 1]!;
      const b = pc.pts[k]!;
      const len = a.p.distanceTo(b.p);
      // A settled line is probed at its nodes, where the solver held it clear: between two nodes the straight
      // piece is the solver's discretisation (it can cut a sharp edge or a facet's corner by its sagitta,
      // up to a few tenths of a millimetre at 2 to 3 mm spacing), not where the wire is.
      const n = pc.nodes ? 1 : Math.max(1, Math.ceil(len / step));
      const t = b.p.clone().sub(a.p).normalize();
      for (let j = k === 1 ? 0 : 1; j <= n; j++) {
        const f = j / n;
        const p = a.p.clone().lerp(b.p, f);
        const seat = a.n.lengthSq() > 0.5 && b.n.lengthSq() > 0.5 ? a.n.clone().lerp(b.n, f).normalize() : a.n.lengthSq() > 0.5 ? a.n.clone() : b.n.clone();
        const here = s + f * len;
        const nearEnd = here < leadOut || here > total - leadOut;
        if (nAcross === 1) out.push({ p, seat, r, s: here, nearEnd });
        else {
          const side = seat.lengthSq() > 0.5 ? new Vector3().crossVectors(t, seat).normalize() : new Vector3().crossVectors(t, Math.abs(t.z) < 0.9 ? new Vector3(0, 0, 1) : new Vector3(1, 0, 0)).normalize();
          for (let q = 0; q < nAcross; q++) {
            const o = nAcross === 1 ? 0 : -across + (2 * across * q) / (nAcross - 1);
            out.push({ p: p.clone().addScaledVector(side, o), seat, r, s: here, nearEnd });
          }
        }
      }
      s += len;
    }
  }
  return out;
}

export interface MeshTarget {
  id: string;
  geometry: BufferGeometry;
  bvh: MeshBVH;
  inv: Matrix4;
  world: Matrix4;
  centre: Vector3;
  radius: number;
}

export function meshTargets(design: Design, values: Readonly<Record<string, number>>): MeshTarget[] {
  const poses = computeLinkPoses(design.scene, values);
  const out: MeshTarget[] = [];
  for (const link of design.scene.links) {
    const lw = poses.get(link.id);
    if (!lw) continue;
    for (const ref of link.meshes) {
      const e = registry.get(ref.id);
      const bvh = e?.geometry.boundsTree as unknown as MeshBVH | undefined;
      if (!e || !bvh) continue;
      const world = lw.clone().multiply(meshPoseMatrix(ref));
      if (!e.geometry.boundingSphere) e.geometry.computeBoundingSphere();
      const bs = e.geometry.boundingSphere!.clone().applyMatrix4(world);
      out.push({ id: ref.id, geometry: e.geometry, bvh, inv: world.clone().invert(), world, centre: bs.center, radius: bs.radius });
    }
  }
  return out;
}

interface PartBox {
  id: string;
  inv: Matrix4;
  half: Vector3;
  centre: Vector3;
}

function partBoxes(design: Design, library: Library | null, values: Readonly<Record<string, number>>): PartBox[] {
  if (!library) return [];
  const poses = computeLinkPoses(design.scene, values);
  const out: PartBox[] = [];
  for (const c of design.components) {
    const part = findPart(library, c.part);
    const lw = poses.get(c.link);
    if (!part || !lw) continue;
    const [sx, sy, sz] = part.body.size_mm;
    // Body box centre in the part frame is (0, 0, sz/2).
    const world = lw.clone().multiply(poseToMatrix(c.pose)).multiply(new Matrix4().makeTranslation(0, 0, sz / 2));
    out.push({ id: c.id, inv: world.clone().invert(), half: new Vector3(sx / 2, sy / 2, sz / 2), centre: new Vector3().setFromMatrixPosition(world) });
  }
  return out;
}

/** Signed distance from a point to a box (negative inside), in the box's local frame. */
function boxDistance(local: Vector3, half: Vector3): number {
  const dx = Math.abs(local.x) - half.x;
  const dy = Math.abs(local.y) - half.y;
  const dz = Math.abs(local.z) - half.z;
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0), Math.max(dz, 0));
  const inside = Math.min(Math.max(dx, dy, dz), 0);
  return outside + inside;
}

function pointSegmentDistance(p: Vector3, a: Vector3, b: Vector3): number {
  const ab = b.clone().sub(a);
  const l2 = ab.lengthSq();
  const t = l2 > 0 ? Math.max(0, Math.min(1, p.clone().sub(a).dot(ab) / l2)) : 0;
  return p.distanceTo(a.clone().addScaledVector(ab, t));
}

const SEAT_COS = Math.cos((50 * Math.PI) / 180);

/**
 * Does the wire fit at this pose? See the header for the rule. `others` are
 * other wires (centre lines and radii) to keep clear of.
 */
export function fitCheck(
  design: Design,
  shape: WireShape,
  env: CableEnvelope,
  values: Readonly<Record<string, number>>,
  opts: { library?: Library | null; others?: readonly OtherWire[]; leadOut_mm?: number } = {},
): FitResult {
  const rMax = (env.shape === 'flat' ? env.height_mm : env.width_mm) / 2;
  const tol = Math.max(0.05, 0.03 * rMax);
  const margin = Math.max(2, rMax);
  const probes = probesOf(shape, env, opts.leadOut_mm ?? 0);
  const meshes = meshTargets(design, values);
  const parts = partBoxes(design, opts.library ?? null, values);
  const others = opts.others ?? [];
  const tri = new Triangle();
  const closest = new Vector3();
  const triNormal = new Vector3();
  const local = new Vector3();
  let tightest = margin;
  let tightestAt: Vec3 | null = null;
  let tightestWhat = '';
  const failingProbe: Array<{ s: number; c: number; p: Vector3; what: string }> = [];
  const uncertain = new Set<string>();

  for (const pr of probes) {
    const reach = pr.r + margin;
    let worst = Infinity;
    let worstWhat = '';
    let worstFree = Infinity;
    let worstFreeWhat = '';
    for (const m of meshes) {
      if (pr.p.distanceTo(m.centre) > m.radius + reach) continue;
      local.copy(pr.p).applyMatrix4(m.inv);
      let nearD = Infinity;
      let nearFace = -1;
      m.bvh.shapecast({
        // Nearest boxes first; a box farther than the best non-seat clearance found so far cannot change
        // the verdict or the tightest clearance (a seat never has c < -tol), so it is skipped.
        boundsTraverseOrder: (box: Box3) => box.distanceToPoint(local),
        intersectsBounds: (_box: Box3, _isLeaf: boolean, score: number | undefined) => (score ?? 0) <= Math.min(reach, pr.r + Math.max(worstFree, -tol) + 1e-9),
        intersectsTriangle: (t: Triangle, triIndex: number) => {
          tri.copy(t);
          tri.closestPointToPoint(local, closest);
          const d = closest.distanceTo(local);
          if (d < nearD) {
            nearD = d;
            nearFace = triIndex;
          }
          if (d > reach) return false;
          const c = d - pr.r;
          if (c < worst) {
            worst = c;
            worstWhat = m.id;
          }
          // Seat: not closer than r - tol, and either lies along -normal, or is a face parallel to the
          // surface, below the probe, whose plane is r away (a neighbouring triangle of the same face).
          let isSeat = false;
          if (pr.seat.lengthSq() > 0.5 && c >= -tol) {
            const dirWorld = closest.clone().applyMatrix4(m.world).sub(pr.p);
            const len = dirWorld.length();
            if (len > 0 && dirWorld.dot(pr.seat) / len < -SEAT_COS) isSeat = true;
            else if (len > 0 && dirWorld.dot(pr.seat) < 0) {
              tri.getNormal(triNormal);
              const planeDist = Math.abs(local.clone().sub(tri.a).dot(triNormal));
              if (Math.abs(triNormal.transformDirection(m.world).dot(pr.seat)) > SEAT_COS && planeDist >= pr.r - tol) isSeat = true;
            }
          }
          if (!isSeat && c < worstFree) {
            worstFree = c;
            worstFreeWhat = m.id;
          }
          return false;
        },
      });
      // Inside the solid: always a collision, by the true depth (distance to the surface + r).
      const ins = insideMesh(m.bvh, m.geometry, local);
      if (!ins.certain) uncertain.add(m.id);
      if (ins.inside) {
        const depth = nearFace >= 0 ? nearD : (m.bvh.closestPointToPoint(local)?.distance ?? 0);
        const c = -(depth + pr.r);
        if (c < worst) {
          worst = c;
          worstWhat = m.id;
        }
        if (c < worstFree) {
          worstFree = c;
          worstFreeWhat = m.id;
        }
      }
    }
    if (!pr.nearEnd) {
      for (const b of parts) {
        if (pr.p.distanceTo(b.centre) > b.half.length() + reach) continue;
        const c = boxDistance(pr.p.clone().applyMatrix4(b.inv), b.half) - pr.r;
        if (c < worst) {
          worst = c;
          worstWhat = b.id;
        }
        if (c < worstFree) {
          worstFree = c;
          worstFreeWhat = b.id;
        }
      }
    }
    for (const o of others) {
      for (let k = 1; k < o.points.length; k++) {
        const c = pointSegmentDistance(pr.p, o.points[k - 1]!, o.points[k]!) - pr.r - o.radius;
        if (c < worstFree) {
          worstFree = c;
          worstFreeWhat = o.id;
        }
        if (c < worst) {
          worst = c;
          worstWhat = o.id;
        }
      }
    }
    if (worstFree < tightest) {
      tightest = worstFree;
      tightestAt = [pr.p.x, pr.p.y, pr.p.z];
      tightestWhat = worstFreeWhat;
    }
    if (worst < -tol) failingProbe.push({ s: pr.s, c: worst, p: pr.p, what: worstWhat });
  }

  // Merge failing probes into stretches along the wire.
  failingProbe.sort((a, b) => a.s - b.s);
  const failing: FitStretch[] = [];
  const gap = Math.max(1, rMax * 2);
  for (const f of failingProbe) {
    const last = failing[failing.length - 1];
    if (last && f.s - last.to_mm <= gap) {
      last.to_mm = f.s;
      if (f.c < last.clearance_mm) {
        last.clearance_mm = f.c;
        last.point = [f.p.x, f.p.y, f.p.z];
        last.what = f.what;
      }
    } else failing.push({ from_mm: f.s, to_mm: f.s, clearance_mm: f.c, point: [f.p.x, f.p.y, f.p.z], what: f.what });
  }
  // A collision is tighter than any free clearance: report it as the tightest.
  const worstFail = failing.reduce<FitStretch | null>((w, f) => (!w || f.clearance_mm < w.clearance_mm ? f : w), null);
  if (worstFail && worstFail.clearance_mm < tightest) {
    tightest = worstFail.clearance_mm;
    tightestAt = worstFail.point;
    tightestWhat = worstFail.what;
  }
  return { fits: failing.length === 0, tightest_mm: tightest, tightestAt, tightestWhat, failing, tolerance_mm: tol, margin_mm: margin, probes: probes.length, uncertainMeshes: [...uncertain] };
}

// ---------------------------------------------------------------- bends and lengths

/**
 * How a broken bend limit is judged. A limit from a datasheet, a measurement
 * or the user is the cable's own figure: breaking it FAILS. A `derived` or
 * `generic` limit is a rule applied to the cable's size (for example 8 x the
 * outer diameter), not the maker's figure: breaking it only WARNS.
 */
export type BendGrade = 'ok' | 'warn' | 'fail';

export function bendIsFirm(source: CableEnvelope['bend_source']): boolean {
  return source === 'datasheet' || source === 'measured' || source === 'user';
}

export function bendGrade(passes: boolean, source: CableEnvelope['bend_source']): BendGrade {
  return passes ? 'ok' : bendIsFirm(source) ? 'fail' : 'warn';
}

/** Plain words for where a bend limit comes from. */
export function bendSourceText(source: CableEnvelope['bend_source']): string {
  switch (source) {
    case 'datasheet':
      return "maker's datasheet";
    case 'measured':
      return 'measured';
    case 'user':
      return 'set by you';
    case 'derived':
      return "rule of thumb from the cable's size, not the maker's figure";
    default:
      return "generic rule from the cable's size, not the maker's figure";
  }
}

export interface BendReport {
  /** Smallest corner radius on links (mm), Infinity when straight. */
  tightest_mm: number;
  limit_mm: number;
  passes: boolean;
  /** Where the limit comes from, and the verdict over the corners on links (crossings are graded in crossings.ts). */
  source: CableEnvelope['bend_source'];
  grade: BendGrade;
  /** Corners tighter than the static radius, worst first, with where they are (`point` in the frame of `link`; `segment`: the run). */
  tight: Array<{ radius_mm: number; segment: number; link: string; point: Vec3 }>;
  /**
   * Flat cables only: corners where the route turns sideways within the
   * surface. The cable has to be folded there, or the route changed.
   * `segment`: the stored route's segment; `point` in the frame of `link`.
   */
  folds: Array<{ angle_deg: number; segment: number; link: string; point: Vec3 }>;
}

/** In-plane turns smaller than this are taken as drawing noise. */
export const FOLD_TOLERANCE_DEG = 10;

/**
 * A segment's centre line with contact points closer together than `minGap`
 * merged (a cable wrapping an edge touches it at several samples a hair
 * apart; judged one by one they would read as corners of radius ~0). Each
 * kept point carries its index in the segment. The ends always stay.
 */
export function mergedCentreLine(points: readonly Vec3[], minGap: number): Array<{ p: Vec3; index: number }> {
  const out: Array<{ p: Vec3; index: number }> = [];
  const dist = (x: Vec3, y: Vec3) => Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
  points.forEach((p, i) => {
    const last = out[out.length - 1];
    if (!last || dist(p, last.p) >= minGap) out.push({ p, index: i });
    else if (i === points.length - 1) {
      // The end stays: it replaces a near-coincident interior point (or joins the start, if only that is left).
      if (out.length > 1) out[out.length - 1] = { p, index: i };
      else out.push({ p, index: i });
    }
  });
  return out;
}

/**
 * Bends on links, run by run (`wirePlan`). A run whose stiff-wire shape
 * settled is judged on the solver's bend radius at each point (a run of
 * points tighter than the limit is one tight place, at its tightest point;
 * the solver's corrected minimum is the figure for the tightest). A run still
 * on its drape is judged as before, corner by corner of the draped line. A
 * lone hold has no bend of its own (the loops either side are graded in
 * crossings.ts). `plan` absent: the drape, nothing settled.
 */
export function bendReport(design: Design, route: Route, env: CableEnvelope, plan?: WirePlan | null): BendReport {
  const lift = env.height_mm / 2;
  const p = plan ?? wirePlan(design, null, route, rodOfEnvelope(env), 'none');
  // Contacts closer than the cable's own diameter are one place where it bends.
  const minGap = env.height_mm;
  let tightest = Infinity;
  const tight: BendReport['tight'] = [];
  p.runs.forEach((run, k) => {
    const st = p.settles[k];
    const link = run.link;
    if (st?.ok) {
      const { radius_mm, points } = st.line;
      tightest = Math.min(tightest, st.line.min_radius_mm);
      const own: BendReport['tight'] = [];
      let open: { radius_mm: number; point: Vec3 } | null = null;
      radius_mm.forEach((r, i) => {
        if (r < env.bend_static_mm) {
          if (!open || r < open.radius_mm) open = { radius_mm: r, point: points[i]! };
        } else if (open) {
          own.push({ ...open, segment: k, link });
          open = null;
        }
      });
      const last = open as { radius_mm: number; point: Vec3 } | null;
      if (last) own.push({ ...last, segment: k, link });
      if (st.line.min_radius_mm < env.bend_static_mm) {
        if (own.length === 0) own.push({ radius_mm: st.line.min_radius_mm, segment: k, link, point: points[0]! });
        const worst = own.reduce((w, t) => (t.radius_mm < w.radius_mm ? t : w), own[0]!);
        worst.radius_mm = Math.min(worst.radius_mm, st.line.min_radius_mm);
      }
      tight.push(...own);
      return;
    }
    const line = mergedCentreLine(segmentCentreLine(run.drape, lift), minGap);
    cornerRadii(line.map((x) => x.p)).forEach((radius, i) => {
      tightest = Math.min(tightest, radius);
      if (radius < env.bend_static_mm) tight.push({ radius_mm: radius, segment: k, link, point: line[i + 1]!.p });
    });
  });
  tight.sort((x, y) => x.radius_mm - y.radius_mm);
  const at = (segment: number, point: number) => segmentCentreLine(route.segments[segment]!, lift)[point]!;
  const folds =
    env.shape === 'flat'
      ? inPlaneTurns(route, lift, FOLD_TOLERANCE_DEG).map((t) => ({ angle_deg: t.angle_deg, segment: t.segment, link: route.segments[t.segment]!.link, point: at(t.segment, t.point) }))
      : [];
  const passes = tight.length === 0;
  return { tightest_mm: tightest, limit_mm: env.bend_static_mm, passes, source: env.bend_source, grade: bendGrade(passes, env.bend_source), tight, folds };
}

/** A bend list fit to read: the count, the tightest, and the worst few with the rest counted. */
export function bendSummary<T extends { radius_mm: number }>(tight: readonly T[], shown = 3): { count: number; tightest_mm: number; worst: T[]; more: T[] } {
  const sorted = [...tight].sort((x, y) => x.radius_mm - y.radius_mm);
  return { count: sorted.length, tightest_mm: sorted[0]?.radius_mm ?? Infinity, worst: sorted.slice(0, shown), more: sorted.slice(shown) };
}

export interface LengthReport {
  /** The joint-slack model of the route: on-link length, each crossing's free length and checks. */
  slack: RouteSlack;
  /** Route length with every crossing at its free length. */
  length_mm: number;
  /** Cut = length x length factor + 2 x allowance. */
  cut_mm: number;
  allowance_mm: number;
  length_factor: number;
  /** False when a crossing does not reach at some pose or has joints that were not swept: the length is then a lower bound. */
  complete: boolean;
}

/**
 * Lengths, from the slack model of the plan's derived route: each run its
 * settled length (the wire laid snug; the drape until settled), each loop its
 * free length. `plan` absent: the drape, nothing settled.
 */
export function lengthReport(design: Design, route: Route, env: CableEnvelope, allowancePerEnd = 10, plan?: WirePlan | null, solve = false): LengthReport {
  const p = plan ?? wirePlan(design, null, route, rodOfEnvelope(env), 'none');
  const slack = planSlack(design, p, env, solve);
  return {
    slack,
    length_mm: slack.length_mm,
    cut_mm: slack.length_mm * env.length_factor + 2 * allowancePerEnd,
    allowance_mm: allowancePerEnd,
    length_factor: env.length_factor,
    complete: slack.complete,
  };
}

/** Joints whose motion changes this wire's crossings. */
export function jointsCrossed(slack: RouteSlack): string[] {
  return [...new Set(slack.crossings.flatMap((c) => c.joints))];
}

/** Poses to sample for the range-of-motion check: every combination of `n` values per joint (up to `maxJoints` joints). */
export function rangePoses(design: Design, joints: readonly string[], n = 5, maxJoints = 6): Array<Record<string, number>> {
  const js = joints
    .map((id) => design.scene.joints.find((j) => j.id === id)!)
    .filter((j) => j && j.type !== 'fixed')
    .slice(0, maxJoints);
  const out: Array<Record<string, number>> = [];
  const values: Record<string, number> = {};
  const visit = (k: number) => {
    if (k === js.length) {
      out.push({ ...values });
      return;
    }
    const j = js[k]!;
    const [lo, hi] = j.type === 'continuous' || !j.limit ? [-Math.PI, Math.PI] : [j.limit.lower, j.limit.upper];
    for (let i = 0; i < n; i++) {
      values[j.id] = n === 1 ? (lo + hi) / 2 : lo + ((hi - lo) * i) / (n - 1);
      visit(k + 1);
    }
  };
  visit(0);
  return out;
}

// ---------------------------------------------------------------- joints that can reach the wire

export interface NearJoint {
  id: string;
  /** Closest approach of the swept bounding spheres to the wire, minus their radii (mm); <= 0 means they can touch. */
  gap_mm: number;
  crossed: boolean;
}

/**
 * Joints whose motion can bring a body near the wire: the joints it crosses,
 * and every joint where a mesh on one side, swept through the joint's motion,
 * can come within `margin` of the wire's centre line on the other side.
 * Bounding spheres of the meshes are swept about the joint axis (a torus,
 * ignoring the limits) or along it between the limits; the test is
 * conservative. Nearest first, crossed joints before the others.
 */
export function jointsNearWire(design: Design, route: Route, env: CableEnvelope, values: Readonly<Record<string, number>>, crossed: readonly string[], margin = 2): NearJoint[] {
  const scene = design.scene;
  const poses = computeLinkPoses(scene, values);
  const r = Math.max(env.width_mm, env.height_mm) / 2;
  // Wire points (world) with their link, every few mm along each segment.
  const pts: Array<{ p: Vector3; link: string }> = [];
  for (const s of route.segments) {
    const m = poses.get(s.link) ?? new Matrix4();
    const line = segmentCentreLine(s, env.height_mm / 2).map((p) => new Vector3(...p).applyMatrix4(m));
    for (let k = 0; k < line.length; k++) {
      const a = line[k]!;
      pts.push({ p: a, link: s.link });
      const b = line[k + 1];
      if (!b) continue;
      const n = Math.floor(a.distanceTo(b) / 4);
      for (let q = 1; q <= n; q++) pts.push({ p: a.clone().lerp(b, q / (n + 1)), link: s.link });
    }
  }
  // Mesh bounding spheres (world, at this pose).
  const spheres: Array<{ c: Vector3; rho: number; link: string }> = [];
  for (const link of scene.links) {
    const lw = poses.get(link.id);
    if (!lw) continue;
    for (const ref of link.meshes) {
      const e = registry.get(ref.id);
      if (!e) continue;
      if (!e.geometry.boundingSphere) e.geometry.computeBoundingSphere();
      const bs = e.geometry.boundingSphere!.clone().applyMatrix4(lw.clone().multiply(meshPoseMatrix(ref)));
      spheres.push({ c: bs.center, rho: bs.radius, link: link.id });
    }
  }
  const children = new Map<string, string[]>();
  for (const j of scene.joints) children.set(j.parent, [...(children.get(j.parent) ?? []), j.child]);
  const subtree = (root: string): Set<string> => {
    const out = new Set<string>();
    const stack = [root];
    while (stack.length) {
      const l = stack.pop()!;
      if (out.has(l)) continue;
      out.add(l);
      stack.push(...(children.get(l) ?? []));
    }
    return out;
  };
  const out: NearJoint[] = [];
  for (const j of scene.joints) {
    if (j.type === 'fixed') continue;
    const frame = (poses.get(j.parent) ?? new Matrix4()).clone().multiply(poseToMatrix(j.origin));
    const a = new Vector3().setFromMatrixPosition(frame);
    const d = new Vector3(...j.axis).transformDirection(frame);
    const moving = subtree(j.child);
    const v = values[j.id] ?? j.value;
    const [lo, hi] = j.type === 'continuous' || !j.limit ? [-Infinity, Infinity] : [j.limit.lower, j.limit.upper];
    // Distance between point q and the path point c traces as the joint moves (or vice versa: the test is symmetric).
    // Distance from q to the path c traces as the joint moves from its current value over its range.
    // `sign` -1 when it is q that moves (the wire on the moving side): relative motion is reversed.
    const sweptDistance = (q: Vector3, c: Vector3, sign: number): number => {
      const t0 = sign * (Number.isFinite(lo) ? lo - v : -1e6);
      const t1 = sign * (Number.isFinite(hi) ? hi - v : 1e6);
      if (j.type === 'prismatic') return pointSegmentDistance(q, c.clone().addScaledVector(d, t0), c.clone().addScaledVector(d, t1));
      const hc = c.clone().sub(a).dot(d);
      const pc = c.clone().sub(a).addScaledVector(d, -hc);
      const hq = q.clone().sub(a).dot(d);
      const pq = q.clone().sub(a).addScaledVector(d, -hq);
      const rc = pc.length();
      const rq = pq.length();
      const ring = Math.hypot(hq - hc, rq - rc);
      if (j.type === 'continuous' || !Number.isFinite(lo) || !Number.isFinite(hi) || rc < 1e-9 || rq < 1e-9) return ring;
      // Angle from c to q about the axis; inside the swept range the ring distance holds, else the nearer end.
      const ang = Math.atan2(new Vector3().crossVectors(pc, pq).dot(d), pc.dot(pq));
      const [from, to] = t0 <= t1 ? [t0, t1] : [t1, t0];
      for (const k of [-2 * Math.PI, 0, 2 * Math.PI]) if (ang + k >= from && ang + k <= to) return ring;
      const end = (t: number) => c.clone().sub(a).applyAxisAngle(d, t).add(a).distanceTo(q);
      return Math.min(end(from), end(to));
    };
    let gap = Infinity;
    for (const w of pts) {
      const wireMoves = moving.has(w.link);
      for (const s of spheres) {
        if (moving.has(s.link) === wireMoves) continue; // same side: no relative motion
        gap = Math.min(gap, sweptDistance(w.p, s.c, wireMoves ? -1 : 1) - s.rho - r);
      }
    }
    const isCrossed = crossed.includes(j.id);
    if (isCrossed || gap <= margin) out.push({ id: j.id, gap_mm: gap, crossed: isCrossed });
  }
  return out.sort((x, y) => Number(y.crossed) - Number(x.crossed) || x.gap_mm - y.gap_mm);
}

/** Bounded sampling for the range check: values per joint so the poses stay at or under `maxPoses`. */
export function rangePlan(joints: readonly string[], maxPoses = 100): { sampled: string[]; skipped: string[]; perJoint: number } {
  let k = joints.length;
  while (k > 0 && 2 ** k > maxPoses) k--;
  const perJoint = k === 0 ? 1 : Math.max(2, Math.min(9, Math.floor(maxPoses ** (1 / k) + 1e-9)));
  return { sampled: joints.slice(0, k), skipped: joints.slice(k), perJoint };
}
