/**
 * How much cable a route needs where it crosses from one link to the next,
 * and what that cable does as the joints between them move.
 *
 * Between the last point of one segment and the first point of the next the
 * cable hangs free (`span.ts` gives its shape). It has one length, fixed when
 * it is cut, while the distance it bridges changes with the joints. This file
 * chooses that length and then checks it at poses across the joints' range:
 * does it reach, how tightly does it bend, how far does the loop stand out.
 *
 * Choosing the length. At any one pose there is a length the cable needs: too
 * short and it kinks leaving its tie-down points, too long and the spare bows.
 * The length taken for a pose is the shortest that keeps the cable at or above
 * its bend limit there or, when none does, the one at which its tightest bend
 * is gentlest (`naturalLength`). The cable is cut for the pose that needs the
 * most, plus a small allowance so it is never pulled tight. Every other pose
 * then has spare length, and the check reports what the spare does there.
 *
 * This is a choice, not the only good one: more slack sometimes bends more
 * gently and always stands out further. A route can state its own slack for a
 * crossing (`route.crossings[].slack_mm`, measured beyond the longest straight
 * distance) and that is used instead.
 *
 * The model. The length search itself uses the free-space shape (`span.ts`)
 * and does not know what is in the way. The caller can say how long the way
 * round the model is at a pose (`detour_mm`); the cable is then cut at least
 * that long, and a pose where even that is not enough is reported as not
 * reaching. The shape drawn and checked at each pose is the caller's business
 * (`rod.ts` with contact).
 *
 * Limits: the poses are samples, so a problem between two samples can be
 * missed; a crossing over more than three joints is swept over the first three
 * only (listed in `unsampled`); and the loop does not know the model is there
 * (see `span.ts`).
 */
import { Matrix4, Vector3 } from 'three';
import { computeLinkPoses } from './kinematics';
import { jointRange, jointsBetween, polylineLength, segmentCentreLine } from './routes';
import type { Design, Route, Vec3 } from './schema';
import { relaxSpan, type SpanEnds, type SpanOptions } from './span';

/** Allowance added to the automatic length, as a fraction of it. An allowance, not a sourced value. */
export const SLACK_ALLOWANCE = 0.02;

/** Furthest the automatic length looks beyond the straight distance, as a fraction of it. */
const SEARCH_LIMIT = 0.6;

/** Iteration cap for the solves that only steer the search for a length. */
const SEARCH_SWEEPS = 1500;

/** The ends of a crossing, with the surface normal at each end where the route has one. */
export interface CrossingEnds extends SpanEnds {
  /** Unit normal of the surface the cable lies on at `a` and at `b`, pointing away from it. */
  na?: Vec3;
  nb?: Vec3;
}

/**
 * The two ends of the free cable after segment `after_segment`, in world
 * coordinates at a pose. An end has a direction when its segment has at least
 * two distinct points (the cable leaves the way it was running); a segment of
 * one point is a single tie and the cable may pivot there.
 */
