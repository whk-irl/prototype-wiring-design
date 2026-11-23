/**
 * The geometry of a route: where a cable's centre line runs, how long the
 * cable must be, and how tightly the route asks it to bend.
 *
 * A route is a list of segments. Each segment belongs to one link and lists
 * points in that link's frame, so it moves with the link. A point with a
 * surface normal lies ON the model; the centre line passes `lift` above it,
 * `lift` being half the cable's height, so one route fits any cable type and
 * a thicker cable simply stands further off the surface. Between the last
 * point of one segment and the first point of the next the cable crosses from
 * link to link, usually over a joint.
 *
 * Length model. On a link the length is that of the polyline through the
 * lifted points (slightly more than a cable that rounds its corners, so it
 * errs long). Across a crossing, `routeLength` here gives only the straight
 * distance between the two end points over the joints' range: the SHORTEST
 * cable that could bridge the gap, a lower bound. The cable a crossing really
 * needs, with the loop that lets the joint move, is worked out in `slack.ts`
 * (`routeSlack`); use that for anything that is cut or checked.
 *
 * Flat cables. A ribbon or flat flex cable bends only across its thickness. It
 * cannot turn sideways in its own plane: to change direction on a surface it
 * must be folded. `inPlaneTurns` finds the corners that ask for that.
 */
import { Matrix4, Vector3 } from 'three';
import { computeLinkPoses } from './kinematics';
import type { Design, Joint, Route, Scene, Vec3 } from './schema';

type Segment = Route['segments'][number];

/** Centre-line points of one segment, in its link's frame. */
export function segmentCentreLine(segment: Segment, lift_mm: number): Vec3[] {
  return segment.points_mm.map((p, i) => {
    const n = segment.normals?.[i];
    if (!n || (n[0] === 0 && n[1] === 0 && n[2] === 0)) return [p[0], p[1], p[2]];
    return [p[0] + n[0] * lift_mm, p[1] + n[1] * lift_mm, p[2] + n[2] * lift_mm];
  });
}

export function polylineLength(points: readonly Vec3[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    total += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }
  return total;
}

/**
 * The joints on the path through the joint tree from one link to another,
 * nearest `from` first. Empty when the links are the same. Null when they are
 * not connected (different root trees).
 */
export function jointsBetween(scene: Scene, from: string, to: string): string[] | null {
  if (from === to) return [];
  const parentJoint = new Map<string, Joint>();
  for (const j of scene.joints) parentJoint.set(j.child, j);
  const chain = (link: string): { links: string[]; joints: string[] } => {
    const links = [link];
    const joints: string[] = [];
    let current = link;
    for (let guard = 0; guard <= scene.joints.length; guard++) {
      const j = parentJoint.get(current);
      if (!j) break;
      joints.push(j.id);
      current = j.parent;
      links.push(current);
    }
    return { links, joints };
  };
  const a = chain(from);
  const b = chain(to);
  for (let i = 0; i < a.links.length; i++) {
    const k = b.links.indexOf(a.links[i]!);
    if (k >= 0) return [...a.joints.slice(0, i), ...b.joints.slice(0, k).reverse()];
  }
  return null;
}

/** The whole centre line in world coordinates at a pose, with where each segment starts. */
export function routeCentreLineWorld(
  design: Design,
  route: Route,
  lift_mm: number,
  values: Readonly<Record<string, number>> = {},
): { points: Vec3[]; starts: number[] } {
  const poses = computeLinkPoses(design.scene, values);
  const points: Vec3[] = [];
  const starts: number[] = [];
  const v = new Vector3();
  for (const segment of route.segments) {
    const pose = poses.get(segment.link) ?? new Matrix4();
    starts.push(points.length);
    for (const p of segmentCentreLine(segment, lift_mm)) {
      v.set(p[0], p[1], p[2]).applyMatrix4(pose);
      points.push([v.x, v.y, v.z]);
    }
  }
  return { points, starts };
}

export interface CrossingSpan {
  /** Index of the segment the span leaves from; it arrives at the next one. */
  after_segment: number;
  from_link: string;
  to_link: string;
  /** Joints whose motion changes this span. Empty: the span never changes. */
  joints: string[];
  /**
   * Joints on the path that were NOT swept (only the first three are): they
   * were held at their saved value, so `min_mm` and `max_mm` may be too
   * narrow. Empty in the usual case.
   */
  unsampled: string[];
  /** Shortest and longest straight distance over the joints' range. */
  min_mm: number;
  max_mm: number;
}

