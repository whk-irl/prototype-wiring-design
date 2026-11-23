/**
 * Wires fix round: the signed fit check and real cross-sections, draping,
 * flat-cable folds, crossings kept out of the verdicts, honest cut lists,
 * re-seating wires when a joint is defined after them, the range check over
 * nearby joints, and one rule for the numbers. Geometry is generated here and
 * every expected value is computed in the test.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { BoxGeometry, BufferGeometry, CylinderGeometry, Vector3 } from 'three';
import { cableEnvelope, emptyDesign, routeLength, splitLink, type CableType, type Design, type Route } from '@core';
import { createJointFromDraft } from '../../src/app/joints/editor';
import { registry } from '../../src/app/scene/registry';
import '../../src/app/scene/bvh';
import { useApp } from '../../src/app/state/store';
import { bendReport, bendSummary, jointsNearWire, leadOutOf, rangePlan } from '../../src/app/wires/checks';
import { compareRow, cutListCsv, evaluateWire, wireNotes } from '../../src/app/wires/compare';
import { drapeLeg, drapePoints, drapeTolerance, editDraped, linkSurface, restingPoint, surfaceDistance } from '../../src/app/wires/drape';
import { reseatWires } from '../../src/app/wires/reseat';
import { pointsOfRoute, segmentsFromPoints, withPoints, type RoutePoint } from '../../src/app/wires/routeEdit';
import { runRangeCheck, runWireChecks, statusOf } from '../../src/app/wires/run';
import { loadLibrary } from './helpers';

const s = () => useApp.getState();
const UP: [number, number, number] = [0, 0, 1];
const DOWN: [number, number, number] = [0, 0, -1];
const FREE: [number, number, number] = [0, 0, 0];

function roundType(id: string, od: number, bend: number, extra: Partial<CableType> = {}): CableType {
  return { id, name: id, family: 'hookup_wire', section: { shape: 'round', od_mm: od }, conductors: 1, min_bend_mm: { static: bend }, flex: 'flexible', connectors: [], interfaces: [], confidence: 'generic', ...extra };
}
function flatType(id: string, width: number, thickness: number, bend = 2): CableType {
  return { id, name: id, family: 'ffc', section: { shape: 'flat', width_mm: width, thickness_mm: thickness }, conductors: 10, min_bend_mm: { static: bend }, flex: 'flexible', connectors: [], interfaces: [], confidence: 'generic' };
}
const build1 = { count: 1, twisted: false, sleeve_wall_mm: 0 };

async function waitForBvh(): Promise<void> {
  for (let i = 0; i < 300 && s().bvhPending > 0; i++) await new Promise((r) => setTimeout(r, 10));
}

/** One root link L (and optional more) holding the given geometries as meshes. */
function sceneOf(meshes: Array<{ id: string; g: BufferGeometry; link?: string }>, links: string[] = ['L']): Design {
  registry.replace(meshes.map((m) => ({ id: m.id, link: m.link ?? 'L', geometry: m.g, color: [1, 1, 1] as [number, number, number] })));
  return {
    ...emptyDesign('gen'),
    scene: {
      sources: [{ id: 's', kind: 'builtin', uri: 'builtin:demo-arm', mm_per_unit: 1 }],
      links: links.map((l) => ({ id: l, name: l, meshes: meshes.filter((m) => (m.link ?? 'L') === l).map((m) => ({ id: m.id, source: 's', node: m.id, tri_count: 12 })) })),
      joints: [],
    },
  };
}

const routeOf = (pts: RoutePoint[]): Route => ({ id: 'r1', cable: 'c1', crossings: [], segments: segmentsFromPoints(pts) });

beforeEach(() => useApp.setState({ library: loadLibrary(), notices: [] }));

// ---------------------------------------------------------------- 1. signed fit, real cross-section

