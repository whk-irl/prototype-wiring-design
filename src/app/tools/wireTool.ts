/**
 * Drawing a wire: each click adds a point on the surface under the cursor
 * (its link, position and outward normal). A click on a placed part's port
 * snaps to the port and adds a short lead-out along the port's exit
 * direction. Enter or double-click finishes, Esc cancels, Backspace removes
 * the last point. Shift+click inside a hole puts the point on the hole's axis
 * (the wire passes through its centre). The preview is drawn at true size.
 */
import { Ray, Vector3 } from 'three';
import { cableEnvelope, findCableType, findPart, poseToMatrix, type PortRef, type Vec3 } from '@core';
import { leadOutLength, plugLengthAt, portInLink } from '../wires/follow';
import { fitAxisFromSeed } from '../placement/axisFit';
import { topologyOf } from '../scene/topology';
import { drapeLeg, restingPoint } from '../wires/drape';
import { addWire, type RoutePoint } from '../wires/routeEdit';
import type { Tool, ToolContext, ToolPointerEvent } from './types';

const toV = (v: Vector3): Vec3 => [v.x, v.y, v.z];

/** The point(s) a click adds: a surface point, or a port plus its lead-out (and which port). */
export function pointsForClick(e: ToolPointerEvent, ctx: ToolContext): { points: RoutePoint[]; port?: PortRef } | null {
  const s = ctx.store.getState();
  const comp = ctx.viewport.pickComponent(e.ray);
  const hit = e.hit;
  if (comp && (!hit || comp.distance <= hit.distance + 1e-3)) {
    const c = s.design.components.find((x) => x.id === comp.componentId);
    const part = c && s.library ? findPart(s.library, c.part) : undefined;
    // Ports usually sit inside the body's outline: take the port the cursor ray passes nearest to.
    let port = part?.ports.find((p) => p.id === comp.portId);
    const lw = c ? ctx.viewport.linkWorldMatrix(c.link) : undefined;
    if (!port && part && c && lw) {
      const m = lw.clone().multiply(poseToMatrix(c.pose));
      let best = Infinity;
      for (const p of part.ports) {
        const d = e.ray.distanceToPoint(new Vector3(...p.pose.p_mm).applyMatrix4(m));
        if (d < best) {
          best = d;
          port = p;
        }
      }
      if (best > Math.max(4, Math.min(...part.body.size_mm.slice(0, 2)) * 0.15)) port = undefined;
    }
    if (c && port) {
      const { origin, exit } = portInLink(c, port);
      const type = s.cableLibrary ? findCableType(s.cableLibrary, s.wireSettings.type) : undefined;
      const size = type ? (type.section.shape === 'round' ? type.section.od_mm : type.section.width_mm) : 2;
      // Long enough for the cable to turn within its bend radius after leaving the connector,
      // and never shorter than the plug (the cable cannot bend inside it). Same rule as wires/follow.ts.
      const plug = plugLengthAt(port, s.connectorLibrary);
      let lead = leadOutLength(type, s.wireSettings, plug);
      // ...but not into whatever is in front of the connector (the plug check reports it if that is less than the plug).
      if (lw) {
        const ow = origin.clone().applyMatrix4(lw);
        const ew = exit.clone().transformDirection(lw);
        const ahead = ctx.viewport.pickRay(new Ray(ow, ew));
        if (ahead) lead = Math.max(plug, Math.min(lead, Math.max(2, ahead.distance - size)));
      }
      const portPt: RoutePoint = { link: c.link, p: toV(origin), n: [0, 0, 0], tie: true };
      const leadPt: RoutePoint = { link: c.link, p: toV(origin.clone().addScaledVector(exit, lead)), n: [0, 0, 0], tie: true };
      // Leaving a port: port first. Arriving: lead-out first.
      const ref: PortRef = { component: c.id, port: port.id };
      return { points: s.wireDraft && s.wireDraft.points.length > 0 ? [leadPt, portPt] : [portPt, leadPt], port: ref };
    }
  }
  if (!hit) return null;
  // Shift+click inside a hole or on a pin: the wire goes through the axis there (a cable hole's centre).
  if (e.native.shiftKey) {
    const entry = ctx.registry.get(hit.meshId);
    const fit = entry ? fitAxisFromSeed(topologyOf(entry.geometry), hit.triangle) : null;
    const obj = ctx.viewport.meshObject(hit.meshId);
    const lw = ctx.viewport.linkWorldMatrix(hit.linkId);
    if (fit && fit.kind === 'cylinder' && fit.quality === 'good' && obj && lw) {
      const toLink = lw.clone().invert().multiply(obj.matrixWorld);
      const a = new Vector3(...fit.point).applyMatrix4(toLink);
      const d = new Vector3(...fit.dir).transformDirection(toLink);
      const q = hit.link.point.clone();
      const onAxis = a.clone().addScaledVector(d, q.clone().sub(a).dot(d));
      return { points: [{ link: hit.linkId, p: toV(onAxis), n: [0, 0, 0], tie: true }] };
    }
  }
  // Normal facing the viewer (meshes with inconsistent winding exist).
  const n = hit.link.normal.clone();
  if (hit.world.normal.dot(e.ray.direction) > 0) n.negate();
  const pt: RoutePoint = { link: hit.linkId, p: toV(hit.link.point), n: toV(n.normalize()) };
  // A click into a gap narrower than the cable: the point goes where the cable can rest, on the rims.
  const r = drapeRadius(ctx);
  return { points: [{ ...(r !== null && s.wireSettings.drape !== false ? restingPoint(s.design, pt, r).point : pt), tie: true }] };
}

