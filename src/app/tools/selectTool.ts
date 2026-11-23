/**
 * Default tool: hover readout; click selects a mesh, a component or nothing;
 * double-click selects a mesh's link. Dragging a component slides it over
 * the surfaces under the cursor (it may move to another link); each drag is
 * one undo step.
 */
import { updateComponent } from '../state/designOps';
import { facingHit, poseOnHit, surfaceVerdict } from '../placement/placing';
import { surfaceFromPose } from '../placement/pose';
import { Matrix4, Vector3 } from 'three';
import { computeLinkPoses } from '@core';
import { idsInRect, toggleId } from '../state/selection';
import { commitWireEdit } from '../wires/editing';
import { pointsOfRoute, routeOfCable, type RoutePoint } from '../wires/routeEdit';
import type { RayHit, Tool, ToolContext, ToolPointerEvent } from './types';

interface Drag {
  componentId: string;
  spin: number;
  last: RayHit | null;
}

let drag: Drag | null = null;
/** Dragging a point of the selected wire over the surfaces. */
let wireDrag: { cableId: string; index: number; moved: boolean; last: RoutePoint | null } | null = null;

/** The selected wire's route, if a wire is selected. */
function selectedRoute(ctx: ToolContext) {
  const s = ctx.store.getState();
  const id = s.selection?.kind === 'cable' ? s.selection.id : null;
  return id ? { cableId: id, route: routeOfCable(s.design, id) } : null;
}

/** Insert a surface point into the leg of the selected wire nearest to it (link frame comparisons in world). */
function insertNearest(ctx: ToolContext, pt: RoutePoint, world: Vector3): void {
  const sel = selectedRoute(ctx);
  if (!sel?.route) return;
  const s = ctx.store.getState();
  const poses = computeLinkPoses(s.design.scene, s.jointValues);
  const pts = pointsOfRoute(sel.route).map((p) => new Vector3(...p.p).applyMatrix4(poses.get(p.link) ?? new Matrix4()));
  let best = 0;
  let bd = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const ab = b.clone().sub(a);
    const t = Math.max(0, Math.min(1, world.clone().sub(a).dot(ab) / Math.max(ab.lengthSq(), 1e-12)));
    const d = world.distanceTo(a.clone().addScaledVector(ab, t));
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  commitWireEdit(sel.cableId, { kind: 'insert', after: best - 1, point: pt });
}
/** Rectangle selection: start corner in viewport pixels, and whether to add to the selection. */
let marquee: { x0: number; y0: number; add: boolean } | null = null;

function canvasXY(e: ToolPointerEvent, ctx: ToolContext): [number, number] {
  const r = ctx.viewport.renderer.domElement.getBoundingClientRect();
  return [e.native.clientX - r.left, e.native.clientY - r.top];
}

/** Component under the pointer if it is nearer than any mesh. */
function componentUnder(e: ToolPointerEvent, ctx: ToolContext) {
  const c = ctx.viewport.pickComponent(e.ray);
  if (!c) return null;
  const m = e.hit;
  return !m || c.distance <= m.distance + 1e-3 ? c : null;
}

function hoverMesh(e: ToolPointerEvent, ctx: ToolContext): void {
  const hit = e.hit;
  ctx.store.getState().setHover(
    hit ? { meshId: hit.meshId, linkId: hit.linkId, triangle: hit.triangle, point: [hit.world.point.x, hit.world.point.y, hit.world.point.z] } : null,
  );
}