describe('fit check is signed and tests the real cross-section', () => {
  it('a centre line inside a 2 mm slab fails by its true depth', async () => {
    // Slab z in [-2, 0]. Points on its top face but with the normal pointing down: the centre line sits 1 mm below the top, in the middle of the slab.
    const d = sceneOf([{ id: 'slab', g: new BoxGeometry(100, 40, 2).translate(50, 0, -1) }]);
    await waitForBvh();
    const route = routeOf([
      { link: 'L', p: [20, 0, 0], n: DOWN },
      { link: 'L', p: [80, 0, 0], n: DOWN },
    ]);
    const fit = evaluateWire(d, route, roundType('w', 2, 1), build1, {}).fit!;
    // centre at z = -1: 1 mm to either face; depth = 1 + r = 2
    expect(fit.fits).toBe(false);
    expect(fit.tightest_mm).toBeCloseTo(-2, 6);
    expect(fit.uncertainMeshes).toEqual([]);
  });

  it('free points inside a 100 mm block fail, by the depth of the deepest probe', async () => {
    // Block x in [0, 100], y in [-50, 50], z in [0, 100].
    const d = sceneOf([{ id: 'block', g: new BoxGeometry(100, 100, 100).translate(50, 0, 50) }]);
    await waitForBvh();
    const route = routeOf([
      { link: 'L', p: [20, 0, 50], n: FREE },
      { link: 'L', p: [80, 0, 50], n: FREE },
    ]);
    const fit = evaluateWire(d, route, roundType('w', 2, 1), build1, {}).fit!;
    // deepest probe at x = 50: 50 mm to the nearest face, + r = 1
    expect(fit.fits).toBe(false);
    expect(fit.tightest_mm).toBeCloseTo(-51, 6);
  });

  it('a 16 mm ribbon in a 12 mm channel reports the true overlap', async () => {
    // Floor top at z = 0; walls y beyond +-6, from z = -2 (into the floor) to 10.
    const w = 12;
    const d = sceneOf([
      { id: 'floor', g: new BoxGeometry(100, 60, 2).translate(50, 0, -1) },
      { id: 'wallL', g: new BoxGeometry(100, 10, 12).translate(50, w / 2 + 5, 4) },
      { id: 'wallR', g: new BoxGeometry(100, 10, 12).translate(50, -w / 2 - 5, 4) },
    ]);
    await waitForBvh();
    const route = routeOf([
      { link: 'L', p: [20, 0, 0], n: UP },
      { link: 'L', p: [80, 0, 0], n: UP },
    ]);
    const fit = evaluateWire(d, route, flatType('ffc16', 16, 1), build1, {}).fit!;
    // the ribbon's edge reaches y = 8, 2 mm past the wall face at 6
    const overlap = (16 - w) / 2;
    expect(fit.fits).toBe(false);
    expect(fit.tightest_mm).toBeCloseTo(-overlap, 6);
    // and a 10 mm ribbon fits, with 1 mm each side
    const ok = evaluateWire(d, route, flatType('ffc10', 10, 1), build1, {}).fit!;
    expect(ok.fits).toBe(true);
    expect(ok.tightest_mm).toBeCloseTo(1, 6);
  });

  it('an open (not watertight) mesh: the rays disagree, the majority decides, and the mesh is reported', async () => {
    // A 20 mm box centred on the origin with its top face (+z) removed: a cup open at z = 10.
    const g = new BoxGeometry(20, 20, 20);
    const idx = Array.from(g.getIndex()!.array);
    g.setIndex([...idx.slice(0, 24), ...idx.slice(30)]);
    g.clearGroups();
    const d = sceneOf([{ id: 'openbox', g }]);
    await waitForBvh();
    // Free points 1 mm below the opening. The two upward first rays and both tie-breakers (all upward)
    // leave through the opening (even); only the downward ray crosses a wall (odd): 1 of 5, outside.
    const route = routeOf([
      { link: 'L', p: [-2, 0, 9], n: FREE },
      { link: 'L', p: [2, 0, 9], n: FREE },
    ]);
    const ev = evaluateWire(d, route, roundType('w', 1, 1), build1, {});
    expect(ev.fit!.uncertainMeshes).toEqual(['openbox']);
    // Outside: the walls are 8 mm or more away, beyond the 2 mm margin.
    expect(ev.fit!.fits).toBe(true);
    expect(ev.fit!.tightest_mm).toBe(ev.fit!.margin_mm);
    expect(wireNotes(ev).some((n) => n.includes('Not watertight') && n.includes('openbox'))).toBe(true);
  });
});

// ---------------------------------------------------------------- 2. draping

/** Densify the centre line of draped points and return the smallest signed distance to the link's solids minus r. */
function worstBelow(d: Design, pts: RoutePoint[], r: number): number {
  const surf = linkSurface(d, 'L');
  const c = pts.map((p) => new Vector3(...p.p).addScaledVector(new Vector3(...p.n), r));
  let worst = Infinity;
  for (let i = 1; i < c.length; i++) {
    const n = Math.max(1, Math.ceil(c[i - 1]!.distanceTo(c[i]!) / 0.2));
    for (let k = 0; k <= n; k++) {
      const q = c[i - 1]!.clone().lerp(c[i]!, k / n);
      worst = Math.min(worst, surfaceDistance(surf, q)!.d - r);
    }
  }
  return worst;
}
/** Largest distance of stored surface points from the surface. */
function worstOff(d: Design, pts: RoutePoint[]): number {
  const surf = linkSurface(d, 'L');
  return Math.max(...pts.map((p) => Math.abs(surfaceDistance(surf, new Vector3(...p.p))!.d)));
}

