/**
 * Zone painting. Face mode (default) floods the connected surface under the
 * click whose normals turn by less than the crease angle; brush mode paints
 * triangles within a radius while dragging. Alt (or the Erase toggle) erases.
 * One stroke or one flood is one undo step.
 */
import { BufferGeometry, Float32BufferAttribute, LineBasicMaterial, LineLoop, Matrix4, Quaternion, Vector3 } from 'three';
import { decodeTriangles, encodeTriangles, type Zone, type ZoneKind } from '@core';
import { removeZones, upsertZone } from '../state/designOps';
import { nextId } from '../state/integrity';
import { brushTriangles, ensureAdjacency, floodRegion } from '../scene/topology';
import type { RayHit, Tool, ToolContext, ToolPointerEvent } from './types';

interface Stroke {
  zoneId: string;
  meshId: string;
  linkId: string;
  kind: ZoneKind;
  name: string;
  created: boolean;
  erase: boolean;
  mask: Uint8Array;
  lastPoint: Vector3 | null;
  changed: boolean;
}

let stroke: Stroke | null = null;
let ring: LineLoop | null = null;
let warmup: ReturnType<typeof setTimeout> | null = null;

/** Last measured cost of one paint step, for the status readout and tests. */
export const paintStats = { lastMs: 0, maxMs: 0, adjacencyMs: 0 };

const DEFAULT_NAMES: Record<ZoneKind, string> = { mount_allowed: 'Mount area', keep_out: 'Keep clear' };
const ID_BASE: Record<ZoneKind, string> = { mount_allowed: 'mount', keep_out: 'keepout' };

function makeRing(): LineLoop {
  const pts: number[] = [];
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    pts.push(Math.cos(a), Math.sin(a), 0);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pts, 3));
  const r = new LineLoop(g, new LineBasicMaterial({ color: 0xffd24a, depthTest: false, transparent: true }));
  r.renderOrder = 20;
  r.matrixAutoUpdate = false;
  r.visible = false;
  return r;
}

function pickTarget(ctx: ToolContext, hit: RayHit, erase: boolean): Stroke | null {
  const s = ctx.store.getState();
  const d = s.design;
  const settings = s.zoneTool;
  const sel = s.selection?.kind === 'zone' ? d.zones.find((z) => z.id === s.selection!.id) : undefined;
  let zone: Zone | undefined;
  // The selected zone is the target when it is on this mesh and of the kind
  // being painted (selecting a zone in the list sets the kind to match).
  if (sel && sel.mesh === hit.meshId && sel.kind === settings.kind) zone = sel;
  else {
    const same = d.zones.filter((z) => z.mesh === hit.meshId && z.kind === settings.kind);
    zone = same[same.length - 1];
  }
  const entry = ctx.registry.get(hit.meshId);
  if (!entry) return null;
  const mask = new Uint8Array(entry.triCount);
  if (zone) {
    for (const t of decodeTriangles(zone.triangles)) if (t < mask.length) mask[t] = 1;
    return { zoneId: zone.id, meshId: zone.mesh, linkId: zone.link, kind: zone.kind, name: zone.name, created: false, erase, mask, lastPoint: null, changed: false };
  }
  if (erase) return null;
  const id = nextId(ID_BASE[settings.kind], d.zones.map((z) => z.id));
  const n = id.slice(id.lastIndexOf('-') + 1);
  return {
    zoneId: id,
    meshId: hit.meshId,
    linkId: hit.linkId,
    kind: settings.kind,
    name: `${DEFAULT_NAMES[settings.kind]} ${n}`,
    created: true,
    erase,
    mask,
    lastPoint: null,
    changed: false,
  };
}

function setTris(st: Stroke, tris: Iterable<number>): void {
  const v = st.erase ? 0 : 1;
  for (const t of tris) {
    if (st.mask[t] !== v) {
      st.mask[t] = v;
      st.changed = true;
    }
  }
}

/** Viewing direction in the mesh's imported frame, where brush queries run. */
function viewDirInMesh(ctx: ToolContext, hit: RayHit): Vector3 {
  const obj = ctx.viewport.meshObject(hit.meshId);
  const meshWorld = obj ? obj.matrixWorld : new Matrix4();
  const eye = ctx.viewport.eye().applyMatrix4(new Matrix4().copy(meshWorld).invert());
  return hit.local.point.clone().sub(eye).normalize();
}

