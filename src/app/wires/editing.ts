/** Editing a finished wire from the UI: one undo step per edit, re-draping the legs it touches. */
import { cableEnvelope, findCableType } from '@core';
import { useApp } from '../state/store';
import { editDraped, redrapeForSize, type DrapeEdit } from './drape';
import { pointsOfRoute, routeOfCable, updateCable, updateRoute } from './routeEdit';
import { detachEnd } from './ports';

/** Half the height of a wire's cable (1 mm when its type is unknown). */
export function wireLift(cableId: string): number {
  const s = useApp.getState();
  const cable = s.design.cables.find((c) => c.id === cableId);
  const type = cable && s.cableLibrary ? findCableType(s.cableLibrary, cable.type) : undefined;
  return cable && type ? cableEnvelope(type, cable).height_mm / 2 : 1;
}

/** Apply an edit; returns false when it was refused (a wire keeps two points). */
export function commitWireEdit(cableId: string, edit: DrapeEdit): boolean {
  const s = useApp.getState();
  const route = routeOfCable(s.design, cableId);
  if (!route) return false;
  // An index from another wire or an older route (past the end) must not edit this one.
  if (edit.kind !== 'insert' && (edit.index < 0 || edit.index >= pointsOfRoute(route).length)) return false;
  const info = { settled: 0 };
  const res = editDraped(s.design, route, edit, wireLift(cableId), s.wireSettings.drape !== false, s.jointValues, info);
  if (!res) {
    s.notify('info', 'A wire keeps at least two points', ['Delete the wire instead if it is not needed.']);
    return false;
  }
  // An end moved or deleted is no longer at its port.
  const last = pointsOfRoute(route).length - 1;
  let next = res.route;
  if ((edit.kind === 'move' || edit.kind === 'delete') && edit.index === 0) next = detachEnd(next, 'from');
  if ((edit.kind === 'move' || edit.kind === 'delete') && edit.index === last) next = detachEnd(next, 'to');
  s.commit((d) => updateRoute(d, route.id, next));
  useApp.setState((st) => ({
    wirePoint: res.index >= 0 ? { cableId, index: res.index } : null,
    drapeSettled: info.settled ? { ...st.drapeSettled, [cableId]: (st.drapeSettled[cableId] ?? 0) + info.settled } : st.drapeSettled,
  }));
  return true;
}

/** Show a pose: set the joints the viewport previews to these values (others stay as they are). */
export function showPose(values: Readonly<Record<string, number>>): void {
  useApp.setState((s) => ({ jointValues: { ...s.jointValues, ...values } }));
}

/**
 * Change a wire's cable (type, count, sleeve...) in one undo step. When its
 * size changes and draping is on, the route is re-draped for the new size from
 * its user-placed points (a thicker cable rests differently on the same bumps).
 */
export function commitCableEdit(cableId: string, patch: Parameters<typeof updateCable>[2]): void {
  const s = useApp.getState();
  const before = wireLift(cableId);
  const info = { settled: 0 };
  let redraped = false;
  s.commit((d) => {
    let next = updateCable(d, cableId, patch);
    const cable = next.cables.find((c) => c.id === cableId);
    const type = cable && s.cableLibrary ? findCableType(s.cableLibrary, cable.type) : undefined;
    const route = routeOfCable(next, cableId);
    if (!cable || !type || !route || s.wireSettings.drape === false) return next;
    const r = cableEnvelope(type, cable).height_mm / 2;
    if (Math.abs(r - before) < 1e-9) return next;
    next = updateRoute(next, route.id, redrapeForSize(next, route, r, s.jointValues, info));
    redraped = true;
    return next;
  });
  // The notes count legs draped point by point; a re-drape replaces the count for this wire.
  if (redraped) useApp.setState((st) => ({ drapeSettled: { ...st.drapeSettled, [cableId]: info.settled } }));
}
