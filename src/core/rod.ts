/**
 * The shape of a stiff wire: an inextensible elastic rod that rests against
 * the model, rounds edges, bridges dips, droops under its own weight and, when
 * laid along a surface, is pulled snug by a light tension.
 *
 * Model (per unit bending stiffness B). The centre line minimises
 *
 *   E = 1/2 ∫ κ² ds  +  L / λ²  [laid]  +  1/ℓg³ ∫ (height along up) ds  [gravity]
 *
 * subject to: pins (listed points held in place, optionally with a held
 * direction of travel; elsewhere the rod is smooth through the pin), contact
 * (the centre line stays at least `radius_mm` from every surface, frictionless)
 * and length (laid: free, the L/λ² term is the tension T = B/λ²; cut: fixed per
 * stretch between consecutive pins).
 *
 * Discretisation. Each stretch between consecutive pins is a chain of N equal
 * pieces of length h (in laid mode h is an unknown of the stretch; in cut mode
 * h = L/N). With d_i the unit direction of piece i, the bending energy is
 *   Σ |d_b - d_a|² / (h_a + h_b)    over joints between pieces,
 *   Σ |d - t|² / h                  for a held direction t at a pin (half a piece),
 * the same energy as span.ts (relaxSpan). Gravity is h · up·(midpoint) per
 * piece. The bend radius reported at a node is the same discrete curvature:
 * (h_a + h_b) / (2 |d_b - d_a|), which for equal pieces is the circle through
 * the node and its neighbours; at a held direction, h / (2 |d - t|) per side.
 *
 * Method: sequential quadratic programming on the node positions (Newton on
 * the KKT system of the Lagrangian, exact second derivatives).
 *  - Each piece's length is an equality constraint with a multiplier (its
 *    tension). In laid mode each piece's length is an unknown too, with
 *    equality constraints keeping the pieces of a stretch equal.
 *  - Contact is an inequality per node against the tangent plane of the
 *    nearest surface (cached, see below). Each Newton step holds on its plane
 *    every node that is on it and pressed into it (judged by the Lagrangian
 *    force; a node held at the last step stays held), solves, and lets go at
 *    once of every held node whose solved contact force comes out pulling.
 *  - The KKT matrix is banded: per node, 5 unknowns in cut mode (half
 *    bandwidth 12), 7 in laid mode (half bandwidth 16), whatever the number
 *    of pins. It is factored by banded LU with partial pivoting, so one
 *    factorisation costs time linear in the number of nodes.
 *  - Each trial step is restored to exact piece lengths (Gauss-Newton
 *    projection, tridiagonal per stretch) and nodes that crossed a plane are
 *    pushed back onto it; the step is accepted if it does not raise
 *    energy + rho · penetration (rho above the largest contact force, capped
 *    at 100 / h²), halving it up to 14 times. Levenberg damping grows when
 *    steps come out short, and then the Hessian also drops the negative
 *    curvature of pieces in compression (negative multipliers set to zero, in
 *    the position and piece-length parts alike) until full steps return.
 *  - A point is accepted as converged when the Newton step is below
 *    `tolerance` times the spacing (or the energy it promises is below 1e-12 of
 *    the energy), with the damping back below 1e-3 / h³ and no convexifying,
 *    no contact query needed this step, no penetration allowance left, the
 *    nodes on or near a surface asked again at their final position without
 *    any plane changing, and the second-order check passed: inverse iteration
 *    with the KKT matrix (Lagrangian Hessian plus a shift of 1e-6 / h³, solves
 *    restricted to directions that keep piece lengths, pins and held contacts)
 *    finds no direction along which the energy curves down by more than 1e-9
 *    of the largest diagonal entry. If it finds one, the solver steps off the
 *    saddle along that direction (or turns a stretch rigidly about its chord
 *    by a multiple of 45 degrees, whichever lowers the energy more), accepts
 *    from then on only steps that strictly lower the energy, and carries on;
 *    up to 20 such exits.
 *
 * Starting inside solid.
 *  - Before solving, parts of the start inside solid are taken out (see
 *    reroute): a stretch mostly inside, or a run whose outside neighbours face
 *    the same way, is replaced by an arc of the same length bowed outward; a
 *    laid run that passes right through a body is lifted out along the way
 *    most of its nodes face.
 *  - What is still inside is let out gradually: each node may first stay as
 *    deep as it is, and that allowance halves with every full step. A node
 *    inside takes the plane where the wire entered the solid (the nearest
 *    outside node along the chain) when both ends of its run agree on it.
 *  - Inside/outside answers are corrected along the chain from the sizes of
 *    the distances (if |d_i| + |d_j| exceeds the gap between two neighbouring
 *    points, no surface lies between them), so a callback that measures to
 *    the nearest surface of any one of several overlapping bodies, and so
 *    calls some points in solid outside, is handled. The optional `inside`
 *    field of an answer makes that exact.
 *  - If no step can be accepted at any damping, the current depths become the
 *    allowance and the damping starts again; after three such restarts in a
 *    row without progress the solve stops. An unconverged solve returns the
 *    least penetrating shape it went through.
 *
 * Contact queries. Each node caches the nearest surface's tangent plane and
 * the point where it was asked. The distance field is 1-Lipschitz, so a node
 * whose last answer was "distance d" is clear while it stays within d - radius
 * of that point; it is asked again when it leaves that ball, or (on or near a
 * surface) when it has moved 5 % of a piece (up to half a piece if its plane
 * keeps coming back the same). A line-search trial that would carry a node
 * further than its last answer vouches for asks again from the trial
 * position before it is accepted.
 *
 * Final contact report. Every node's distance from the surface at its final
 * position comes from an answer the callback gave there, unless an earlier
 * answer proves the node clear. A node that got "nothing within reach" is
 * asked again with a reach beyond the nearest node known to be outside, which
 * any point in solid must be within. So for a callback that answers honestly
 * within the reach it is asked for, `worst_penetration_mm` and `touching` are
 * the true values at the nodes. The report is never cut short by the time
 * budget.
 *
 * Input repairs. Never throws: a non-finite path point, an unusable pin,
 * tangent, radius, bend length, gravity or cut length is replaced by a stated
 * default and listed in `repaired`. Pins closer than MERGE_REL (1e-3) of the
 * spacing, with (cut) no more wire than that between them, are merged into
 * one hold, which keeps a held direction if either pin had one and otherwise
 * the direction from the first to the second (none if they coincide); the
 * bend through it is counted. A stretch shorter than half a piece is taken as
 * one straight piece. A cut stretch with less than TAUT_REL (1e-6) relative
 * slack is the straight line between its pins (`reaches` is false if the
 * length is shorter than the chord); where a held direction there departs
 * from that line the wire would have to kink, and the bend radius there is
 * reported as 0.
 *
 * Time budget. With `time_budget_ms` the solve checks the clock before each
 * Newton step, each re-solve after letting go of contacts and each
 * line-search trial, and stops when the time spent plus the time the final
 * contact report is expected to take (one callback call per node at the
 * average cost seen) exceeds the budget. It overruns by at most one
 * factorisation and one trial step. Not covered: the one callback call per
 * node needed to start (and to report), which no budget can avoid.
 *
 * Determinism and invariance. The same input gives the same output. A turned
 * or moved copy of the input (contact function included) gives the turned or
 * moved shape to solver tolerance, with one exception: when nothing in the
 * input tells the sides apart (a cut stretch whose start is a straight line,
 * with no held directions and no gravity; or a stretch laid out afresh
 * between pins that coincide) the side it bows to is taken from the
 * coordinate axes.
 *
 * What the model and solver leave out (read results with this in mind):
 *  - Contact is checked at the nodes only. A piece between two clear nodes can
 *    cut a corner sharper than the spacing, by its sagitta. Round a sharp
 *    edge the rod may rest on one node or straddle the edge with two; the
 *    per-node radius (radius_mm) is then too large by up to about 0.45 h / λ
 *    (relative). min_radius_mm corrects for this by extrapolating the
 *    curvature to the contact point. The one-node and two-node states are
 *    both minima of the discrete problem, so a set-up symmetric about the
 *    edge can land in either (min radius differs by about 2 % between them).
 *  - Bends tighter than the spacing are not resolved: with almost no slack
 *    against a held direction the true radius tends to 0, the reported one to
 *    about a third of a piece.
 *  - Laid mode with gravity is bounded only while a surface holds the wire up:
 *    hanging more than ℓg³/λ² below its pins in free air, extra length lowers
 *    the energy without limit and the wire runs away (returned unconverged,
 *    node count capped). Free spans belong in cut mode.
 *  - A pin inside solid stays there. Moving away from it along the wire the
 *    allowed depth falls by half a millimetre per millimetre of wire, and
 *    worst_penetration_mm reports it.
 *  - One surface per node per query: in a concave corner tighter than the
 *    spacing a node sees only the nearer wall at a time.
 *  - During the solve a node deeper inside solid than the query reach sees
 *    nothing there and is not pushed out by it (the final report still finds
 *    it).
 *  - No twist, no friction, no self-contact (a long slack loop can pass
 *    through itself).
 *  - The second-order check finds local minima, not the lowest one: a loop can
 *    stay in a local minimum (bowed sideways round an obstacle, say) when a
 *    lower one exists elsewhere.
 *  - Two pins at exactly the same point impose no direction: the merged hold
 *    is a free pivot there.
 *
 * Lengths are mm. Positions in any one frame.
 */
import type { Vec3 } from './schema';

/**
 * Signed distance from `p` to the nearest surface within `reach_mm` (negative
 * inside solid) and the outward unit normal there, or null when nothing is that
 * near.
 */
export type RodContact = (p: Vec3, reach_mm: number) => RodContactHit | null;

export interface RodContactHit {
  distance_mm: number;
  normal: Vec3;
  /**
   * Optional: whether p is inside ANY solid. Give it when bodies overlap or
   * nest and `distance_mm` is measured to the nearest surface of any one body:
   * a point inside an outer body but outside an inner one is then reported
   * outside (positive distance to the inner body's face) although it is in
   * solid. With this flag the solver treats such a point as inside and lets
   * it out the way the wire came in (see settleRod). Omitted: inside means
   * distance_mm < 0.
   */
  inside?: boolean;
}

/** A held point of the wire: index into `RodInput.path`; optionally the unit direction of travel there. */
export interface RodPin {
  index: number;
  tangent?: Vec3;
}

export interface RodInput {
  /** Starting centre line, any spacing, outside solid or nearly so. Pins index into it. */
  path: Vec3[];
  /** Sorted. The first and last path points are pinned even if not listed. */
  pins: RodPin[];
  radius_mm: number;
  /**
   * laid: length free, pulled snug by a tension with natural bend length
   * λ = √(B/T). cut: one fixed length per stretch between consecutive pins.
   */
  mode: { kind: 'laid'; bend_length_mm: number } | { kind: 'cut'; lengths_mm: number[] };
  /** Weight: `up` (unit) and ℓg = (B/w)^(1/3). */
  gravity?: { up: Vec3; sag_length_mm: number };
  contact?: RodContact;
}

export interface RodOptions {
  /**
   * Target piece length. Default clamp(f / 10, 0.5, 3) mm where f is the
   * smallest of λ (laid), ℓg (gravity) and a fifth of the shortest stretch;
   * raised if the wire would need more than 4000 pieces.
   */
  spacing_mm?: number;
  /** Newton iteration cap. Default 400. */
  max_iterations?: number;
  /** Converged (among the other conditions in the header) when no node moves more than this times the spacing in a Newton step. Default 1e-7. */
  tolerance?: number;
  /** Wall-clock budget for the solve; see "Time budget" at the top of this file. Default none. */
  time_budget_ms?: number;
  /** Touching / penetration tolerance on the distance to a surface. Default 1e-3 mm. */
  contact_tolerance_mm?: number;
}

export interface RodShape {
  /** Settled centre line, near-uniform spacing, passes exactly through every pin. */
  points: Vec3[];
  /** Where each pin sits in `points`, in pin order. */
  pin_indices: number[];
  length_mm: number;
  /** Bend radius at each point: circle through the point and its neighbours (Infinity where straight or at a free end). */
  radius_mm: number[];
  min_radius_mm: number;
  tightest_index: number;
  /** Per point: within `contact_tolerance_mm` of `radius_mm` from a surface (or nearer). */
  touching: boolean[];
  /** Largest radius_mm - distance over the points, or 0 if none is nearer than radius_mm - contact tolerance. */
  worst_penetration_mm: number;
  /** Cut mode: false if a stretch is shorter than the straight distance between its pins (that stretch is then straight). */
  reaches: boolean;
  converged: boolean;
  iterations: number;
  /** How many times the contact callback was called. */
  contact_calls: number;
  /**
   * Every repair made to the input, in words (a non-finite point replaced, a
   * missing cut length taken from the path, pins merged, a stretch too short
   * to bend taken straight, ...). Empty when the input was used as given.
   */
  repaired: string[];
}

// ---- small vector helpers ------------------------------------------------

type V3 = [number, number, number];

function finite3(v: unknown): v is readonly number[] {
  return Array.isArray(v) && v.length >= 3 && Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]);
}

function unit3(v: unknown): V3 | null {
  if (!finite3(v)) return null;
  const l = Math.hypot(v[0]!, v[1]!, v[2]!);
  if (!(l > 1e-12)) return null;
  return [v[0]! / l, v[1]! / l, v[2]! / l];
}

function anyPerpendicular(c: V3): V3 {
  const ax = Math.abs(c[0]);
  const ay = Math.abs(c[1]);
  const az = Math.abs(c[2]);
  const e: V3 = ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1];
  return unit3([c[1] * e[2] - c[2] * e[1], c[2] * e[0] - c[0] * e[2], c[0] * e[1] - c[1] * e[0]])!;
}

function perpTo(v: V3, c: V3): V3 {
  const k = v[0] * c[0] + v[1] * c[1] + v[2] * c[2];
  return [v[0] - k * c[0], v[1] - k * c[1], v[2] - k * c[2]];
}

