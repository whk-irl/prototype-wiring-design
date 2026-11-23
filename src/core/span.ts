/**
 * The shape of a cable where it hangs free between two tie-down points, and
 * how much cable a joint crossing needs.
 *
 * Between the last point of one route segment and the first point of the next
 * the cable is not lying on anything: it leaves one link, crosses the joint and
 * lands on the other. The straight distance between those two points changes as
 * the joint moves, but the cable between them has ONE length, fixed when it is
 * cut. Where the points are close, the spare length has to go somewhere and the
 * cable bows; where they are far apart it pulls straight.
 *
 * Model. The free cable is a thin elastic rod of fixed length: it takes the
 * shape of least bending for the length it has. Each end is held at its
 * tie-down point and, where the route gives a direction, along that direction
 * (the cable leaves the link the way it was running on it). This is the
 * elastica, solved here as a chain of equal straight pieces.
 *
 * What the model leaves out, so that results are read correctly:
 *  - Contact. The rod does not know the prototype is there. The caller should
 *    test the returned points against the model and report where the loop
 *    presses into a part.
 *  - Gravity and the cable's own twist. Both are small for the short, light
 *    spans of a prototype.
 *  - Other stable shapes. A long loop can sit in more than one way (bowed to
 *    either side, or coiled). The solver returns the one that bows toward
 *    `bias`, starting from a plain arc; it does not search for others.
 *
 * Lengths are mm. Ends are given in any one frame (world, usually).
 */
import type { Vec3 } from './schema';

export interface SpanEnds {
  /** Where the free cable starts and ends. */
  a: Vec3;
  b: Vec3;
  /** Unit direction of travel as the cable leaves `a`. Absent: the end is free to pivot. */
  ta?: Vec3;
  /** Unit direction of travel as the cable arrives at `b`. Absent: free to pivot. */
  tb?: Vec3;
  /** Which way spare length should bow (away from the surface). Need not be unit or perpendicular. */
  bias?: Vec3;
}

export interface SpanShape {
  /**
   * False when the length is shorter than the straight distance: the cable
   * cannot reach. `points` is then the straight line and `min_radius_mm` is
   * Infinity; read `short_by_mm`.
   */
  reaches: boolean;
  /** How much longer the cable would have to be to reach. 0 when it reaches. */
  short_by_mm: number;
  /** The centre line, `segments + 1` points from `a` to `b`. */
  points: Vec3[];
  /** Tightest radius along the span, ends included. */
  min_radius_mm: number;
  /** Largest distance of the centre line from the straight line between the ends. */
  bulge_mm: number;
  /** False when the solver stopped at its iteration cap; the shape is then approximate. */
  converged: boolean;
}

export interface SpanOptions {
  /** Number of straight pieces. More is more exact and slower. Default 20, minimum 4. */
  segments?: number;
  /** Iteration cap. Default 10000 sweeps. Most shapes settle in a few hundred; a cable pulled nearly straight with its ends askew is the slow case. */
  max_sweeps?: number;
  /**
   * How still the pieces must be to call the shape settled: the largest change
   * of any piece's unit direction in one sweep. Default 1e-7, at which radius
   * and bulge are good to a fraction of a percent.
   */
  tolerance?: number;
}

const DEFAULT_SEGMENTS = 20;
const DEFAULT_SWEEPS = 10000;
const DEFAULT_TOLERANCE = 1e-7;
/** Size of the out-of-plane nudge given to the starting shape, as a tilt of each piece. */
const NUDGE = 1e-3;
/** Penalty weight of the method of multipliers that holds the far end in place. */
const RHO = 0.1;
/** The multiplier moves once the pieces have settled to this fraction of the closure error. */
const GATE = 0.1;

function unit(v: readonly number[]): [number, number, number] | null {
  const l = Math.hypot(v[0]!, v[1]!, v[2]!);
  if (!(l > 1e-12)) return null;
  return [v[0]! / l, v[1]! / l, v[2]! / l];
}

