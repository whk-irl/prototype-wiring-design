/**
 * Regressions from the review of the custom-parts rounds:
 *  1. wire ends attached at both ends with few points (each end owns its
 *     lead-out; following is idempotent);
 *  2. part-file ids never take a bundled part's place or overwrite a stored
 *     part silently;
 *  3. deleting a port detaches the wire ends on it (the design stays
 *     saveable); a random sequence of store actions always saves;
 *  4. opening, undo and redo never write the parts store; edits go by the
 *     documented rule;
 *  6. the plug-room check is exact (thin walls anywhere in front of the
 *     port, nothing beside it);
 *  7. thumbnail keys change with ports and model;
 *  9. duplicating a component.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IDBFactory } from 'fake-indexeddb';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { BoxGeometry, Quaternion, Vector3 } from 'three';
import { connectorBoxes, emptyDesign, findConnector, parseCableLibrary, parseConnectorLibrary, type Design, type Library, type Part, type Route } from '@core';
import { serializeForSave } from '../../src/app/io/saveGuard';
import { duplicateOf } from '../../src/app/placement/placing';
import { registry } from '../../src/app/scene/registry';
import '../../src/app/scene/bvh';
import { addComponent, removeComponent, updateComponent } from '../../src/app/state/designOps';
import { runtimeLibrary, watchRuntimeLibrary } from '../../src/app/state/library';
import { useApp } from '../../src/app/state/store';
import { deleteUserCable, saveUserCable } from '../../src/app/userCables/actions';
import { addUserPart, applyStoredVersion, editTarget, updatePartDefinition } from '../../src/app/userParts/actions';
import { isCustomId } from '../../src/app/userParts/ids';
import { planPartImport } from '../../src/app/userParts/partFile';
import { addPortAt, deletePort, nudgePort, setExit } from '../../src/app/userParts/portEdit';
import { thumbKey } from '../../src/app/viewport/thumbnails';
import { followWireEnds, plugLengthAt, portInLink, type FollowLibraries } from '../../src/app/wires/follow';
import { plugObstruction, portInfo } from '../../src/app/wires/ports';
import { addWire, deletePoint, insertPoint, movePoint, pointsOfRoute, removeWire, segmentsFromPoints, type RoutePoint } from '../../src/app/wires/routeEdit';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const connectors = parseConnectorLibrary(readFileSync(resolve(ROOT, 'library/connectors.yaml'), 'utf8'));
const cables = parseCableLibrary(readFileSync(resolve(ROOT, 'library/cables.yaml'), 'utf8'));
const s = () => useApp.getState();
const ID: [number, number, number, number] = [0, 0, 0, 1];

const mine: Part = {
  id: 'custom-b-1',
  name: 'B',
  category: 'controller',
  tags: [],
  custom: true,
  confidence: 'generic',
  mounting_holes: [],
  body: { size_mm: [60, 40, 10] },
  ports: [
    { id: 'p1', connector: 'jst-sh', ways: 4, pose: { p_mm: [-30, 10, 4], q: [0, 0, 1, 0] }, interfaces: ['i2c'] },
    { id: 'p2', connector: 'jst-sh', ways: 4, pose: { p_mm: [30, -10, 4], q: ID }, interfaces: ['i2c'] },
  ],
};
const bundled: Part = { ...mine, id: 'lib-board', name: 'Library board', custom: undefined };
const base: Library = { version: 1, parts: [bundled] };

function scene(): Design['scene'] {
  return { sources: [], links: [{ id: 'L', name: 'L', meshes: [] }, { id: 'M', name: 'M', meshes: [] }], joints: [] };
}

let unwatch: (() => void) | null = null;
beforeEach(() => {
  (globalThis as { indexedDB?: unknown }).indexedDB = new IDBFactory();
  registry.replace([]);
  unwatch?.();
  useApp.setState({ notices: [], connectorLibrary: connectors, cableLibrary: cables, baseCableLibrary: cables, customCables: [], baseLibrary: base, customParts: [mine], library: runtimeLibrary(base, { parts: [] }, [mine]) });
  unwatch = watchRuntimeLibrary();
});
afterAll(() => {
  unwatch?.();
  delete (globalThis as { indexedDB?: unknown }).indexedDB;
});

function oneBoard(points: RoutePoint[], ends: { from?: boolean; to?: boolean }): Design {
  const route: Route = {
    id: 'r1',
    cable: 'w1',
    crossings: [],
    ...(ends.from ? { from: { component: 'c1', port: 'p1' } } : {}),
    ...(ends.to ? { to: { component: 'c1', port: 'p2' } } : {}),
    segments: segmentsFromPoints(points),
  };
  return {
    ...emptyDesign('t'),
    scene: scene(),
    parts: [mine],
    components: [{ id: 'c1', name: 'C1', part: mine.id, link: 'L', pose: { p_mm: [0, 0, 0], q: ID } }],
    cables: [{ id: 'w1', name: 'Wire 1', connections: [], type: 'ul1007-28awg', count: 1, twisted: false, sleeve_wall_mm: 0, reasons: [] }],
    routes: [route],
  };
}
const free = (p: [number, number, number], link = 'L'): RoutePoint => ({ link, p, n: [0, 0, 0] });
const libs = (): FollowLibraries => ({ library: runtimeLibrary(base, { parts: [mine] }, [mine]), connectors, cables });

/** The shape follow promises: each attached end on its port with its own lead-out of at least the plug, along the exit. */
function expectEnds(d: Design): void {
  const route = d.routes[0]!;
  const pts = pointsOfRoute(route);
  const c = d.components.find((x) => x.id === 'c1')!;
  if (route.from && route.to) expect(pts.length).toBeGreaterThanOrEqual(4);
  for (const end of ['from', 'to'] as const) {
    const ref = route[end];
    if (!ref) continue;
    const port = mine.ports.find((p) => p.id === ref.port)!;
    const { origin, exit } = portInLink(c, port);
    const [e, l] = end === 'from' ? [pts[0]!, pts[1]!] : [pts[pts.length - 1]!, pts[pts.length - 2]!];
    expect(new Vector3(...e.p).distanceTo(origin)).toBeLessThan(1e-6);
    const lead = new Vector3(...l.p).sub(origin);
    expect(lead.length()).toBeGreaterThanOrEqual(plugLengthAt(port, connectors) - 1e-9);
    expect(lead.normalize().dot(exit)).toBeCloseTo(1, 9);
  }
}

