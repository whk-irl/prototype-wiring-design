/**
 * Building and editing routes from clicked points. Pure.
 *
 * The editing model is a flat list of route points, each with its link,
 * position and normal in that link's frame. Consecutive points on the same
 * link form one segment; a change of link starts the next segment, and the
 * gap between them is a crossing (usually over a joint). Every edit works on
 * the flat list and rebuilds the segments, so moving a point to another link
 * splits and merges segments as needed.
 */
import { jointsBetween, type Cable, type Design, type Route, type Vec3 } from '@core';

export interface RoutePoint {
  link: string;
  /** Link frame, mm. */
  p: Vec3;
  /** Outward unit surface normal (link frame), or [0, 0, 0] for a point the centre line passes exactly (a port, free space). */
  n: Vec3;
  /**
   * True where the wire is HELD: a point the user placed, a port, a lead-out
   * end. False for a point the drape added (a contact over a bump or an edge,
   * where the path changes body): only the starting path of the stiff wire.
   * Absent: not known (a point built by code that does not say).
   */
  tie?: boolean;
}

export const ZERO: Vec3 = [0, 0, 0];

type Segment = Route['segments'][number];

/** Segments from an ordered list of points. Hold flags (`ties`) are written when any point states one. */
export function segmentsFromPoints(points: readonly RoutePoint[]): Segment[] {
  const out: Segment[] = [];
  const withTies = points.some((p) => p.tie !== undefined);
  for (const pt of points) {
    const last = out[out.length - 1];
    if (last && last.link === pt.link) {
      last.points_mm.push([...pt.p]);
      last.normals!.push([...pt.n]);
      if (withTies) last.ties!.push(pt.tie ?? false);
    } else {
      out.push({ link: pt.link, points_mm: [[...pt.p]], normals: [[...pt.n]], ...(withTies ? { ties: [pt.tie ?? false] } : {}) });
    }
  }
  return out;
}

// ---------------------------------------------------------------- holds

const vsub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const vlen = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const vunit = (a: Vec3): Vec3 | undefined => {
  const l = vlen(a);
  return l > 1e-9 ? [a[0] / l, a[1] / l, a[2] / l] : undefined;
};
const vdot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** A turn smaller than this at a route point is drawing noise or the drape following the surface, not a placed point. */
export const PIN_TURN_DEG = 15;

/**
 * Which points of a segment most likely held the wire, for a route saved
 * before holds were recorded (`ties`): its two ends, every free point (no
 * surface normal: a port, its lead-out, a point in free space or a hole), and
 * every point where the route turns in a way a wire laid over the surface
 * would not by itself: sideways within the surface (an in-plane turn) or up
 * away from it (into an inside corner). Points where the route only bends
 * round the surface (over an edge, over a bump: the turn points into the
 * surface) are contacts the drape added. Holds closer than `minGap_mm` along
 * the line merge (the ends stay).
 */
export function segmentPins(points: readonly Vec3[], normals: readonly (Vec3 | undefined)[], minGap_mm = 0): number[] {
  const out = [0];
  const cosMin = Math.cos((PIN_TURN_DEG * Math.PI) / 180);
  for (let i = 1; i < points.length - 1; i++) {
    const n = normals[i];
    if (!n || vlen(n) < 1e-9) {
      out.push(i);
      continue;
    }
    let a: Vec3 | undefined;
    for (let j = i - 1; j >= 0 && !a; j--) a = vunit(vsub(points[i]!, points[j]!));
    let b: Vec3 | undefined;
    for (let j = i + 1; j < points.length && !b; j++) b = vunit(vsub(points[j]!, points[i]!));
    if (!a || !b || vdot(a, b) > cosMin) continue;
    const k = vunit(vsub(b, a))!;
    // Into the surface (k . n < 0): bending round it, the wire does that itself. Otherwise it was held here.
    if (vdot(k, vunit(n)!) > -0.5) out.push(i);
  }
  if (points.length > 1) out.push(points.length - 1);
  const unique = [...new Set(out)];
  if (!(minGap_mm > 0)) return unique;
  const along: number[] = [0];
  for (let i = 1; i < points.length; i++) along.push(along[i - 1]! + vlen(vsub(points[i]!, points[i - 1]!)));
  const end = along[points.length - 1]!;
  const kept = [0];
  for (const i of unique) {
    if (i === 0 || i === points.length - 1) continue;
    if (along[i]! - along[kept[kept.length - 1]!]! >= minGap_mm && end - along[i]! >= minGap_mm) kept.push(i);
  }
  if (points.length > 1) kept.push(points.length - 1);
  return kept;
}