/** Any unit vector perpendicular to `c` (unit), chosen the same way every time. */
function anyPerpendicular(c: readonly number[]): [number, number, number] {
  const ax = Math.abs(c[0]!);
  const ay = Math.abs(c[1]!);
  const az = Math.abs(c[2]!);
  // Cross with the world axis the vector is least aligned with.
  const e: [number, number, number] = ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1];
  return unit([c[1]! * e[2] - c[2]! * e[1], c[2]! * e[0] - c[0]! * e[2], c[0]! * e[1] - c[1]! * e[0]])!;
}

/** Remove from `v` its part along unit `c`. */
function perp(v: readonly number[], c: readonly number[]): [number, number, number] {
  const k = v[0]! * c[0]! + v[1]! * c[1]! + v[2]! * c[2]!;
  return [v[0]! - k * c[0]!, v[1]! - k * c[1]!, v[2]! - k * c[2]!];
}

/** Solve sin(x) / x = r for x in [0, pi], r in [0, 1]. */
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

/**
 * The shape a cable of `length_mm` takes between two tie-down points.
 *
 * The cable is a chain of N equal pieces with unit directions d_1..d_N. Its
 * bending energy is the sum of |d_(i+1) - d_i|^2 over the joints between
 * pieces, plus 2 |d_1 - ta|^2 and 2 |d_N - tb|^2 for the held ends (the factor
 * 2 because the end direction applies at the end point, half a piece from the
 * middle of the first piece). The pieces must add up to the vector from `a` to
 * `b`. That one vector constraint is held by the method of multipliers; each
 * piece's direction then has a closed-form best value given its neighbours,
 * and the pieces are swept in turn until nothing moves.
 *
 * The same inputs always give the same shape, and a turned or moved copy of
 * the inputs gives the turned or moved shape (to the solver's tolerance).
 */