describe('1. wire ends attached at both ends', () => {
  it('three points, both ends attached: repeated moves do not drift, each end has its own lead-out', () => {
    // Port A, its lead-out, port B (B's lead-out was deleted).
    s().replaceDesign(oneBoard([free([-30, 10, 4]), free([-38, 10, 4]), free([30, -10, 4])], { from: true, to: true }));
    const seen: number[][][] = [];
    for (let k = 0; k < 3; k++) {
      s().commit((d) => updateComponent(d, 'c1', { pose: { p_mm: [k + 1, 0, 0], q: ID } }));
      expectEnds(s().design);
      seen.push(pointsOfRoute(s().design.routes[0]!).map((p) => p.p));
    }
    // Each move shifts every point by exactly 1 mm in x: nothing runs away.
    for (let k = 1; k < 3; k++) for (let i = 0; i < seen[k]!.length; i++) expect(seen[k]![i]![0]! - seen[k - 1]![i]![0]!).toBeCloseTo(1, 9);
  });

  it('two points, both ends attached: both lead-outs are inserted', () => {
    s().replaceDesign(oneBoard([free([-30, 10, 4]), free([30, -10, 4])], { from: true, to: true }));
    s().commit((d) => updateComponent(d, 'c1', { pose: { p_mm: [1, 0, 0], q: ID } }));
    expect(pointsOfRoute(s().design.routes[0]!)).toHaveLength(4);
    expectEnds(s().design);
  });

  it('deleting a lead-out point of an attached wire gives it back', () => {
    // The middle point lies on a surface (it is not a lead-out).
    s().replaceDesign(oneBoard([free([-30, 10, 4]), free([-40, 10, 4]), { link: 'L', p: [0, 30, 0], n: [0, 0, 1] }, free([40, -10, 4]), free([30, -10, 4])], { from: true, to: true }));
    s().commit((d) => ({ ...d, routes: d.routes.map((r) => deletePoint(r, 1)!) }));
    expectEnds(s().design);
    expect(pointsOfRoute(s().design.routes[0]!)).toHaveLength(5);
  });

  it('property: following is idempotent and leaves every attached end in shape, for random routes', () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let trial = 0; trial < 400; trial++) {
      const n = 2 + Math.floor(rnd() * 7);
      const pts: RoutePoint[] = [];
      for (let i = 0; i < n; i++) {
        const link = rnd() < 0.3 ? 'M' : 'L';
        const onSurface = rnd() < 0.4;
        pts.push({ link, p: [rnd() * 100 - 50, rnd() * 100 - 50, rnd() * 20], n: onSurface ? [0, 0, 1] : [0, 0, 0] });
      }
      const which = Math.floor(rnd() * 3);
      const d = oneBoard(pts, { from: which !== 1, to: which !== 0 });
      const moved = updateComponent(d, 'c1', { pose: { p_mm: [rnd() * 10, rnd() * 10, 0], q: new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), rnd() * 6).toArray() as [number, number, number, number] }, link: rnd() < 0.5 ? 'L' : 'M' });
      const once = followWireEnds(moved, libs());
      expectEnds(once);
      expect(followWireEnds(once, libs())).toBe(once);
    }
  });
});

