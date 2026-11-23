/**
 * Running the wire checks for the app: debounced after design, pose or
 * geometry changes, one wire at a time with yields so a large model does not
 * freeze the UI; the range-of-motion check; and the comparison table rows.
 */
import { Vector3 } from 'three';
import { cableEnvelope, findCableType, routeCentreLineWorld, type Cable, type CableType, type Design, type Route, type Vec3 } from '@core';
import { useApp } from '../state/store';
import { jointsCrossed, jointsNearWire, rangePlan, rangePoses, wireShape, wireTubes, type BendGrade, type OtherWire } from './checks';
import { buildFor, compareRow, evaluateWire, fitsPorts, incompleteReason, totalSlack, wireNotes, type CompareRow } from './compare';
import { crossingGrade, type CrossingReport } from './crossings';
import { routeOfCable } from './routeEdit';
import { keepClearHits } from './areas';
import { attachedEnds, endChecks, type EndCheck } from './ports';
import { onSettled, whenSettled } from './settle';

export interface WireStatus {
  /** False when the cable type is not in the library (drawn as a placeholder). */
  known: boolean;
  fits?: boolean;
  tightest_mm?: number;
  tightestAt?: Vec3 | null;
  tightestWhat?: string;
  failing?: Array<{ from_mm: number; to_mm: number; clearance_mm: number; point: Vec3; what: string }>;
  tolerance_mm?: number;
  margin_mm?: number;
  /** Meshes judged by face direction because they are not watertight near the wire. */
  uncertainMeshes?: string[];
  /** True when no bend limit is broken on links (see bendGrade for how a broken one is judged). */
  bendPasses?: boolean;
  bendGrade?: BendGrade;
  bendSource?: CableType['confidence'] | 'user';
  /** The library's static radius for the bundle when the user overrides it. */
  libraryBend_mm?: number;
  tightestBend_mm?: number;
  bendLimit_mm?: number;
  tightBends?: Array<{ radius_mm: number; segment: number; link: string; point: Vec3 }>;
  /** Flat cables: sideways turns in the surface, where the cable must be folded. */
  folds?: Array<{ angle_deg: number; segment: number; link: string; point: Vec3 }>;
  onLinks_mm?: number;
  /** Joint crossings: free length, reach, bend, loop fit, ribbon twist (see crossings.ts). */
  crossings?: CrossingReport[];
  /** Worst verdict over the crossings. */
  crossingGrade?: BendGrade;
  /** Checks at the route's ends attached to ports: fit in the connector, room for the plug, detached. */
  ends?: EndCheck[];
  /** Keep-clear areas the wire lies on (warnings). */
  keepClear?: string[];
  /** False: the cut length is a lower bound; `incomplete` says why. */
  complete?: boolean;
  incomplete?: string;
  /** Slack over all crossings. */
  slack_mm?: number;
  /** Route length with every crossing at its free length. */
  length_mm?: number;
  /** The length to cut: the user's when set, else the computed requirement. */
  cut_mm?: number;
  /** The computed requirement. */
  required_mm?: number;
  /** Set when the user's cut length is shorter than the computed requirement. */
  cutTooShort?: boolean;
  length_factor?: number;
  /** Lay length assumed because none was given. */
  layAssumed_mm?: number;
  notes?: string[];
  width_mm?: number;
  height_mm?: number;
  shape?: 'round' | 'flat';
  range?: RangeResult;
  /** The stiff-wire shape of some segment is still being worked out: the drape is drawn meanwhile and nothing is graded. */
  shapePending?: boolean;
  /** Something the wire depends on changed since these figures were worked out: they are being worked out again (nothing reads as passing meanwhile). */
  stale?: boolean;
  /** Segments kept on their drape because the stiff-wire shape did not settle, one sentence each: the shape is approximate, nothing on it passes. */
  shapeApproximate?: string[];
  /** What the stiff-wire model assumed about this cable (stiffness, weight), in plain words. */
  shapeNotes?: string[];
}

export interface RangeResult {
  /** What the result was computed for; a different key means it is stale. */
  key: string;
  running: boolean;
  poses: number;
  done: number;
  sampled: string[];
  /** Joints near the wire left at the pose shown (too many to sample). */
  skipped: string[];
  perJoint: number;
  worst_mm?: number;
  worstPose?: Record<string, number>;
  worstWhat?: string;
  /** Every sampled pose fits, each judged on its settled shape. */
  fitsAll?: boolean;
  /** Poses judged on a shape that did not settle (the drape stood in): fitsAll is then false. */
  approximate?: number;
}

const pause = () => new Promise<void>((r) => setTimeout(r, 0));

