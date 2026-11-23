/**
 * Review round: draping at the foot of a wall and under an overhang, re-draping
 * when the cable's size changes, the inside test on overlapping shells, and the
 * crossing grades for an unknown flexing limit and for a joint that turns
 * without limit.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { BoxGeometry, Vector3, type BufferGeometry } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { emptyDesign, type CableLibrary, type CableType, type Design, type Route } from '@core';
import { registry } from '../../src/app/scene/registry';
import '../../src/app/scene/bvh';
import { useApp } from '../../src/app/state/store';
import { evaluateWire, wireNotes } from '../../src/app/wires/compare';
import { drapePoints } from '../../src/app/wires/drape';
import { commitCableEdit } from '../../src/app/wires/editing';
import { pointsOfRoute, segmentsFromPoints, withPoints, type RoutePoint } from '../../src/app/wires/routeEdit';
import { insideMesh } from '../../src/app/wires/solid';
import type { MeshBVH } from 'three-mesh-bvh';
import { loadLibrary } from './helpers';

const s = () => useApp.getState();
const UP: [number, number, number] = [0, 0, 1];
const FREE: [number, number, number] = [0, 0, 0];
const build1 = { count: 1, twisted: false, sleeve_wall_mm: 0 };

function roundType(id: string, od: number, bend: number, extra: Partial<CableType> = {}): CableType {
  return { id, name: id, family: 'hookup_wire', section: { shape: 'round', od_mm: od }, conductors: 1, min_bend_mm: { static: bend }, flex: 'flexible', connectors: [], interfaces: [], confidence: 'generic', ...extra };
}

async function waitForBvh(): Promise<void> {
  for (let i = 0; i < 300 && s().bvhPending > 0; i++) await new Promise((r) => setTimeout(r, 10));
}

function sceneOf(meshes: Array<{ id: string; g: BufferGeometry }>): Design {
  registry.replace(meshes.map((m) => ({ id: m.id, link: 'L', geometry: m.g, color: [1, 1, 1] as [number, number, number] })));
  return {
    ...emptyDesign('gen'),
    scene: {
      sources: [{ id: 's', kind: 'builtin', uri: 'builtin:demo-arm', mm_per_unit: 1 }],
      links: [{ id: 'L', name: 'L', meshes: meshes.map((m) => ({ id: m.id, source: 's', node: m.id, tri_count: 12 })) }],
      joints: [],
    },
  };
}
const routeOf = (pts: RoutePoint[]): Route => ({ id: 'r1', cable: 'c1', crossings: [], segments: segmentsFromPoints(pts) });
const lengthOf = (pts: RoutePoint[], r: number) => {
  const c = pts.map((p) => new Vector3(...p.p).addScaledVector(new Vector3(...p.n), r));
  return c.reduce((t, q, i) => (i ? t + q.distanceTo(c[i - 1]!) : t), 0);
};

beforeEach(() => useApp.setState({ library: loadLibrary(), notices: [] }));

describe('draping beside walls and under overhangs', () => {
  const r = 2;
  /** Floor (top z = 0) and a 20 mm wall occupying y >= 0. */
  const wallScene = () =>
    sceneOf([
      { id: 'floor', g: new BoxGeometry(100, 60, 2).translate(50, 0, -1) },
      { id: 'wall', g: new BoxGeometry(100, 10, 20).translate(50, 5, 10) },
    ]);

  it('clicks 1.5 mm from the wall: moved out by the 0.5 mm shortfall, the leg stays at the foot', async () => {
    const d = wallScene();
    await waitForBvh();
    const pts = drapePoints(d, [{ link: 'L', p: [10, -1.5, 0], n: UP }, { link: 'L', p: [90, -1.5, 0], n: UP }], r);
    expect(pts.length).toBe(2);
    for (const p of pts) {
      expect(p.p[1]).toBeCloseTo(-2, 2);
      expect(p.p[2]).toBeCloseTo(0, 6);
    }
    expect(lengthOf(pts, r)).toBeCloseTo(80, 6);
    const fit = evaluateWire(d, routeOf(pts), roundType('w', 2 * r, 1), build1, {}).fit!;
    expect(fit.fits).toBe(true);
  });

  it('clicks 2.5 mm from the wall: untouched, straight along the foot', async () => {
    const d = wallScene();
    await waitForBvh();
    const pts = drapePoints(d, [{ link: 'L', p: [10, -2.5, 0], n: UP }, { link: 'L', p: [90, -2.5, 0], n: UP }], r);
    expect(pts.map((p) => p.p)).toEqual([
      [10, -2.5, 0],
      [90, -2.5, 0],
    ]);
  });

  it('a leg under an overhang stays under it (the fit check reports the ceiling)', async () => {
    // A slab over x 30..70 with its underside at z = 3.5: 1.5 mm above the cable's centre line at z = 2.
    const d = sceneOf([
      { id: 'floor', g: new BoxGeometry(100, 60, 2).translate(50, 0, -1) },
      { id: 'shelf', g: new BoxGeometry(40, 60, 3).translate(50, 0, 5) },
    ]);
    await waitForBvh();
    const pts = drapePoints(d, [{ link: 'L', p: [10, 0, 0], n: UP }, { link: 'L', p: [90, 0, 0], n: UP }], r);
    expect(pts.length).toBe(2);
    const fit = evaluateWire(d, routeOf(pts), roundType('w', 2 * r, 1), build1, {}).fit!;
    expect(fit.fits).toBe(false);
    expect(fit.tightest_mm).toBeCloseTo(-0.5, 3);
    expect(fit.tightestWhat).toBe('shelf');
  });
});