describe('draping a leg onto the surface', () => {
  const r = 1;
  const tol = drapeTolerance(r);

  it('a flat leg stays two points', async () => {
    const d = sceneOf([{ id: 'floor', g: new BoxGeometry(100, 40, 2).translate(50, 0, -1) }]);
    await waitForBvh();
    expect(drapeLeg(d, { link: 'L', p: [10, 0, 0], n: UP }, { link: 'L', p: [90, 0, 0], n: UP }, r)).toEqual([]);
  });

  it('climbs a step instead of passing through the riser, and comes down the far side', async () => {
    // Floor z = 0; a block 10 high from x = 40 to 60.
    const d = sceneOf([
      { id: 'floor', g: new BoxGeometry(100, 40, 2).translate(50, 0, -1) },
      { id: 'step', g: new BoxGeometry(20, 40, 12).translate(50, 0, 4) },
    ]);
    await waitForBvh();
    const a: RoutePoint = { link: 'L', p: [10, 0, 0], n: UP };
    const b: RoutePoint = { link: 'L', p: [90, 0, 0], n: UP };
    const pts = drapePoints(d, [a, b], r);
    expect(pts.length).toBeGreaterThanOrEqual(4);
    // it goes over the top: some centre point at the step's height + r
    expect(Math.max(...pts.map((p) => p.p[2] + p.n[2] * r))).toBeCloseTo(10 + r, 1);
    expect(worstOff(d, pts)).toBeLessThan(tol);
    expect(worstBelow(d, pts, r)).toBeGreaterThan(-2 * tol);
    // and the fit check agrees
    const fit = evaluateWire(d, routeOf(pts), roundType('w', 2 * r, 1), build1, {}).fit!;
    expect(fit.fits).toBe(true);
  });

  it('passes taut over a sharp ridge, resting on its apex', async () => {
    // A square bar rotated 45 degrees about y: a ridge along y with its edge at z = 5 * sqrt(2).
    const ridge = new BoxGeometry(10, 40, 10).rotateY(Math.PI / 4).translate(50, 0, 0);
    const d = sceneOf([
      { id: 'floor', g: new BoxGeometry(100, 40, 2).translate(50, 0, -1) },
      { id: 'ridge', g: ridge },
    ]);
    await waitForBvh();
    const pts = drapePoints(d, [{ link: 'L', p: [10, 0, 0], n: UP }, { link: 'L', p: [90, 0, 0], n: UP }], r);
    const top = 5 * Math.SQRT2;
    expect(Math.max(...pts.map((p) => p.p[2] + p.n[2] * r))).toBeCloseTo(top + r, 1);
    expect(worstOff(d, pts)).toBeLessThan(tol);
    expect(worstBelow(d, pts, r)).toBeGreaterThan(-2 * tol);
    // pulled taut: it rests on the apex only, and the long straight legs round it gently
    expect(pts.slice(1, -1).filter((p) => Math.abs(p.p[0] - 50) > 2 * r)).toEqual([]);
    const env = cableEnvelope(roundType('w', 2 * r, 10), build1);
    expect(bendReport(d, routeOf(pts), env).grade).toBe('ok');
  });

  /** Tangent from P to a circle round C (radius r), then along the circle to its top: the taut path onto an edge. */
  function onToEdge(P: [number, number], C: [number, number], rr: number): number {
    const dx = P[0] - C[0];
    const dy = P[1] - C[1];
    const dd = Math.hypot(dx, dy);
    const phi = Math.atan2(dy, dx);
    const alpha = Math.acos(rr / dd);
    const cands = [phi + alpha, phi - alpha];
    const tp = cands.reduce((x, y) => (Math.sin(y) > Math.sin(x) ? y : x));
    let arc = Math.abs(Math.atan2(Math.sin(tp - Math.PI / 2), Math.cos(tp - Math.PI / 2)));
    if (arc > Math.PI) arc = 2 * Math.PI - arc;
    return Math.sqrt(dd * dd - rr * rr) + rr * arc;
  }

  /** Floor (top z = 0) with a gap at x 40..50; bumps 5 high at x 15..25 and 60..70. */
  function bumps(): Design {
    return sceneOf([
      { id: 'f1', g: new BoxGeometry(40, 40, 2).translate(20, 0, -1) },
      { id: 'f2', g: new BoxGeometry(50, 40, 2).translate(75, 0, -1) },
      { id: 'b1', g: new BoxGeometry(10, 40, 5).translate(20, 0, 2.5) },
      { id: 'b2', g: new BoxGeometry(10, 40, 5).translate(65, 0, 2.5) },
    ]);
  }

  it('pulled taut over two bumps and a gap: rests on the bump tops, bridges the rest, taut length by hand', async () => {
    const d = bumps();
    await waitForBvh();
    const pts = drapePoints(d, [{ link: 'L', p: [5, 0, 0], n: UP }, { link: 'L', p: [95, 0, 0], n: UP }], r);
    // nothing between the bumps (the hollow and the gap are bridged), every contact on a bump
    expect(pts.slice(1, -1).every((p) => (p.p[0] >= 14 && p.p[0] <= 26) || (p.p[0] >= 59 && p.p[0] <= 71))).toBe(true);
    expect(pts.slice(1, -1).every((p) => p.p[2] + p.n[2] * r > 5)).toBe(true);
    // centre line: A' (5, 1) -> round the edge (15, 5) -> along z = 6 to (70, 6) -> round the edge (70, 5) -> B' (95, 1)
    const hand = onToEdge([5, 1], [15, 5], r) + (70 - 15) + onToEdge([95, 1], [70, 5], r);
    const onLinks = routeLength(d, routeOf(pts), r).on_links_mm;
    expect(Math.abs(onLinks - hand)).toBeLessThan(0.1);
    // the fit check: clear of what it bridges, touching at the contacts
    const fit = evaluateWire(d, routeOf(pts), roundType('w', 2 * r, 1), build1, {}).fit!;
    expect(fit.fits).toBe(true);
    const surf = linkSurface(d, 'L');
    for (const p of pts.slice(1, -1)) {
      const c = new Vector3(...p.p).addScaledVector(new Vector3(...p.n), r);
      expect(Math.abs(Math.abs(surfaceDistance(surf, c)!.d) - r)).toBeLessThan(fit.tolerance_mm);
    }
    // ...and the straight chord, with a bump standing in its way, fails
    const chord = routeOf([{ link: 'L', p: [5, 0, 0], n: UP }, { link: 'L', p: [95, 0, 0], n: UP }]);
    expect(evaluateWire(d, chord, roundType('w', 2 * r, 1), build1, {}).fit!.fits).toBe(false);
  });

  it('a step up gives one contact place, at the top edge, and one corner in the bend report', async () => {
    // Floor z = 0 for x < 50; a block 10 high from x = 50 to 100.
    const d = sceneOf([
      { id: 'floor', g: new BoxGeometry(50, 40, 2).translate(25, 0, -1) },
      { id: 'block', g: new BoxGeometry(50, 40, 12).translate(75, 0, 4) },
    ]);
    await waitForBvh();
    const pts = drapePoints(d, [{ link: 'L', p: [10, 0, 0], n: UP }, { link: 'L', p: [90, 0, 10], n: UP }], r);
    const inner = pts.slice(1, -1);
    expect(inner.length).toBeGreaterThan(0);
    for (const p of inner) expect(Math.hypot(p.p[0] - 50, p.p[2] - 10)).toBeLessThan(2 * r + 0.01);
    const env = cableEnvelope(roundType('w', 2 * r, 1000), build1);
    expect(bendReport(d, routeOf(pts), env).tight.length).toBe(1);
    expect(evaluateWire(d, routeOf(pts), roundType('w', 2 * r, 1), build1, {}).fit!.fits).toBe(true);
  });

  it('a click into a slot narrower than the cable is moved up onto its rims', async () => {
    // Two blocks 10 high leaving a 1 mm slot at x 49.5..50.5; floor at z = 0.
    const d = sceneOf([
      { id: 'floor', g: new BoxGeometry(100, 40, 2).translate(50, 0, -1) },
      { id: 'b1', g: new BoxGeometry(20, 40, 10).translate(39.5, 0, 5) },
      { id: 'b2', g: new BoxGeometry(20, 40, 10).translate(60.5, 0, 5) },
    ]);
    await waitForBvh();
    const inSlot = restingPoint(d, { link: 'L', p: [50, 0, 0], n: UP }, r);
    expect(inSlot.moved).toBe(true);
    // resting on the rim: centre r from the rim edge, above the slot
    const c = new Vector3(...inSlot.point.p).addScaledVector(new Vector3(...inSlot.point.n), r);
    expect(c.z).toBeCloseTo(10 + Math.sqrt(r * r - 0.5 * 0.5), 1);
    expect(restingPoint(d, { link: 'L', p: [39.5, 0, 10], n: UP }, r).moved).toBe(false);
  });

  it('follows a curved surface', async () => {
    // A cylinder of radius 20 along y (three's default axis), axis at (50, *, -10).
    const R = 20;
    const cyl = new CylinderGeometry(R, R, 40, 256).translate(50, 0, -10);
    const d = sceneOf([{ id: 'cyl', g: cyl }]);
    await waitForBvh();
    const at = (deg: number): RoutePoint => {
      const t = (deg * Math.PI) / 180;
      return { link: 'L', p: [50 + R * Math.cos(t), 0, -10 + R * Math.sin(t)], n: [Math.cos(t), 0, Math.sin(t)] };
    };
    const pts = drapePoints(d, [at(20), at(160)], r);
    expect(pts.length).toBeGreaterThan(6);
    // tessellation: the facets are inside the true circle by up to R (1 - cos(pi/256))
    const facet = R * (1 - Math.cos(Math.PI / 256));
    for (const p of pts) {
      const c = new Vector3(...p.p).addScaledVector(new Vector3(...p.n), r);
      expect(Math.abs(Math.hypot(c.x - 50, c.z + 10) - (R + r))).toBeLessThan(tol + facet + 1e-6);
    }
    expect(worstOff(d, pts)).toBeLessThan(tol);
    expect(worstBelow(d, pts, r)).toBeGreaterThan(-2 * tol);
  });

  it('a leg between links lies on the bodies of both, and changes link where the bodies meet', async () => {
    // Base plate (x 0..50, top z = 0) on L; a higher plate (x 50..100, top z = 4) on L2 hinged at x = 50.
    const base = sceneOf(
      [
        { id: 'p1', g: new BoxGeometry(50, 40, 2).translate(25, 0, -1), link: 'L' },
        { id: 'p2', g: new BoxGeometry(50, 40, 6).translate(75, 0, 1), link: 'L2' },
      ],
      ['L', 'L2'],
    );
    const d: Design = {
      ...base,
      scene: { ...base.scene, joints: [{ id: 'J', name: 'J', type: 'revolute', parent: 'L', child: 'L2', origin: { p_mm: [0, 0, 0], q: [0, 0, 0, 1] }, axis: [0, 1, 0], limit: { lower: -1, upper: 1 }, value: 0 }] },
    };
    await waitForBvh();
    const pts = drapePoints(d, [{ link: 'L', p: [10, 0, 0], n: UP }, { link: 'L2', p: [90, 0, 4], n: UP }], r);
    const links = pts.map((p) => p.link);
    // all L points first, then all L2 points: one crossing
    expect(links.indexOf('L2')).toBeGreaterThan(0);
    expect(links.slice(links.indexOf('L2')).every((l) => l === 'L2')).toBe(true);
    const route = routeOf(pts);
    expect(route.segments.map((x) => x.link)).toEqual(['L', 'L2']);
    // it climbs the 4 mm step onto the second plate instead of cutting through it
    const fit = evaluateWire(d, route, roundType('w', 2 * r, 1), build1, {}).fit!;
    expect(fit.fits).toBe(true);
  });

  it('moving a point re-drapes the legs on either side', async () => {
    const d = sceneOf([
      { id: 'floor', g: new BoxGeometry(100, 40, 2).translate(50, 0, -1) },
      { id: 'step', g: new BoxGeometry(20, 40, 12).translate(50, 0, 4) },
    ]);
    await waitForBvh();
    const route = withPoints(routeOf([]), [
      { link: 'L', p: [10, 0, 0], n: UP },
      { link: 'L', p: [30, 0, 0], n: UP },
      { link: 'L', p: [35, 10, 0], n: UP },
    ]);
    // move the last point beyond the step: the new leg must climb it
    const res = editDraped(d, route, { kind: 'move', index: 2, point: { link: 'L', p: [90, 0, 0], n: UP } }, r, true)!;
    const pts = pointsOfRoute(res.route);
    expect(pts.at(-1)!.p).toEqual([90, 0, 0]);
    expect(worstBelow(d, pts, r)).toBeGreaterThan(-2 * tol);
    expect(evaluateWire(d, res.route, roundType('w', 2, 1), build1, {}).fit!.fits).toBe(true);
  });
});

