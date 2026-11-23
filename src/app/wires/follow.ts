/**
 * Wire ends follow their part. A route end attached to a port (`route.from`
 * / `route.to`) starts with two points on the component's link: the port
 * itself and the end of the lead-out in front of it, both free points (zero
 * normal). When the component moves or turns, moves to another link, or the
 * port is edited, those two points are recomputed from the port pose: the
 * end at the port, the lead-out along the port's exit direction, as long as
 * before but never shorter than the plug (the cable cannot bend inside it).
 * The leg from the lead-out onwards starts at a free point, so it is a
 * straight span and needs no re-draping.
 *
 * Each attached end owns exactly two points (see `followPoints`); a route
 * attached at both ends always has at least four, so the ends never share a
 * point, and following is idempotent. An end whose component or port no
 * longer exists is left where it is (the commit detaches it; see
 * state/portRefs.ts). Pure (no store, no geometry).
 */
import { Quaternion, Vector3 } from 'three';
import {
  cableEnvelope,
  connectorBoxes,
  findCableType,
  findConnector,
  findPart,
  portWays,
  type CableLibrary,
  type CableType,
  type CableBuild,
  type Component,
  type ConnectorLibrary,
  type Design,
  type Library,
  type Port,
  type PortRef,
  type Route,
} from '@core';
import { pointsOfRoute, withPoints, type RoutePoint } from './routeEdit';

export interface FollowLibraries {
  library: Library | null;
  connectors: ConnectorLibrary | null;
  cables: CableLibrary | null;
}

/** The plug's length at a port (0 when the connector or its size is not known). */
export function plugLengthAt(port: Port, connectors: ConnectorLibrary | null): number {
  const conn = connectors ? findConnector(connectors, port.connector) : undefined;
  const ways = conn ? portWays(conn, port) : undefined;
  return conn && ways ? (connectorBoxes(conn, ways).plug?.[0] ?? 0) : 0;
}

/** Lead-out length for a cable leaving a port: room to turn within its bend radius, and at least the plug. */
export function leadOutLength(type: CableType | undefined, build: CableBuild, plug: number): number {
  const size = type ? (type.section.shape === 'round' ? type.section.od_mm : type.section.width_mm) : 2;
  const bend = type ? cableEnvelope(type, build).bend_static_mm : 5;
  return Math.max(5, 3 * size, 2 * bend, plug);
}

/** The port point and its exit direction, in the component's link frame. */
export function portInLink(component: Component, port: Port): { origin: Vector3; exit: Vector3 } {
  const cq = new Quaternion(...component.pose.q).normalize();
  const origin = new Vector3(...port.pose.p_mm).applyQuaternion(cq).add(new Vector3(...component.pose.p_mm));
  const exit = new Vector3(1, 0, 0).applyQuaternion(new Quaternion(...port.pose.q).normalize()).applyQuaternion(cq).normalize();
  return { origin, exit };
}

const isFree = (p: RoutePoint | undefined) => !!p && Math.hypot(...p.n) < 1e-9;
const same = (a: RoutePoint, b: RoutePoint) => a.link === b.link && Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1], a.p[2] - b.p[2]) < 1e-6 && Math.hypot(a.n[0] - b.n[0], a.n[1] - b.n[1], a.n[2] - b.n[2]) < 1e-9;

/** Where an attached end is now: the port point and its exit in the component's link frame, plus the plug length. Null when the component or port is gone. */
function portPose(design: Design, libs: FollowLibraries, ref: PortRef): { link: string; origin: Vector3; exit: Vector3; plug: number } | null {
  const component = design.components.find((c) => c.id === ref.component);
  const part = component && libs.library ? findPart(libs.library, component.part) : undefined;
  const port = part?.ports.find((p) => p.id === ref.port);
  if (!component || !port) return null;
  return { link: component.link, ...portInLink(component, port), plug: plugLengthAt(port, libs.connectors) };
}

