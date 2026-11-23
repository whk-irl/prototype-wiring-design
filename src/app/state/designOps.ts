/**
 * Pure edits on the design used by tools and panels. Each returns a new
 * design (or the same object when nothing changed) and keeps references
 * consistent, so the result still passes `validateDesign`.
 */
import type { Component, Design, Zone } from '@core';

export function upsertZone(d: Design, zone: Zone): Design {
  const i = d.zones.findIndex((z) => z.id === zone.id);
  const zones = i >= 0 ? d.zones.map((z) => (z.id === zone.id ? zone : z)) : [...d.zones, zone];
  return { ...d, zones };
}

export function updateZone(d: Design, id: string, patch: Partial<Omit<Zone, 'id'>>): Design {
  if (!d.zones.some((z) => z.id === id)) return d;
  return { ...d, zones: d.zones.map((z) => (z.id === id ? { ...z, ...patch } : z)) };
}

/** Remove zones and every component reference to them. */
export function removeZones(d: Design, ids: ReadonlySet<string>): Design {
  if (!d.zones.some((z) => ids.has(z.id))) return d;
  return {
    ...d,
    zones: d.zones.filter((z) => !ids.has(z.id)),
    components: d.components.map((c) => (c.zone !== undefined && ids.has(c.zone) ? withoutZone(c) : c)),
  };
}

/**
 * Repair references that an edit can leave stale. A component's `zone` must
 * name an existing zone on the component's own link; otherwise it is cleared.
 * A zone that became keep-out keeps its components (validation warns and the
 * placement checks show it on the part), so switching a zone to keep-out and
 * back does not detach them. Returns the same object when nothing changed.
 */
export function normalizeDesign(d: Design): Design {
  const zones = new Map(d.zones.map((z) => [z.id, z]));
  let changed = false;
  const components = d.components.map((c) => {
    if (c.zone === undefined) return c;
    const z = zones.get(c.zone);
    if (z && z.link === c.link) return c;
    changed = true;
    return withoutZone(c);
  });
  return changed ? { ...d, components } : d;
}

function withoutZone(c: Component): Component {
  const copy = { ...c };
  delete copy.zone;
  return copy;
}

export function addComponent(d: Design, c: Component): Design {
  return { ...d, components: [...d.components, c] };
}

export function updateComponent(d: Design, id: string, patch: Partial<Omit<Component, 'id'>>): Design {
  if (!d.components.some((c) => c.id === id)) return d;
  return {
    ...d,
    components: d.components.map((c) => {
      if (c.id !== id) return c;
      const next = { ...c, ...patch };
      if ('zone' in patch && patch.zone === undefined) delete next.zone;
      return next;
    }),
  };
}

/**
 * Remove a component and every connection that uses it (and cables that only
 * served those connections). Wires drawn by hand (no connections) stay; a
 * route end attached to one of the component's ports is detached.
 */
export function removeComponent(d: Design, id: string): Design {
  if (!d.components.some((c) => c.id === id)) return d;
  const connections = d.connections.filter((c) => c.from.component !== id && c.to.component !== id);
  const live = new Set(connections.map((c) => c.id));
  const cables = d.cables
    .map((c) => ({ c, kept: c.connections.filter((x) => live.has(x)) }))
    .filter(({ c, kept }) => c.connections.length === 0 || kept.length > 0)
    .map(({ c, kept }) => (kept.length === c.connections.length ? c : { ...c, connections: kept }));
  const cableIds = new Set(cables.map((c) => c.id));
  const routes = d.routes
    .filter((r) => cableIds.has(r.cable))
    .map((r) => {
      if (r.from?.component !== id && r.to?.component !== id) return r;
      const next = { ...r };
      if (r.from?.component === id) delete next.from;
      if (r.to?.component === id) delete next.to;
      return next;
    });
  const routeIds = new Set(routes.map((r) => r.id));
  return {
    ...d,
    components: d.components.filter((c) => c.id !== id),
    mounts: d.mounts.filter((m) => m.component !== id),
    connections,
    cables,
    routes,
    fixings: d.fixings.filter((f) => routeIds.has(f.route)),
  };
}

/** Is triangle `t` in a run-length encoded triangle list? Binary search. */
export function runsContain(runs: readonly number[], t: number): boolean {
  let lo = 0;
  let hi = runs.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const start = runs[2 * mid]!;
    const count = runs[2 * mid + 1]!;
    if (t < start) hi = mid - 1;
    else if (t >= start + count) lo = mid + 1;
    else return true;
  }
  return false;
}

/** Zones covering a triangle; keep-out zones first. */
export function zonesAt(d: Design, meshId: string, triangle: number): Zone[] {
  return d.zones
    .filter((z) => z.mesh === meshId && runsContain(z.triangles, triangle))
    .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'keep_out' ? -1 : 1));
}