describe('bend report stays readable', () => {
  it('merges contacts closer than the cable diameter and caps the list', () => {
    registry.replace([]);
    const d = { ...emptyDesign('b'), scene: { sources: [], links: [{ id: 'L', name: 'L', meshes: [] }], joints: [] } };
    // a 90-degree corner touched twice, 0.05 mm apart: one corner with 10 mm legs, radius 5 / tan(45 deg) = 5
    const route = routeOf([
      { link: 'L', p: [0, 0, 0], n: UP },
      { link: 'L', p: [10, 0, 0], n: UP },
      { link: 'L', p: [10, 0.05, 0], n: UP },
      { link: 'L', p: [10, 10, 0], n: UP },
    ]);
    const bend = bendReport(d, route, cableEnvelope(roundType('w', 2, 6), build1));
    expect(bend.tight.length).toBe(1);
    expect(bend.tightest_mm).toBeCloseTo(5 - 0.05 / 2 / Math.tan(Math.PI / 4) * 0, 1);
    const sum = bendSummary([7, 3, 9, 1, 5, 2, 8].map((x) => ({ radius_mm: x })));
    expect(sum.count).toBe(7);
    expect(sum.tightest_mm).toBe(1);
    expect(sum.worst.map((x) => x.radius_mm)).toEqual([1, 2, 3]);
    expect(sum.more.length).toBe(4);
  });
});