describe('a change of cable size re-drapes the route', () => {
  it('a thicker type rests higher on the same bump, in one undo step', async () => {
    const d = sceneOf([
      { id: 'floor', g: new BoxGeometry(100, 40, 2).translate(50, 0, -1) },
      { id: 'bump', g: new BoxGeometry(10, 40, 5).translate(50, 0, 2.5) },
    ]);
    await waitForBvh();
    const thin = roundType('thin', 2, 1);
    const thick = roundType('thick', 6, 1);
    useApp.setState({ cableLibrary: { cables: [thin, thick] } as unknown as CableLibrary, jointValues: {} });
    const clicks: RoutePoint[] = [
      { link: 'L', p: [5, 0, 0], n: UP },
      { link: 'L', p: [95, 0, 0], n: UP },
    ];
    const route = withPoints(routeOf([]), drapePoints(d, clicks, 1));
    s().replaceDesign({ ...d, cables: [{ id: 'c1', name: 'W', connections: [], type: 'thin', count: 1, twisted: false, sleeve_wall_mm: 0, reasons: [] }], routes: [route] });
    useApp.setState({ cableLibrary: { cables: [thin, thick] } as unknown as CableLibrary, wireSettings: { ...s().wireSettings, drape: true } });
    const topOf = (rr: number) => Math.max(...pointsOfRoute(s().design.routes[0]!).map((p) => p.p[2] + p.n[2] * rr));
    expect(topOf(1)).toBeCloseTo(6, 1);
    commitCableEdit('c1', { type: 'thick' });
    expect(s().design.cables[0]!.type).toBe('thick');
    expect(topOf(3)).toBeCloseTo(8, 1);
    // the clicked ends are kept
    const pts = pointsOfRoute(s().design.routes[0]!);
    expect(pts[0]!.p).toEqual([5, 0, 0]);
    expect(pts.at(-1)!.p).toEqual([95, 0, 0]);
    s().undo();
    expect(s().design.cables[0]!.type).toBe('thin');
    expect(s().design.routes[0]).toEqual(route);
  });
});

describe('inside test on overlapping shells', () => {
  it('counts crossings with their sign: a point inside both shells is inside', async () => {
    // A 20 mm box and a 4 mm box pushed into its side (x 7..11): one mesh, two closed shells.
    const g = mergeGeometries([new BoxGeometry(20, 20, 20), new BoxGeometry(4, 4, 4).translate(9, 0, 0)])!;
    const d = sceneOf([{ id: 'two', g }]);
    await waitForBvh();
    void d;
    const bvh = g.boundsTree as unknown as MeshBVH;
    expect(insideMesh(bvh, g, new Vector3(8, 0, 0))).toEqual({ inside: true, certain: true });
    expect(insideMesh(bvh, g, new Vector3(10.5, 0, 0))).toEqual({ inside: true, certain: true });
    expect(insideMesh(bvh, g, new Vector3(0, 0, 0))).toEqual({ inside: true, certain: true });
    expect(insideMesh(bvh, g, new Vector3(10.5, 5, 0))).toEqual({ inside: false, certain: true });
  });
});

/** Links A, B on a joint at the origin; a route from A to B. */
function hinge(type: 'revolute' | 'continuous'): { d: Design; route: Route } {
  const d: Design = {
    ...emptyDesign('h'),
    scene: {
      sources: [],
      links: [
        { id: 'A', name: 'A', meshes: [] },
        { id: 'B', name: 'B', meshes: [] },
      ],
      joints: [{ id: 'J', name: 'J', type, parent: 'A', child: 'B', origin: { p_mm: [0, 0, 0], q: [0, 0, 0, 1] }, axis: [0, 0, 1], ...(type === 'revolute' ? { limit: { lower: -1, upper: 1 } } : {}), value: 0 }],
    },
  };
  const route = routeOf([
    { link: 'A', p: [-40, 0, 0], n: UP },
    { link: 'A', p: [-10, 0, 0], n: UP },
    { link: 'B', p: [10, 0, 0], n: FREE },
    { link: 'B', p: [40, 0, 0], n: FREE },
  ]);
  return { d, route };
}

describe('crossing grades', () => {
  beforeEach(() => registry.replace([]));

  it('no flexing figure on a moving crossing: never a clean pass', () => {
    const { d, route } = hinge('revolute');
    const c = evaluateWire(d, route, roundType('w', 2, 1), build1, {}, { skipFit: true }).crossings[0]!;
    expect(c.bend.noFlexFigure).toBe(true);
    expect(c.bend.ok).toBe(true);
    expect(c.grade).toBe('warn');
    // with a flexing figure stated and held, it passes
    const ok = evaluateWire(d, route, roundType('w', 2, 1, { min_bend_mm: { static: 1, dynamic: 1.5 } }), build1, {}, { skipFit: true }).crossings[0]!;
    expect(ok.bend.noFlexFigure).toBe(false);
    expect(ok.grade).toBe('ok');
  });

  it('a joint that turns without limit: warning, and the cut length is conditional', () => {
    const { d, route } = hinge('continuous');
    const ev = evaluateWire(d, route, roundType('w', 2, 1, { min_bend_mm: { static: 1, dynamic: 1.5 } }), build1, {}, { skipFit: true });
    const c = ev.crossings[0]!;
    expect(c.continuous).toEqual(['J']);
    expect(c.continuousWarning).toMatch(/slip ring/);
    expect(c.grade).not.toBe('ok');
    expect(ev.lengths.complete).toBe(false);
    expect(wireNotes(ev).some((n) => n.includes('LOWER BOUND') && n.includes('without limit'))).toBe(true);
  });
});