describe('2. part ids from part files', () => {
  const stored = [mine];
  const ids = new Set(['arduino-uno-r3', 'lib-board']);
  it('a part file carrying a bundled id, or any id that is not a user id, gets a new custom id', () => {
    const uno = { ...mine, id: 'arduino-uno-r3', name: 'Not an Uno' };
    const plan = planPartImport(uno, ids, stored);
    expect(plan.kind).toBe('add');
    if (plan.kind === 'add') {
      expect(plan.renamedFrom).toBe('arduino-uno-r3');
      expect(isCustomId(plan.part.id)).toBe(true);
      expect(plan.part.id).not.toBe('arduino-uno-r3');
    }
    expect(planPartImport({ ...mine, id: 'my-thing' }, ids, stored).kind).toBe('add');
  });

  it('the same part again is a no-op; a different part with a stored id is a conflict', () => {
    expect(planPartImport({ ...mine }, ids, stored).kind).toBe('same');
    const other = { ...mine, name: 'Other B' };
    const plan = planPartImport(other, ids, stored);
    expect(plan.kind).toBe('conflict');
    expect(planPartImport({ ...mine, id: 'custom-new-1' }, ids, stored)).toEqual({ kind: 'add', part: { ...mine, id: 'custom-new-1' } });
  });

  it('a stored part never shadows a bundled one; a design part does, for that design only', () => {
    const fake = { ...mine, id: 'lib-board', name: 'Fake' };
    expect(runtimeLibrary(base, { parts: [] }, [fake])!.parts.find((p) => p.id === 'lib-board')!.name).toBe('Library board');
    expect(runtimeLibrary(base, { parts: [fake] }, [])!.parts.find((p) => p.id === 'lib-board')!.name).toBe('Fake');
  });

  it('the parts store refuses a part that is not a user part', async () => {
    await expect(addUserPart({ ...mine, id: 'lib-board' })).rejects.toThrow(/not a user part id/);
    await expect(addUserPart({ ...mine, id: 'plain-id' })).rejects.toThrow(/not a user part id/);
  });
});