export interface RouteLength {
  /** Length lying on links; the same at every pose. */
  on_links_mm: number;
  crossings: CrossingSpan[];
  /** Route length at the pose where the crossings are shortest and longest. */
  min_mm: number;
  max_mm: number;
}

/** The values a joint can take: null when it cannot move or has no limit set. */
export function jointRange(joint: Joint): [number, number] | null {
  if (joint.type === 'fixed') return null;
  if (joint.type === 'continuous') return [-Math.PI, Math.PI];
  if (!joint.limit) return null;
  return [joint.limit.lower, joint.limit.upper];
}

/**
 * Length of a route over the whole range of motion.
 *
 * Each crossing is sampled over every combination of `samples` values per
 * joint on its path (other joints do not affect it), up to three joints per
 * crossing; a crossing over more joints is sampled with the three nearest its
 * start and the rest at their saved value, and lists those in `unsampled`
 * because its range may then be too narrow. The route's longest length is the
 * sum of each crossing's longest span, which is exact when crossings depend on
 * different joints and otherwise errs long (unless a crossing has unsampled
 * joints).
 */
export function routeLength(design: Design, route: Route, lift_mm: number, samples = 9): RouteLength {
  const jointsById = new Map(design.scene.joints.map((j) => [j.id, j]));
  let onLinks = 0;
  const lines = route.segments.map((s) => segmentCentreLine(s, lift_mm));
  for (const line of lines) onLinks += polylineLength(line);

  const crossings: CrossingSpan[] = [];
  const a = new Vector3();
  const b = new Vector3();
  for (let i = 0; i + 1 < route.segments.length; i++) {
    const from = route.segments[i]!;
    const to = route.segments[i + 1]!;
    const end = lines[i]![lines[i]!.length - 1]!;
    const start = lines[i + 1]![0]!;
    const path = jointsBetween(design.scene, from.link, to.link) ?? [];
    const moving = path.map((id) => jointsById.get(id)!).filter((j) => jointRange(j) !== null);
    const sampled = moving.slice(0, 3);

    let min = Infinity;
    let max = -Infinity;
    const values: Record<string, number> = {};
    const visit = (depth: number) => {
      if (depth === sampled.length) {
        const poses = computeLinkPoses(design.scene, values);
        a.set(end[0], end[1], end[2]).applyMatrix4(poses.get(from.link) ?? new Matrix4());
        b.set(start[0], start[1], start[2]).applyMatrix4(poses.get(to.link) ?? new Matrix4());
        const d = a.distanceTo(b);
        if (d < min) min = d;
        if (d > max) max = d;
        return;
      }
      const joint = sampled[depth]!;
      const [lo, hi] = jointRange(joint)!;
      const n = Math.max(2, samples);
      for (let k = 0; k < n; k++) {
        values[joint.id] = lo + ((hi - lo) * k) / (n - 1);
        visit(depth + 1);
      }
    };
    visit(0);
    crossings.push({
      after_segment: i,
      from_link: from.link,
      to_link: to.link,
      joints: moving.map((j) => j.id),
      unsampled: moving.slice(3).map((j) => j.id),
      min_mm: min,
      max_mm: max,
    });
  }

  return {
    on_links_mm: onLinks,
    crossings,
    min_mm: onLinks + crossings.reduce((s, c) => s + c.min_mm, 0),
    max_mm: onLinks + crossings.reduce((s, c) => s + c.max_mm, 0),
  };
}

/**
 * Wire to cut for a route: the longest route length, times the cable's length
 * factor (more than 1 when twisted), plus an allowance per end for stripping
 * and termination.
 */
export function cutLength(length: RouteLength, length_factor: number, allowance_per_end_mm = 0): number {
  return length.max_mm * length_factor + 2 * allowance_per_end_mm;
}

/**
 * The largest radius each interior corner of a polyline can be rounded to,
 * using at most half of each adjoining leg (so neighbouring corners do not
 * compete for the same stretch). Infinity for a straight-through point, 0 for
 * a reversal. One entry per interior point: index i describes point i + 1.
 */