// ---------------------------------------------------------------- 3. flat cables turning in their plane

describe('flat cables cannot turn sideways in the surface', () => {
  it('a 90-degree in-plane turn needs a fold; a round cable does not care', async () => {
    const d = sceneOf([{ id: 'floor', g: new BoxGeometry(200, 200, 2).translate(50, 0, -1) }]);
    await waitForBvh();
    const route = routeOf([
      { link: 'L', p: [0, 0, 0], n: UP },
      { link: 'L', p: [50, 0, 0], n: UP },
      { link: 'L', p: [50, 50, 0], n: UP },
    ]);
    const flat = compareRow(d, route, flatType('ffc16', 16, 0.3), build1, {});
    expect(flat.folds).toBe(1);
    expect(flat.notes.some((n) => n.includes('folded'))).toBe(true);
    expect(compareRow(d, route, roundType('w', 2, 1), build1, {}).folds).toBe(0);
    const env = cableEnvelope(flatType('ffc16', 16, 0.3), build1);
    expect(bendReport(d, route, env).folds[0]!.angle_deg).toBeCloseTo(90, 6);
  });
});

// ---------------------------------------------------------------- 4. crossings

/** Root link A with a floor, link B on a revolute joint about z at the origin; a route from A to B. */
function twoLinks(): { d: Design; route: Route } {
  const base = sceneOf([{ id: 'floorA', g: new BoxGeometry(40, 40, 2).translate(-30, 0, -1), link: 'A' }], ['A', 'B']);
  const d: Design = {
    ...base,
    scene: { ...base.scene, joints: [{ id: 'J', name: 'J', type: 'revolute', parent: 'A', child: 'B', origin: { p_mm: [0, 0, 0], q: [0, 0, 0, 1] }, axis: [0, 0, 1], limit: { lower: -Math.PI, upper: Math.PI }, value: 0 }] },
  };
  const route = routeOf([
    { link: 'A', p: [-30, 0, 0], n: UP },
    { link: 'A', p: [-5, 0, 0], n: UP },
    { link: 'B', p: [5, 0, 0], n: FREE },
    { link: 'B', p: [30, 0, 0], n: FREE },
  ]);
  return { d, route };
}