/**
 * One flag per point of the route (flat order), true where the wire is held:
 * the route's `ties` where it records them, else worked out from the path
 * (`segmentPins` on each segment). The two ends of the route are always held.
 */
export function routeHolds(route: Route): boolean[] {
  const out: boolean[] = [];
  for (const s of route.segments) {
    if (s.ties && s.ties.length === s.points_mm.length) out.push(...s.ties);
    else {
      const pins = new Set(segmentPins(s.points_mm, s.points_mm.map((_, i) => s.normals?.[i])));
      s.points_mm.forEach((_, i) => out.push(pins.has(i)));
    }
  }
  if (out.length) {
    out[0] = true;
    out[out.length - 1] = true;
  }
  return out;
}

/** A run of holds on one link joined by laid stretches (the points between consecutive holds all on that link). */
export interface HoldRun {
  link: string;
  /** Flat indices of its holds, in order (at least one). */
  holds: number[];
}

/**
 * The route's holds grouped into runs: consecutive holds on the same link,
 * with every point between them on that link too, are one run (laid stretches
 * settled together). Between two runs the wire hangs free over the joint(s)
 * between them (a loop). A run of one hold is a single tie the wire pivots at.
 */
export function holdRuns(points: readonly RoutePoint[]): HoldRun[] {
  const runs: HoldRun[] = [];
  let prev = -1;
  points.forEach((pt, i) => {
    if (!pt.tie) return;
    const last = runs[runs.length - 1];
    let joined = false;
    if (last && prev >= 0 && last.link === pt.link) {
      joined = true;
      for (let k = prev + 1; k < i; k++) if (points[k]!.link !== pt.link) joined = false;
    }
    if (joined) last!.holds.push(i);
    else runs.push({ link: pt.link, holds: [i] });
    prev = i;
  });
  return runs;
}

/** The flat point list of a route, each with its hold flag (`routeHolds`). */
export function pointsOfRoute(route: Route): RoutePoint[] {
  const out: RoutePoint[] = [];
  const holds = routeHolds(route);
  for (const s of route.segments) {
    s.points_mm.forEach((p, i) => out.push({ link: s.link, p: [...p], n: s.normals?.[i] ? [...s.normals[i]!] : [...ZERO], tie: holds[out.length] ?? false }));
  }
  return out;
}

/** Make a normal a unit vector, or zero when it is (nearly) zero; validation needs exactly one or the other. */
export function cleanNormal(n: Vec3): Vec3 {
  const l = Math.hypot(n[0], n[1], n[2]);
  if (l < 1e-9) return [0, 0, 0];
  return [n[0] / l, n[1] / l, n[2] / l];
}

/**
 * A route through these points. When any point says whether it is held, hold
 * flags are written for all (a point that does not say is not a hold; the
 * route's two ends always are). Points from `pointsOfRoute` always say, so an
 * edited route saved before holds were recorded gets them written.
 */
export function withPoints(route: Route, points: readonly RoutePoint[]): Route {
  const last = points.length - 1;
  const told = points.some((p) => p.tie !== undefined);
  return {
    ...route,
    segments: segmentsFromPoints(points.map((p, i) => ({ ...p, n: cleanNormal(p.n), ...(told ? { tie: i === 0 || i === last ? true : (p.tie ?? false) } : {}) }))),
  };
}

export function insertPoint(route: Route, index: number, point: RoutePoint): Route {
  const pts = pointsOfRoute(route);
  pts.splice(Math.max(0, Math.min(pts.length, index)), 0, point);
  return withPoints(route, pts);
}

export function movePoint(route: Route, index: number, point: RoutePoint): Route {
  const pts = pointsOfRoute(route);
  if (index < 0 || index >= pts.length) return route;
  pts[index] = point;
  return withPoints(route, pts);
}