/** Solve sin(x)/x = r for x in [0, π]. */
function sincInverse(r: number): number {
  if (r >= 1) return 0;
  if (r <= 0) return Math.PI;
  let lo = 0;
  let hi = Math.PI;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (Math.sin(mid) / mid > r) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

function polyLength(p: Float64Array): number {
  let s = 0;
  for (let i = 3; i < p.length; i += 3) s += Math.hypot(p[i]! - p[i - 3]!, p[i + 1]! - p[i - 2]!, p[i + 2]! - p[i - 1]!);
  return s;
}

/** Resample a polyline (flat xyz) to n equal-arc pieces; the ends are kept exactly. */
function resample(p: Float64Array, n: number): Float64Array {
  const m = p.length / 3;
  const out = new Float64Array(3 * (n + 1));
  const cum = new Float64Array(m);
  for (let i = 1; i < m; i++) cum[i] = cum[i - 1]! + Math.hypot(p[3 * i]! - p[3 * i - 3]!, p[3 * i + 1]! - p[3 * i - 2]!, p[3 * i + 2]! - p[3 * i - 1]!);
  const total = cum[m - 1]!;
  let seg = 0;
  for (let k = 0; k <= n; k++) {
    if (k === 0 || total <= 0 || m === 1) {
      const src = k === n ? m - 1 : 0;
      out[3 * k] = p[3 * src]!;
      out[3 * k + 1] = p[3 * src + 1]!;
      out[3 * k + 2] = p[3 * src + 2]!;
      continue;
    }
    if (k === n) {
      out[3 * k] = p[3 * m - 3]!;
      out[3 * k + 1] = p[3 * m - 2]!;
      out[3 * k + 2] = p[3 * m - 1]!;
      continue;
    }
    const s = (total * k) / n;
    while (seg < m - 2 && cum[seg + 1]! < s) seg++;
    const l = cum[seg + 1]! - cum[seg]!;
    const t = l > 0 ? Math.min(1, Math.max(0, (s - cum[seg]!) / l)) : 0;
    for (let d = 0; d < 3; d++) out[3 * k + d] = p[3 * seg + d]! + t * (p[3 * seg + 3 + d]! - p[3 * seg + d]!);
  }
  return out;
}

// ---- banded LU -----------------------------------------------------------

/** Column scratch for bandFactor (largest band used). */
const nzCols = new Int32Array(2 * 16 + 16 + 1);

/** In-place banded LU with partial pivoting (LINPACK style; L multipliers are not re-permuted). */
function bandFactor(a: Float64Array, n: number, piv: Int32Array, KL: number, KU: number): void {
  const BW = 2 * KL + KU + 1;
  let scale = 0;
  for (let i = 0; i < a.length; i++) {
    const v = Math.abs(a[i]!);
    if (v > scale) scale = v;
  }
  const tiny = Math.max(1e-300, 1e-14 * scale);
  for (let r = 0; r < n; r++) {
    const iMax = Math.min(n - 1, r + KL);
    let p = r;
    let best = Math.abs(a[r * BW + KL]!);
    for (let i = r + 1; i <= iMax; i++) {
      const v = Math.abs(a[i * BW + (r - i + KL)]!);
      if (v > best) {
        best = v;
        p = i;
      }
    }
    piv[r] = p;
    const jMax = Math.min(n - 1, r + KL + KU);
    if (p !== r) {
      for (let j = r; j <= jMax; j++) {
        const ir = r * BW + (j - r + KL);
        const ip = p * BW + (j - p + KL);
        const t = a[ir]!;
        a[ir] = a[ip]!;
        a[ip] = t;
      }
    }
    let d = a[r * BW + KL]!;
    if (!(Math.abs(d) > tiny)) {
      d = d < 0 ? -tiny : tiny;
      a[r * BW + KL] = d;
    }
    const rb = r * BW - r + KL;
    // The band is far from full: update only the pivot row's nonzero columns.
    let nz = 0;
    for (let j = r + 1; j <= jMax; j++) if (a[rb + j] !== 0) nzCols[nz++] = j;
    for (let i = r + 1; i <= iMax; i++) {
      const ib = i * BW - i + KL;
      const l = a[ib + r]! / d;
      a[ib + r] = l;
      if (l === 0) continue;
      for (let q = 0; q < nz; q++) {
        const j = nzCols[q]!;
        a[ib + j] = a[ib + j]! - l * a[rb + j]!;
      }
    }
  }
}

function bandSolve(a: Float64Array, n: number, piv: Int32Array, b: Float64Array, KL: number, KU: number): void {
  const BW = 2 * KL + KU + 1;
  for (let r = 0; r < n; r++) {
    const p = piv[r]!;
    if (p !== r) {
      const t = b[r]!;
      b[r] = b[p]!;
      b[p] = t;
    }
    const br = b[r]!;
    if (br === 0) continue;
    const iMax = Math.min(n - 1, r + KL);
    for (let i = r + 1; i <= iMax; i++) b[i] = b[i]! - a[i * BW + (r - i + KL)]! * br;
  }
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r]!;
    const jMax = Math.min(n - 1, r + KL + KU);
    const rb = r * BW - r + KL;
    for (let j = r + 1; j <= jMax; j++) s -= a[rb + j]! * b[j]!;
    b[r] = s / a[rb + r]!;
  }
}

// ---- the solver ------------------------------------------------------------

interface Stretch {
  /** First and last node. */
  a: number;
  b: number;
  /** Pieces. */
  n: number;
  /** Fixed straight (cut stretch that cannot bow, or a zero-length stretch): no unknowns. */
  fixed: boolean;
  /** Index of this stretch's h among the laid-mode unknowns, or -1. */
  hv: number;
  /** Scale used in the length constraint (the target spacing). */
  hs: number;
  chord: number;
  /** Cut mode: the stretch's fixed length. */
  L: number;
}

const DEFAULT_MAX_ITER = 400;
const DEFAULT_TOL = 1e-7;
const DEFAULT_CONTACT_TOL = 1e-3;
const MAX_PIECES = 4000;
/** Pins closer than this times the spacing (with no more wire between) are merged. */
const MERGE_REL = 1e-3;
/** A cut stretch with less relative slack than this is the straight line. */
const TAUT_REL = 1e-6;

function emptyShape(points: Vec3[], pinIdx: number[], reaches: boolean, repaired: string[]): RodShape {
  const n = points.length;
  let len = 0;
  for (let i = 1; i < n; i++) len += Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1], points[i]![2] - points[i - 1]![2]);
  return {
    points,
    pin_indices: pinIdx,
    length_mm: len,
    radius_mm: points.map(() => Infinity),
    min_radius_mm: Infinity,
    tightest_index: n > 0 ? 0 : -1,
    touching: points.map(() => false),
    worst_penetration_mm: 0,
    reaches,
    converged: true,
    iterations: 0,
    contact_calls: 0,
    repaired,
  };
}

/**
 * Settle a stiff wire: a local minimum of the rod energy described at the top
 * of this file, found from the starting `path`. Determinism, invariance,
 * repairs and the time budget are as described there. Never throws.
 */