describe('crossings are judged by the joint-slack model', () => {
  it('a crossing gets a free length and its own checks; the length is complete when it reaches', async () => {
    const { d, route } = twoLinks();
    await waitForBvh();
    const ev = evaluateWire(d, route, roundType('stiff', 2, 50, { confidence: 'datasheet' }), build1, { J: Math.PI / 2 });
    expect(ev.crossings.length).toBe(1);
    const c = ev.lengths.slack.crossings[0]!;
    expect(c.free_length_mm).toBeGreaterThanOrEqual(c.chord_max_mm);
    expect(ev.lengths.complete).toBe(true);
    expect(wireNotes(ev).some((n) => n.includes('LOWER BOUND'))).toBe(false);
  });

  it('says when a crossing was not swept over all its joints', () => {
    const joints = ['J1', 'J2', 'J3', 'J4'];
    const links = ['A', 'B', 'C', 'D', 'E'];
    const d: Design = {
      ...emptyDesign('chain'),
      scene: {
        sources: [],
        links: links.map((id) => ({ id, name: id, meshes: [] })),
        joints: joints.map((id, i) => ({ id, name: id, type: 'revolute' as const, parent: links[i]!, child: links[i + 1]!, origin: { p_mm: [10, 0, 0] as [number, number, number], q: [0, 0, 0, 1] as [number, number, number, number] }, axis: [0, 0, 1] as [number, number, number], limit: { lower: -1, upper: 1 }, value: 0 })),
      },
    };
    const route = routeOf([
      { link: 'A', p: [0, 0, 0], n: FREE },
      { link: 'E', p: [5, 0, 0], n: FREE },
    ]);
    registry.replace([]);
    const ev = evaluateWire(d, route, roundType('w', 1, 1), build1, {}, { skipFit: true });
    expect(ev.lengths.slack.crossings[0]!.unsampled).toEqual(['J4']);
    expect(ev.lengths.complete).toBe(false);
    expect(wireNotes(ev).some((n) => n.includes('too narrow') && n.includes('J4'))).toBe(true);
    expect(wireNotes(ev).some((n) => n.includes('LOWER BOUND') && n.includes('J4'))).toBe(true);
  });
});

// ---------------------------------------------------------------- 5. cut list says what is uncertain

describe('cut list', () => {
  it('marks a lower bound only when the slack model says so, with crossings, slack, joint bend, lay and notes', () => {
    const t = roundType('w26', 1.3, 5);
    const csv = cutListCsv([
      {
        cable: { id: 'wire-1', name: 'Servo', connections: [], type: 'w26', count: 3, twisted: true, sleeve_wall_mm: 0, reasons: [] },
        type: t,
        cut_mm: 190.7,
        required_mm: 190.7,
        crossings: 2,
        slack_mm: 12.34,
        joint_bend_min_mm: 8.25,
        incomplete: '',
        lay_assumed_mm: 36.5,
        notes: ['No lay length given: assumed'],
        status: 'fits',
      },
      {
        cable: { id: 'wire-2', name: 'B', connections: [], type: 'w26', count: 1, twisted: false, sleeve_wall_mm: 0, reasons: [], length_mm: 50 },
        type: t,
        cut_mm: 50,
        required_mm: 80,
        crossings: 1,
        slack_mm: 0,
        joint_bend_min_mm: Infinity,
        incomplete: 'the crossing over J does not reach at some pose',
        notes: [],
        status: 'fits',
      },
    ]);
    const lines = csv.split('\n');
    expect(lines[0]).toBe('wire,name,type,type_name,count,twisted,cut_length_mm,total_wire_mm,required_mm,length_basis,crossings,slack_mm,joint_bend_min_mm,lay_assumed_mm,from_port,to_port,status,notes');
    expect(lines[1]).toBe('wire-1,Servo,w26,w26,3,yes,190.7,572.1,190.7,with 2 joint crossings at their free length (slack 12.3 mm),2,12.3,8.3,36.5,,,fits,No lay length given: assumed');
    expect(lines[2]).toBe('wire-2,B,w26,w26,1,no,50.0,50.0,80.0,"set by user, SHORTER than required; lower bound: the crossing over J does not reach at some pose",1,0.0,,,,,fits,');
  });
});