export function crossingEnds(
  design: Design,
  route: Route,
  lift_mm: number,
  after_segment: number,
  values: Readonly<Record<string, number>> = {},
): CrossingEnds {
  const from = route.segments[after_segment];
  const to = route.segments[after_segment + 1];
  if (!from || !to) throw new RangeError(`route "${route.id}" has no crossing after segment ${after_segment}`);
  const poses = computeLinkPoses(design.scene, values);
  const fromPose = poses.get(from.link) ?? new Matrix4();
  const toPose = poses.get(to.link) ?? new Matrix4();
  const fromLine = segmentCentreLine(from, lift_mm);
  const toLine = segmentCentreLine(to, lift_mm);

  const point = (p: Vec3, m: Matrix4): Vec3 => {
    const v = new Vector3(p[0], p[1], p[2]).applyMatrix4(m);
    return [v.x, v.y, v.z];
  };
  const direction = (p: Vec3, q: Vec3, m: Matrix4): Vec3 | undefined => {
    const v = new Vector3(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
    if (v.length() < 1e-9) return undefined;
    v.transformDirection(m);
    return [v.x, v.y, v.z];
  };

  const endA = fromLine[fromLine.length - 1]!;
  const endB = toLine[0]!;
  // The nearest earlier (later) point that is not the end point itself.
  let ta: Vec3 | undefined;
  for (let i = fromLine.length - 2; i >= 0 && !ta; i--) ta = direction(fromLine[i]!, endA, fromPose);
  let tb: Vec3 | undefined;
  for (let i = 1; i < toLine.length && !tb; i++) tb = direction(endB, toLine[i]!, toPose);

  const normal = (n: Vec3 | undefined, m: Matrix4): Vec3 | undefined => {
    if (!n || !(Math.hypot(n[0], n[1], n[2]) > 0)) return undefined;
    const v = new Vector3(n[0], n[1], n[2]).transformDirection(m);
    return [v.x, v.y, v.z];
  };
  const na = normal(from.normals?.[from.points_mm.length - 1], fromPose);
  const nb = normal(to.normals?.[0], toPose);
  const bias: Vec3 = [(na?.[0] ?? 0) + (nb?.[0] ?? 0), (na?.[1] ?? 0) + (nb?.[1] ?? 0), (na?.[2] ?? 0) + (nb?.[2] ?? 0)];

  return {
    a: point(endA, fromPose),
    b: point(endB, toPose),
    ...(ta ? { ta } : {}),
    ...(tb ? { tb } : {}),
    ...(Math.hypot(bias[0], bias[1], bias[2]) > 1e-6 ? { bias } : {}),
    ...(na ? { na } : {}),
    ...(nb ? { nb } : {}),
  };
}

/**
 * What a crossing asks of a FLAT cable beyond bending across its thickness.
 *
 * A ribbon lying on a surface has its width along (normal x direction of
 * travel). Bending across its thickness keeps that width axis where it is, so
 * a hinge whose axis runs along the ribbon's width is the one crossing a flat
 * cable takes without complaint. Anything else needs the ribbon to twist
 * (`twist_deg`: the angle between its width axis at the two ends, 0 to 90) or to shift
 * sideways (`sideways_mm`: how far the far end is displaced along the width
 * axis), neither of which the loop model includes.
 *
 * Undefined when either end lacks a direction or a surface normal: the
 * ribbon's orientation is then not known.
 */
export function flatDemand(ends: CrossingEnds): { twist_deg: number; sideways_mm: number } | undefined {
  const { ta, tb, na, nb } = ends;
  if (!ta || !tb || !na || !nb) return undefined;
  const wa = new Vector3(na[0], na[1], na[2]).cross(new Vector3(ta[0], ta[1], ta[2]));
  const wb = new Vector3(nb[0], nb[1], nb[2]).cross(new Vector3(tb[0], tb[1], tb[2]));
  // A cable that leaves straight along the normal has no width axis there.
  if (wa.length() < 1e-6 || wb.length() < 1e-6) return undefined;
  wa.normalize();
  wb.normalize();
  // The width axis is a line, not an arrow: a ribbon that goes from the top
  // of one plate to the underside of the next has only bent across its
  // thickness, though (normal x travel) has turned right round.
  if (wa.dot(wb) < 0) wb.negate();
  const twist = (Math.atan2(wa.clone().cross(wb).length(), wa.dot(wb)) * 180) / Math.PI;
  const across = wa.clone().add(wb).normalize();
  const sideways = Math.abs((ends.b[0] - ends.a[0]) * across.x + (ends.b[1] - ends.a[1]) * across.y + (ends.b[2] - ends.a[2]) * across.z);
  return { twist_deg: twist, sideways_mm: sideways };
}

function chordOf(ends: SpanEnds): number {
  return Math.hypot(ends.b[0] - ends.a[0], ends.b[1] - ends.a[1], ends.b[2] - ends.a[2]);
}

export interface NaturalLengthOptions extends SpanOptions {
  /** The radius the cable must not go below, when known. */
  bend_limit_mm?: number;
}

/**
 * The length a cable between these ends should have at this one pose.
 *
 * Too short and it kinks leaving its tie-down points; too long and the spare
 * bows. So as the length grows from the straight distance, the tightest radius
 * rises to a peak and then falls.
 *  - With a `bend_limit_mm`: the shortest length at which the tightest radius
 *    reaches the limit. A cable need not bend more gently than it is allowed
 *    to, and every millimetre beyond that is spare at every other pose.
 *  - Without one, or when no length reaches it: the length at the peak, where
 *    the bend is gentlest.
 *
 * Looks no further than 60 % beyond the straight distance (a half circle on it
 * is 57 %). Ends that face away from each other have no peak in that window:
 * the radius keeps creeping up as the loop grows. They get the shortest length
 * whose radius is within 10 % of the best in the window, more length buying
 * almost nothing after that.
 *
 * Returns the straight distance itself when 1 % of extra length already meets
 * the rule: the ends face each other, near enough. (Looking closer than 1 %
 * costs a lot, a nearly straight cable being slow to solve, and the allowance
 * added afterwards is larger than what it could find.)
 */
export function naturalLength(ends: SpanEnds, options: NaturalLengthOptions = {}): number {
  const chord = chordOf(ends);
  if (!(chord > 1e-9)) return 0;
  const limit = options.bend_limit_mm;
  // The search only compares neighbouring lengths, so it does not need the
  // slow cases settled to the last digit.
  const quick: SpanOptions = {
    ...(options.segments !== undefined ? { segments: options.segments } : {}),
    ...(options.tolerance !== undefined ? { tolerance: options.tolerance } : {}),
    max_sweeps: Math.min(options.max_sweeps ?? SEARCH_SWEEPS, SEARCH_SWEEPS),
  };
  const radius = (x: number) => relaxSpan(ends, chord * (1 + x), quick).min_radius_mm;
  /** Where the radius first reaches `target` between a sample below it and one at or above it. */
  const reaching = (lo: number, hi: number, target: number): number => {
    for (let i = 0; i < 6; i++) {
      const mid = (lo + hi) / 2;
      if (radius(mid) >= target) hi = mid;
      else lo = mid;
    }
    return hi;
  };

  // Scan outward in growing steps until the limit is met or the radius first falls.
  const xs: number[] = [];
  for (let x = 0.01; x < SEARCH_LIMIT; x *= 1.6) xs.push(x);
  xs.push(SEARCH_LIMIT);
  const rs: number[] = [];
  let peak = -1;
  for (let k = 0; k < xs.length; k++) {
    const r = radius(xs[k]!);
    rs.push(r);
    if (limit !== undefined && r >= limit) return k === 0 ? chord : chord * (1 + reaching(xs[k - 1]!, xs[k]!, limit));
    if (k > 0 && r < rs[k - 1]!) {
      peak = k - 1;
      break;
    }
  }

  if (peak < 0) {
    // Still rising at the edge of the window.
    const target = 0.9 * rs[rs.length - 1]!;
    const k = rs.findIndex((r) => r >= target);
    return k <= 0 ? chord : chord * (1 + reaching(xs[k - 1]!, xs[k]!, target));
  }
  if (peak === 0) return chord;
  // The peak lies between the samples either side of the highest one.
  let lo = xs[peak - 1]!;
  let hi = xs[peak + 1]!;
  const g = (Math.sqrt(5) - 1) / 2;
  let x1 = hi - g * (hi - lo);
  let x2 = lo + g * (hi - lo);
  let r1 = radius(x1);
  let r2 = radius(x2);
  for (let i = 0; i < 6; i++) {
    if (r1 < r2) {
      lo = x1;
      x1 = x2;
      r1 = r2;
      x2 = lo + g * (hi - lo);
      r2 = radius(x2);
    } else {
      hi = x2;
      x2 = x1;
      r2 = r1;
      x1 = hi - g * (hi - lo);
      r1 = radius(x1);
    }
  }
  return chord * (1 + (lo + hi) / 2);
}

export interface SlackPose {
  /** Values of the swept joints at this pose. */
  values: Record<string, number>;
  /** Straight distance between the two ends. */
  chord_mm: number;
  /**
   * How much longer the cable would have to be to reach at this pose: across
   * the straight distance, or round the model when the caller says how long
   * the way round is (`detour_mm`). 0 when it reaches.
   */
  short_by_mm: number;
  /** Length of the shortest way between the ends that stays out of the model at this pose, when the caller gave one. */
  detour_mm?: number;
  /** Tightest radius of the free cable. Infinity when it does not reach or runs straight. */
  min_radius_mm: number;
  /** How far the free cable stands off the straight line between its ends. */
  bulge_mm: number;
  /** False when the shape solver stopped at its cap; the figures are then approximate. */
  converged: boolean;
  /** For a flat cable: see `flatDemand`. Absent when the ribbon's orientation is not known. */
  twist_deg?: number;
  sideways_mm?: number;
}

export interface CrossingSlack {
  /** Index of the segment the crossing leaves from; it arrives at the next one. */
  after_segment: number;
  from_link: string;
  to_link: string;
  /** Joints whose motion changes this crossing. Empty: it never changes. */
  joints: string[];
  /** Moving joints on the path that were NOT swept: the figures may be too kind. */
  unsampled: string[];
  /**
   * Joints on the path that can turn without limit. A cable cannot follow one
   * round and round: it winds up. Such a joint is swept over one turn (half a
   * turn each way) only, and the figures hold only if something else keeps it
   * within that; otherwise the crossing needs a slip ring, not a loop.
   */
  continuous: string[];
  /**
   * Shortest and longest straight distance over the joints' range. Swept more
   * finely than `poses` (the distance is cheap, the shapes are not).
   */
  chord_min_mm: number;
  chord_max_mm: number;
  /** Longest way round the model over the sampled poses, when the caller gave one (`SlackOptions.detour_mm`). */
  detour_max_mm?: number;
  /** Cable between the two tie-down points. */
  free_length_mm: number;
  /** `free_length_mm` beyond the longest straight distance. */
  slack_mm: number;
  /** `auto`: chosen here. `user`: the route's own `slack_mm` for this crossing. */
  basis: 'auto' | 'user';
  /** The radius the free cable was judged against. */
  bend_limit_mm: number;
  /** The cable reaches at every sampled pose. */
  reaches: boolean;
  /** The free cable stays at or above `bend_limit_mm` at every sampled pose. */
  bend_ok: boolean;
  /** Index into `poses` of the pose with the tightest bend. */
  tightest: number;
  /** Largest bulge over the sampled poses. */
  bulge_mm: number;
  /** Largest twist and sideways shift asked of a flat cable over the sampled poses (`flatDemand`). */
  twist_deg?: number;
  sideways_mm?: number;
  /**
   * The poses the shape was solved at: an even grid over the swept joints'
   * ranges, then, when they are not on that grid, the pose of the longest
   * straight distance (where the cable is most nearly taut) and the pose of
   * the shortest (where it has the most spare).
   */
  poses: SlackPose[];
}

export interface SlackOptions extends SpanOptions {
  /** Radius the free cable must not go below. */
  bend_limit_mm: number;
  /** Cable beyond the longest straight distance. Absent: chosen automatically. */
  slack_mm?: number;
  /** Poses per joint when one joint moves the crossing. Default 9; two joints get 5 each, three get 3 each. */
  samples?: number;
  /**
   * The model, as far as the length needs to know it: the length of the
   * shortest path between the two ends that stays out of the model at a pose
   * (a string pulled taut round whatever is in the way), or undefined when
   * the straight line is clear. The cable is cut at least that long at every
   * sampled pose, so a loop that has to go round a body (a wire from a fixed
   * base to a turret that turns half way round) is long enough to do it.
   * Without this the length comes from the straight distances alone.
   */
  detour_mm?: (values: Readonly<Record<string, number>>, ends: CrossingEnds) => number | undefined;
}

/** Size, bend and reach of the free cable after segment `after_segment`, over the joints' range. */
export function crossingSlack(design: Design, route: Route, lift_mm: number, after_segment: number, options: SlackOptions): CrossingSlack {
  const from = route.segments[after_segment];
  const to = route.segments[after_segment + 1];
  if (!from || !to) throw new RangeError(`route "${route.id}" has no crossing after segment ${after_segment}`);
  const jointsById = new Map(design.scene.joints.map((j) => [j.id, j]));
  const path = jointsBetween(design.scene, from.link, to.link) ?? [];
  const moving = path.map((id) => jointsById.get(id)!).filter((j) => jointRange(j) !== null);
  const swept = moving.slice(0, 3);
  const single = Math.max(2, Math.floor(options.samples ?? 9));
  const perJoint = swept.length <= 1 ? single : swept.length === 2 ? Math.min(single, 5) : Math.min(single, 3);
  const spanOptions: SpanOptions = {
    ...(options.segments !== undefined ? { segments: options.segments } : {}),
    ...(options.max_sweeps !== undefined ? { max_sweeps: options.max_sweeps } : {}),
  };

  // ---- the ends at every sampled pose.
  type Sample = { values: Record<string, number>; ends: CrossingEnds; chord: number };
  const sampled: Sample[] = [];
  // The straight distance is cheap, so it is swept much more finely than the
  // shapes are solved: 8 steps between solved poses for one joint, 4 for more.
  // The solved poses are every `fine`-th of those.
  const fine = swept.length <= 1 ? 8 : 4;
  const steps = fine * (perJoint - 1) + 1;
  let chordMax = -Infinity;
  let chordMin = Infinity;
  const longest: { sample?: Sample; solved: boolean } = { solved: false };
  const shortest: { sample?: Sample; solved: boolean } = { solved: false };
  const values: Record<string, number> = {};
  const visit = (depth: number, solved: boolean) => {
    if (depth === swept.length) {
      const ends = crossingEnds(design, route, lift_mm, after_segment, values);
      const sample: Sample = { values: { ...values }, ends, chord: chordOf(ends) };
      if (solved) sampled.push(sample);
      if (sample.chord < chordMin) {
        chordMin = sample.chord;
        shortest.sample = sample;
        shortest.solved = solved;
      }
      if (sample.chord > chordMax) {
        chordMax = sample.chord;
        longest.sample = sample;
        longest.solved = solved;
      }
      return;
    }
    const joint = swept[depth]!;
    const [lo, hi] = jointRange(joint)!;
    for (let k = 0; k < steps; k++) {
      values[joint.id] = lo + ((hi - lo) * k) / (steps - 1);
      visit(depth + 1, solved && k % fine === 0);
    }
  };
  visit(0, true);
  // The pose of the longest straight distance is where the cable is most
  // nearly taut, and that of the shortest is where it has the most spare:
  // solve them too when they fall between the others.
  if (longest.sample && !longest.solved) sampled.push(longest.sample);
  if (shortest.sample && !shortest.solved && shortest.sample !== longest.sample) sampled.push(shortest.sample);

  // ---- the way round the model at each solved pose, where the caller knows it.
  const detours: Array<number | undefined> = sampled.map((pose) => {
    const d = options.detour_mm?.(pose.values, pose.ends);
    return d !== undefined && Number.isFinite(d) && d > pose.chord ? d : undefined;
  });
  const detourMax = detours.reduce<number | undefined>((m, d) => (d === undefined ? m : m === undefined ? d : Math.max(m, d)), undefined);

  // ---- the length.
  let free: number;
  let basis: CrossingSlack['basis'];
  if (options.slack_mm !== undefined) {
    free = chordMax + options.slack_mm;
    basis = 'user';
  } else {
    // The pose that needs the most cable sets the length. Longest straight
    // distance first: it usually is that pose, and the others can then be
    // ruled out with a solve or two each.
    const quick: SpanOptions = { ...spanOptions, max_sweeps: Math.min(spanOptions.max_sweeps ?? SEARCH_SWEEPS, SEARCH_SWEEPS) };
    let want = 0;
    const order = [...sampled].sort((p, q) => q.chord - p.chord);
    for (const pose of order) {
      if (!(pose.chord > 1e-9)) continue;
      if (want >= pose.chord * (1 + SEARCH_LIMIT)) continue;
      if (want > pose.chord * 1.01) {
        // Already within its limit at the current length: it needs no more.
        const here = relaxSpan(pose.ends, want, quick).min_radius_mm;
        if (here >= options.bend_limit_mm) continue;
        // Or already past its gentlest length: more would only add spare.
        // Looked at 1 % and 3 % further on, so that a gentlest length lying
        // just beyond the current one is not mistaken for one already passed
        // (what can still slip through is under 1 %, inside the allowance).
        const nearer = relaxSpan(pose.ends, want * 1.01, quick).min_radius_mm;
        if (nearer <= here && relaxSpan(pose.ends, want * 1.03, quick).min_radius_mm <= here) continue;
      }
      want = Math.max(want, naturalLength(pose.ends, { ...spanOptions, bend_limit_mm: options.bend_limit_mm }));
    }
    // And never shorter than the way round the model at any pose.
    free = Math.max(chordMax, want, detourMax ?? 0) * (1 + SLACK_ALLOWANCE);
    basis = 'auto';
  }

  // ---- what that length does at every pose.
  const poses: SlackPose[] = sampled.map((pose, i) => {
    const shape = relaxSpan(pose.ends, free, spanOptions);
    const flat = flatDemand(pose.ends);
    const detour = detours[i];
    return {
      values: pose.values,
      chord_mm: pose.chord,
      short_by_mm: Math.max(shape.short_by_mm, detour !== undefined ? Math.max(0, detour - free) : 0),
      ...(detour !== undefined ? { detour_mm: detour } : {}),
      min_radius_mm: shape.min_radius_mm,
      bulge_mm: shape.bulge_mm,
      converged: shape.converged,
      ...(flat ? flat : {}),
    };
  });
  let tightest = 0;
  poses.forEach((p, i) => {
    if (p.min_radius_mm < poses[tightest]!.min_radius_mm) tightest = i;
  });
  const reaches = poses.every((p) => p.short_by_mm === 0);

  return {
    after_segment,
    from_link: from.link,
    to_link: to.link,
    joints: moving.map((j) => j.id),
    unsampled: moving.slice(3).map((j) => j.id),
    continuous: moving.filter((j) => j.type === 'continuous').map((j) => j.id),
    chord_min_mm: chordMin,
    chord_max_mm: chordMax,
    ...(detourMax !== undefined ? { detour_max_mm: detourMax } : {}),
    free_length_mm: free,
    slack_mm: free - chordMax,
    basis,
    bend_limit_mm: options.bend_limit_mm,
    reaches,
    bend_ok: reaches && poses[tightest]!.min_radius_mm >= options.bend_limit_mm,
    tightest,
    bulge_mm: Math.max(...poses.map((p) => p.bulge_mm)),
    ...(poses.every((p) => p.twist_deg !== undefined)
      ? { twist_deg: Math.max(...poses.map((p) => p.twist_deg!)), sideways_mm: Math.max(...poses.map((p) => p.sideways_mm!)) }
      : {}),
    poses,
  };
}

export interface RouteSlack {
  /** Length lying on links; the same at every pose. */
  on_links_mm: number;
  crossings: CrossingSlack[];
  /** The route's length with every crossing at its free length: what the cable is cut from. */
  length_mm: number;
  /**
   * True when `length_mm` can be relied on as modelled: every crossing reaches
   * at every sampled pose, none has joints that were not swept and none
   * crosses a joint that turns without limit.
   */
  complete: boolean;
}

export interface RouteSlackOptions extends SpanOptions {
  /** The cable's limit where it is installed and left. Used for crossings no joint moves. */
  bend_static_mm: number;
  /** The cable's limit where it flexes in use. Used for crossings a joint moves; falls back to the static one. */
  bend_dynamic_mm?: number;
  samples?: number;
  /** As `SlackOptions.detour_mm`, with the index of the segment the crossing leaves from. */
  detour_mm?: (after_segment: number, values: Readonly<Record<string, number>>, ends: CrossingEnds) => number | undefined;
}

/**
 * The slack a route states for the crossing after `after_segment`: the first
 * entry of `route.crossings` naming a joint on the path between the two links.
 * Undefined when the route states none. Slack is stated per joint, so a route
 * that crosses the same joint twice (out and back) gets the same figure for
 * both crossings.
 */
export function statedSlack(design: Design, route: Route, after_segment: number): number | undefined {
  const from = route.segments[after_segment];
  const to = route.segments[after_segment + 1];
  if (!from || !to) return undefined;
  const path = jointsBetween(design.scene, from.link, to.link) ?? [];
  return route.crossings.find((c) => path.includes(c.joint))?.slack_mm;
}

/** Every crossing of a route, and the length of cable the route needs. */
export function routeSlack(design: Design, route: Route, lift_mm: number, options: RouteSlackOptions): RouteSlack {
  let onLinks = 0;
  for (const segment of route.segments) onLinks += polylineLength(segmentCentreLine(segment, lift_mm));
  const jointsById = new Map(design.scene.joints.map((j) => [j.id, j]));
  const crossings: CrossingSlack[] = [];
  for (let i = 0; i + 1 < route.segments.length; i++) {
    const path = jointsBetween(design.scene, route.segments[i]!.link, route.segments[i + 1]!.link) ?? [];
    const moves = path.some((id) => jointRange(jointsById.get(id)!) !== null);
    const stated = statedSlack(design, route, i);
    crossings.push(
      crossingSlack(design, route, lift_mm, i, {
        bend_limit_mm: moves ? (options.bend_dynamic_mm ?? options.bend_static_mm) : options.bend_static_mm,
        ...(stated !== undefined ? { slack_mm: stated } : {}),
        ...(options.samples !== undefined ? { samples: options.samples } : {}),
        ...(options.segments !== undefined ? { segments: options.segments } : {}),
        ...(options.max_sweeps !== undefined ? { max_sweeps: options.max_sweeps } : {}),
        ...(options.detour_mm ? { detour_mm: (values, ends) => options.detour_mm!(i, values, ends) } : {}),
      }),
    );
  }
  return {
    on_links_mm: onLinks,
    crossings,
    length_mm: onLinks + crossings.reduce((sum, c) => sum + c.free_length_mm, 0),
    complete: crossings.every((c) => c.reaches && c.unsampled.length === 0 && c.continuous.length === 0),
  };
}