export function relaxSpan(ends: SpanEnds, length_mm: number, options: SpanOptions = {}): SpanShape {
  const n = Math.max(4, Math.floor(options.segments ?? DEFAULT_SEGMENTS));
  const maxSweeps = options.max_sweeps ?? DEFAULT_SWEEPS;
  const { a, b } = ends;
  const chordVec = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const chord = Math.hypot(chordVec[0]!, chordVec[1]!, chordVec[2]!);

  if (!(length_mm >= 0) || length_mm < chord) {
    const points: Vec3[] = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      points.push([a[0] + chordVec[0]! * t, a[1] + chordVec[1]! * t, a[2] + chordVec[2]! * t]);
    }
    return { reaches: false, short_by_mm: chord - Math.max(0, length_mm), points, min_radius_mm: Infinity, bulge_mm: 0, converged: true };
  }

  // Too short to have a shape (and too short to divide into pieces safely).
  if (length_mm < 1e-9) {
    const points: Vec3[] = [];
    for (let i = 0; i <= n; i++) points.push(i < n ? [a[0], a[1], a[2]] : [b[0], b[1], b[2]]);
    return { reaches: true, short_by_mm: 0, points, min_radius_mm: Infinity, bulge_mm: 0, converged: true };
  }

  const s = length_mm / n;
  const ta = ends.ta ? unit(ends.ta) : null;
  const tb = ends.tb ? unit(ends.tb) : null;
  // Target for the sum of the directions.
  const vx = chordVec[0]! / s;
  const vy = chordVec[1]! / s;
  const vz = chordVec[2]! / s;

  // ---- starting shape: a plain arc of the right length, bowed toward the bias.
  const c = unit(chordVec) ?? (ta && tb ? unit([ta[0] + tb[0], ta[1] + tb[1], ta[2] + tb[2]]) : null) ?? ta ?? tb ?? [1, 0, 0];
  // Which side the spare length goes to. The end directions say how the
  // cable sets off, so they lead; the bias (away from the surface) decides
  // when they do not, which is when both run along the chord.
  let lean: [number, number, number] = [0, 0, 0];
  if (ta && tb) lean = perp([ta[0] - tb[0], ta[1] - tb[1], ta[2] - tb[2]], c);
  else if (ta) lean = perp(ta, c);
  else if (tb) lean = perp([-tb[0], -tb[1], -tb[2]], c);
  const fromBias = ends.bias ? unit(perp(ends.bias, c)) : null;
  if (fromBias) lean = [lean[0] + 0.2 * fromBias[0], lean[1] + 0.2 * fromBias[1], lean[2] + 0.2 * fromBias[2]];
  // No lean and no bias (the two ends run parallel, askew to the chord): take
  // the side one end points to, which turns with the input as any other
  // choice here must, so that a rotated copy of a problem gets the rotated
  // answer. Only a problem with nothing to tell the sides apart gets an
  // arbitrary one, and there every side is the same.
  const side =
    unit(lean) ??
    fromBias ??
    (ta ? unit(perp(ta, c)) : null) ??
    (tb ? unit(perp(tb, c)) : null) ??
    anyPerpendicular(c);
  // Out of the plane of the starting arc. A start that lies exactly in one
  // plane stays in it for ever, even when the flat shape is only balanced, not
  // stable, and the cable would really bow out sideways. A small nudge out of
  // plane lets it leave if it wants to and dies away if it does not.
  const out: [number, number, number] = [c[1] * side[2] - c[2] * side[1], c[2] * side[0] - c[0] * side[2], c[0] * side[1] - c[1] * side[0]];
  const half = sincInverse(chord / length_mm);
  const d = new Float64Array(3 * n);
  for (let i = 0; i < n; i++) {
    // Angle to the chord runs from +half to -half along the arc.
    const u = (i + 0.5) / n;
    const phi = half * (1 - 2 * u);
    const cs = Math.cos(phi);
    const sn = Math.sin(phi);
    // One part that tilts the whole span and one that tilts its halves
    // opposite ways, so neither kind of sideways bow is left out.
    const k = NUDGE * (Math.cos(Math.PI * u) + Math.cos(2 * Math.PI * u));
    const x = cs * c[0] + sn * side[0] + k * out[0];
    const y = cs * c[1] + sn * side[1] + k * out[1];
    const z = cs * c[2] + sn * side[2] + k * out[2];
    const l = Math.hypot(x, y, z);
    d[3 * i] = x / l;
    d[3 * i + 1] = y / l;
    d[3 * i + 2] = z / l;
  }

  // ---- relax.
  let sx = 0;
  let sy = 0;
  let sz = 0;
  for (let i = 0; i < n; i++) {
    sx += d[3 * i]!;
    sy += d[3 * i + 1]!;
    sz += d[3 * i + 2]!;
  }
  let mx = 0;
  let my = 0;
  let mz = 0;
  let converged = false;
  // Settled when no piece turns by more than the tolerance in a sweep and the
  // far end is within ten times that (in piece lengths) of where it belongs.
  const moveTol = options.tolerance ?? DEFAULT_TOLERANCE;
  const closeTol = 10 * moveTol * n;
  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let moved = 0;
    for (let i = 0; i < n; i++) {
      const k = 3 * i;
      const ox = d[k]!;
      const oy = d[k + 1]!;
      const oz = d[k + 2]!;
      sx -= ox;
      sy -= oy;
      sz -= oz;
      let gx = mx - RHO * (sx - vx);
      let gy = my - RHO * (sy - vy);
      let gz = mz - RHO * (sz - vz);
      if (i > 0) {
        gx += d[k - 3]!;
        gy += d[k - 2]!;
        gz += d[k - 1]!;
      } else if (ta) {
        gx += 2 * ta[0];
        gy += 2 * ta[1];
        gz += 2 * ta[2];
      }
      if (i < n - 1) {
        gx += d[k + 3]!;
        gy += d[k + 4]!;
        gz += d[k + 5]!;
      } else if (tb) {
        gx += 2 * tb[0];
        gy += 2 * tb[1];
        gz += 2 * tb[2];
      }
      const gl = Math.hypot(gx, gy, gz);
      let nx = ox;
      let ny = oy;
      let nz = oz;
      if (gl > 1e-12) {
        nx = gx / gl;
        ny = gy / gl;
        nz = gz / gl;
      }
      d[k] = nx;
      d[k + 1] = ny;
      d[k + 2] = nz;
      sx += nx;
      sy += ny;
      sz += nz;
      const dx = nx - ox;
      const dy = ny - oy;
      const dz = nz - oz;
      const m2 = dx * dx + dy * dy + dz * dz;
      if (m2 > moved) moved = m2;
    }
    const ex = sx - vx;
    const ey = sy - vy;
    const ez = sz - vz;
    const err2 = ex * ex + ey * ey + ez * ez;
    if (moved < moveTol * moveTol && err2 < closeTol * closeTol) {
      converged = true;
      break;
    }
    // Move the multiplier only once the pieces have settled for the current
    // one (to a fraction of the closure error still left). Updating it on
    // every sweep makes the two chase each other and never settle on long
    // chains.
    if (moved < GATE * GATE * err2 || moved < moveTol * moveTol) {
      mx -= RHO * ex;
      my -= RHO * ey;
      mz -= RHO * ez;
    }
  }

  // ---- read the shape.
  const points: Vec3[] = [[a[0], a[1], a[2]]];
  let px = a[0];
  let py = a[1];
  let pz = a[2];
  // Spread whatever closure error is left evenly, so the last point is exactly b.
  const fx = (vx - sx) / n;
  const fy = (vy - sy) / n;
  const fz = (vz - sz) / n;
  for (let i = 0; i < n; i++) {
    px += s * (d[3 * i]! + fx);
    py += s * (d[3 * i + 1]! + fy);
    pz += s * (d[3 * i + 2]! + fz);
    points.push([px, py, pz]);
  }
  points[n] = [b[0], b[1], b[2]];

  // Radius at a joint between two pieces: the circle through its three points,
  // s / (2 sin(turn / 2)) = s / |d_(i+1) - d_i|. At a held end the turn from
  // the end direction to the first piece happens over half a piece.
  let tight = Infinity;
  for (let i = 1; i < n; i++) {
    const k = 3 * i;
    const turn = Math.hypot(d[k]! - d[k - 3]!, d[k + 1]! - d[k - 2]!, d[k + 2]! - d[k - 1]!);
    if (turn > 1e-12) tight = Math.min(tight, s / turn);
  }
  if (ta) {
    const turn = Math.hypot(d[0]! - ta[0], d[1]! - ta[1], d[2]! - ta[2]);
    if (turn > 1e-12) tight = Math.min(tight, s / (2 * turn));
  }
  if (tb) {
    const k = 3 * (n - 1);
    const turn = Math.hypot(d[k]! - tb[0], d[k + 1]! - tb[1], d[k + 2]! - tb[2]);
    if (turn > 1e-12) tight = Math.min(tight, s / (2 * turn));
  }

  let bulge = 0;
  for (let i = 1; i < n; i++) {
    const p = points[i]!;
    const rx = p[0] - a[0];
    const ry = p[1] - a[1];
    const rz = p[2] - a[2];
    let t = chord > 1e-12 ? (rx * chordVec[0]! + ry * chordVec[1]! + rz * chordVec[2]!) / (chord * chord) : 0;
    t = Math.min(1, Math.max(0, t));
    const dist = Math.hypot(rx - t * chordVec[0]!, ry - t * chordVec[1]!, rz - t * chordVec[2]!);
    if (dist > bulge) bulge = dist;
  }

  return { reaches: true, short_by_mm: 0, points, min_radius_mm: tight, bulge_mm: bulge, converged };
}