/**
 * The second click of a double-click lands where the first did: drop it with
 * everything it added (for a port: its lead-out and the port again, which
 * would leave the wire doubling back on itself).
 */
export function dropRepeatedClick<T extends { points: RoutePoint[]; marks?: number[]; markPorts?: Array<PortRef | null> }>(d: T): T {
  const marks = d.marks ?? [];
  if (marks.length < 2) return d;
  const lastStart = marks[marks.length - 1]!;
  const prevStart = marks[marks.length - 2]!;
  const a = d.points.at(-1);
  const b = d.points[lastStart - 1];
  if (!a || !b || lastStart <= prevStart) return d;
  const same = a.link === b.link && Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1], a.p[2] - b.p[2]) < 1e-6;
  if (!same) return d;
  return { ...d, points: d.points.slice(0, lastStart), marks: marks.slice(0, -1), markPorts: (d.markPorts ?? []).slice(0, -1) };
}

/** Half the height of the cable being drawn (its centre line's lift), or null without a type. */
function drapeRadius(ctx: ToolContext): number | null {
  const s = ctx.store.getState();
  const type = s.cableLibrary ? findCableType(s.cableLibrary, s.wireSettings.type) : undefined;
  return type ? cableEnvelope(type, s.wireSettings).height_mm / 2 : null;
}

function finish(ctx: ToolContext): void {
  const s = ctx.store.getState();
  const d = s.wireDraft;
  if (!d || d.points.length < 2) {
    s.notify('info', 'A wire needs at least two points', ['Click on the model (or on a port) at least twice, then press Enter.']);
    return;
  }
  if (!s.cableLibrary || !findCableType(s.cableLibrary, s.wireSettings.type)) {
    s.notify('error', 'Choose a cable type first', ['Pick a type in the Wires tab.']);
    return;
  }
  let cableId = '';
  // A first or last click on a port attaches that end of the route to it.
  const ports = d.markPorts ?? [];
  const from = ports[0] ?? undefined;
  const to = ports.length > 1 ? (ports.at(-1) ?? undefined) : undefined;
  s.commit((design) => {
    const r = addWire(design, s.wireSettings, d.points);
    cableId = r.cableId;
    return {
      ...r.design,
      routes: r.design.routes.map((route) => (route.cable === r.cableId ? { ...route, ...(from ? { from } : {}), ...(to ? { to } : {}) } : route)),
    };
  });
  ctx.store.setState((st) => ({ wireDraft: null, drapeSettled: cableId && d.settled ? { ...st.drapeSettled, [cableId]: d.settled } : st.drapeSettled }));
  s.setActiveTool('select');
  if (cableId) s.select({ kind: 'cable', id: cableId });
}