/** Other wires as tubes at a pose, to keep clear of (their real cross-section; crossings are not modelled). */
export function otherWires(design: Design, exceptCable: string, values: Readonly<Record<string, number>>): OtherWire[] {
  const lib = useApp.getState().cableLibrary;
  const out: OtherWire[] = [];
  for (const c of design.cables) {
    if (c.id === exceptCable) continue;
    const route = routeOfCable(design, c.id);
    const type = lib ? findCableType(lib, c.type) : undefined;
    if (!route || !type) continue;
    const ev = evaluateWire(design, route, type, c, values, { library: useApp.getState().library, skipFit: true, skipCrossings: true });
    out.push(...wireTubes(c.id, wireShape(design, route, ev.env, values, ev.lengths.slack, { library: useApp.getState().library, plan: ev.settle.plan }), ev.env));
  }
  return out;
}

/** What a range result depends on: the wire, its route, the scene, the parts, the other wires and the libraries. */
export function rangeKey(design: Design, cableId: string): string {
  const cable = design.cables.find((c) => c.id === cableId);
  const route = routeOfCable(design, cableId);
  return JSON.stringify([cable, route, design.scene.joints, design.scene.links.map((l) => [l.id, l.meshes.map((m) => m.id)]), design.components, design.cables.length, design.routes.length]);
}

const ranges = new Map<string, RangeResult>();

export function statusOf(design: Design, cable: Cable, route: Route, type: CableType | undefined, values: Readonly<Record<string, number>>): WireStatus {
  if (!type) return { known: false };
  const s = useApp.getState();
  const ev = evaluateWire(design, route, type, cable, values, {
    library: s.library,
    others: otherWires(design, cable.id, values),
    allowance_mm: s.wireAllowance_mm,
  });
  const jointName = (id: string) => design.scene.joints.find((j) => j.id === id)?.name || id;
  const centre = routeCentreLineWorld(design, route, ev.env.height_mm / 2, values).points;
  const endPoints = centre.length ? { first: new Vector3(...centre[0]!), last: new Vector3(...centre.at(-1)!) } : null;
  const ends = endChecks(design, s.library, s.connectorLibrary, route, type, cable.count, values, endPoints);
  const keepClear = keepClearHits(design, route);
  const required = ev.lengths.cut_mm;
  const user = cable.length_mm;
  const notes = wireNotes(ev, jointName);
  const settled = s.drapeSettled[cable.id] ?? 0;
  // Only worth saying while a segment is drawn on its drape.
  if (settled > 0 && ev.settle.settles.some((x) => !x?.ok)) {
    notes.push(
      `${settled} leg${settled === 1 ? '' : 's'} could not be pulled taut as one height profile (end normals more than 60 degrees apart, or climbing more steeply than 60 degrees): draped point by point along the surface instead, so ${settled === 1 ? 'it' : 'they'} may be longer than a taut cable.`,
    );
  }
  if (user !== undefined && user < required) notes.unshift(`Your cut length ${user.toFixed(0)} mm is SHORTER than the ${required.toFixed(0)} mm this route needs.`);
  const layAssumed = cable.twisted && cable.count > 1 && cable.lay_length_mm === undefined && ev.env.lay_length_mm !== undefined ? ev.env.lay_length_mm : undefined;
  return {
    known: true,
    fits: ev.fit!.fits,
    tightest_mm: ev.fit!.tightest_mm,
    tightestAt: ev.fit!.tightestAt,
    tightestWhat: ev.fit!.tightestWhat,
    failing: ev.fit!.failing,
    tolerance_mm: ev.fit!.tolerance_mm,
    margin_mm: ev.fit!.margin_mm,
    uncertainMeshes: ev.fit!.uncertainMeshes,
    bendPasses: ev.bend.grade === 'ok',
    bendGrade: ev.bend.grade,
    bendSource: ev.bend.source,
    ...(cable.bend_override_mm !== undefined ? { libraryBend_mm: cableEnvelope(type, buildFor(cable, '')).bend_static_mm } : {}),
    tightestBend_mm: ev.bend.tightest_mm,
    bendLimit_mm: ev.bend.limit_mm,
    tightBends: ev.bend.tight,
    folds: ev.bend.folds,
    onLinks_mm: ev.lengths.slack.on_links_mm,
    crossings: ev.crossings,
    ends,
    keepClear,
    crossingGrade: crossingGrade(ev.crossings),
    complete: ev.lengths.complete,
    incomplete: incompleteReason(ev.lengths, jointName),
    slack_mm: totalSlack(ev.lengths),
    length_mm: ev.lengths.length_mm,
    cut_mm: user ?? required,
    required_mm: required,
    cutTooShort: user !== undefined && user < required,
    length_factor: ev.env.length_factor,
    ...(layAssumed !== undefined ? { layAssumed_mm: layAssumed } : {}),
    notes,
    width_mm: ev.env.width_mm,
    height_mm: ev.env.height_mm,
    shape: ev.env.shape,
    ...(ev.settle.pending > 0 ? { shapePending: true } : {}),
    ...(ev.settle.approximate.length ? { shapeApproximate: ev.settle.approximate } : {}),
    shapeNotes: ev.settle.notes,
  };
}