describe('3. deleting a port', () => {
  it('detaches the wire ends on it in the same undo step, names the wire, and the design still saves', async () => {
    s().replaceDesign(oneBoard([free([-30, 10, 4]), free([-38, 10, 4]), free([0, 20, 4]), free([38, -10, 4]), free([30, -10, 4])], { from: true, to: true }));
    await updatePartDefinition(deletePort(mine, 'p1'));
    const route = s().design.routes[0]!;
    expect(route.from).toBeUndefined();
    expect(route.to).toEqual({ component: 'c1', port: 'p2' });
    expect(s().notices.some((n) => n.title.includes('Detached') && n.details?.some((x) => x.includes('Wire 1')))).toBe(true);
    expect(serializeForSave(s().design, s().library, connectors).ok).toBe(true);
    s().undo();
    expect(s().design.routes[0]!.from).toEqual({ component: 'c1', port: 'p1' });
    expect(s().design.parts[0]!.ports).toHaveLength(2);
  });

  it('property: after any sequence of store actions the design saves and wire ends are in shape', async () => {
    let seed = 99;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const pick = <T,>(xs: readonly T[]): T | undefined => xs[Math.floor(rnd() * xs.length)];
    s().replaceDesign({ ...emptyDesign('t'), scene: scene() });
    for (let step = 0; step < 300; step++) {
      const d = s().design;
      const comps = d.components;
      const lib = s().library!;
      const action = Math.floor(rnd() * 16);
      const comp = pick(comps);
      const partOf = (id: string) => lib.parts.find((p) => p.id === id)!;
      if (action === 0 || comps.length === 0) {
        const part = rnd() < 0.6 ? mine.id : bundled.id;
        const id = `c${step}`;
        s().commit((x) => addComponent(x, { id, name: id, part, link: rnd() < 0.5 ? 'L' : 'M', pose: { p_mm: [rnd() * 100, rnd() * 100, 0], q: ID } }));
      } else if (action === 1 && comp) s().commit((x) => updateComponent(x, comp.id, { pose: { p_mm: [rnd() * 100, rnd() * 100, rnd() * 5], q: ID } }));
      else if (action === 2 && comp) s().commit((x) => removeComponent(x, comp.id));
      else if (action === 3 && comp && partOf(comp.part).custom) await updatePartDefinition(addPortAt(partOf(comp.part), [rnd() * 20, rnd() * 20, 5], [1, 0, 0], connectors).part);
      else if (action === 4 && comp && partOf(comp.part).custom) {
        const part = partOf(comp.part);
        const port = pick(part.ports);
        if (port) await updatePartDefinition(rnd() < 0.5 ? nudgePort(part, port.id, 0, 0.5) : setExit(part, port.id, '+z'));
      } else if (action === 5 && comp && partOf(comp.part).custom) {
        const part = partOf(comp.part);
        const port = pick(part.ports);
        if (port) await updatePartDefinition(deletePort(part, port.id));
      } else if (action === 6 && comps.length) {
        const a = pick(comps)!;
        const b = pick(comps)!;
        const pa = pick(partOf(a.part).ports);
        const pb = pick(partOf(b.part).ports);
        s().commit((x) => {
          const { design } = addWire(x, { type: 'ul1007-28awg', count: 1, twisted: false, sleeve_wall_mm: 0 }, [free([0, 0, 0], a.link), free([10, 10, 10], b.link), free([20, 0, 0], b.link)]);
          const r = design.routes[design.routes.length - 1]!;
          const routed = { ...r, ...(pa ? { from: { component: a.id, port: pa.id } } : {}), ...(pb && rnd() < 0.7 ? { to: { component: b.id, port: pb.id } } : {}) };
          return { ...design, routes: design.routes.map((y) => (y.id === r.id ? routed : y)) };
        });
      } else if (action === 7 && d.routes.length) {
        const r = pick(d.routes)!;
        const n = pointsOfRoute(r).length;
        const i = Math.floor(rnd() * n);
        const kind = rnd();
        s().commit((x) => ({
          ...x,
          routes: x.routes.map((y) => {
            if (y.id !== r.id) return y;
            if (kind < 0.33) return deletePoint(y, i) ?? y;
            if (kind < 0.66) return movePoint(y, i, { link: 'L', p: [rnd() * 50, rnd() * 50, 0], n: [0, 0, 1] });
            return insertPoint(y, i, free([rnd() * 50, rnd() * 50, 3]));
          }),
        }));
      } else if (action === 8 && d.cables.length) {
        const c = pick(d.cables)!;
        s().commit((x) => removeWire(x, c.id));
      } else if (action === 9) s().undo();
      else if (action === 10) s().redo();
      // The user's own cable types: add, use, edit (updating the design's copy or not), delete.
      else if (action === 11) await saveUserCable({ kind: 'flat_flex', construction: 'ffc', ways: 4 + Math.floor(rnd() * 20), pitch_mm: rnd() < 0.5 ? 0.5 : 1 });
      else if (action === 12 && s().customCables.length && d.cables.length) {
        const t = pick(s().customCables)!.type.id;
        const c = pick(d.cables)!;
        s().commit((x) => ({ ...x, cables: x.cables.map((y) => (y.id === c.id ? { ...y, type: t } : y)) }));
      } else if (action === 13 && s().customCables.length) {
        const stored = pick(s().customCables)!;
        await saveUserCable({ kind: 'wire', awg: 20 + Math.floor(rnd() * 10) }, { id: stored.type.id, updateDesign: rnd() < 0.5 });
      } else if (action === 14 && s().customCables.length) await deleteUserCable(pick(s().customCables)!.type.id);
      const now = s().design;
      // Every wire's type resolves (the design's own copy when this PC no longer has it).
      for (const c of now.cables) expect(s().cableLibrary!.cables.some((t) => t.id === c.type), `step ${step}: ${c.type}`).toBe(true);
      const saved = serializeForSave(now, s().library, connectors);
      if (!saved.ok) throw new Error(`step ${step} (action ${action}): ${saved.errors.join('; ')}`);
      expect(followWireEnds(now, { library: s().library, connectors, cables })).toBe(now);
    }
  });
});

