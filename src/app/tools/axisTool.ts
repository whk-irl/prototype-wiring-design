/**
 * Axis picking for the joint editor: click a pin, shaft, hole or round flat
 * face; the axis is fitted to the smooth surface around the click. A second
 * pick replaces the first.
 */
import { axisFromHit, setDraftAxisFromWorld } from '../joints/editor';
import type { Tool } from './types';

export const axisTool: Tool = {
  id: 'axis',
  label: 'Pick axis',
  cursor: 'crosshair',

  onPointerMove(e, { store }) {
    const hit = e.hit;
    store.getState().setHover(
      hit ? { meshId: hit.meshId, linkId: hit.linkId, triangle: hit.triangle, point: [hit.world.point.x, hit.world.point.y, hit.world.point.z] } : null,
    );
  },

  onPointerLeave({ store }) {
    store.getState().setHover(null);
  },

  onClick(e, { store, viewport }) {
    const hit = e.hit;
    if (!hit) return;
    const obj = viewport.meshObject(hit.meshId);
    if (!obj) return;
    const axis = axisFromHit(hit, obj.matrixWorld);
    const s = store.getState();
    if (!axis) {
      s.notify('warning', 'No axis found there', ['Click a cylindrical surface (a pin, shaft or hole) or a flat round face.']);
      return;
    }
    // Picked in world at the pose shown; stored in the parent link's frame.
    setDraftAxisFromWorld(axis);
    s.setActiveTool('select');
  },

  onKeyDown(e, { store }) {
    if (e.key === 'Escape') {
      store.getState().setJointDraft((d) => ({ ...d, picking: false }));
      store.getState().setActiveTool('select');
      return true;
    }
    return false;
  },
};