export function settleRod(input: RodInput, options: RodOptions = {}): RodShape {
  const perf = (globalThis as { performance?: { now(): number } }).performance;
  const clock = perf && typeof perf.now === 'function' ? () => perf.now() : () => Date.now();
  const tStart = clock();
  /** Time spent in the contact callback so far (only measured under a time budget). */
  let queryTime = 0;
  /**
   * Over budget, counting the time the final contact report will need: one
   * callback call per node not proven clear, at the average cost seen.
   */
  const overBudget = (): boolean => {
    if (budget === Infinity) return false;
    const perQuery = contactCalls > 0 ? queryTime / contactCalls : 0;
    return clock() - tStart + perQuery * nn > budget;
  };
  const budget = typeof options.time_budget_ms === 'number' && options.time_budget_ms > 0 ? options.time_budget_ms : Infinity;
  const maxIter =
    typeof options.max_iterations === 'number' && options.max_iterations >= 0 ? Math.floor(options.max_iterations) : DEFAULT_MAX_ITER;
  const tol = typeof options.tolerance === 'number' && options.tolerance > 0 ? options.tolerance : DEFAULT_TOL;
  const touchTol =
    typeof options.contact_tolerance_mm === 'number' && options.contact_tolerance_mm > 0 ? options.contact_tolerance_mm : DEFAULT_CONTACT_TOL;

  // ---- read and repair the input. Every repair is listed in `repaired`.
  const repaired: string[] = [];
  const rawPath: unknown[] = Array.isArray(input?.path) ? input.path : [];
  if (!Array.isArray(input?.path)) repaired.push('path is not an array: taken as empty');
  const np = rawPath.length;
  const path: V3[] = [];
  let firstGood = -1;
  for (let i = 0; i < np; i++) {
    if (finite3(rawPath[i])) {
      firstGood = i;
      break;
    }
  }
  if (firstGood < 0) return emptyShape([], [], true, np > 0 ? ['no path point is finite: empty result'] : repaired);
  let last: V3 = [...(rawPath[firstGood] as number[]).slice(0, 3)] as V3;
  for (let i = 0; i < np; i++) {
    const p = rawPath[i];
    if (finite3(p)) last = [p[0]!, p[1]!, p[2]!];
    else repaired.push(`path[${i}] is not a finite point: replaced by the nearest finite point before it (or the first finite one)`);
    path.push([last[0], last[1], last[2]]);
  }
  if (np === 1) return emptyShape([[path[0]![0], path[0]![1], path[0]![2]]], [0], true, repaired);

  // ---- pins.
  const pinMap = new Map<number, V3 | null>();
  for (const pin of Array.isArray(input?.pins) ? input.pins : []) {
    if (!pin || typeof pin.index !== 'number' || !Number.isInteger(pin.index) || pin.index < 0 || pin.index >= np) {
      repaired.push(`pin with index ${String(pin?.index)} is not a path index: ignored`);
      continue;
    }
    const t = unit3(pin.tangent);
    if (pin.tangent !== undefined && !t) repaired.push(`pin at path[${pin.index}]: tangent is not a usable direction: ignored`);
    if (pinMap.has(pin.index) && pinMap.get(pin.index) && t) repaired.push(`pin at path[${pin.index}] listed twice: first tangent kept`);
    if (!pinMap.has(pin.index) || (pinMap.get(pin.index) === null && t)) pinMap.set(pin.index, t);
  }
  if (!pinMap.has(0)) pinMap.set(0, null);
  if (!pinMap.has(np - 1)) pinMap.set(np - 1, null);
  /** Every pin as given (path index), in order: what pin_indices reports. */
  const allPins = [...pinMap.keys()].sort((x, y) => x - y);

  // Work relative to the first pin (translation invariance and precision).
  const O: V3 = [path[allPins[0]!]![0], path[allPins[0]!]![1], path[allPins[0]!]![2]];
  const rel = path.map((p) => [p[0] - O[0], p[1] - O[1], p[2] - O[2]] as V3);

  let radius = 0;
  if (typeof input?.radius_mm === 'number' && Number.isFinite(input.radius_mm) && input.radius_mm > 0) radius = input.radius_mm;
  else if (input?.radius_mm !== 0) repaired.push(`radius_mm ${String(input?.radius_mm)} is not a positive number: taken as 0`);
  const laid = input?.mode?.kind === 'laid';
  if (!laid && input?.mode?.kind !== 'cut') repaired.push('mode is neither laid nor cut: taken as cut');
  let lambda = 10;
  if (laid) {
    const b = (input.mode as { bend_length_mm: unknown }).bend_length_mm;
    if (typeof b === 'number' && Number.isFinite(b) && b > 0) lambda = b;
    else repaired.push(`bend_length_mm ${String(b)} is not a positive number: taken as 10`);
  }
  const tension = laid ? 1 / (lambda * lambda) : 0;
  let up: V3 | null = null;
  let lg = 0;
  if (input?.gravity) {
    up = unit3(input.gravity.up);
    const g = input.gravity.sag_length_mm;
    if (typeof g === 'number' && Number.isFinite(g) && g > 0) lg = g;
    if (!up || !(lg > 0)) repaired.push('gravity has no usable up direction or sag length: gravity ignored');
  }
  const weight = up && lg > 0 ? 1 / (lg * lg * lg) : 0;
  const contactFn = typeof input?.contact === 'function' ? input.contact : null;
  const cutLengths: unknown[] = !laid && Array.isArray((input?.mode as { lengths_mm?: unknown })?.lengths_mm) ? (input.mode as { lengths_mm: unknown[] }).lengths_mm : [];

  const arcOf = (i0: number, i1: number): number => {
    let s = 0;
    for (let i = i0 + 1; i <= i1; i++) s += Math.hypot(rel[i]![0] - rel[i - 1]![0], rel[i]![1] - rel[i - 1]![1], rel[i]![2] - rel[i - 1]![2]);
    return s;
  };
  const chordOf = (i0: number, i1: number): number => Math.hypot(rel[i1]![0] - rel[i0]![0], rel[i1]![1] - rel[i0]![1], rel[i1]![2] - rel[i0]![2]);
  // Cut lengths per stretch between the given pins.
  const givenL: number[] = [];
  for (let j = 0; j + 1 < allPins.length; j++) {
    const g = cutLengths[j];
    if (laid) givenL.push(arcOf(allPins[j]!, allPins[j + 1]!));
    else if (typeof g === 'number' && Number.isFinite(g) && g >= 0) givenL.push(g);
    else {
      givenL.push(arcOf(allPins[j]!, allPins[j + 1]!));
      repaired.push(`lengths_mm[${j}] ${String(g)} is not a length: taken as the path's length between those pins`);
    }
  }

  // ---- spacing.
  let spacing: number;
  {
    let f = Infinity;
    if (laid) f = Math.min(f, lambda);
    if (weight > 0) f = Math.min(f, lg);
    for (let j = 0; j + 1 < allPins.length; j++) {
      const Lj = laid ? chordOf(allPins[j]!, allPins[j + 1]!) : givenL[j]!;
      if (Lj > 5e-3) f = Math.min(f, Lj / 5);
    }
    spacing = Number.isFinite(f) ? Math.min(3, Math.max(0.5, f / 10)) : 3;
    let total = 0;
    for (let j = 0; j < givenL.length; j++) total += givenL[j]!;
    if (typeof options.spacing_mm === 'number' && options.spacing_mm > 0 && Number.isFinite(options.spacing_mm)) spacing = options.spacing_mm;
    if (total / spacing > MAX_PIECES) spacing = total / MAX_PIECES;
  }

  // ---- merge pins that (nearly) coincide. Two pins closer than MERGE_REL of
  // the spacing, with (cut) no more wire than that between them, are one hold:
  // the first one's position, either one's held direction. The wire then bends
  // through that one point and the bend is counted there.
  const mergeTol = MERGE_REL * spacing;
  const pinPath: number[] = [allPins[0]!];
  const pinTan: (V3 | null)[] = [pinMap.get(allPins[0]!) ?? null];
  /** For each given pin, the index of the hold it ended up in. */
  const holdOf: number[] = [0];
  const holdL: number[] = [];
  for (let j = 1; j < allPins.length; j++) {
    const i = allPins[j]!;
    const prev = pinPath[pinPath.length - 1]!;
    const close = chordOf(prev, i) < mergeTol && (laid || givenL[j - 1]! < mergeTol);
    if (close) {
      // Two holds a hair apart still fix the wire's direction between them;
      // the merged hold keeps that direction unless one of them gives one.
      const between = unit3([rel[i]![0] - rel[prev]![0], rel[i]![1] - rel[prev]![1], rel[i]![2] - rel[prev]![2]]);
      if (!pinTan[pinTan.length - 1]) pinTan[pinTan.length - 1] = pinMap.get(i) ?? between;
      // The far side of the merged hold: the next stretch starts at the kept pin.
      repaired.push(`pins at path[${prev}] and path[${i}] are ${chordOf(prev, i).toExponential(2)} mm apart: merged into one hold at path[${prev}]`);
      holdOf.push(pinPath.length - 1);
      if (holdL.length > 0 && !laid) holdL[holdL.length - 1] = holdL[holdL.length - 1]! + givenL[j - 1]!;
      continue;
    }
    holdL.push(givenL[j - 1]!);
    pinPath.push(i);
    pinTan.push(pinMap.get(i) ?? null);
    holdOf.push(pinPath.length - 1);
  }
  if (pinPath.length === 1) {
    // Everything collapsed onto one hold: a single point.
    return emptyShape([[path[allPins[0]!]![0], path[allPins[0]!]![1], path[allPins[0]!]![2]]], allPins.map(() => 0), true, repaired);
  }
  const nPins = pinPath.length;
  const nStr = nPins - 1;

  // ---- stretches between holds.
  const subs: Float64Array[] = [];
  const arcs: number[] = [];
  const chords: number[] = [];
  const targetL: number[] = [];
  let reaches = true;
  for (let j = 0; j < nStr; j++) {
    const i0 = pinPath[j]!;
    // A merged hold ends the stretch at the kept pin's position.
    const i1 = pinPath[j + 1]!;
    const s = new Float64Array(3 * (i1 - i0 + 1));
    for (let i = i0; i <= i1; i++) for (let d = 0; d < 3; d++) s[3 * (i - i0) + d] = rel[i]![d]!;
    subs.push(s);
    arcs.push(polyLength(s));
    chords.push(chordOf(i0, i1));
    targetL.push(laid ? arcs[j]! : holdL[j]!);
  }
  /**
   * Stretches taken as one straight piece: too short to bend at this spacing
   * (under half a piece), or (cut) with less than TAUT_REL relative slack.
   */
  const degenerate: boolean[] = [];
  /** Cut stretches pulled straight with less than TAUT_REL slack, or short of their chord. */
  const taut: boolean[] = [];
  for (let j = 0; j < nStr; j++) {
    const D = chords[j]!;
    if (laid) {
      degenerate.push(D < 0.5 * spacing);
      taut.push(false);
      continue;
    }
    const L = targetL[j]!;
    if (L < D * (1 - 1e-12)) {
      reaches = false;
      degenerate.push(true);
      taut.push(true);
    } else if (L <= D * (1 + TAUT_REL)) {
      degenerate.push(true);
      taut.push(true);
    } else if (L < 0.5 * spacing) {
      degenerate.push(true);
      taut.push(false);
      repaired.push(`stretch ${j}: ${L.toExponential(2)} mm of wire is too short to bend at a spacing of ${spacing.toFixed(3)} mm: taken straight`);
    } else {
      degenerate.push(false);
      taut.push(false);
    }
  }
  let totalLen = 0;
  for (let j = 0; j < nStr; j++) totalLen += degenerate[j] ? chords[j]! : targetL[j]!;
  const reach = radius + Math.max(3 * spacing, 2 * radius);
  const reach0 = radius + Math.max(6 * spacing, 4 * radius);
  const qNear = 0.05 * spacing;
  // KKT layout. Per node k: x, y, z (NPN k .. +2), the contact multiplier
  // (+3) and the multiplier of piece k's length (+4). Laid mode adds the
  // length of piece k as an unknown (+5) and the multiplier of "piece k as
  // long as piece k+1" (+6), which keeps the pieces of a stretch equal: the
  // per-stretch piece length then couples neighbours only, and the matrix
  // stays banded however many pins there are. Node k couples to node k±2.
  const NPN = laid ? 7 : 5;
  const KL = laid ? 16 : 12;
  const KU = KL;
  const BW = 2 * KL + KU + 1;
  const bendScale = 1 / (spacing * spacing * spacing);
  const tauMin = 1e-9 * bendScale;
  const tauMax = 1e8 * bendScale;
  let tau = 1e-6 * bendScale;
  /**
   * After a short step the Hessian drops the negative curvature of pieces in
   * compression, which makes every step a descent direction; full steps bring
   * the exact Hessian back.
   */
  let convexify = false;
  let fullSteps = 0;

  // ---- starting polylines per stretch.
  const polys: Float64Array[] = [];
  const counts: number[] = [];
  for (let j = 0; j < nStr; j++) {
    const s = subs[j]!;
    const D = chords[j]!;
    if (degenerate[j]) {
      const n = Math.max(1, Math.round(D / spacing));
      const p = new Float64Array(3 * (n + 1));
      for (let k = 0; k <= n; k++) for (let d = 0; d < 3; d++) p[3 * k + d] = s[d]! + ((s[s.length - 3 + d]! - s[d]!) * k) / n;
      polys.push(p);
      counts.push(n);
      continue;
    }
    if (laid) {
      const n = Math.max(2, Math.round(arcs[j]! / spacing));
      polys.push(resample(s, n));
      counts.push(n);
      continue;
    }
    const L = targetL[j]!;
    const n = Math.max(2, Math.round(L / spacing));
    polys.push(cutStart(s, L, D, n, pinTan[j] ?? null, pinTan[j + 1] ?? null, up));
    counts.push(n);
  }

  // ---- state.
  let nn = 0;
  let X = new Float64Array(0);
  let fixedN = new Uint8Array(0);
  let tanN = new Float64Array(0);
  let hasTan = new Uint8Array(0);
  let segS = new Int32Array(0);
  let segC = new Uint8Array(0);
  let mu = new Float64Array(0);
  /** Per node: how far it may move along a surface before the plane is asked for again. */
  let cThr = new Float64Array(0);
  /** Per node: the last answer said the node is inside solid. */
  let cIn = new Uint8Array(0);
  /**
   * Per node: its plane is borrowed from where the wire entered the solid
   * (see assignEscape), not its own nearest face.
   */
  let esc = new Uint8Array(0);
  /** Per node: penetration still allowed while a start inside solid is let out. */
  let allow = new Float64Array(0);
  /**
   * Per node: penetration that can never be removed because a pin is inside
   * solid. Moving away from such a pin along the wire, the allowed depth falls
   * by half a millimetre per millimetre of wire: a node k pieces away may
   * stay depth - h k / 2 deep.
   */
  let allowFloor = new Float64Array(0);
  function setFloor(): void {
    allowFloor = new Float64Array(nn);
    if (!contactFn) return;
    for (let i = 0; i < nPins; i++) {
      const p = pinNode[i]!;
      if (cHas[p] !== 2) continue;
      const depth = radius - cD[p]!;
      if (!(depth > 0)) continue;
      for (let k = 0; k < nn; k++) {
        if (fixedN[k]) continue;
        const h = H[segS[Math.min(k, p, nn - 2)]!]!;
        const f = depth - 0.5 * h * Math.abs(k - p);
        if (f > allowFloor[k]!) allowFloor[k] = f;
      }
    }
    for (let k = 0; k < nn; k++) if (allowFloor[k]! > allow[k]!) allow[k] = allowFloor[k]!;
  }
  // contact cache: 0 not asked, 1 nothing within reach, 2 plane
  let cHas = new Uint8Array(0);
  let cQ = new Float64Array(0);
  let cD = new Float64Array(0);
  let cN = new Float64Array(0);
  let cR = new Float64Array(0);
  const pinNode = new Int32Array(nPins);
  const strs: Stretch[] = [];
  const H = new Float64Array(nStr);
  let m = 0;
  for (let j = 0; j < nStr; j++) {
    const fixed = degenerate[j]!;
    strs.push({ a: 0, b: 0, n: counts[j]!, fixed, hv: !fixed && laid ? m++ : -1, hs: spacing, chord: chords[j]!, L: targetL[j]! });
  }
  let contactCalls = 0;

  function build(ps: Float64Array[], muPer: number[]): void {
    nn = 1;
    for (let j = 0; j < nStr; j++) nn += ps[j]!.length / 3 - 1;
    X = new Float64Array(3 * nn);
    fixedN = new Uint8Array(nn);
    tanN = new Float64Array(3 * nn);
    hasTan = new Uint8Array(nn);
    segS = new Int32Array(Math.max(0, nn - 1));
    segC = new Uint8Array(Math.max(0, nn - 1));
    mu = new Float64Array(Math.max(0, nn - 1));
    cThr = new Float64Array(nn).fill(qNear);
    allow = new Float64Array(nn);
    cHas = new Uint8Array(nn);
    cIn = new Uint8Array(nn);
    esc = new Uint8Array(nn);
    cQ = new Float64Array(3 * nn);
    cD = new Float64Array(nn);
    cN = new Float64Array(3 * nn);
    cR = new Float64Array(nn);
    let k = 0;
    for (let j = 0; j < nStr; j++) {
      const p = ps[j]!;
      const n = p.length / 3 - 1;
      const st = strs[j]!;
      st.a = k;
      st.n = n;
      st.b = k + n;
      for (let q = 0; q <= n; q++) for (let d = 0; d < 3; d++) X[3 * (k + q) + d] = p[3 * q + d]!;
      for (let q = 0; q < n; q++) {
        segS[k + q] = j;
        segC[k + q] = st.fixed ? 0 : 1;
        mu[k + q] = muPer[j]!;
      }
      if (st.fixed) for (let q = 0; q <= n; q++) fixedN[k + q] = 1;
      H[j] = n > 0 ? (st.fixed ? st.chord / n : laid ? polyLength(p) / n : st.L / n) : 0;
      k += n;
    }
    for (let i = 0; i < nPins; i++) {
      const node = i === 0 ? 0 : strs[i - 1]!.b;
      pinNode[i] = node;
      fixedN[node] = 1;
      const t = pinTan[i];
      if (t) {
        hasTan[node] = 1;
        tanN[3 * node] = t[0];
        tanN[3 * node + 1] = t[1];
        tanN[3 * node + 2] = t[2];
      }
    }
    // Pins sit exactly at the input pin positions.
    for (let i = 0; i < nPins; i++) for (let d = 0; d < 3; d++) X[3 * pinNode[i]! + d] = rel[pinPath[i]!]![d]!;
  }

  build(polys, strs.map(() => tension));

  // ---- contact.
  function query(k: number, rch: number, P: Float64Array = X): void {
    if (!contactFn) return;
    const p: Vec3 = [P[3 * k]! + O[0], P[3 * k + 1]! + O[1], P[3 * k + 2]! + O[2]];
    let res: ReturnType<RodContact> = null;
    const tq = budget !== Infinity ? clock() : 0;
    try {
      res = contactFn(p, rch);
    } catch {
      res = null;
    }
    if (budget !== Infinity) queryTime += clock() - tq;
    contactCalls++;
    cQ[3 * k] = P[3 * k]!;
    cQ[3 * k + 1] = P[3 * k + 1]!;
    cQ[3 * k + 2] = P[3 * k + 2]!;
    cR[k] = rch;
    esc[k] = 0;
    const nrm = res ? unit3(res.normal) : null;
    if (!res || !nrm || typeof res.distance_mm !== 'number' || !Number.isFinite(res.distance_mm)) {
      cHas[k] = 1;
      cIn[k] = 0;
      return;
    }
    cHas[k] = 2;
    cD[k] = res.distance_mm;
    cIn[k] = res.distance_mm < 0 || res.inside === true ? 1 : 0;
    cN[3 * k] = nrm[0];
    cN[3 * k + 1] = nrm[1];
    cN[3 * k + 2] = nrm[2];
  }
  function moved(k: number, P: Float64Array): number {
    return Math.hypot(P[3 * k]! - cQ[3 * k]!, P[3 * k + 1]! - cQ[3 * k + 1]!, P[3 * k + 2]! - cQ[3 * k + 2]!);
  }
  /** Signed clearance of node k from its cached plane (distance - radius); Infinity if no plane. */
  function gap(k: number, P: Float64Array): number {
    if (cHas[k] !== 2) return Infinity;
    const b = 3 * k;
    return cD[k]! + cN[b]! * (P[b]! - cQ[b]!) + cN[b + 1]! * (P[b + 1]! - cQ[b + 1]!) + cN[b + 2]! * (P[b + 2]! - cQ[b + 2]!) - radius;
  }
  /**
   * Clearance the solver works to: the true clearance plus the penetration
   * still allowed at this node. A node inside solid is let out gradually (its
   * allowance halves with every full step), so the rod as a whole moves out
   * instead of each node jumping to its own nearest face.
   */
  function gapC(k: number, P: Float64Array): number {
    return gap(k, P) + allow[k]!;
  }
  function needsQuery(k: number): boolean {
    if (!contactFn) return false;
    if (cHas[k] === 0) return true;
    if (fixedN[k]) return false;
    // A borrowed entry plane is kept until the node has come out through it.
    if (esc[k]) return gap(k, X) >= -1e-9 * spacing;
    const mv = moved(k, X);
    if (cHas[k] === 1) return mv > 0.8 * (cR[k]! - radius);
    return mv > Math.max(0.8 * (cD[k]! - radius), cThr[k]!);
  }
  /**
   * A node inside solid is let out the way the wire went in, not through its
   * own nearest face: it takes the plane of the nearest node along the chain
   * that is outside (where the wire entered). Leaving every inside node
   * through its nearest face pulls a loop that lies deep in a thick body (or
   * in overlapping bodies, whose nearest faces point different ways) apart in
   * opposite directions, which its length cannot allow; leaving through the
   * entry face retracts it, and for a convex body the far side of the entry
   * face is outside the body.
   */
  function assignEscape(): void {
    if (!contactFn) return;
    for (let k = 0; k < nn; k++) {
      if (fixedN[k] || cHas[k] !== 2 || !cIn[k] || esc[k]) continue;
      const out = (c: number): boolean => cHas[c] === 2 && !cIn[c] && !esc[c];
      let jl = k - 1;
      while (jl >= 0 && !out(jl)) jl--;
      let jr = k + 1;
      while (jr < nn && !out(jr)) jr++;
      let j = -1;
      if (jl >= 0 && jr < nn) {
        // The wire runs right through the body (it went in and comes out
        // facing apart): there is no one way back, so the node keeps its own
        // nearest face.
        const agree = cN[3 * jl]! * cN[3 * jr]! + cN[3 * jl + 1]! * cN[3 * jr + 1]! + cN[3 * jl + 2]! * cN[3 * jr + 2]!;
        if (agree < 0) continue;
        j = k - jl <= jr - k ? jl : jr;
      } else if (jl >= 0) j = jl;
      else if (jr < nn) j = jr;
      if (j < 0) continue;
      cQ[3 * k] = cQ[3 * j]!;
      cQ[3 * k + 1] = cQ[3 * j + 1]!;
      cQ[3 * k + 2] = cQ[3 * j + 2]!;
      cD[k] = cD[j]!;
      cN[3 * k] = cN[3 * j]!;
      cN[3 * k + 1] = cN[3 * j + 1]!;
      cN[3 * k + 2] = cN[3 * j + 2]!;
      esc[k] = 1;
      const depth = -gap(k, X);
      if (depth > allow[k]!) allow[k] = depth;
    }
  }
  /**
   * Ask again for node k; returns true if the surface seen differs from the
   * cached plane at this position. A node whose plane keeps coming back the
   * same (a flat face) is asked less often.
   */
  function requery(k: number): boolean {
    const had = cHas[k] === 2;
    const g0 = had ? gap(k, X) : Infinity;
    const nx = cN[3 * k]!;
    const ny = cN[3 * k + 1]!;
    const nz = cN[3 * k + 2]!;
    query(k, reach);
    if (!had || cHas[k] !== 2) {
      cThr[k] = qNear;
      return had !== (cHas[k] === 2);
    }
    const dn = Math.abs(nx - cN[3 * k]!) + Math.abs(ny - cN[3 * k + 1]!) + Math.abs(nz - cN[3 * k + 2]!);
    const same = Math.abs(gap(k, X) - g0) <= 1e-3 * touchTol && dn <= 1e-6;
    cThr[k] = same ? Math.min(2 * cThr[k]!, 0.5 * spacing) : qNear;
    return !same;
  }
  /** Cache entries replaced by lookAhead, so a rejected trial can put them back. */
  const saved: number[] = [];
  function lookAhead(P: Float64Array): void {
    saved.length = 0;
    if (!contactFn) return;
    for (let k = 0; k < nn; k++) {
      if (fixedN[k] || cHas[k] === 0 || esc[k]) continue;
      const mv = moved(k, P);
      const range = cHas[k] === 1 ? 0.8 * (cR[k]! - radius) : Math.max(0.8 * (cD[k]! - radius), 0.5 * spacing);
      if (mv > range) {
        saved.push(k, cHas[k]!, cQ[3 * k]!, cQ[3 * k + 1]!, cQ[3 * k + 2]!, cD[k]!, cN[3 * k]!, cN[3 * k + 1]!, cN[3 * k + 2]!, cR[k]!, cIn[k]!);
        query(k, reach, P);
      }
    }
  }
  function undoLookAhead(): void {
    for (let i = 0; i < saved.length; i += 11) {
      const k = saved[i]!;
      cHas[k] = saved[i + 1]!;
      cQ[3 * k] = saved[i + 2]!;
      cQ[3 * k + 1] = saved[i + 3]!;
      cQ[3 * k + 2] = saved[i + 4]!;
      cD[k] = saved[i + 5]!;
      cN[3 * k] = saved[i + 6]!;
      cN[3 * k + 1] = saved[i + 7]!;
      cN[3 * k + 2] = saved[i + 8]!;
      cR[k] = saved[i + 9]!;
      cIn[k] = saved[i + 10]!;
    }
    saved.length = 0;
  }
  /** Nodes asked again by the last refreshContacts. */
  let fresh = new Uint8Array(0);
  function refreshContacts(first: boolean): number {
    let q = 0;
    fresh = new Uint8Array(nn);
    for (let k = 0; k < nn; k++) {
      if (needsQuery(k)) {
        if (first || cHas[k] === 0) query(k, reach0);
        else requery(k);
        fresh[k] = 1;
        q++;
      }
    }
    return q;
  }

  /**
   * Correct "outside" answers that cannot be true. The size of a distance
   * answer is reliable even when its sign is not (overlapping or nested
   * bodies, distance to the nearest surface of any one body): if |d_i| + |d_j|
   * exceeds the distance between two neighbouring query points, no surface
   * lies on the segment between them, so both are on the same side. An inside answer then makes its neighbour
   * inside too, and so on along the chain. Only inside spreads: a
   * nearest-surface answer can call a point in solid outside, never the
   * reverse.
   */
  function inferInside(): void {
    if (!contactFn) return;
    for (let pass = 0; pass < 2; pass++) {
      const order = pass === 0 ? 1 : -1;
      for (let s0 = 0; s0 < nn - 1; s0++) {
        const i = order > 0 ? s0 : nn - 1 - s0;
        const j = i + order;
        // (A borrowed entry plane says nothing about distance at the node.)
        if (cHas[i] !== 2 || cHas[j] !== 2 || !cIn[i] || cIn[j] || fixedN[j] || esc[i] || esc[j]) continue;
        const L = Math.hypot(cQ[3 * j]! - cQ[3 * i]!, cQ[3 * j + 1]! - cQ[3 * i + 1]!, cQ[3 * j + 2]! - cQ[3 * i + 2]!);
        if (Math.abs(cD[i]!) + Math.abs(cD[j]!) > L * (1 + 1e-9) + 1e-12) {
          cIn[j] = 1;
          cD[j] = -Math.abs(cD[j]!);
        }
      }
    }
  }
  /** The outward way two outside nodes agree on, or null. */
  function way(i: number, j: number): V3 | null {
    if (cHas[i] !== 2 || cIn[i] || cHas[j] !== 2 || cIn[j]) return null;
    const agree = cN[3 * i]! * cN[3 * j]! + cN[3 * i + 1]! * cN[3 * j + 1]! + cN[3 * i + 2]! * cN[3 * j + 2]!;
    if (agree < 0) return null;
    return unit3([cN[3 * i]! + cN[3 * j]!, cN[3 * i + 1]! + cN[3 * j + 1]!, cN[3 * i + 2]! + cN[3 * j + 2]!]);
  }
  /** Replace nodes strictly between a and b (same stretch) by an arc bowed the way they agree on. */
  function relay(a: number, b: number): boolean {
    const n = way(a, b);
    if (!n) return false;
    const pieces = b - a;
    const pts = arcBetween(X, a, b, pieces * H[segS[a]!]!, n, pieces);
    for (let q = 1; q < pieces; q++) {
      const kk = a + q;
      for (let d = 0; d < 3; d++) X[3 * kk + d] = pts[3 * q + d]!;
      cHas[kk] = 0;
      esc[kk] = 0;
    }
    return true;
  }
  /**
   * Before solving, take the parts of the start that are inside solid out of
   * it, the way a hand frees a wire: pull it out where it went in rather than
   * through each node's own nearest face (which tears a loop lying deep in a
   * thick body apart in opposite directions).
   *  - A stretch with at least half its inner nodes inside is replaced by an
   *    arc of its length between its pins, bowed the way both pins face.
   *  - Otherwise each run of inside nodes whose two outside neighbours face
   *    the same way is replaced by such an arc between them.
   *  - A run whose neighbours face apart (it passes right through a body):
   *    laid, the run is lifted out along the way most of its nodes face, by
   *    the depth of the deepest of those, and the stretch's pieces are spread
   *    evenly along the result; cut, the whole stretch is laid out as an arc
   *    from its pins if they face the same way.
   * Returns whether anything moved; what is left inside is let out gradually.
   */
  function reroute(): boolean {
    if (!contactFn) return false;
    let movedAny = false;
    const relaid = new Uint8Array(nStr);
    for (const st of strs) {
      if (st.fixed) continue;
      // A stretch mostly inside solid is laid out afresh from its pins: with
      // bodies that overlap or nest, a nearest-surface answer calls some
      // points in solid outside, which breaks it into runs that say nothing
      // useful about the way out.
      let inside = 0;
      for (let i = st.a + 1; i < st.b; i++) if (cHas[i] === 2 && cIn[i]) inside++;
      let k = 2 * inside >= st.n - 1 ? st.b : st.a + 1;
      if (k === st.b && inside > 0) {
        if (relay(st.a, st.b)) movedAny = true;
        continue;
      }
      while (k < st.b) {
        if (!(cHas[k] === 2 && cIn[k])) {
          k++;
          continue;
        }
        let e = k;
        while (e + 1 < st.b && cHas[e + 1] === 2 && cIn[e + 1]) e++;
        const a = k - 1;
        const b = e + 1;
        k = e + 1;
        // Out the way both ends face. Ends facing apart (the run passes right
        // through a body) give no such way: then the whole stretch is laid
        // out afresh from its pins.
        if (way(a, b)) {
          if (relay(a, b)) movedAny = true;
          continue;
        }
        if (laid) {
          // Laid, the length is free: lift the whole run out along the way
          // most of its nodes face, as far as the deepest of those is in, and
          // let the stretch take its pieces evenly along that path.
          let bestQ = a + 1;
          let bestCount = -1;
          for (let q = a + 1; q < b; q++) {
            let count = 0;
            for (let o = a + 1; o < b; o++) if (cN[3 * q]! * cN[3 * o]! + cN[3 * q + 1]! * cN[3 * o + 1]! + cN[3 * q + 2]! * cN[3 * o + 2]! > 0.9) count++;
            if (count > bestCount) {
              bestCount = count;
              bestQ = q;
            }
          }
          const nx = cN[3 * bestQ]!;
          const ny = cN[3 * bestQ + 1]!;
          const nz = cN[3 * bestQ + 2]!;
          let lift = 0;
          for (let q = a + 1; q < b; q++) if (cN[3 * q]! * nx + cN[3 * q + 1]! * ny + cN[3 * q + 2]! * nz > 0.9) lift = Math.max(lift, -gap(q, X));
          lift += 0.01 * spacing;
          for (let q = a + 1; q < b; q++) {
            X[3 * q] = X[3 * q]! + lift * nx;
            X[3 * q + 1] = X[3 * q + 1]! + lift * ny;
            X[3 * q + 2] = X[3 * q + 2]! + lift * nz;
          }
          relaid[strs.indexOf(st)] = 1;
          movedAny = true;
          continue;
        }
        if (relay(st.a, st.b)) movedAny = true;
        k = st.b;
      }
    }
    for (let j = 0; j < nStr; j++) {
      if (!relaid[j]) continue;
      const st = strs[j]!;
      const cur = X.slice(3 * st.a, 3 * st.b + 3);
      const even = resample(cur, st.n);
      for (let q = 1; q < st.n; q++) {
        for (let d = 0; d < 3; d++) X[3 * (st.a + q) + d] = even[3 * q + d]!;
        cHas[st.a + q] = 0;
        esc[st.a + q] = 0;
      }
      H[j] = polyLength(even) / st.n;
    }
    if (movedAny) {
      const P1 = X.slice();
      const H1 = H.slice();
      if (project(P1, H1, new Uint8Array(nn))) {
        X.set(P1);
        H.set(H1);
      }
    }
    return movedAny;
  }

  // ---- energy terms. A bending term is f = |u|²/S with u linear in the
  // node positions (coefficients tc) and depending on up to two h's.
  const tn = new Int32Array(3);
  const tc = new Float64Array(3);
  let tnp = 0;
  const tu = new Float64Array(3);
  let tS = 0;
  const thv = new Int32Array(2);
  const tJu = new Float64Array(6);
  const tDxh = new Float64Array(6);
  const tW = new Float64Array(6);
  let tnh = 0;

  /** Fill the term record for node k's joint; kind 0 joint, 1 held tangent with the piece before, 2 with the piece after. */
  function makeTerm(P: Float64Array, Hh: Float64Array, k: number, kind: number): boolean {
    if (kind === 0) {
      const ja = segS[k - 1]!;
      const jb = segS[k]!;
      const ha = Hh[ja]!;
      const hb = Hh[jb]!;
      if (!(ha > 1e-12 && hb > 1e-12)) return false;
      tnp = 3;
      tn[0] = k - 1;
      tn[1] = k;
      tn[2] = k + 1;
      tc[0] = 1 / ha;
      tc[1] = -1 / ha - 1 / hb;
      tc[2] = 1 / hb;
      tS = ha + hb;
      tnh = 2;
      thv[0] = strs[ja]!.hv >= 0 ? k - 1 : -1;
      thv[1] = strs[jb]!.hv >= 0 ? k : -1;
      for (let d = 0; d < 3; d++) {
        const ea = P[3 * k + d]! - P[3 * k - 3 + d]!;
        const eb = P[3 * k + 3 + d]! - P[3 * k + d]!;
        tu[d] = eb / hb - ea / ha;
        tJu[d] = ea / (ha * ha);
        tJu[3 + d] = -eb / (hb * hb);
        tW[d] = (-2 * ea) / (ha * ha * ha);
        tW[3 + d] = (2 * eb) / (hb * hb * hb);
      }
      tDxh[0] = -1 / (ha * ha);
      tDxh[1] = 1 / (ha * ha);
      tDxh[2] = 0;
      tDxh[3] = 0;
      tDxh[4] = 1 / (hb * hb);
      tDxh[5] = -1 / (hb * hb);
      return true;
    }
    const before = kind === 1;
    const seg = before ? k - 1 : k;
    const j = segS[seg]!;
    const h = Hh[j]!;
    if (!(h > 1e-12)) return false;
    tnp = 2;
    tS = h;
    tnh = 1;
    thv[0] = strs[j]!.hv >= 0 ? seg : -1;
    thv[1] = -1;
    if (before) {
      tn[0] = k - 1;
      tn[1] = k;
      tc[0] = 1 / h;
      tc[1] = -1 / h;
      for (let d = 0; d < 3; d++) {
        const e = P[3 * k + d]! - P[3 * k - 3 + d]!;
        tu[d] = tanN[3 * k + d]! - e / h;
        tJu[d] = e / (h * h);
        tW[d] = (-2 * e) / (h * h * h);
      }
      tDxh[0] = -1 / (h * h);
      tDxh[1] = 1 / (h * h);
    } else {
      tn[0] = k;
      tn[1] = k + 1;
      tc[0] = -1 / h;
      tc[1] = 1 / h;
      for (let d = 0; d < 3; d++) {
        const e = P[3 * k + 3 + d]! - P[3 * k + d]!;
        tu[d] = e / h - tanN[3 * k + d]!;
        tJu[d] = -e / (h * h);
        tW[d] = (2 * e) / (h * h * h);
      }
      tDxh[0] = 1 / (h * h);
      tDxh[1] = -1 / (h * h);
    }
    return true;
  }

  function forEachTerm(P: Float64Array, Hh: Float64Array, visit: () => void): void {
    for (let k = 0; k < nn; k++) {
      const hasA = k > 0;
      const hasB = k < nn - 1;
      if (hasTan[k]) {
        if (hasA && makeTerm(P, Hh, k, 1)) visit();
        if (hasB && makeTerm(P, Hh, k, 2)) visit();
      } else if (hasA && hasB && makeTerm(P, Hh, k, 0)) visit();
    }
  }

  function energy(P: Float64Array, Hh: Float64Array): number {
    let E = 0;
    forEachTerm(P, Hh, () => {
      E += (tu[0]! * tu[0]! + tu[1]! * tu[1]! + tu[2]! * tu[2]!) / tS;
    });
    if (weight > 0) {
      for (let i = 0; i < nn - 1; i++) {
        const h = Hh[segS[i]!]!;
        const z = up![0] * (P[3 * i]! + P[3 * i + 3]!) + up![1] * (P[3 * i + 1]! + P[3 * i + 4]!) + up![2] * (P[3 * i + 2]! + P[3 * i + 5]!);
        E += 0.5 * weight * h * z;
      }
    }
    if (tension > 0) for (let j = 0; j < nStr; j++) E += tension * strs[j]!.n * Hh[j]!;
    return E;
  }

  /** Largest penetration of a free node through its cached plane. */
  function violation(P: Float64Array): number {
    let v = 0;
    for (let k = 0; k < nn; k++) {
      if (fixedN[k]) continue;
      const g = gapC(k, P);
      if (-g > v) v = -g;
    }
    return v;
  }

  /** Total penetration of free nodes past their allowance. */
  function penetration(P: Float64Array): number {
    let v = 0;
    for (let k = 0; k < nn; k++) {
      if (fixedN[k]) continue;
      const g = gapC(k, P);
      if (g < 0) v -= g;
    }
    return v;
  }

  /**
   * Make a trial shape feasible: exact piece lengths, and every node on or
   * outside its contact plane. Nodes held on a plane (act) and nodes pushed
   * back onto one move only within it while the lengths are restored.
   */
  function restore(P: Float64Array, Hh: Float64Array, act: Uint8Array): boolean {
    if (restoreExact(P, Hh, act)) return true;
    // Nodes pushed back onto planes that face each other (inside overlapping
    // bodies, whose nearest faces point different ways) can leave no shape
    // with exact lengths that keeps every pushed node on its plane. Then
    // alternate: restore the lengths with only the held nodes kept in their
    // planes, push what went through back out, repeat. Lengths end exact; a
    // little penetration may be left, which the line search weighs.
    P.set(restoreP);
    Hh.set(restoreH);
    act.set(restoreAct);
    let ok = false;
    const none = new Uint8Array(nn);
    for (let round = 0; round < 8; round++) {
      ok = project(P, Hh, none);
      let pushed = false;
      for (let k = 0; k < nn; k++) {
        if (fixedN[k] || cHas[k] !== 2) continue;
        const g = gapC(k, P);
        if (g < -1e-9 * spacing) {
          for (let d = 0; d < 3; d++) P[3 * k + d] = P[3 * k + d]! - g * cN[3 * k + d]!;
          pushed = true;
        }
      }
      if (!pushed) break;
    }
    ok = project(P, Hh, none);
    return ok;
  }
  let restoreP = new Float64Array(0);
  let restoreH = new Float64Array(0);
  let restoreAct = new Uint8Array(0);
  function restoreExact(P: Float64Array, Hh: Float64Array, act: Uint8Array): boolean {
    if (restoreP.length !== P.length) restoreP = new Float64Array(P.length);
    if (restoreH.length !== Hh.length) restoreH = new Float64Array(Hh.length);
    if (restoreAct.length !== act.length) restoreAct = new Uint8Array(act.length);
    restoreP.set(P);
    restoreH.set(Hh);
    restoreAct.set(act);
    let ok = project(P, Hh, act);
    for (let round = 0; round < 6; round++) {
      let pushed = false;
      for (let k = 0; k < nn; k++) {
        if (fixedN[k] || cHas[k] !== 2) continue;
        const g = gapC(k, P);
        if (g < 0) {
          for (let d = 0; d < 3; d++) P[3 * k + d] = P[3 * k + d]! - g * cN[3 * k + d]!;
          act[k] = 1;
          if (-g > 1e-12 * spacing) pushed = true;
        }
      }
      if (!pushed) break;
      ok = project(P, Hh, act);
    }
    return ok;
  }

  // ---- projection back onto exact piece lengths (Gauss-Newton, min-norm).
  const projOk = { residual: 0 };
  function project(P: Float64Array, Hh: Float64Array, act: Uint8Array): boolean {
    let prev = Infinity;
    let slow = 0;
    for (let it = 0; it < 40; it++) {
      let worst = 0;
      for (let j = 0; j < nStr; j++) {
        const st = strs[j]!;
        if (st.fixed) continue;
        const h = Hh[j]!;
        for (let i = st.a; i < st.b; i++) {
          const ex = P[3 * i + 3]! - P[3 * i]!;
          const ey = P[3 * i + 4]! - P[3 * i + 1]!;
          const ez = P[3 * i + 5]! - P[3 * i + 2]!;
          const c = Math.abs(Math.sqrt(ex * ex + ey * ey + ez * ez) - h);
          if (c > worst) worst = c;
        }
      }
      projOk.residual = worst;
      if (!Number.isFinite(worst)) return false;
      if (worst <= 1e-11 * spacing) return true;
      // Gauss-Newton converges fast when the lengths can be met; residuals
      // that stop shrinking mean they cannot (from here), so stop early.
      slow = worst > 0.5 * prev ? slow + 1 : 0;
      if (slow >= 10) return worst <= 1e-9 * spacing;
      prev = worst;
      for (let j = 0; j < nStr; j++) {
        const st = strs[j]!;
        if (st.fixed) continue;
        projectStretch(P, Hh, act, j);
      }
    }
    return projOk.residual <= 1e-9 * spacing;
  }

  // scratch for projectStretch
  let pd = new Float64Array(0);
  let po = new Float64Array(0);
  let pc = new Float64Array(0);
  let pv = new Float64Array(0);
  let pa = new Float64Array(0);
  let pb = new Float64Array(0);
  let pdx = new Float64Array(0);
  let pcp = new Float64Array(0);
  /** e_i^T M_k e_q for node k (M = 0 fixed, in-plane projector if in contact, identity otherwise). */
  function mDot(k: number, P: Float64Array, i: number, q: number, act: Uint8Array): number {
    if (fixedN[k]) return 0;
    const ex = P[3 * i + 3]! - P[3 * i]!;
    const ey = P[3 * i + 4]! - P[3 * i + 1]!;
    const ez = P[3 * i + 5]! - P[3 * i + 2]!;
    const fx = P[3 * q + 3]! - P[3 * q]!;
    const fy = P[3 * q + 4]! - P[3 * q + 1]!;
    const fz = P[3 * q + 5]! - P[3 * q + 2]!;
    let s = ex * fx + ey * fy + ez * fz;
    if (act[k] && cHas[k] === 2) {
      const nx = cN[3 * k]!;
      const ny = cN[3 * k + 1]!;
      const nz = cN[3 * k + 2]!;
      s -= (ex * nx + ey * ny + ez * nz) * (fx * nx + fy * ny + fz * nz);
    }
    return s;
  }
  function projectStretch(P: Float64Array, Hh: Float64Array, act: Uint8Array, j: number): void {
    const st = strs[j]!;
    const n = st.n;
    if (pd.length < n) {
      pd = new Float64Array(n);
      po = new Float64Array(n);
      pc = new Float64Array(n);
      pv = new Float64Array(n);
      pa = new Float64Array(n);
      pb = new Float64Array(n);
    }
    const hs = st.hs;
    const h = Hh[j]!;
    const free = st.hv >= 0;
    const w = free ? 1 / n : 0;
    for (let q = 0; q < n; q++) {
      const i = st.a + q;
      const ex = P[3 * i + 3]! - P[3 * i]!;
      const ey = P[3 * i + 4]! - P[3 * i + 1]!;
      const ez = P[3 * i + 5]! - P[3 * i + 2]!;
      pc[q] = (ex * ex + ey * ey + ez * ez - h * h) / (2 * hs);
      pd[q] = (mDot(i, P, i, i, act) + mDot(i + 1, P, i, i, act)) / (hs * hs) + 1e-14 * (h / hs) * (h / hs);
      po[q] = q < n - 1 ? -mDot(i + 1, P, i, i + 1, act) / (hs * hs) : 0;
      pv[q] = -h / hs;
    }
    // Solve T a = c and T b = v (symmetric tridiagonal, Thomas).
    thomas(n, pc, pa);
    if (free) thomas(n, pv, pb);
    const y = pa;
    let dh = 0;
    if (free) {
      let va = 0;
      let vb = 0;
      for (let q = 0; q < n; q++) {
        va += pv[q]! * pa[q]!;
        vb += pv[q]! * pb[q]!;
      }
      const f = (w * va) / (1 + w * vb);
      for (let q = 0; q < n; q++) y[q] = pa[q]! - f * pb[q]!;
      let vy = 0;
      for (let q = 0; q < n; q++) vy += pv[q]! * y[q]!;
      dh = -w * vy;
    }
    // Δx = -M Jᵀ y.
    if (pdx.length < 3 * (n + 1)) pdx = new Float64Array(3 * (n + 1));
    const dx = pdx;
    dx.fill(0, 0, 3 * (n + 1));
    for (let q = 0; q < n; q++) {
      const i = st.a + q;
      const s = y[q]! / hs;
      for (let d = 0; d < 3; d++) {
        const e = P[3 * i + 3 + d]! - P[3 * i + d]!;
        dx[3 * q + 3 + d] = dx[3 * q + 3 + d]! - (s * e);
        dx[3 * q + d] = dx[3 * q + d]! + (s * e);
      }
    }
    for (let q = 0; q <= n; q++) {
      const k = st.a + q;
      if (fixedN[k]) continue;
      let ax = dx[3 * q]!;
      let ay = dx[3 * q + 1]!;
      let az = dx[3 * q + 2]!;
      if (act[k] && cHas[k] === 2) {
        const nx = cN[3 * k]!;
        const ny = cN[3 * k + 1]!;
        const nz = cN[3 * k + 2]!;
        const dn = ax * nx + ay * ny + az * nz;
        ax -= dn * nx;
        ay -= dn * ny;
        az -= dn * nz;
      }
      P[3 * k] = P[3 * k]! + ax;
      P[3 * k + 1] = P[3 * k + 1]! + ay;
      P[3 * k + 2] = P[3 * k + 2]! + az;
    }
    if (free) Hh[j] = Math.max(0.2 * Hh[j]!, Hh[j]! + dh);
  }
  function thomas(n: number, rhs: Float64Array, out: Float64Array): void {
    // Symmetric tridiagonal: diag pd, off po (po[q] couples q and q+1).
    if (pcp.length < n) pcp = new Float64Array(n);
    const cp = pcp;
    let prevC = 0;
    let prevD = 0;
    for (let q = 0; q < n; q++) {
      const lo = q > 0 ? po[q - 1]! : 0;
      let den = pd[q]! - lo * prevC;
      if (!(Math.abs(den) > 1e-300)) den = 1e-300;
      cp[q] = po[q]! / den;
      out[q] = (rhs[q]! - lo * prevD) / den;
      prevC = cp[q]!;
      prevD = out[q]!;
    }
    for (let q = n - 2; q >= 0; q--) out[q] = out[q]! - cp[q]! * out[q + 1]!;
  }

  // ---- KKT assembly.
  let nK = 0;
  let K0 = new Float64Array(0);
  let r0 = new Float64Array(0);
  let Kf = new Float64Array(0);
  let rf = new Float64Array(0);
  let piv = new Int32Array(0);
  function ensureSize(): void {
    nK = NPN * nn;
    if (K0.length !== nK * BW) {
      K0 = new Float64Array(nK * BW);
      Kf = new Float64Array(nK * BW);
      r0 = new Float64Array(nK);
      rf = new Float64Array(nK);
      piv = new Int32Array(nK);
    }
  }
  function kadd(i: number, j: number, v: number): void {
    K0[i * BW + (j - i + KL)] = K0[i * BW + (j - i + KL)]! + (v);
  }

  function assemble(tau: number): void {
    ensureSize();
    K0.fill(0);
    r0.fill(0);
    const P = X;
    // bending
    forEachTerm(P, H, () => {
      const S = tS;
      const uu = tu[0]! * tu[0]! + tu[1]! * tu[1]! + tu[2]! * tu[2]!;
      for (let p = 0; p < tnp; p++) {
        const kp = tn[p]!;
        if (fixedN[kp]) continue;
        const cg = (2 * tc[p]!) / S;
        for (let d = 0; d < 3; d++) r0[NPN * kp + d] = r0[NPN * kp + d]! - (cg * tu[d]!);
        for (let q = 0; q < tnp; q++) {
          const kq = tn[q]!;
          if (fixedN[kq]) continue;
          const v = (2 * tc[p]! * tc[q]!) / S;
          for (let d = 0; d < 3; d++) kadd(NPN * kp + d, NPN * kq + d, v);
        }
      }
      for (let a = 0; a < tnh; a++) {
        const sa = thv[a]!;
        if (sa < 0) continue;
        const ra = NPN * sa + 5;
        const uJa = tu[0]! * tJu[3 * a]! + tu[1]! * tJu[3 * a + 1]! + tu[2]! * tJu[3 * a + 2]!;
        r0[ra] = r0[ra]! - ((2 * uJa) / S - uu / (S * S));
        for (let p = 0; p < tnp; p++) {
          const kp = tn[p]!;
          if (fixedN[kp]) continue;
          for (let d = 0; d < 3; d++) {
            const v = (2 * tc[p]! * tJu[3 * a + d]! + 2 * tDxh[3 * a + p]! * tu[d]!) / S - (2 * tc[p]! * tu[d]!) / (S * S);
            kadd(ra, NPN * kp + d, v);
            kadd(NPN * kp + d, ra, v);
          }
        }
        for (let b = 0; b < tnh; b++) {
          const sb = thv[b]!;
          if (sb < 0) continue;
          const uJb = tu[0]! * tJu[3 * b]! + tu[1]! * tJu[3 * b + 1]! + tu[2]! * tJu[3 * b + 2]!;
          const JJ = tJu[3 * a]! * tJu[3 * b]! + tJu[3 * a + 1]! * tJu[3 * b + 1]! + tJu[3 * a + 2]! * tJu[3 * b + 2]!;
          const uw = a === b ? tu[0]! * tW[3 * a]! + tu[1]! * tW[3 * a + 1]! + tu[2]! * tW[3 * a + 2]! : 0;
          kadd(ra, NPN * sb + 5, (2 * JJ + 2 * uw) / S - (2 * uJa + 2 * uJb) / (S * S) + (2 * uu) / (S * S * S));
        }
      }
    });
    // gravity
    if (weight > 0) {
      for (let i = 0; i < nn - 1; i++) {
        const j = segS[i]!;
        const h = H[j]!;
        const free = strs[j]!.hv >= 0;
        const ra = NPN * i + 5;
        for (const k of [i, i + 1]) {
          if (fixedN[k]) continue;
          for (let d = 0; d < 3; d++) {
            r0[NPN * k + d] = r0[NPN * k + d]! - 0.5 * weight * h * up![d]!;
            if (free) {
              kadd(ra, NPN * k + d, 0.5 * weight * up![d]!);
              kadd(NPN * k + d, ra, 0.5 * weight * up![d]!);
            }
          }
        }
        if (free) {
          const z = up![0] * (P[3 * i]! + P[3 * i + 3]!) + up![1] * (P[3 * i + 1]! + P[3 * i + 4]!) + up![2] * (P[3 * i + 2]! + P[3 * i + 5]!);
          r0[ra] = r0[ra]! - 0.5 * weight * z;
        }
      }
    }
    // tension, and the pieces of a stretch kept equal
    if (laid) {
      for (let i = 0; i < nn - 1; i++) {
        const ra = NPN * i + 5;
        const re = NPN * i + 6;
        const free = strs[segS[i]!]!.hv >= 0;
        if (!free) {
          kadd(ra, ra, 1);
          kadd(re, re, 1);
          continue;
        }
        r0[ra] = r0[ra]! - tension;
        kadd(ra, ra, tau);
        if (i + 1 < nn - 1 && segS[i + 1] === segS[i]) {
          kadd(re, ra, 1);
          kadd(ra, re, 1);
          kadd(re, NPN * (i + 1) + 5, -1);
          kadd(NPN * (i + 1) + 5, re, -1);
        } else kadd(re, re, 1);
      }
      kadd(NPN * (nn - 1) + 5, NPN * (nn - 1) + 5, 1);
      kadd(NPN * (nn - 1) + 6, NPN * (nn - 1) + 6, 1);
    }
    // length constraints
    for (let i = 0; i < nn - 1; i++) {
      const row = NPN * i + 4;
      if (!segC[i]) {
        kadd(row, row, 1);
        continue;
      }
      const j = segS[i]!;
      const st = strs[j]!;
      const hs = st.hs;
      const h = H[j]!;
      const e0 = P[3 * i + 3]! - P[3 * i]!;
      const e1 = P[3 * i + 4]! - P[3 * i + 1]!;
      const e2 = P[3 * i + 5]! - P[3 * i + 2]!;
      const e = [e0, e1, e2];
      r0[row] = -(e0 * e0 + e1 * e1 + e2 * e2 - h * h) / (2 * hs);
      const mi = (convexify ? Math.max(0, mu[i]!) : mu[i]!) / hs;
      const fa = fixedN[i]!;
      const fb = fixedN[i + 1]!;
      for (let d = 0; d < 3; d++) {
        if (!fb) {
          kadd(row, NPN * (i + 1) + d, e[d]! / hs);
          kadd(NPN * (i + 1) + d, row, e[d]! / hs);
          kadd(NPN * (i + 1) + d, NPN * (i + 1) + d, mi);
        }
        if (!fa) {
          kadd(row, NPN * i + d, -e[d]! / hs);
          kadd(NPN * i + d, row, -e[d]! / hs);
          kadd(NPN * i + d, NPN * i + d, mi);
        }
        if (!fa && !fb) {
          kadd(NPN * i + d, NPN * (i + 1) + d, -mi);
          kadd(NPN * (i + 1) + d, NPN * i + d, -mi);
        }
      }
      if (st.hv >= 0) {
        kadd(row, NPN * i + 5, -h / hs);
        kadd(NPN * i + 5, row, -h / hs);
        kadd(NPN * i + 5, NPN * i + 5, -(convexify ? Math.max(0, mu[i]!) : mu[i]!) / hs);
      }
    }
    kadd(NPN * (nn - 1) + 4, NPN * (nn - 1) + 4, 1);
    // damping, dead rows
    for (let k = 0; k < nn; k++) {
      kadd(NPN * k + 3, NPN * k + 3, 1);
      for (let d = 0; d < 3; d++) {
        if (fixedN[k]) {
          kadd(NPN * k + d, NPN * k + d, 1);
          r0[NPN * k + d] = 0;
        } else kadd(NPN * k + d, NPN * k + d, tau);
      }
    }
  }

  /** Solve the KKT system; returns the solution (node steps and new multipliers), with the h steps in dhOut, or null. */
  const dhOut = new Float64Array(m);
  function solveKKT(W: Uint8Array): Float64Array | null {
    Kf.set(K0);
    rf.set(r0);
    // Nodes held on their contact plane: -n.dx = g (multiplier: the contact force).
    for (let k = 0; k < nn; k++) {
      if (!W[k]) continue;
      const row = NPN * k + 3;
      Kf[row * BW + KL] = 0;
      for (let d = 0; d < 3; d++) {
        const v = -cN[3 * k + d]!;
        Kf[row * BW + (NPN * k + d - row + KL)] = v;
        Kf[(NPN * k + d) * BW + (row - (NPN * k + d) + KL)] = v;
      }
      rf[row] = gapC(k, X);
    }
    bandFactor(Kf, nK, piv, KL, KU);
    const z = rf.slice();
    bandSolve(Kf, nK, piv, z, KL, KU);
    for (const st of strs) if (st.hv >= 0) dhOut[st.hv] = z[NPN * st.a + 5]!;
    for (let i = 0; i < nK; i++) if (!Number.isFinite(z[i]!)) return null;
    for (let q = 0; q < m; q++) if (!Number.isFinite(dhOut[q]!)) return null;
    return z;
  }

  // ---- second-order check.
  /** The unknowns that are positions (and, laid, piece lengths): the primal part of the KKT vector. */
  function primal(i: number): boolean {
    const k = Math.floor(i / NPN);
    const r = i - NPN * k;
    if (r < 3) return !fixedN[k];
    return laid && r === 5 && k < nn - 1 && strs[segS[k]!]!.hv >= 0;
  }
  /**
   * Lowest curvature of the energy over the directions the constraints allow
   * (piece lengths kept, pins fixed, the nodes held on surfaces kept on their
   * planes): inverse iteration with the KKT matrix of the Lagrangian Hessian
   * plus a tiny shift, whose solves stay on those directions. Returns a unit
   * direction (KKT layout) along which the energy curves down, or null.
   * The start vector is built from the shape itself (turning about the
   * centroid, sliding along the wire, and node-to-node variation), so a turned
   * or moved copy of the problem probes the same way.
   */
  function negativeCurvature(W: Uint8Array): Float64Array | null {
    const sigma = 1e-6 * bendScale;
    const keepConvex = convexify;
    convexify = false;
    assemble(sigma);
    convexify = keepConvex;
    Kf.set(K0);
    for (let k = 0; k < nn; k++) {
      if (!W[k]) continue;
      const row = NPN * k + 3;
      Kf[row * BW + KL] = 0;
      for (let d = 0; d < 3; d++) {
        const v = -cN[3 * k + d]!;
        Kf[row * BW + (NPN * k + d - row + KL)] = v;
        Kf[(NPN * k + d) * BW + (row - (NPN * k + d) + KL)] = v;
      }
    }
    bandFactor(Kf, nK, piv, KL, KU);
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let k = 0; k < nn; k++) {
      cx += X[3 * k]! / nn;
      cy += X[3 * k + 1]! / nn;
      cz += X[3 * k + 2]! / nn;
    }
    let v = new Float64Array(nK);
    for (let k = 0; k < nn; k++) {
      if (fixedN[k]) continue;
      const i = Math.min(k, nn - 2);
      const tx = X[3 * i + 3]! - X[3 * i]!;
      const ty = X[3 * i + 4]! - X[3 * i + 1]!;
      const tz = X[3 * i + 5]! - X[3 * i + 2]!;
      const rx = X[3 * k]! - cx;
      const ry = X[3 * k + 1]! - cy;
      const rz = X[3 * k + 2]! - cz;
      const a = Math.sin(1.7 * k + 0.3);
      const b = Math.cos(2.9 * k + 0.1);
      v[NPN * k] = ry * tz - rz * ty + a * rx + b * tx;
      v[NPN * k + 1] = rz * tx - rx * tz + a * ry + b * ty;
      v[NPN * k + 2] = rx * ty - ry * tx + a * rz + b * tz;
    }
    const isP = new Uint8Array(nK);
    for (let i = 0; i < nK; i++) isP[i] = primal(i) ? 1 : 0;
    const norm = (w: Float64Array): number => {
      let q = 0;
      for (let i = 0; i < nK; i++) if (isP[i]) q += w[i]! * w[i]!;
      return Math.sqrt(q);
    };
    const curvature = (w: Float64Array): number => {
      let num = 0;
      let den = 0;
      for (let i = 0; i < nK; i++) {
        if (!isP[i]) continue;
        den += w[i]! * w[i]!;
        let hw = -sigma * w[i]!;
        const j0 = Math.max(0, i - KL);
        const j1 = Math.min(nK - 1, i + KL);
        for (let j = j0; j <= j1; j++) if (isP[j]) hw += K0[i * BW + (j - i + KL)]! * w[j]!;
        num += w[i]! * hw;
      }
      return den > 0 ? num / den : 0;
    };
    let best: Float64Array | null = null;
    let bestC = Infinity;
    for (let it = 0; it < 24; it++) {
      if (overBudget()) {
        checkCut = true;
        return null;
      }
      const w = new Float64Array(nK);
      for (let i = 0; i < nK; i++) if (isP[i]) w[i] = v[i]!;
      bandSolve(Kf, nK, piv, w, KL, KU);
      for (let i = 0; i < nK; i++) if (!isP[i]) w[i] = 0;
      const n = norm(w);
      if (!(n > 0) || !Number.isFinite(n)) break;
      for (let i = 0; i < nK; i++) w[i] = w[i]! / n;
      if (it % 4 === 3) {
        const c = curvature(w);
        if (c < bestC) {
          bestC = c;
          best = w;
        }
      }
      v = w;
    }
    // Curving down, beyond what rounding in the Hessian can produce.
    let scale = 0;
    for (let k = 0; k < nn; k++) if (!fixedN[k]) scale = Math.max(scale, Math.abs(K0[NPN * k * BW + KL]!));
    lastNegative = Math.max(0, -bestC);
    return best && bestC < -1e-9 * Math.max(scale, bendScale) ? best : null;
  }
  /** Step along a direction of negative curvature, whichever way lowers the energy more; false if neither does. */
  function leaveSaddle(dir: Float64Array, W: Uint8Array): boolean {
    let mx = 0;
    for (let k = 0; k < nn; k++) if (!fixedN[k]) mx = Math.max(mx, Math.hypot(dir[NPN * k]!, dir[NPN * k + 1]!, dir[NPN * k + 2]!));
    if (!(mx > 0)) return false;
    const E0 = energy(X, H);
    const P = new Float64Array(X.length);
    const Hh = new Float64Array(nStr);
    const act = new Uint8Array(nn);
    let bestE = E0 - 1e-12 * Math.abs(E0);
    let bestP: Float64Array | null = null;
    let bestH: Float64Array | null = null;
    for (const sign of [1, -1]) {
      // From a move of a tenth of the wire's length down: a soft mode (a loop
      // turning about its chord) gains little over a short step.
      for (let t = Math.max(0.1 * totalLen, spacing) / mx, tries = 0; tries < 16; t *= 0.5, tries++) {
        for (let k = 0; k < nn; k++) for (let d = 0; d < 3; d++) P[3 * k + d] = X[3 * k + d]! + (fixedN[k] ? 0 : sign * t * dir[NPN * k + d]!);
        Hh.set(H);
        if (laid) for (const st of strs) if (st.hv >= 0) Hh[strs.indexOf(st)] = Math.max(0.5 * H[strs.indexOf(st)]!, H[strs.indexOf(st)]! + sign * t * dir[NPN * st.a + 5]!);
        act.set(W);
        if (!restore(P, Hh, act)) continue;
        if (violation(P) > Math.max(violation(X), 1e-9 * spacing)) continue;
        const E = energy(P, Hh);
        if (E < E0 - 1e-12 * Math.abs(E0)) {
          if (E < bestE) {
            bestE = E;
            bestP = P.slice();
            bestH = Hh.slice();
          }
          break;
        }
      }
    }
    // A negative curvature of a whole stretch is usually the stretch turning
    // about its chord (a loop above its ends under gravity). A straight step
    // along it gains little before the geometry bends away, so also try the
    // stretch turned rigidly about its chord by multiples of 45 degrees.
    for (let j = 0; j < nStr; j++) {
      const st = strs[j]!;
      if (st.fixed || st.b - st.a < 2) continue;
      const ax = X[3 * st.b]! - X[3 * st.a]!;
      const ay = X[3 * st.b + 1]! - X[3 * st.a + 1]!;
      const az = X[3 * st.b + 2]! - X[3 * st.a + 2]!;
      const al = Math.hypot(ax, ay, az);
      if (!(al > 1e-9 * spacing)) continue;
      const ux = ax / al;
      const uy = ay / al;
      const uz = az / al;
      for (let q = 1; q < 8; q++) {
        const th = (q * Math.PI) / 4;
        const c = Math.cos(th);
        const sn = Math.sin(th);
        P.set(X);
        for (let k = st.a + 1; k < st.b; k++) {
          const rx = X[3 * k]! - X[3 * st.a]!;
          const ry = X[3 * k + 1]! - X[3 * st.a + 1]!;
          const rz = X[3 * k + 2]! - X[3 * st.a + 2]!;
          const dot = rx * ux + ry * uy + rz * uz;
          const cx = uy * rz - uz * ry;
          const cy = uz * rx - ux * rz;
          const cz = ux * ry - uy * rx;
          P[3 * k] = X[3 * st.a]! + rx * c + cx * sn + ux * dot * (1 - c);
          P[3 * k + 1] = X[3 * st.a + 1]! + ry * c + cy * sn + uy * dot * (1 - c);
          P[3 * k + 2] = X[3 * st.a + 2]! + rz * c + cz * sn + uz * dot * (1 - c);
        }
        Hh.set(H);
        act.fill(0);
        if (!restore(P, Hh, act)) continue;
        if (violation(P) > Math.max(violation(X), 1e-9 * spacing)) continue;
        const E = energy(P, Hh);
        if (E < bestE) {
          bestE = E;
          bestP = P.slice();
          bestH = Hh.slice();
        }
      }
    }
    if (!bestP || !bestH) return false;
    X.set(bestP);
    H.set(bestH);
    return true;
  }

  // ---- main loop.
  {
    const P0 = X.slice();
    const H0 = H.slice();
    if (project(P0, H0, new Uint8Array(nn))) {
      X.set(P0);
      H.set(H0);
    }
  }
  refreshContacts(true);
  inferInside();
  if (reroute()) {
    refreshContacts(false);
    inferInside();
  }
  assignEscape();
  for (let k = 0; k < nn; k++) if (!fixedN[k] && cHas[k] === 2 && -gap(k, X) > 0.05 * spacing) allow[k] = -gap(k, X);
  setFloor();

  let converged = false;
  let iterations = 0;
  let finalChecks = 0;
  let resamples = 0;
  const maxMove = Math.max(0.05 * totalLen, 4 * spacing);
  let Pt = new Float64Array(0);
  const Ht = new Float64Array(nStr);
  let prevW = new Uint8Array(0);
  let saddleExits = 0;
  /** The time budget ran out during the second-order check: not converged. */
  let checkCut = false;
  let strict = false;
  let lastNegative = 0;
  let bestX = new Float64Array(0);
  let bestH = new Float64Array(0);
  let bestWorst = Infinity;
  let bestSum = Infinity;
  let rho = 0;
  let restarts = 0;
  const epsB = Math.max(1e-3 * touchTol, 1e-9 * spacing);
  const vTol = Math.max(1e-9 * spacing, 1e-3 * touchTol);

  for (let iter = 0; iter < maxIter; iter++) {
    if (overBudget()) break;
    iterations = iter + 1;
    const requeried = refreshContacts(false);
    inferInside();
    assignEscape();
    // A node found deep inside solid (it got there between two looks at the
    // surface) is let out gradually too, like a start inside solid.
    for (let k = 0; k < nn; k++) {
      if (fixedN[k] || cHas[k] !== 2) continue;
      const depth = -gap(k, X);
      if (fresh[k]) {
        if (depth > 0.05 * spacing && depth > allow[k]!) allow[k] = depth;
      } else if (depth - allow[k]! > 0.5 * spacing) {
        // Further in than the allowance by more than a step can push it out
        // (a surface seen late, or one body's face hiding another's): widen
        // the allowance so the push stays gradual.
        allow[k] = depth - 0.25 * spacing;
      }
    }
    assemble(tau);
    // Held set: nodes on (or through) their plane that the rod presses into
    // it. The pressing force is the Lagrangian force with the current tensions.
    const W = new Uint8Array(nn);
    for (let k = 0; k < nn; k++) {
      if (fixedN[k] || cHas[k] !== 2) continue;
      const g = gapC(k, X);
      if (g < -epsB) {
        W[k] = 1;
        continue;
      }
      if (g > 0.05 * spacing) continue;
      // Held last step and not let go by its own solve: stays held (the
      // force estimate below uses tensions from before the step and is noisy
      // for a node pressed only lightly).
      if (prevW.length === nn && prevW[k]) {
        W[k] = 1;
        continue;
      }
      if (g > epsB) continue;
      let fn = 0;
      for (let d = 0; d < 3; d++) {
        let f = r0[NPN * k + d]!;
        if (k < nn - 1 && segC[k]) f += (mu[k]! * (X[3 * k + 3 + d]! - X[3 * k + d]!)) / strs[segS[k]!]!.hs;
        if (k > 0 && segC[k - 1]) f -= (mu[k - 1]! * (X[3 * k + d]! - X[3 * k - 3 + d]!)) / strs[segS[k - 1]!]!.hs;
        fn += f * cN[3 * k + d]!;
      }
      if (fn < 0) W[k] = 1;
    }
    let z = solveKKT(W);
    // Let go, all at once, of held nodes whose contact force comes out
    // pulling; nodes the step then sends through a surface are put back on it
    // by the line search.
    for (let inner = 0; inner < 3 && z && !overBudget(); inner++) {
      let released = false;
      for (let k = 0; k < nn; k++) {
        if (W[k] && z[NPN * k + 3]! < 0 && gapC(k, X) > -epsB) {
          W[k] = 0;
          released = true;
        }
      }
      if (!released) break;
      z = solveKKT(W);
    }
    if (!z) {
      tau *= 10;
      if (tau > tauMax) break;
      continue;
    }
    let stepNorm = 0;
    for (let k = 0; k < nn; k++) {
      if (fixedN[k]) continue;
      const s = Math.hypot(z[NPN * k]!, z[NPN * k + 1]!, z[NPN * k + 2]!);
      if (s > stepNorm) stepNorm = s;
    }
    let hStep = 0;
    for (let q = 0; q < m; q++) hStep = Math.max(hStep, Math.abs(dhOut[q]!));
    // A small step only means settled when the damping is not what made it small.
    // Or when the energy the step promises is below what the energy can
    // resolve: a nearly neutral mode (a loop turning about its chord under a
    // very light weight) creeps for ever otherwise.
    let promised = 0;
    for (let k = 0; k < nn; k++) if (!fixedN[k]) for (let d = 0; d < 3; d++) promised += r0[NPN * k + d]! * z[NPN * k + d]!;
    if (laid) for (let i = 0; i < nn - 1; i++) if (strs[segS[i]!]!.hv >= 0) promised += r0[NPN * i + 5]! * z[NPN * i + 5]!;
    const settled = tau <= 1e-3 * bendScale && !convexify;
    const tiny = settled && ((stepNorm <= tol * spacing && hStep <= tol * spacing) || Math.abs(promised) <= 1e-12 * Math.abs(energy(X, H)));
    prevW = W;

    // Line search on an exact penalty: energy plus rho times the total
    // penetration past the allowance, rho above the largest contact force.
    let nuMax = 0;
    for (let k = 0; k < nn; k++) if (W[k]) nuMax = Math.max(nuMax, Math.abs(z[NPN * k + 3]!));
    // Capped: a held node pushed against its neighbours can come out with an
    // enormous force, and an unbounded weight then lets any energy through.
    rho = Math.min(Math.max(2 * nuMax, 0.5 * rho), 100 * bendScale * spacing);
    const E0 = energy(X, H);
    const V0 = violation(X);
    const F0 = E0 + rho * penetration(X);
    let alpha = Math.min(1, maxMove / Math.max(stepNorm, 1e-300));
    const alphaStart = alpha;
    let accepted = false;
    if (Pt.length !== X.length) Pt = new Float64Array(X.length);
    const act = new Uint8Array(nn);
    for (let ls = 0; ls < 14 && !overBudget(); ls++) {
      for (let k = 0; k < nn; k++) for (let d = 0; d < 3; d++) Pt[3 * k + d] = X[3 * k + d]! + (fixedN[k] ? 0 : alpha * z[NPN * k + d]!);
      Ht.set(H);
      for (let j = 0; j < nStr; j++) {
        const hv = strs[j]!.hv;
        if (hv >= 0) Ht[j] = Math.min(1.1 * H[j]!, Math.max(0.9 * H[j]!, H[j]! + alpha * dhOut[hv]!));
      }
      act.set(W);
      // A node that would travel further than its last look at the surface
      // vouches for looks again from where it would land, so it cannot pass
      // into solid unseen.
      const passes = (): boolean => {
        // Exact lengths and no new penetration always; a step too small to
        // matter is taken whatever the energy says (rounding decides it).
        if (!restore(Pt, Ht, act)) return false;
        const Ft = energy(Pt, Ht) + rho * penetration(Pt);
        const Vt = violation(Pt);
        if (!Number.isFinite(Ft) || Vt > Math.max(V0, vTol)) return false;
        return tiny || Ft <= F0 + (strict ? -1e-15 : 1e-10) * Math.abs(F0);
      };
      if (passes()) {
        // Only a trial that passes looks ahead, and is judged again with
        // what it saw.
        lookAhead(Pt);
        if (saved.length === 0 || passes()) {
          accepted = true;
          break;
        }
      }
      undoLookAhead();
      alpha *= 0.5;
    }
    if (!accepted) {
      tau *= 10;
      convexify = true;
      fullSteps = 0;
      if (tau > tauMax) {
        // No step is accepted at any damping: the shape cannot be made
        // feasible from here in one go. Accept where every node is now as the
        // allowance, start the damping again, and let the allowance shrink
        // from there. Give up only after this has failed repeatedly in a row.
        if (++restarts > 3) break;
        for (let k = 0; k < nn; k++) if (!fixedN[k] && cHas[k] === 2) allow[k] = Math.max(allow[k]!, -gap(k, X));
        tau = 1e-6 * bendScale;
        prevW = new Uint8Array(0);
      }
      continue;
    }
    restarts = 0;
    X.set(Pt);
    H.set(Ht);
    for (let i = 0; i < nn - 1; i++) if (segC[i]) mu[i] = mu[i]! + alpha * (z[NPN * i + 4]! - mu[i]!);
    const full = alpha === alphaStart;
    if (full) {
      tau = Math.max(strict ? Math.max(tauMin, 4 * lastNegative) : tauMin, tau / 4);
      if (++fullSteps >= 2) convexify = false;
    } else {
      fullSteps = 0;
      if (alpha < 0.5) convexify = true;
      if (alpha < 0.1) tau = Math.min(tauMax, tau * 10);
    }
    let allowed = 0;
    for (let k = 0; k < nn; k++) {
      if (allow[k]! === 0) continue;
      const fl = allowFloor[k]!;
      // Halved with each full step.
      const cur = allow[k]! - fl;
      const a = Math.min(full ? 0.5 * cur : cur, Math.max(0, -gap(k, X) - fl));
      allow[k] = fl + (a < 0.05 * spacing ? 0 : a);
      allowed = Math.max(allowed, allow[k]! - fl);
    }

    // Keep the least penetrating shape seen, for a solve that ends unconverged.
    {
      let worstD = 0;
      let sumD = 0;
      for (let k = 0; k < nn; k++) {
        if (fixedN[k]) continue;
        const dpt = -(gap(k, X) + allowFloor[k]!);
        if (dpt > 0) {
          sumD += dpt;
          if (dpt > worstD) worstD = dpt;
        }
      }
      if (bestX.length !== X.length || worstD < bestWorst - 1e-12 || (worstD <= bestWorst + 1e-12 && sumD < bestSum)) {
        bestX = X.slice();
        bestH = H.slice();
        bestWorst = worstD;
        bestSum = sumD;
      }
    }

    if (tiny && requeried === 0 && allowed === 0) {
      // Final contact check: ask again at the final position for nodes on or near a surface.
      let changed = false;
      if (contactFn && finalChecks < 10) {
        finalChecks++;
        for (let k = 0; k < nn; k++) {
          if (fixedN[k] || cHas[k] !== 2) continue;
          if (gap(k, X) > 0.5 * spacing) continue;
          if (moved(k, X) <= 1e-9 * spacing) continue;
          if (requery(k)) changed = true;
        }
      }
      if (changed) continue;
      // A stationary point is only a minimum if the energy curves up in every
      // direction the constraints allow. Otherwise leave along the direction
      // in which it curves down, and carry on.
      if (overBudget()) break;
      if (saddleExits < 20) {
        const dir = negativeCurvature(W);
        if (checkCut) break;
        if (dir && leaveSaddle(dir, W)) {
          saddleExits++;
          prevW = new Uint8Array(0);
          // Keep the model convex along the way down, and accept only steps
          // that lower the energy: the projection noise the usual acceptance
          // allows for would otherwise let Newton climb back to the saddle.
          tau = Math.max(tau, 4 * lastNegative);
          strict = true;
          continue;
        }
      }
      converged = true;
      break;
    }

    // Laid: keep the spacing near the target.
    if (laid && resamples < 30) {
      let redo = false;
      for (let j = 0; j < nStr; j++) {
        const st = strs[j]!;
        if (st.hv < 0) continue;
        const ratio = H[j]! / spacing;
        // Pieces that have grown are only refined once the shape has nearly
        // settled: refining a start that still has corners raises its
        // (discrete) bending energy, and doing that every few steps lets a
        // kinked start ratchet itself into a long loop.
        const grown = ratio > 1.6 && stepNorm * alpha < 0.05 * spacing;
        if ((ratio < 0.6 || grown) && Math.max(2, Math.round((st.n * H[j]!) / spacing)) !== st.n) redo = true;
      }
      if (redo) {
        resamples++;
        const ps: Float64Array[] = [];
        const muPer: number[] = [];
        for (let j = 0; j < nStr; j++) {
          const st = strs[j]!;
          const cur = X.slice(3 * st.a, 3 * st.b + 3);
          let mAvg = 0;
          for (let i = st.a; i < st.b; i++) mAvg += mu[i]!;
          muPer.push(st.n > 0 ? mAvg / st.n : 0);
          if (st.hv < 0) {
            ps.push(cur);
            continue;
          }
          const n = Math.min(2 * st.n, Math.max(2, Math.round((st.n * H[j]!) / spacing)), MAX_PIECES);
          ps.push(n === st.n ? cur : resample(cur, n));
        }
        build(ps, muPer);
        const P1 = X.slice();
        const H1 = H.slice();
        if (project(P1, H1, new Uint8Array(nn))) {
          X.set(P1);
          H.set(H1);
        }
        refreshContacts(false);
        inferInside();
        assignEscape();
        setFloor();
        prevW = new Uint8Array(0);
      }
    }
  }

  // ---- read the shape.
  // Unconverged: hand back the least penetrating shape the solve went
  // through, if it is less penetrating than where it stopped (same node count:
  // a laid resample since makes the two incomparable).
  if (!converged && bestX.length === X.length) {
    let worstD = 0;
    for (let k = 0; k < nn; k++) if (!fixedN[k]) worstD = Math.max(worstD, -(gap(k, X) + allowFloor[k]!));
    if (bestWorst < worstD - 1e-9) {
      X.set(bestX);
      H.set(bestH);
    }
  }
  // Final contact report: the distance of every node from the surface at its
  // final position, established by an answer the callback gave there, unless
  // an earlier answer proves the node clear (1-Lipschitz). A node that got
  // "nothing within reach" may be deeper inside than the reach, so it is
  // asked again with a reach beyond the nearest point known to be outside:
  // if it is in solid, a surface lies nearer than that, and an honest
  // callback must report it.
  const finalD = new Float64Array(nn).fill(Infinity);
  if (contactFn) {
    const clear = (k: number): boolean => cHas[k] === 2 && !cIn[k] && !esc[k] && cD[k]! - moved(k, X) > radius + 10 * touchTol;
    const exact = (k: number): boolean => cHas[k] === 2 && !esc[k] && moved(k, X) <= 1e-9 * spacing;
    for (let k = 0; k < nn; k++) {
      if (clear(k)) continue;
      if (!exact(k)) {
        query(k, reach);
      }
      if (cHas[k] === 2) finalD[k] = cIn[k] ? -Math.abs(cD[k]!) : cD[k]!;
    }
    // Nodes that answered nothing: look further, out to a point known outside.
    const outside = (k: number): boolean => cHas[k] !== 0 && (cHas[k] === 2 ? finalD[k]! >= 0 && !cIn[k] : false);
    const left = new Int32Array(nn).fill(-1);
    const right = new Int32Array(nn).fill(-1);
    for (let k = 0, last = -1; k < nn; k++) {
      if (outside(k) || clear(k)) last = k;
      left[k] = last;
    }
    for (let k = nn - 1, last = -1; k >= 0; k--) {
      if (outside(k) || clear(k)) last = k;
      right[k] = last;
    }
    let span = 0;
    for (let k = 1; k < nn; k++) span = Math.max(span, Math.hypot(X[3 * k]! - X[0]!, X[3 * k + 1]! - X[1]!, X[3 * k + 2]! - X[2]!));
    for (let k = 0; k < nn; k++) {
      if (cHas[k] !== 1 || clear(k)) continue;
      let far = 2 * span + 2 * reach;
      for (const j of [left[k]!, right[k]!]) {
        if (j < 0 || j === k) continue;
        far = Math.min(far, Math.hypot(X[3 * k]! - X[3 * j]!, X[3 * k + 1]! - X[3 * j + 1]!, X[3 * k + 2]! - X[3 * j + 2]!));
      }
      const rch = Math.max(reach, far + radius + spacing);
      if (rch <= cR[k]! && moved(k, X) <= 1e-9 * spacing) continue;
      query(k, rch);
      if (cHas[k] === 2) finalD[k] = cIn[k] ? -Math.abs(cD[k]!) : cD[k]!;
    }
  }
  const points: Vec3[] = [];
  for (let k = 0; k < nn; k++) points.push([X[3 * k]! + O[0], X[3 * k + 1]! + O[1], X[3 * k + 2]! + O[2]]);
  // A pin is returned exactly where it was given: working relative to the
  // first pin and adding it back can be one rounding step out.
  for (let i = 0; i < nPins; i++) {
    const p = path[pinPath[i]!]!;
    points[pinNode[i]!] = [p[0], p[1], p[2]];
  }
  let length = 0;
  for (let i = 0; i < nn - 1; i++) length += Math.hypot(X[3 * i + 3]! - X[3 * i]!, X[3 * i + 4]! - X[3 * i + 1]!, X[3 * i + 5]! - X[3 * i + 2]!);
  const radii: number[] = [];
  let minR = Infinity;
  let tight = 0;
  // Bend radius at a node, the same discrete curvature the energy uses: the
  // turn between the two pieces over half their combined length,
  // R = (h_a + h_b) / (2 |d_b - d_a|) (for equal pieces the circle through
  // the node and its neighbours, as span.ts reports). At a held direction t
  // each side turns from t over half a piece: R = h / (2 |d - t|), and where
  // the side is a cut stretch pulled straight (no slack to turn with) any
  // turn is a kink: R = 0.
  const pieceDir = (i: number): [number, number, number, number] => {
    const ex = X[3 * i + 3]! - X[3 * i]!;
    const ey = X[3 * i + 4]! - X[3 * i + 1]!;
    const ez = X[3 * i + 5]! - X[3 * i + 2]!;
    const l = Math.hypot(ex, ey, ez);
    return l > 1e-12 ? [ex / l, ey / l, ez / l, l] : [0, 0, 0, 0];
  };
  for (let k = 0; k < nn; k++) {
    let R = Infinity;
    if (hasTan[k]) {
      for (const i of [k - 1, k]) {
        if (i < 0 || i >= nn - 1) continue;
        const [dx, dy, dz, l] = pieceDir(i);
        if (!(l > 0)) continue;
        const turn = Math.hypot(dx - tanN[3 * k]!, dy - tanN[3 * k + 1]!, dz - tanN[3 * k + 2]!);
        if (!(turn > 1e-9)) continue;
        R = Math.min(R, taut[segS[i]!] ? 0 : l / (2 * turn));
      }
    } else if (k > 0 && k < nn - 1) {
      const [ax, ay, az, la] = pieceDir(k - 1);
      const [bx, by, bz, lb] = pieceDir(k);
      const turn = Math.hypot(bx - ax, by - ay, bz - az);
      if (la > 0 && lb > 0 && turn > 1e-12) R = (la + lb) / (2 * turn);
    }
    radii.push(R);
    if (R < minR) {
      minR = R;
      tight = k;
    }
  }
  const touching: boolean[] = [];
  let worst = 0;
  for (let k = 0; k < nn; k++) {
    const d = finalD[k]!;
    touching.push(d <= radius + touchTol);
    if (radius - d > worst) worst = radius - d;
  }
  if (worst <= touchTol) worst = 0;
  // Round a sharp edge the contact force is a point force and the curvature
  // peaks at the contact point with a corner. When two neighbouring nodes rest
  // on the edge from either side (their surface normals differ), that point
  // lies between them and both read a curvature short of the peak by about
  // half a piece times its slope (about 0.45 h / λ relative, laid). The
  // tightest radius is then taken from the curvature extrapolated to the
  // contact point from each side; radius_mm keeps the per-node values.
  for (let k = 1; k + 2 < nn; k++) {
    if (!touching[k] || !touching[k + 1] || cHas[k] !== 2 || cHas[k + 1] !== 2) continue;
    const nd = cN[3 * k]! * cN[3 * k + 3]! + cN[3 * k + 1]! * cN[3 * k + 4]! + cN[3 * k + 2]! * cN[3 * k + 5]!;
    if (nd > 1 - 1e-6) continue;
    const ka = 1 / radii[k - 1]!;
    const kb = 1 / radii[k]!;
    const kc = 1 / radii[k + 1]!;
    const kd = 1 / radii[k + 2]!;
    if (!(kb >= ka && kc >= kd)) continue;
    // The surface must turn faster than the rod across the piece (an edge,
    // not a smooth surface the rod lies along).
    const piece = Math.hypot(X[3 * k + 3]! - X[3 * k]!, X[3 * k + 4]! - X[3 * k + 1]!, X[3 * k + 5]! - X[3 * k + 2]!);
    if (Math.acos(Math.max(-1, Math.min(1, nd))) < 1.5 * piece * Math.max(kb, kc)) continue;
    const peak = Math.max(kb + 0.5 * (kb - ka), kc + 0.5 * (kc - kd));
    if (peak > 0 && 1 / peak < minR) {
      minR = 1 / peak;
      tight = kb >= kc ? k : k + 1;
    }
  }
  return {
    points,
    pin_indices: holdOf.map((h) => pinNode[h]!),
    length_mm: length,
    radius_mm: radii,
    min_radius_mm: minR,
    tightest_index: tight,
    touching,
    worst_penetration_mm: worst,
    reaches,
    converged,
    iterations,
    contact_calls: contactCalls,
    repaired,
  };
}