/** The lead-out a new end gets: the cable's own rule (bend room, at least the plug). */
function freshLead(design: Design, libs: FollowLibraries, route: Route, plug: number): number {
  const cable = design.cables.find((c) => c.id === route.cable);
  const type: CableType | undefined = cable && libs.cables ? findCableType(libs.cables, cable.type) : undefined;
  return leadOutLength(type, cable ?? { count: 1, twisted: false, sleeve_wall_mm: 0 }, plug);
}

/**
 * The points of a route with its attached ends put on their ports. Each
 * attached end OWNS two points: the end point (at the port) and its lead-out
 * point next to it. Ownership is by position, never shared: `from` owns
 * points 0 and 1, `to` owns the last two, and when both ends are attached a
 * route has at least four points (missing lead-outs are inserted), so the two
 * ends can never claim the same point. A lead-out keeps its length (it may
 * have been shortened to clear something) but never goes under the plug;
 * a point that is not a free point on the end point's link (a surface point
 * the user dragged there) is not a lead-out, and one is inserted in front of
 * it. Applying this twice changes nothing the second time.
 */
export function followPoints(design: Design, libs: FollowLibraries, route: Route, input: readonly RoutePoint[]): RoutePoint[] {
  const from = route.from ? portPose(design, libs, route.from) : null;
  const to = route.to ? portPose(design, libs, route.to) : null;
  if ((!from && !to) || input.length === 0) return [...input];
  let pts = [...input];
  // A lone point cannot be both ends: give the route a second one to work with.
  if (pts.length === 1) pts = [pts[0]!, { ...pts[0]! }];
  const n = pts.length;
  const leadAt = (endIdx: number, leadIdx: number) => {
    const e = pts[endIdx];
    const l = pts[leadIdx];
    return !!e && !!l && isFree(l) && l.link === e.link;
  };
  // Which input points each end owns: `from` first, then `to` from what is left.
  // With both ends attached `from` takes a lead-out only when a point is left for `to`.
  const fromOwns = !from ? 0 : leadAt(0, 1) && (!to || n >= 3) ? 2 : 1;
  const left = n - fromOwns;
  const toOwns = !to ? 0 : left >= 2 && leadAt(n - 1, n - 2) ? 2 : left >= 1 ? 1 : 0;
  const build = (pose: NonNullable<typeof from>, owned: RoutePoint[]): [RoutePoint, RoutePoint] => {
    const [end, lead] = owned;
    const was = end && lead ? Math.hypot(lead.p[0] - end.p[0], lead.p[1] - end.p[1], lead.p[2] - end.p[2]) : 0;
    const len = Math.max(pose.plug, was > 1e-9 ? was : freshLead(design, libs, route, pose.plug));
    const tip = pose.origin.clone().addScaledVector(pose.exit, len);
    return [
      { link: pose.link, p: [pose.origin.x, pose.origin.y, pose.origin.z], n: [0, 0, 0], tie: true },
      { link: pose.link, p: [tip.x, tip.y, tip.z], n: [0, 0, 0], tie: true },
    ];
  };
  const middle = pts.slice(fromOwns, n - toOwns);
  const head = from ? build(from, fromOwns === 2 ? [pts[0]!, pts[1]!] : [pts[0]!]) : [];
  const tailOwned = toOwns === 2 ? [pts[n - 1]!, pts[n - 2]!] : toOwns === 1 ? [pts[n - 1]!] : [];
  const tail = to ? build(to, tailOwned).reverse() : [];
  return [...head, ...middle, ...tail];
}

/** Move every attached route end to its port. Returns the same design when nothing moved. */
export function followWireEnds(design: Design, libs: FollowLibraries): Design {
  let changed = false;
  const routes = design.routes.map((route) => {
    if (!route.from && !route.to) return route;
    const pts = pointsOfRoute(route);
    const next = followPoints(design, libs, route, pts);
    if (next.length === pts.length && next.every((p, i) => same(p, pts[i]!))) return route;
    changed = true;
    return withPoints(route, next);
  });
  return changed ? { ...design, routes } : design;
}