describe('4. the parts store is written only by the user', () => {
  it('undo of a port edit and opening a design with an older version leave the store alone', async () => {
    s().replaceDesign({ ...emptyDesign('t'), scene: scene() });
    s().commit((x) => addComponent(x, { id: 'c1', name: 'C1', part: mine.id, link: 'L', pose: { p_mm: [0, 0, 0], q: ID } }));
    expect(editTarget(mine.id)).toEqual({ design: true, store: true });
    const edited = nudgePort(mine, 'p1', 0, 0.5);
    await updatePartDefinition(edited);
    expect(s().customParts[0]).toEqual(edited);
    s().undo();
    expect(s().design.parts[0]).toEqual(mine);
    expect(s().customParts[0]).toEqual(edited); // undo does not write the store
    // The two now differ: a further edit goes to the design's copy only.
    expect(editTarget(mine.id)).toEqual({ design: true, store: false });
    await updatePartDefinition(setExit(mine, 'p2', '-y'));
    expect(s().customParts[0]).toEqual(edited);
    // "Use my stored version here" puts the stored one into the design (undoable).
    applyStoredVersion(mine.id);
    expect(s().design.parts[0]).toEqual(edited);
    // Opening a design carrying an older version does not write the store either.
    const old = { ...oneBoard([free([0, 0, 0]), free([1, 0, 0])], {}), parts: [{ ...mine, name: 'Old B' }] };
    s().replaceDesign(old);
    expect(s().customParts[0]!.name).toBe('B');
  });

  it('a design part with a bundled id is never written to the store', async () => {
    const fake = { ...bundled, name: 'Edited library board' };
    s().replaceDesign({ ...emptyDesign('t'), scene: scene(), parts: [fake] });
    useApp.setState({ customParts: [mine, { ...bundled, custom: true }] });
    expect(editTarget('lib-board').store).toBe(false);
  });
});