/**
 * A circular arc of length L from node a to node b of P, bowed along n (made
 * square to the chord), in `pieces` equal pieces; the ends are exact.
 */
function arcBetween(P: Float64Array, a: number, b: number, L: number, n: V3, pieces: number): Float64Array {
  const A: V3 = [P[3 * a]!, P[3 * a + 1]!, P[3 * a + 2]!];
  const B: V3 = [P[3 * b]!, P[3 * b + 1]!, P[3 * b + 2]!];
  const cv: V3 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
  const D = Math.hypot(cv[0], cv[1], cv[2]);
  const c = unit3(cv) ?? anyPerpendicular(n);
  const side = unit3(perpTo(n, c)) ?? anyPerpendicular(c);
  const half = sincInverse(L > 0 ? D / L : 1);
  const piece = L / pieces;
  const p = new Float64Array(3 * (pieces + 1));
  p[0] = A[0];
  p[1] = A[1];
  p[2] = A[2];
  for (let i = 0; i < pieces; i++) {
    const u = (i + 0.5) / pieces;
    const phi = half * (1 - 2 * u);
    for (let d = 0; d < 3; d++) p[3 * i + 3 + d] = p[3 * i + d]! + piece * (Math.cos(phi) * c[d]! + Math.sin(phi) * side[d]!);
  }
  for (let i = 1; i <= pieces; i++) for (let d = 0; d < 3; d++) p[3 * i + d] = p[3 * i + d]! + ((B[d]! - p[3 * pieces + d]!) * i) / pieces;
  return p;
}