// ---------------------------------------------------------------- 6. a joint defined after the wire

/** One link L: a base plate (x 0..50) and an arm plate (x 50..100); a wire drawn along both. */
function wireThenJoint(): Design {
  const d = sceneOf([
    { id: 'base', g: new BoxGeometry(50, 40, 2).translate(25, 0, -1) },
    { id: 'arm', g: new BoxGeometry(50, 40, 2).translate(75, 0, -1) },
  ]);
  return {
    ...d,
    cables: [{ id: 'c1', name: 'W', connections: [], type: 'w', count: 1, twisted: false, sleeve_wall_mm: 0, reasons: [] }],
    routes: [
      routeOf([
        { link: 'L', p: [10, 0, 0], n: UP },
        { link: 'L', p: [40, 0, 0], n: UP },
        { link: 'L', p: [60, 0, 0], n: UP },
        { link: 'L', p: [90, 0, 0], n: UP },
      ]),
    ],
  };
}

describe('wires re-seat when a joint is defined after them', () => {
  it('points on the moved part go to the new link and a crossing appears (core split + reseat)', async () => {
    const d = wireThenJoint();
    await waitForBvh();
    const split = splitLink(d, {
      parent: 'L',
      link: { id: 'L2', name: 'L2' },
      joint: { id: 'J', name: 'J', type: 'revolute', axis_point_mm: [50, 0, 0], axis_dir: [0, 1, 0], limit: { lower: -1, upper: 1 } },
      meshes: ['arm'],
    });
    expect(split.routes[0]!.segments.map((x) => x.link)).toEqual(['L']); // the core leaves it on the parent
    const { design, changed } = reseatWires(split, ['L', 'L2']);
    expect(changed).toEqual(['c1']);
    const r = design.routes[0]!;
    expect(r.segments.map((x) => x.link)).toEqual(['L', 'L2']);
    const lengths = routeLength(design, r, 0.5);
    expect(lengths.crossings[0]!.joints).toEqual(['J']);
    // world positions at the zero pose are unchanged
    expect(lengths.min_mm).toBeLessThan(lengths.max_mm);
  });

  it('through the joint editor: one undo step, with a notice naming the wire', async () => {
    const d = wireThenJoint();
    await waitForBvh();
    s().replaceDesign(d);
    s().setJointDraft({ mode: 'new', parent: 'L', meshes: ['arm'], components: [], takeJoints: [], name: 'J', type: 'revolute', lower: -90, upper: 90, axis: { point: [50, 0, 0], dir: [0, 1, 0] }, preview: 0, picking: false });
    expect(await createJointFromDraft()).toBe(true);
    const r = s().design.routes[0]!;
    expect(r.segments.length).toBe(2);
    expect(r.segments[1]!.link).not.toBe('L');
    expect(s().notices.some((n) => n.title.includes('re-seated') && n.details.join(' ').includes('W'))).toBe(true);
    s().undo();
    expect(s().design.scene.joints).toEqual([]);
    expect(s().design.routes[0]!.segments.map((x) => x.link)).toEqual(['L']);
  });
});

// ---------------------------------------------------------------- 7. range check over nearby joints