let timer: ReturnType<typeof setTimeout> | null = null;
let runId = 0;

/** Re-run all wire checks soon (debounced). */
export function scheduleWireChecks(delay = 150): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void runWireChecks(), delay);
}

/** The range result for a wire if it is still valid for this design. */
function validRange(design: Design, cableId: string): RangeResult | undefined {
  const r = ranges.get(cableId);
  if (!r) return undefined;
  if (r.running || r.key === rangeKey(design, cableId)) return r;
  ranges.delete(cableId);
  return undefined;
}

export async function runWireChecks(): Promise<void> {
  const id = ++runId;
  const s0 = useApp.getState();
  const design = s0.design;
  const values = s0.jointValues;
  const lib = s0.cableLibrary;
  for (const c of design.cables) {
    if (id !== runId) return;
    const route = routeOfCable(design, c.id);
    if (!route) continue;
    const type = lib ? findCableType(lib, c.type) : undefined;
    let status: WireStatus;
    try {
      status = statusOf(design, c, route, type, values);
    } catch (e) {
      status = { known: !!type, notes: [`The check failed: ${e instanceof Error ? e.message : String(e)}`] };
    }
    if (id !== runId) return;
    // A range result survives only while the wire, its route and the scene are unchanged.
    const range = validRange(design, c.id);
    useApp.setState((st) => ({ wireChecks: { ...st.wireChecks, [c.id]: { ...status, ...(range ? { range } : {}) } } }));
    await pause();
  }
}

/** Mark every wire's figures as out of date (they are worked out again). Statuses of deleted wires are dropped. */
export function markChecksStale(): void {
  useApp.setState((st) => {
    const ids = new Set(st.design.cables.map((c) => c.id));
    const next: typeof st.wireChecks = {};
    let changed = false;
    for (const [id, w] of Object.entries(st.wireChecks)) {
      if (!ids.has(id)) {
        changed = true;
        continue;
      }
      if (!w.stale) changed = true;
      next[id] = w.stale ? w : { ...w, stale: true };
    }
    for (const id of ranges.keys()) if (!ids.has(id)) ranges.delete(id);
    return changed ? { wireChecks: next } : {};
  });
}

/** Watch for changes that invalidate the checks. */
export function watchWireChecks(): () => void {
  // Settled shapes arriving: redraw (shapeVersion) and check again on them.
  const off = onSettled(() => {
    useApp.setState((st) => ({ shapeVersion: st.shapeVersion + 1 }));
    scheduleWireChecks(0);
  });
  const unsub = useApp.subscribe((s, prev) => {
    if (
      s.design.cables !== prev.design.cables ||
      s.design.routes !== prev.design.routes ||
      s.design.scene !== prev.design.scene ||
      s.design.components !== prev.design.components ||
      s.jointValues !== prev.jointValues ||
      s.geometryVersion !== prev.geometryVersion ||
      s.bvhPending !== prev.bvhPending ||
      s.cableLibrary !== prev.cableLibrary ||
      s.library !== prev.library ||
      s.connectorLibrary !== prev.connectorLibrary ||
      s.design.zones !== prev.design.zones ||
      s.wireAllowance_mm !== prev.wireAllowance_mm
    ) {
      // Every wire is being checked again from now: nothing reads as passing until it has been.
      markChecksStale();
      scheduleWireChecks(s.jointValues !== prev.jointValues ? 250 : 120);
    }
  });
  return () => {
    off();
    unsub();
  };
}

/** Most poses the range check samples. */
export const RANGE_MAX_POSES = 100;

/**
 * Fit across the range of motion of every joint that can bring a body near
 * the wire (the ones it crosses and the ones whose swept bodies come within
 * reach), sampled with at most RANGE_MAX_POSES poses; the worst pose.
 */