export function cornerRadii(points: readonly Vec3[]): number[] {
  const out: number[] = [];
  for (let i = 1; i + 1 < points.length; i++) {
    const p = points[i - 1]!;
    const q = points[i]!;
    const r = points[i + 1]!;
    const inX = q[0] - p[0];
    const inY = q[1] - p[1];
    const inZ = q[2] - p[2];
    const outX = r[0] - q[0];
    const outY = r[1] - q[1];
    const outZ = r[2] - q[2];
    const l1 = Math.hypot(inX, inY, inZ);
    const l2 = Math.hypot(outX, outY, outZ);
    if (l1 === 0 || l2 === 0) {
      out.push(0);
      continue;
    }
    // Work with unit directions, and get tan(turn / 2) = |u x v| / (1 + u . v)
    // from the cross product. Going through acos would turn one unit of
    // rounding in the cosine into 1e-8 rad for a straight line.
    const ux = inX / l1;
    const uy = inY / l1;
    const uz = inZ / l1;
    const vx = outX / l2;
    const vy = outY / l2;
    const vz = outZ / l2;
    const cross = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    const dot = ux * vx + uy * vy + uz * vz;
    if (cross < 1e-12) out.push(dot > 0 ? Infinity : 0);
    else out.push((Math.min(l1, l2) / 2) * ((1 + dot) / cross));
  }
  return out;
}

export interface TightBend {
  segment: number;
  /** Index into the segment's points. */
  point: number;
  radius_mm: number;
}

/** The tightest corner of each segment that is tighter than `limit_mm`, worst first. */
export function bendsTighterThan(route: Route, lift_mm: number, limit_mm: number): TightBend[] {
  const out: TightBend[] = [];
  route.segments.forEach((segment, s) => {
    cornerRadii(segmentCentreLine(segment, lift_mm)).forEach((radius, i) => {
      if (radius < limit_mm) out.push({ segment: s, point: i + 1, radius_mm: radius });
    });
  });
  return out.sort((x, y) => x.radius_mm - y.radius_mm);
}

export interface InPlaneTurn {
  segment: number;
  /** Index into the segment's points. */
  point: number;
  /** How far the route turns within the surface at this point, in degrees. */
  angle_deg: number;
}

/**
 * Corners where a route turns sideways within the surface it lies on, by more
 * than `tolerance_deg`. A round cable does not care. A flat cable cannot do
 * it: it has to be folded there (or the route changed), so each of these is a
 * place the drawing shows something the cable cannot do as drawn.
 *
 * Only points that carry a surface normal are judged; at a free point the
 * ribbon's orientation is not known.
 */
export function inPlaneTurns(route: Route, lift_mm: number, tolerance_deg = 5): InPlaneTurn[] {
  const out: InPlaneTurn[] = [];
  route.segments.forEach((segment, s) => {
    const line = segmentCentreLine(segment, lift_mm);
    for (let i = 1; i + 1 < line.length; i++) {
      const n = segment.normals?.[i];
      if (!n || (n[0] === 0 && n[1] === 0 && n[2] === 0)) continue;
      const p = line[i - 1]!;
      const q = line[i]!;
      const r = line[i + 1]!;
      // Project both legs onto the surface plane at the corner.
      const project = (a: Vec3, b: Vec3): Vec3 => {
        const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const along = d[0] * n[0] + d[1] * n[1] + d[2] * n[2];
        return [d[0] - along * n[0], d[1] - along * n[1], d[2] - along * n[2]];
      };
      const u = project(p, q);
      const v = project(q, r);
      const lu = Math.hypot(u[0], u[1], u[2]);
      const lv = Math.hypot(v[0], v[1], v[2]);
      // A leg that leaves straight along the normal has no direction in the plane.
      if (lu < 1e-9 || lv < 1e-9) continue;
      const cross = Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
      const dot = u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
      const angle = (Math.atan2(cross, dot) * 180) / Math.PI;
      if (angle > tolerance_deg) out.push({ segment: s, point: i, angle_deg: angle });
    }
  });
  return out.sort((a, b) => b.angle_deg - a.angle_deg);
}

/**
 * Where a string pulled tight over a height profile touches it.
 *
 * `profile` is a list of [distance along the leg, height] samples of the
 * surface under a leg, distances increasing. A cable laid over a bumpy surface
 * under light tension does not follow every hollow: it rests on the high
 * points and bridges the gaps between them, which is the upper convex hull of
 * the profile. Returns the indices of the samples it touches, always including
 * the first and the last.
 *
 * Use it to turn a dense surface profile into the few points a real cable
 * would rest on. Rounding those contact points to the cable's bend radius is a
 * separate matter (`cornerRadii`).
 */
export function tautOverProfile(profile: readonly (readonly [number, number])[]): number[] {
  const hull: number[] = [];
  for (let i = 0; i < profile.length; i++) {
    const [x, y] = profile[i]!;
    while (hull.length >= 2) {
      const [ax, ay] = profile[hull[hull.length - 2]!]!;
      const [bx, by] = profile[hull[hull.length - 1]!]!;
      // The middle point stays only if the path turns downward at it (it
      // pokes above the straight line from its neighbours).
      const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
      if (cross >= 0) hull.pop();
      else break;
    }
    hull.push(i);
  }
  return hull;
}