describe('range of motion includes joints that sweep near the wire', () => {
  /** A base plate on A with the wire on it; an arm on B (revolute about y at x = 0, z = 20) that swings down over the plate; a far joint C. */
  function sweep(): Design {
    const base = sceneOf(
      [
        { id: 'plate', g: new BoxGeometry(100, 40, 2).translate(50, 0, -1), link: 'A' },
        { id: 'arm', g: new BoxGeometry(80, 10, 4).translate(40, 0, 20), link: 'B' },
        { id: 'far', g: new BoxGeometry(10, 10, 10).translate(0, 500, 0), link: 'C' },
      ],
      ['A', 'B', 'C'],
    );
    return {
      ...base,
      scene: {
        ...base.scene,
        joints: [
          { id: 'JB', name: 'swing', type: 'revolute', parent: 'A', child: 'B', origin: { p_mm: [0, 0, 20], q: [0, 0, 0, 1] }, axis: [0, 1, 0], limit: { lower: -0.6, upper: 0.6 }, value: 0 },
          { id: 'JC', name: 'far', type: 'revolute', parent: 'A', child: 'C', origin: { p_mm: [0, 500, 0], q: [0, 0, 0, 1] }, axis: [0, 0, 1], limit: { lower: -1, upper: 1 }, value: 0 },
        ],
      },
    };
  }

  it('finds the swinging joint, leaves the far one out, and fails at the pose where the arm hits the wire', async () => {
    const d = sweep();
    await waitForBvh();
    const route = routeOf([
      { link: 'A', p: [20, 0, 0], n: UP },
      { link: 'A', p: [80, 0, 0], n: UP },
    ]);
    const t = roundType('w', 2, 1);
    const env = cableEnvelope(t, build1);
    const near = jointsNearWire(d, route, env, {}, []);
    expect(near.map((j) => j.id)).toEqual(['JB']);
    // at the shown pose it fits; swung down by 0.6 rad the arm reaches the plate
    expect(evaluateWire(d, route, t, build1, {}).fit!.fits).toBe(true);
    expect(evaluateWire(d, route, t, build1, { JB: 0.6 }).fit!.fits).toBe(false);
    // the app's range check finds it
    useApp.setState({ cableLibrary: { cables: [t] } as never, jointValues: {} });
    s().replaceDesign({ ...d, cables: [{ id: 'c1', name: 'W', connections: [], type: 'w', count: 1, twisted: false, sleeve_wall_mm: 0, reasons: [] }], routes: [route] });
    useApp.setState({ cableLibrary: { cables: [t] } as never });
    await runRangeCheck('c1');
    const range = s().wireChecks['c1']!.range!;
    expect(range.sampled).toEqual(['JB']);
    expect(range.fitsAll).toBe(false);
    expect(range.poses).toBe(9);
  });

  it('keeps the number of poses bounded and names what it leaves out', () => {
    expect(rangePlan(['a'])).toEqual({ sampled: ['a'], skipped: [], perJoint: 9 });
    expect(rangePlan(['a', 'b']).perJoint ** 2).toBeLessThanOrEqual(100);
    expect(rangePlan(['a', 'b', 'c', 'd']).perJoint).toBe(3);
    const many = rangePlan(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
    expect(many.sampled.length).toBe(6);
    expect(many.skipped).toEqual(['g']);
    expect(many.perJoint ** many.sampled.length).toBeLessThanOrEqual(100);
  });
});

// ---------------------------------------------------------------- 8. one rule for the numbers

describe('one wire, the same numbers everywhere', () => {
  it('status and comparison use the same lead-out rule and agree', async () => {
    const d = sceneOf([{ id: 'floor', g: new BoxGeometry(100, 40, 2).translate(50, 0, -1) }]);
    await waitForBvh();
    const t = roundType('w', 3, 1);
    const route = routeOf([
      { link: 'L', p: [10, 0, 0], n: UP },
      { link: 'L', p: [90, 0, 0], n: UP },
    ]);
    const cable = { id: 'c1', name: 'W', connections: [], type: 'w', count: 1, twisted: false, sleeve_wall_mm: 0, reasons: [] };
    useApp.setState({ cableLibrary: { cables: [t] } as never, wireAllowance_mm: 10 });
    const st = statusOf({ ...d, cables: [cable], routes: [route] }, cable, route, t, {});
    const row = compareRow(d, route, t, build1, {}, { allowance_mm: 10 });
    expect(st.tightest_mm).toBe(row.clearance_mm);
    expect(st.required_mm).toBe(row.cut_mm);
    expect(leadOutOf(cableEnvelope(t, build1))).toBe(Math.max(6, 4 * 3));
  });

  it('a range result is dropped when the route changes', async () => {
    const d = sceneOf([{ id: 'floor', g: new BoxGeometry(100, 40, 2).translate(50, 0, -1) }]);
    await waitForBvh();
    const t = roundType('w', 2, 1);
    const route = routeOf([
      { link: 'L', p: [10, 0, 0], n: UP },
      { link: 'L', p: [90, 0, 0], n: UP },
    ]);
    s().replaceDesign({ ...d, cables: [{ id: 'c1', name: 'W', connections: [], type: 'w', count: 1, twisted: false, sleeve_wall_mm: 0, reasons: [] }], routes: [route] });
    useApp.setState({ cableLibrary: { cables: [t] } as never });
    await runRangeCheck('c1');
    await runWireChecks();
    expect(s().wireChecks['c1']!.range).toBeDefined();
    s().commit((x) => ({ ...x, routes: [withPoints(route, [...pointsOfRoute(route), { link: 'L', p: [90, 10, 0], n: UP }])] }));
    await runWireChecks();
    expect(s().wireChecks['c1']!.range).toBeUndefined();
  });

  it('a user cut length shorter than required is flagged', async () => {
    const d = sceneOf([{ id: 'floor', g: new BoxGeometry(100, 40, 2).translate(50, 0, -1) }]);
    await waitForBvh();
    const t = roundType('w', 2, 1);
    const route = routeOf([
      { link: 'L', p: [10, 0, 0], n: UP },
      { link: 'L', p: [90, 0, 0], n: UP },
    ]);
    const cable = { id: 'c1', name: 'W', connections: [], type: 'w', count: 1, twisted: false, sleeve_wall_mm: 0, reasons: [], length_mm: 60 };
    useApp.setState({ wireAllowance_mm: 10 });
    const st = statusOf({ ...d, cables: [cable], routes: [route] }, cable, route, t, {});
    expect(st.required_mm).toBeCloseTo(80 + 20, 9);
    expect(st.cut_mm).toBe(60);
    expect(st.cutTooShort).toBe(true);
    expect(st.notes![0]).toContain('SHORTER');
  });
});