/** Remove a point. A route keeps at least two points; returns null when the removal would leave fewer. */
export function deletePoint(route: Route, index: number): Route | null {
  const pts = pointsOfRoute(route);
  if (pts.length <= 2) return null;
  pts.splice(index, 1);
  return withPoints(route, pts);
}

// ---------------------------------------------------------------- cables in the design

export interface CableSettings {
  type: string;
  count: number;
  twisted: boolean;
  lay_length_mm?: number;
  sleeve_wall_mm: number;
  /** Lay each leg between surface points on the surface (drawing and dragging). Off: straight legs. */
  drape?: boolean;
}

function nextFree(base: string, taken: ReadonlySet<string>): string {
  for (let n = 1; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** Add a cable and its route (one route per drawn wire). */
export function addWire(design: Design, settings: CableSettings, points: readonly RoutePoint[], name?: string): { design: Design; cableId: string } {
  const cableIds = new Set(design.cables.map((c) => c.id));
  const routeIds = new Set(design.routes.map((r) => r.id));
  const cableId = nextFree('wire', cableIds);
  const routeId = nextFree('route', routeIds);
  const n = Number(cableId.slice(5));
  const cable: Cable = {
    id: cableId,
    name: name ?? `Wire ${n}`,
    connections: [],
    type: settings.type,
    count: settings.count,
    twisted: settings.twisted,
    ...(settings.lay_length_mm !== undefined ? { lay_length_mm: settings.lay_length_mm } : {}),
    sleeve_wall_mm: settings.sleeve_wall_mm,
    reasons: [],
  };
  const route: Route = withPoints({ id: routeId, cable: cableId, segments: [], crossings: [] }, points);
  return { design: { ...design, cables: [...design.cables, cable], routes: [...design.routes, route] }, cableId };
}

export function routeOfCable(design: Design, cableId: string): Route | undefined {
  return design.routes.find((r) => r.cable === cableId);
}

export function updateCable(design: Design, cableId: string, patch: Partial<Omit<Cable, 'id'>>): Design {
  return {
    ...design,
    cables: design.cables.map((c) => {
      if (c.id !== cableId) return c;
      const next = { ...c, ...patch };
      if ('lay_length_mm' in patch && patch.lay_length_mm === undefined) delete next.lay_length_mm;
      if ('length_mm' in patch && patch.length_mm === undefined) delete next.length_mm;
      if ('bend_override_mm' in patch && patch.bend_override_mm === undefined) delete next.bend_override_mm;
      return next;
    }),
  };
}

export function updateRoute(design: Design, routeId: string, route: Route): Design {
  return { ...design, routes: design.routes.map((r) => (r.id === routeId ? route : r)) };
}

/** Remove a cable, its routes and fixings on them. */
export function removeWire(design: Design, cableId: string): Design {
  const routes = design.routes.filter((r) => r.cable === cableId).map((r) => r.id);
  return {
    ...design,
    cables: design.cables.filter((c) => c.id !== cableId),
    routes: design.routes.filter((r) => r.cable !== cableId),
    fixings: design.fixings.filter((f) => !routes.includes(f.route)),
  };
}

/**
 * State (a number, mm beyond the longest straight distance) or clear
 * (undefined: automatic) the slack of loop `afterSegment`: the free cable
 * between hold run `afterSegment` and the next (`holdRuns`; the checks number
 * crossings the same way). Stored as `route.crossings` = { joint: the first
 * joint on the path between the two links, strategy: 'service_loop',
 * slack_mm }; any other entry naming a joint on that path is removed, since
 * the slack model reads the first one it finds.
 */
export function setCrossingSlack(design: Design, routeId: string, afterSegment: number, slack_mm: number | undefined): Design {
  const route = design.routes.find((r) => r.id === routeId);
  const runs = route ? holdRuns(pointsOfRoute(route)) : [];
  const from = runs[afterSegment];
  const to = runs[afterSegment + 1];
  if (!route || !from || !to) return design;
  const path = jointsBetween(design.scene, from.link, to.link) ?? [];
  if (path.length === 0) return design;
  const kept = route.crossings.filter((c) => !path.includes(c.joint));
  const crossings = slack_mm === undefined ? kept : [...kept, { joint: path[0]!, strategy: 'service_loop' as const, slack_mm: Math.max(0, slack_mm) }];
  return updateRoute(design, route.id, { ...route, crossings });
}