export const wireTool: Tool = {
  id: 'wire',
  label: 'Draw wire',
  cursor: 'crosshair',

  activate(ctx) {
    ctx.store.setState({ wireDraft: { points: [], cursor: null, marks: [] } });
  },

  deactivate(ctx) {
    ctx.store.setState({ wireDraft: null, portHover: null });
    ctx.viewport.setHoverComponent(null);
  },

  onPointerMove(e, ctx) {
    const d = ctx.store.getState().wireDraft;
    if (!d) return;
    const click = pointsForClick(e, ctx);
    const pts = click?.points;
    ctx.store.setState({ wireDraft: { ...d, cursor: pts ? pts[0]! : null } });
    // Over a part's port: highlight the part and name the port (the label and the status bar), not the body under it.
    const port = click?.port;
    ctx.viewport.setHoverComponent(port?.component ?? null);
    if (port) {
      const rect = ctx.viewport.renderer.domElement.getBoundingClientRect();
      const ph = ctx.store.getState().portHover;
      if (!ph || ph.componentId !== port.component || ph.portId !== port.port)
        ctx.store.setState({ portHover: { componentId: port.component, portId: port.port, x: e.native.clientX - rect.left, y: e.native.clientY - rect.top } });
      ctx.store.getState().setHover(null);
      return;
    }
    if (ctx.store.getState().portHover) ctx.store.setState({ portHover: null });
    const hit = e.hit;
    ctx.store.getState().setHover(hit ? { meshId: hit.meshId, linkId: hit.linkId, triangle: hit.triangle, point: [hit.world.point.x, hit.world.point.y, hit.world.point.z] } : null);
  },

  onPointerLeave(ctx) {
    const d = ctx.store.getState().wireDraft;
    if (d) ctx.store.setState({ wireDraft: { ...d, cursor: null } });
    ctx.viewport.setHoverComponent(null);
    ctx.store.setState({ portHover: null });
  },

  onClick(e, ctx) {
    const d = ctx.store.getState().wireDraft;
    if (!d) return;
    const click = pointsForClick(e, ctx);
    if (!click) {
      ctx.store.getState().notify('info', 'Nothing there to hold the wire', ['Click on the model or on a port of a placed part.']);
      return;
    }
    const pts = click.points;
    const s = ctx.store.getState();
    // Drape the leg from the last point to this click onto the surface.
    const last = d.points.at(-1);
    let draped: RoutePoint[] = [];
    const info = { settled: d.settled ?? 0 };
    if (last && s.wireSettings.drape !== false) {
      const r = drapeRadius(ctx);
      if (r !== null) draped = drapeLeg(s.design, last, pts[0]!, r, undefined, s.jointValues, info);
    }
    ctx.store.setState({
      wireDraft: { ...d, points: [...d.points, ...draped, ...pts], marks: [...(d.marks ?? []), d.points.length], markPorts: [...(d.markPorts ?? []), click.port ?? null], settled: info.settled },
    });
  },

  onDoubleClick(_e, ctx) {
    // The second click of the double-click already added a point; drop the duplicate.
    const d = ctx.store.getState().wireDraft;
    if (d) ctx.store.setState({ wireDraft: dropRepeatedClick(d) });
    finish(ctx);
  },

  onKeyDown(e, ctx) {
    const s = ctx.store.getState();
    const d = s.wireDraft;
    if (!d) return false;
    if (e.key === 'Enter') {
      finish(ctx);
      return true;
    }
    if (e.key === 'Escape') {
      ctx.store.setState({ wireDraft: null });
      s.setActiveTool('select');
      return true;
    }
    if (e.key === 'Backspace') {
      // Remove the last click with the points draped up to it.
      const marks = d.marks ?? [];
      const cut = marks.length ? marks.at(-1)! : Math.max(0, d.points.length - 1);
      ctx.store.setState({ wireDraft: { ...d, points: d.points.slice(0, cut), marks: marks.slice(0, -1), markPorts: (d.markPorts ?? []).slice(0, -1) } });
      return true;
    }
    return false;
  },
};
