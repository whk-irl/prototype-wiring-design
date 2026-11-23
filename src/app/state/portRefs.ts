/**
 * References to ports that no longer exist. A port can disappear while wires
 * and connections still name it: the user deletes it in the port editor, a
 * part definition is replaced, a component is deleted. Such a design does not
 * pass `validateDesign`, so it could not be saved. `pruneDanglingPortRefs`
 * runs in every commit (state/store.ts) and, in the same undo step:
 *  - detaches the wire ends (`route.from` / `route.to`) attached to a missing
 *    port or component; the wire itself stays where it is;
 *  - removes the electrical connections that name one, and takes them off
 *    the cables that carried them (the cables stay).
 * It returns the names of the wires it detached so the caller can say so.
 * Pure.
 */
import { findPart, type Design, type Library, type PortRef } from '@core';

export interface PruneResult {
  design: Design;
  /** Names of the wires (cables) whose ends were detached. */
  detachedWires: string[];
}

export function pruneDanglingPortRefs(design: Design, library: Library | null): PruneResult {
  if (!library) return { design, detachedWires: [] };
  const components = new Map(design.components.map((c) => [c.id, c]));
  const exists = (ref: PortRef): boolean => {
    const c = components.get(ref.component);
    if (!c) return false;
    const part = design.parts.find((p) => p.id === c.part) ?? findPart(library, c.part);
    // A part that is not known at all is reported by the validator on the component; leave its references alone.
    return !part || part.ports.some((p) => p.id === ref.port);
  };
  const detached = new Set<string>();
  let routesChanged = false;
  const routes = design.routes.map((r) => {
    const dropFrom = !!r.from && !exists(r.from);
    const dropTo = !!r.to && !exists(r.to);
    if (!dropFrom && !dropTo) return r;
    routesChanged = true;
    detached.add(r.cable);
    const next = { ...r };
    if (dropFrom) delete next.from;
    if (dropTo) delete next.to;
    return next;
  });
  const connections = design.connections.filter((c) => exists(c.from) && exists(c.to));
  const connectionsChanged = connections.length !== design.connections.length;
  let cables = design.cables;
  if (connectionsChanged) {
    const live = new Set(connections.map((c) => c.id));
    cables = design.cables.map((c) => (c.connections.every((id) => live.has(id)) ? c : { ...c, connections: c.connections.filter((id) => live.has(id)) }));
  }
  if (!routesChanged && !connectionsChanged) return { design, detachedWires: [] };
  const names = [...detached].map((id) => design.cables.find((c) => c.id === id)?.name || id);
  return { design: { ...design, routes, connections, cables }, detachedWires: names };
}