describe('6. plug room, exact', () => {
  async function wallAt(min: [number, number, number], max: [number, number, number]): Promise<string | null> {
    const g = new BoxGeometry(max[0] - min[0], max[1] - min[1], max[2] - min[2]).translate((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
    registry.replace([{ id: 'wall', link: 'L', geometry: g, color: [1, 1, 1] }]);
    for (let i = 0; i < 300 && s().bvhPending > 0; i++) await new Promise((r) => setTimeout(r, 5));
    const part: Part = { ...mine, ports: [{ id: 'usb', connector: 'usb-c', pose: { p_mm: [0, 0, 10], q: ID }, interfaces: ['usb2'] }] };
    const d: Design = {
      ...emptyDesign('t'),
      scene: { sources: [{ id: 's', kind: 'builtin', uri: 'builtin:demo-arm', mm_per_unit: 1 }], links: [{ id: 'L', name: 'L', meshes: [{ id: 'wall', source: 's', node: 'wall', tri_count: 12 }] }], joints: [] },
      parts: [part],
      components: [{ id: 'c1', name: 'C1', part: part.id, link: 'L', pose: { p_mm: [0, 0, 0], q: ID } }],
    };
    const lib = runtimeLibrary(null, d);
    const info = portInfo(d, lib, connectors, { component: 'c1', port: 'usb' })!;
    return plugObstruction(d, lib, info, {});
  }
  const usb = findConnector(connectors, 'usb-c')!;
  const [len, w, h] = connectorBoxes(usb, usb.ways.min).plug!;

  it('a 1 mm wall anywhere across the plug is found', async () => {
    for (let x = 0.2; x < len - 0.3; x += 0.75) expect(await wallAt([x, -20, 0], [x + 1, 20, 30])).toBe('wall');
  });

  it('a 3 mm wall 3 to 6 mm in front of the port is found (the old sampling missed it)', async () => {
    expect(await wallAt([3, -20, 0], [6, 20, 30])).toBe('wall');
  });

  it('a wall past the plug, or beside it, or touching its side, is not a clash', async () => {
    expect(await wallAt([len + 0.2, -20, 0], [len + 3, 20, 30])).toBeNull();
    expect(await wallAt([-5, w / 2 + 0.3, 0], [len + 5, w / 2 + 2, 30])).toBeNull();
    expect(await wallAt([-5, w / 2, 0], [len + 5, w / 2 + 2, 30])).toBeNull(); // touching
    expect(await wallAt([-5, -20, 10 + h / 2 + 0.2], [len + 5, 20, 30])).toBeNull(); // a roof just above
    // ...but one reaching 0.3 mm into the side is.
    expect(await wallAt([-5, w / 2 - 0.3, 0], [len + 5, w / 2 + 2, 30])).toBe('wall');
  });
});

describe('7. thumbnail keys', () => {
  it('change with a port edit and with the model sha, not with the file name alone', () => {
    const k = thumbKey(mine, connectors);
    expect(thumbKey(nudgePort(mine, 'p1', 0, 0.5), connectors)).not.toBe(k);
    expect(thumbKey(setExit(mine, 'p1', '+z'), connectors)).not.toBe(k);
    const a = { ...mine, model: { uri: 'boards/x.glb', sha256: 'a'.repeat(64) } };
    const b = { ...mine, model: { uri: 'boards/x.glb', sha256: 'b'.repeat(64) } };
    expect(thumbKey(a, connectors)).not.toBe(thumbKey(b, connectors));
    expect(thumbKey({ ...mine }, connectors)).toBe(k);
  });
});

describe('9. duplicate component', () => {
  it('the same part beside the original along its surface, a new id, no wires', () => {
    const d = oneBoard([free([-30, 10, 4]), free([-38, 10, 4])], { from: true });
    const turned = updateComponent(d, 'c1', { pose: { p_mm: [5, 5, 0], q: new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2).toArray() as [number, number, number, number] } });
    const copy = duplicateOf(turned, mine, 'c1')!;
    expect(copy.id).not.toBe('c1');
    expect(copy.part).toBe(mine.id);
    expect(copy.link).toBe('L');
    // Turned 90 degrees about Z: its X axis is the link's +Y; moved by the width (60) plus 5 mm.
    expect(copy.pose.p_mm[0]).toBeCloseTo(5, 9);
    expect(copy.pose.p_mm[1]).toBeCloseTo(70, 9);
    expect(copy.pose.p_mm[2]).toBeCloseTo(0, 9);
    const after = addComponent(turned, copy);
    expect(after.routes).toEqual(turned.routes);
  });
});