/**
 * A starting shape of exact length L for a cut stretch: the caller's path with
 * its deviation from the chord scaled until the length is right, or, when the
 * path is straight, a plain arc bowed the way the end directions (or gravity)
 * say, nudged out of plane as span.ts does.
 */
function cutStart(s: Float64Array, L: number, D: number, n: number, ta: V3 | null, tb: V3 | null, up: V3 | null): Float64Array {
  const m = s.length / 3;
  const a: V3 = [s[0]!, s[1]!, s[2]!];
  const b: V3 = [s[3 * m - 3]!, s[3 * m - 2]!, s[3 * m - 1]!];
  const cv: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const cum = new Float64Array(m);
  for (let i = 1; i < m; i++) cum[i] = cum[i - 1]! + Math.hypot(s[3 * i]! - s[3 * i - 3]!, s[3 * i + 1]! - s[3 * i - 2]!, s[3 * i + 2]! - s[3 * i - 1]!);
  const total = cum[m - 1]!;
  const dev = new Float64Array(3 * m);
  let maxDev = 0;
  for (let i = 0; i < m; i++) {
    const u = total > 0 ? cum[i]! / total : i / Math.max(1, m - 1);
    for (let d = 0; d < 3; d++) dev[3 * i + d] = s[3 * i + d]! - (a[d]! + u * cv[d]!);
    maxDev = Math.max(maxDev, Math.hypot(dev[3 * i]!, dev[3 * i + 1]!, dev[3 * i + 2]!));
  }
  if (maxDev > 1e-6 * Math.max(L, 1e-9) && m > 2) {
    const shaped = (k: number): Float64Array => {
      const q = new Float64Array(3 * m);
      for (let i = 0; i < m; i++) {
        const u = total > 0 ? cum[i]! / total : i / (m - 1);
        for (let d = 0; d < 3; d++) q[3 * i + d] = a[d]! + u * cv[d]! + k * dev[3 * i + d]!;
      }
      return q;
    };
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 80 && polyLength(shaped(hi)) < L; i++) hi *= 2;
    for (let i = 0; i < 80; i++) {
      const mid = (lo + hi) / 2;
      if (polyLength(shaped(mid)) < L) lo = mid;
      else hi = mid;
    }
    return resample(shaped((lo + hi) / 2), n);
  }
  // Plain arc (as span.ts).
  const c = unit3(cv) ?? (ta && tb ? unit3([ta[0] + tb[0], ta[1] + tb[1], ta[2] + tb[2]]) : null) ?? ta ?? tb ?? ([1, 0, 0] as V3);
  let lean: V3 = [0, 0, 0];
  if (ta && tb) lean = perpTo([ta[0] - tb[0], ta[1] - tb[1], ta[2] - tb[2]], c);
  else if (ta) lean = perpTo(ta, c);
  else if (tb) lean = perpTo([-tb[0], -tb[1], -tb[2]], c);
  const down = up ? unit3(perpTo([-up[0], -up[1], -up[2]], c)) : null;
  if (down) lean = [lean[0] + 0.2 * down[0], lean[1] + 0.2 * down[1], lean[2] + 0.2 * down[2]];
  const side = unit3(lean) ?? down ?? (ta ? unit3(perpTo(ta, c)) : null) ?? (tb ? unit3(perpTo(tb, c)) : null) ?? anyPerpendicular(c);
  const out: V3 = [c[1] * side[2] - c[2] * side[1], c[2] * side[0] - c[0] * side[2], c[0] * side[1] - c[1] * side[0]];
  const half = sincInverse(D / L);
  const piece = L / n;
  const p = new Float64Array(3 * (n + 1));
  p[0] = a[0];
  p[1] = a[1];
  p[2] = a[2];
  for (let i = 0; i < n; i++) {
    const u = (i + 0.5) / n;
    const phi = half * (1 - 2 * u);
    const k = 1e-3 * (Math.cos(Math.PI * u) + Math.cos(2 * Math.PI * u));
    const dx = Math.cos(phi) * c[0] + Math.sin(phi) * side[0] + k * out[0];
    const dy = Math.cos(phi) * c[1] + Math.sin(phi) * side[1] + k * out[1];
    const dz = Math.cos(phi) * c[2] + Math.sin(phi) * side[2] + k * out[2];
    const l = Math.hypot(dx, dy, dz);
    p[3 * i + 3] = p[3 * i]! + (piece * dx) / l;
    p[3 * i + 4] = p[3 * i + 1]! + (piece * dy) / l;
    p[3 * i + 5] = p[3 * i + 2]! + (piece * dz) / l;
  }
  // Spread the closure error so the last point is exactly b.
  const fx = (b[0] - p[3 * n]!) / n;
  const fy = (b[1] - p[3 * n + 1]!) / n;
  const fz = (b[2] - p[3 * n + 2]!) / n;
  for (let i = 1; i <= n; i++) {
    p[3 * i] = p[3 * i]! + fx * i;
    p[3 * i + 1] = p[3 * i + 1]! + fy * i;
    p[3 * i + 2] = p[3 * i + 2]! + fz * i;
  }
  return p;
}