export async function runRangeCheck(cableId: string): Promise<void> {
  const s = useApp.getState();
  const design = s.design;
  const cable = design.cables.find((c) => c.id === cableId);
  const route = cable && routeOfCable(design, cable.id);
  const type = cable && s.cableLibrary ? findCableType(s.cableLibrary, cable.type) : undefined;
  if (!cable || !route || !type) return;
  const base = evaluateWire(design, route, type, cable, s.jointValues, { library: s.library, skipFit: true, skipCrossings: true });
  const near = jointsNearWire(design, route, base.env, s.jointValues, jointsCrossed(base.lengths.slack));
  const plan = rangePlan(
    near.map((j) => j.id),
    RANGE_MAX_POSES,
  );
  const poses = plan.sampled.length ? rangePoses(design, plan.sampled, plan.perJoint, plan.sampled.length) : [{}];
  const key = rangeKey(design, cableId);
  const set = (r: Omit<RangeResult, 'key' | 'sampled' | 'skipped' | 'perJoint'>) => {
    const range: RangeResult = { ...r, key, sampled: plan.sampled, skipped: plan.skipped, perJoint: plan.perJoint };
    ranges.set(cableId, range);
    // A wire deleted meanwhile gets no status back.
    useApp.setState((st) => (st.design.cables.some((c) => c.id === cableId) ? { wireChecks: { ...st.wireChecks, [cableId]: { ...(st.wireChecks[cableId] ?? { known: true }), range } } } : {}));
  };
  set({ running: true, poses: poses.length, done: 0 });
  let worst = Infinity;
  let worstPose: Record<string, number> | undefined;
  let worstWhat = '';
  let fitsAll = true;
  let approximate = 0;
  for (const [i, pose] of poses.entries()) {
    const values = { ...s.jointValues, ...pose };
    // Judged on the settled shape: wait for it like the checks do (a few rounds at most).
    for (let round = 0; round < 6; round++) {
      if (evaluateWire(design, route, type, cable, values, { library: s.library, skipFit: true, skipCrossings: true }).settle.pending === 0) break;
      await whenSettled();
      if (useApp.getState().design !== design) break;
    }
    const ev = evaluateWire(design, route, type, cable, values, { library: s.library, others: otherWires(design, cable.id, values), skipCrossings: true });
    const settled = ev.settle.pending === 0 && ev.settle.approximate.length === 0;
    if (!settled) approximate++;
    if (!ev.fit!.fits || !settled) fitsAll = false;
    if (ev.fit!.tightest_mm < worst) {
      worst = ev.fit!.tightest_mm;
      worstPose = pose;
      worstWhat = ev.fit!.tightestWhat;
    }
    set({ running: true, poses: poses.length, done: i + 1, worst_mm: worst, ...(worstPose ? { worstPose } : {}), worstWhat, fitsAll, approximate });
    await pause();
  }
  set({ running: false, poses: poses.length, done: poses.length, worst_mm: worst, ...(worstPose ? { worstPose } : {}), worstWhat, fitsAll, approximate });
  // A design edit during the run makes the result stale at once.
  if (useApp.getState().design !== design) scheduleWireChecks(0);
}

/** Comparison rows for every library type, one at a time (the UI stays responsive). */
/**
 * The types that could plausibly replace the wire's own: the same family, plus
 * any other the ports it is attached to accept (none when it is attached to none).
 */
export function compareCandidates(cableId: string): string[] {
  const s = useApp.getState();
  const cable = s.design.cables.find((c) => c.id === cableId);
  const route = cable && routeOfCable(s.design, cable.id);
  const lib = s.cableLibrary;
  if (!cable || !route || !lib) return [];
  const own = findCableType(lib, cable.type);
  const ports = attachedEnds(s.design, s.library, s.connectorLibrary, route).flatMap((e) => (e.info ? [e.info] : []));
  return lib.cables.filter((t) => t.id === cable.type || t.family === own?.family || (ports.length > 0 && fitsPorts(ports, t, cable.count))).map((t) => t.id);
}

export async function compareAll(
  cableId: string,
  onRow: (row: CompareRow, done: number, total: number) => void,
  isCancelled: () => boolean,
  only?: readonly string[],
): Promise<void> {
  const s = useApp.getState();
  const design = s.design;
  const cable = design.cables.find((c) => c.id === cableId);
  const route = cable && routeOfCable(design, cable.id);
  const lib = s.cableLibrary;
  if (!cable || !route || !lib) return;
  const others = otherWires(design, cable.id, s.jointValues);
  const jointName = (id: string) => design.scene.joints.find((j) => j.id === id)?.name || id;
  const ports = attachedEnds(design, s.library, s.connectorLibrary, route).flatMap((e) => (e.info ? [e.info] : []));
  const types = only ? lib.cables.filter((t) => only.includes(t.id)) : lib.cables;
  for (const [i, type] of types.entries()) {
    if (isCancelled()) return;
    try {
      // Each type on its own settled shape (its own stiffness and size), worked out in slices like the view's:
      // ask, wait until nothing is left to work out, ask again (the loops are asked for once the runs are known).
      const build = buildFor(cable, type.id);
      for (let round = 0; round < 6; round++) {
        if (evaluateWire(design, route, type, build, s.jointValues, { library: s.library, skipFit: true }).settle.pending === 0) break;
        await whenSettled();
        if (isCancelled()) return;
      }
      onRow(compareRow(design, route, type, build, s.jointValues, { library: s.library, others, allowance_mm: s.wireAllowance_mm, jointName, ports }), i + 1, types.length);
    } catch {
      // A type the route cannot be evaluated with is simply left out.
    }
    await pause();
  }
}
