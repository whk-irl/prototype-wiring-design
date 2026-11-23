/**
 * Add port: click a point on a placed component of the part being edited
 * (`store.portPickPart`). The point is found on the real surface (the model,
 * or the board drawing; the box only when the part has neither) and the new
 * port's cable leaves along the surface normal there. One click adds one
 * port; the tool then returns to Select.
 */
import { findPart } from '@core';
import { addPortAt } from '../userParts/portEdit';
import { updatePartDefinition } from '../userParts/actions';
import type { Tool } from './types';

export const portTool: Tool = {
  id: 'port',
  label: 'Add port',
  cursor: 'crosshair',

  onClick(e, { store, viewport }) {
    const s = store.getState();
    const partId = s.portPickPart;
    const part = partId && s.library ? findPart(s.library, partId) : undefined;
    if (!partId || !part) {
      s.setActiveTool('select');
      return;
    }
    const hit = viewport.pickPartSurface(e.ray, partId);
    if (!hit) {
      s.notify('info', 'Click on the part itself', [`Add port: click a point on a placed "${part.name}". Esc stops.`]);
      return;
    }
    const { part: next, port } = addPortAt(part, [hit.point.x, hit.point.y, hit.point.z], [hit.normal.x, hit.normal.y, hit.normal.z], s.connectorLibrary);
    void updatePartDefinition(next);
    store.setState({ portPickPart: null, portEditFocus: port.id });
    s.setActiveTool('select');
  },

  onKeyDown(e, { store }) {
    if (e.key !== 'Escape') return false;
    store.setState({ portPickPart: null });
    store.getState().setActiveTool('select');
    return true;
  },

  deactivate({ store }) {
    if (store.getState().portPickPart) store.setState({ portPickPart: null });
  },
};