function apply(ctx: ToolContext, st: Stroke, hit: RayHit): void {
  const t0 = performance.now();
  const entry = ctx.registry.get(st.meshId);
  if (!entry) return;
  const settings = ctx.store.getState().zoneTool;
  if (settings.mode === 'face') {
    if (st.mask[hit.triangle] === (st.erase ? 0 : 1)) return; // already in the wanted state
    const before = performance.now();
    ensureAdjacency(entry.geometry);
    paintStats.adjacencyMs = Math.max(paintStats.adjacencyMs, performance.now() - before);
    setTris(st, floodRegion(entry.geometry, hit.triangle, (settings.creaseDeg * Math.PI) / 180));
  } else {
    const r = Math.max(0.01, settings.radiusMm);
    const view = viewDirInMesh(ctx, hit);
    const end = hit.local.point;
    const start = st.lastPoint ?? end;
    const dist = start.distanceTo(end);
    const steps = Math.min(64, Math.max(1, Math.ceil(dist / (r * 0.5))));
    const found: number[] = [];
    const c = new Vector3();
    for (let i = 1; i <= steps; i++) {
      c.lerpVectors(start, end, i / steps);
      brushTriangles(entry.geometry, c, r, view, hit.local.normal, found);
    }
    brushTriangles(entry.geometry, end, r, view, hit.local.normal, found);
    setTris(st, found);
    st.lastPoint = end.clone();
  }
  ctx.viewport.zones.setDraft({ zoneId: st.zoneId, meshId: st.meshId, linkId: st.linkId, kind: st.kind, mask: st.mask });
  ctx.viewport.refreshZones();
  paintStats.lastMs = performance.now() - t0;
  paintStats.maxMs = Math.max(paintStats.maxMs, paintStats.lastMs);
}

function finish(ctx: ToolContext): void {
  const st = stroke;
  stroke = null;
  ctx.viewport.zones.setDraft(null);
  if (!st || !st.changed) {
    ctx.viewport.refreshZones();
    return;
  }
  const tris: number[] = [];
  for (let t = 0; t < st.mask.length; t++) if (st.mask[t]) tris.push(t);
  const store = ctx.store.getState();
  if (tris.length === 0) {
    if (!st.created) store.commit((d) => removeZones(d, new Set([st.zoneId])));
    if (store.selection?.kind === 'zone' && store.selection.id === st.zoneId) store.select(null);
    ctx.viewport.refreshZones();
    return;
  }
  store.commit((d) => {
    const existing = d.zones.find((z) => z.id === st.zoneId);
    const zone: Zone = existing
      ? { ...existing, triangles: encodeTriangles(tris) }
      : { id: st.zoneId, name: st.name, kind: st.kind, link: st.linkId, mesh: st.meshId, triangles: encodeTriangles(tris) };
    return upsertZone(d, zone);
  });
  store.select({ kind: 'zone', id: st.zoneId });
  ctx.viewport.refreshZones();
}

function updateRing(ctx: ToolContext, hit: RayHit | null): void {
  if (!ring) return;
  const settings = ctx.store.getState().zoneTool;
  if (!hit || settings.mode !== 'brush') {
    if (ring.visible) {
      ring.visible = false;
      ctx.viewport.requestRender();
    }
    return;
  }
  const q = new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), hit.world.normal);
  const r = settings.radiusMm;
  ring.matrix.compose(hit.world.point.clone().addScaledVector(hit.world.normal, 0.05), q, new Vector3(r, r, r));
  ring.matrixWorldNeedsUpdate = true;
  (ring.material as LineBasicMaterial).color.set(settings.erase ? 0xffffff : 0xffd24a);
  ring.visible = true;
  ctx.viewport.requestRender();
}

export const zoneTool: Tool = {
  id: 'zones',
  label: 'Zones',
  cursor: 'crosshair',

  activate(ctx) {
    ring = makeRing();
    ctx.viewport.overlay.add(ring);
    // Build adjacency for every mesh in the background so the first flood is instant.
    const ids = [...ctx.registry.all()].map((e) => e.id);
    const step = () => {
      const id = ids.shift();
      if (id === undefined) return;
      const e = ctx.registry.get(id);
      if (e) paintStats.adjacencyMs = Math.max(paintStats.adjacencyMs, ensureAdjacency(e.geometry));
      warmup = setTimeout(step, 0);
    };
    warmup = setTimeout(step, 50);
  },

  deactivate(ctx) {
    if (warmup) clearTimeout(warmup);
    if (stroke) finish(ctx);
    if (ring) {
      ring.removeFromParent();
      ring.geometry.dispose();
      (ring.material as LineBasicMaterial).dispose();
      ring = null;
    }
    ctx.viewport.requestRender();
  },

  onPointerDown(e: ToolPointerEvent, ctx) {
    const hit = e.hit;
    if (!hit) return false;
    const settings = ctx.store.getState().zoneTool;
    const st = pickTarget(ctx, hit, settings.erase || e.native.altKey);
    if (!st) return true; // erasing where there is no zone: swallow the drag
    stroke = st;
    apply(ctx, st, hit);
    return true;
  },

  onPointerMove(e, ctx) {
    const hit = e.hit;
    if (!stroke) {
      updateRing(ctx, hit);
      ctx.store.getState().setHover(
        hit ? { meshId: hit.meshId, linkId: hit.linkId, triangle: hit.triangle, point: [hit.world.point.x, hit.world.point.y, hit.world.point.z] } : null,
      );
      return;
    }
    updateRing(ctx, hit);
    if (hit && hit.meshId === stroke.meshId) apply(ctx, stroke, hit);
    else if (stroke) stroke.lastPoint = null;
  },

  onPointerUp(_e, ctx) {
    finish(ctx);
  },

  onPointerCancel(ctx) {
    // Keep what the interrupted stroke painted, as one undo step.
    finish(ctx);
  },

  onPointerLeave(ctx) {
    updateRing(ctx, null);
    ctx.store.getState().setHover(null);
  },

  onPoseChanged(ctx) {
    updateRing(ctx, null);
  },
};
