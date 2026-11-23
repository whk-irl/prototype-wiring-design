/**
 * Place tool: a translucent preview of the armed part follows the cursor on
 * surfaces; R turns it 15 degrees about the normal (Shift+R: 90), a click
 * places it, Esc cancels. Shift+click keeps the tool armed for another copy.
 */
import { Matrix4 } from 'three';
import { findPart, type Part } from '@core';
import { addComponent } from '../state/designOps';
import { facingHit, newComponent, poseOnHit, surfaceVerdict } from '../placement/placing';
import { partWorldMatrix, wrapAngle } from '../placement/pose';
import { buildPartVisual, disposeObject, type PartVisual } from '../viewport/partVisual';
import type { RayHit, Tool, ToolContext } from './types';
import { placementPreviewWarnings } from '../placement/checks';

let preview: PartVisual | null = null;
let previewPart: string | null = null;
let unsubscribe: (() => void) | null = null;
let lastHit: RayHit | null = null;

function currentPart(ctx: ToolContext): Part | undefined {
  const s = ctx.store.getState();
  return s.placingPart && s.library ? findPart(s.library, s.placingPart) : undefined;
}

function rebuild(ctx: ToolContext): void {
  const part = currentPart(ctx);
  if (preview) {
    preview.group.removeFromParent();
    disposeObject(preview.group);
    preview = null;
  }
  previewPart = part?.id ?? null;
  if (!part) return;
  preview = buildPartVisual(part, { preview: true, connectors: ctx.store.getState().connectorLibrary, onModel: () => ctx.viewport.requestRender() });
  preview.group.matrixAutoUpdate = false;
  preview.group.visible = false;
  preview.group.traverse((o) => (o.raycast = () => {}));
  ctx.viewport.overlay.add(preview.group);
}

function show(ctx: ToolContext, hit: RayHit | null): void {
  lastHit = hit;
  if (!preview) return;
  if (!hit) {
    if (ctx.store.getState().placeWarnings.length) ctx.store.setState({ placeWarnings: [] });
    preview.group.visible = false;
    ctx.viewport.requestRender();
    return;
  }
  const linkWorld = ctx.viewport.linkWorldMatrix(hit.linkId) ?? new Matrix4();
  partWorldMatrix(linkWorld, poseOnHit(hit, ctx.store.getState().placeSpin), preview.group.matrix);
  preview.group.matrixWorldNeedsUpdate = true;
  preview.group.visible = true;
  const st = ctx.store.getState();
  const verdict = surfaceVerdict(st.design, hit);
  const warnings = verdict.ok && previewPart ? placementPreviewWarnings(st.design, st.library, previewPart, hit.linkId, poseOnHit(hit, st.placeSpin), st.jointValues) : [];
  if (warnings.join('|') !== st.placeWarnings.join('|')) ctx.store.setState({ placeWarnings: warnings });
  const mat = preview.bodyMaterial;
  if (!verdict.ok) mat.emissive.setRGB(0.6, 0.05, 0.05);
  else if (warnings.length) mat.emissive.setRGB(0.55, 0.35, 0.0);
  else if (verdict.zone) mat.emissive.setRGB(0.0, 0.25, 0.05);
  else mat.emissive.setRGB(0, 0, 0);
  ctx.viewport.requestRender();
}

export const placeTool: Tool = {
  id: 'place',
  label: 'Place part',
  cursor: 'copy',

  activate(ctx) {
    rebuild(ctx);
    unsubscribe = ctx.store.subscribe((s, prev) => {
      if (s.placingPart !== prev.placingPart && s.placingPart && s.placingPart !== previewPart) rebuild(ctx);
    });
  },

  deactivate(ctx) {
    unsubscribe?.();
    unsubscribe = null;
    if (preview) {
      preview.group.removeFromParent();
      disposeObject(preview.group);
      preview = null;
    }
    previewPart = null;
    lastHit = null;
    ctx.store.setState({ placeWarnings: [] });
    ctx.viewport.requestRender();
  },

  onPointerMove(e, ctx) {
    const hit = e.hit;
    show(ctx, hit ? facingHit(hit, e.ray) : null);
  },

  onPointerLeave(ctx) {
    show(ctx, null);
  },

  onPoseChanged(ctx) {
    show(ctx, null);
  },

  onClick(e, ctx) {
    const raw = e.hit;
    const part = currentPart(ctx);
    if (!part) return;
    if (!raw) {
      // A click beside the model (the grid, the background): say so rather than do nothing.
      ctx.store.getState().notify('info', `${part.name} was not placed`, ['Click on a surface of the model; the preview shows where the part will go.']);
      return;
    }
    const hit = facingHit(raw, e.ray);
    const store = ctx.store.getState();
    const verdict = surfaceVerdict(store.design, hit);
    if (!verdict.ok) {
      store.notify('warning', `${part.name} was not placed`, [verdict.reason, 'Choose a surface outside keep-out zones.']);
      return;
    }
    const component = newComponent(store.design, part, hit.linkId, poseOnHit(hit, store.placeSpin), verdict.zone);
    store.commit((d) => addComponent(d, component));
    store.select({ kind: 'component', id: component.id });
    // The placed part is what Properties shows from now on, not the catalogue entry it came from.
    ctx.store.setState({ partDetails: null });
    if (!e.native.shiftKey) store.startPlacing(null);
  },

  onKeyDown(e, ctx) {
    const key = e.key.toLowerCase();
    if (key === 'r' && !e.ctrlKey && !e.metaKey) {
      const step = ((e.shiftKey ? 90 : 15) * Math.PI) / 180;
      ctx.store.setState((s) => ({ placeSpin: wrapAngle(s.placeSpin + step) }));
      show(ctx, lastHit);
      return true;
    }
    if (key === 'escape') {
      ctx.store.getState().startPlacing(null);
      return true;
    }
    return false;
  },
};