export const selectTool: Tool = {
  id: 'select',
  label: 'Select',

  onPointerMove(e, ctx) {
    const store = ctx.store.getState();
    if (wireDrag) {
      const hit = e.hit;
      if (!hit) return;
      const n = hit.link.normal.clone();
      if (hit.world.normal.dot(e.ray.direction) > 0) n.negate();
      wireDrag.last = { link: hit.linkId, p: [hit.link.point.x, hit.link.point.y, hit.link.point.z], n: [n.x, n.y, n.z] };
      wireDrag.moved = true;
      return;
    }
    if (marquee) {
      const [x, y] = canvasXY(e, ctx);
      ctx.store.setState({ marquee: { x0: marquee.x0, y0: marquee.y0, x1: x, y1: y } });
      return;
    }
    if (drag) {
      const raw = e.hit;
      if (!raw) return;
      const hit = facingHit(raw, e.ray);
      drag.last = hit;
      ctx.viewport.components.setDraft({ componentId: drag.componentId, linkId: hit.linkId, pose: poseOnHit(hit, drag.spin) });
      ctx.viewport.refreshComponents();
      return;
    }
    const comp = componentUnder(e, ctx);
    ctx.viewport.setHoverComponent(comp?.componentId ?? null);
    if (comp) {
      store.setHover(null);
      if (comp.portId) {
        const rect = ctx.viewport.renderer.domElement.getBoundingClientRect();
        const ph = store.portHover;
        if (!ph || ph.componentId !== comp.componentId || ph.portId !== comp.portId) {
          ctx.store.setState({
            portHover: { componentId: comp.componentId, portId: comp.portId, x: e.native.clientX - rect.left, y: e.native.clientY - rect.top },
          });
        }
      } else if (store.portHover) ctx.store.setState({ portHover: null });
      return;
    }
    if (store.portHover) ctx.store.setState({ portHover: null });
    hoverMesh(e, ctx);
  },

  onPointerLeave(ctx) {
    ctx.viewport.setHoverComponent(null);
    ctx.store.setState({ portHover: null });
    ctx.store.getState().setHover(null);
  },

  onPointerDown(e, ctx) {
    // A point handle of the selected wire: drag it over the surfaces.
    const handle = ctx.viewport.pickWireHandle(e.ray);
    if (handle) {
      ctx.store.setState({ wirePoint: { cableId: handle.cableId, index: handle.index } });
      wireDrag = { cableId: handle.cableId, index: handle.index, moved: false, last: null };
      return true;
    }
    if (e.native.shiftKey) {
      // Shift+drag: rectangle selection of meshes.
      const [x, y] = canvasXY(e, ctx);
      marquee = { x0: x, y0: y, add: e.native.ctrlKey || e.native.metaKey };
      ctx.store.setState({ marquee: { x0: x, y0: y, x1: x, y1: y } });
      return true;
    }
    const comp = componentUnder(e, ctx);
    if (!comp) return false;
    const store = ctx.store.getState();
    const c = store.design.components.find((x) => x.id === comp.componentId);
    if (!c) return false;
    store.select({ kind: 'component', id: c.id });
    drag = { componentId: c.id, spin: surfaceFromPose(c.pose).spin, last: null };
    ctx.store.setState({ portHover: null });
    return true;
  },

  onPointerUp(e, ctx) {
    if (wireDrag) {
      const w = wireDrag;
      wireDrag = null;
      if (w.moved && w.last) commitWireEdit(w.cableId, { kind: 'move', index: w.index, point: w.last });
      return;
    }
    if (marquee) {
      const m = marquee;
      marquee = null;
      const [x, y] = canvasXY(e, ctx);
      ctx.store.setState({ marquee: null });
      const store = ctx.store.getState();
      if (Math.hypot(x - m.x0, y - m.y0) < 4) {
        // A Shift+click without dragging: treat as a toggle on the mesh under the cursor.
        const hit = e.hit;
        if (hit) store.selectMeshes(toggleId(store.selectedMeshes, hit.meshId), hit.meshId);
        return;
      }
      const inside = idsInRect({ x0: m.x0, y0: m.y0, x1: x, y1: y }, ctx.viewport.projectedMeshBoxes());
      const ids = m.add ? [...store.selectedMeshes, ...inside.filter((id) => !store.selectedMeshes.includes(id))] : inside;
      store.selectMeshes(ids, ids[0] ?? null);
      return;
    }
    const d = drag;
    drag = null;
    if (!d) return;
    ctx.viewport.components.setDraft(null);
    const store = ctx.store.getState();
    if (d.last) {
      const verdict = surfaceVerdict(store.design, d.last);
      const c = store.design.components.find((x) => x.id === d.componentId);
      if (!verdict.ok) {
        store.notify('warning', `${c?.name ?? 'The part'} was not moved`, [verdict.reason]);
      } else {
        const hit = d.last;
        store.commit((des) => updateComponent(des, d.componentId, { link: hit.linkId, pose: poseOnHit(hit, d.spin), zone: verdict.zone }));
      }
    }
    ctx.viewport.refreshComponents();
  },

  onPointerCancel(ctx) {
    wireDrag = null;
    if (marquee) {
      marquee = null;
      ctx.store.setState({ marquee: null });
    }
    // Abandon the drag: the part stays where it was.
    if (!drag) return;
    drag = null;
    ctx.viewport.components.setDraft(null);
    ctx.viewport.refreshComponents();
  },

  onClick(e, ctx) {
    const { store } = ctx;
    const hit = e.hit;
    const s = store.getState();
    // Ctrl+click on the model while a wire is selected: insert a point into its nearest leg.
    if ((e.native.ctrlKey || e.native.metaKey) && s.selection?.kind === 'cable' && hit) {
      const n = hit.link.normal.clone();
      if (hit.world.normal.dot(e.ray.direction) > 0) n.negate();
      insertNearest(ctx, { link: hit.linkId, p: [hit.link.point.x, hit.link.point.y, hit.link.point.z], n: [n.x, n.y, n.z] }, hit.world.point);
      return;
    }
    // A wire under the cursor, nearer than the model: select it.
    const wire = ctx.viewport.pickWire(e.ray);
    if (wire && (!hit || wire.distance <= hit.distance + 1e-3)) {
      s.select({ kind: 'cable', id: wire.cableId });
      return;
    }
    if (e.native.ctrlKey || e.native.metaKey) {
      // Ctrl+click toggles a mesh in the multi-selection.
      if (hit) s.selectMeshes(toggleId(s.selectedMeshes, hit.meshId), hit.meshId);
      return;
    }
    s.select(hit ? { kind: 'mesh', id: hit.meshId } : null);
  },

  onDoubleClick(e, ctx) {
    if (componentUnder(e, ctx)) {
      ctx.viewport.fit('selection');
      return;
    }
    const hit = e.hit;
    if (hit) {
      ctx.store.getState().select({ kind: 'link', id: hit.linkId });
      ctx.viewport.fit('selection');
    }
  },

  deactivate(ctx) {
    if (drag) {
      drag = null;
      ctx.viewport.components.setDraft(null);
      ctx.viewport.refreshComponents();
    }
    ctx.viewport.setHoverComponent(null);
    ctx.store.setState({ portHover: null });
  },
};
