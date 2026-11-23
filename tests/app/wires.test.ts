/**
 * Wires: building routes from clicks, the fit check on generated channels,
 * the comparison table against hand-computed numbers, the cut list CSV,
 * reopening with a missing cable type, and crossing lengths across a joint.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { BoxGeometry } from 'three';
import { emptyDesign, type CableType, type Design, type Route } from '@core';
import { openProject } from '../../src/app/io/load';
import { registry } from '../../src/app/scene/registry';
import '../../src/app/scene/bvh';
import { useApp } from '../../src/app/state/store';
import { buildFor, compareRow, cutListCsv, evaluateWire, sortRows } from '../../src/app/wires/compare';
import { addWire, deletePoint, insertPoint, movePoint, pointsOfRoute, routeOfCable, segmentsFromPoints, type RoutePoint } from '../../src/app/wires/routeEdit';
import { armDesign, designFile, fileOf, loadCableLibrary, loadLibrary, stubImporter } from './helpers';

const s = () => useApp.getState();
const UP: [number, number, number] = [0, 0, 1];

function roundType(id: string, od: number, bend: number, extra: Partial<CableType> = {}): CableType {
  return { id, name: id, family: 'hookup_wire', section: { shape: 'round', od_mm: od }, conductors: 1, min_bend_mm: { static: bend }, flex: 'flexible', connectors: [], interfaces: [], confidence: 'generic', ...extra };
}

async function waitForBvh(): Promise<void> {
  for (let i = 0; i < 200 && s().bvhPending > 0; i++) await new Promise((r) => setTimeout(r, 10));
}

describe('routes from clicks', () => {
  it('consecutive points on one link form a segment; a change of link starts the next', () => {
    const pts: RoutePoint[] = [
      { link: 'A', p: [0, 0, 0], n: UP },
      { link: 'A', p: [10, 0, 0], n: UP },
      { link: 'B', p: [0, 5, 0], n: [0, 0, 0] },
      { link: 'B', p: [0, 15, 0], n: UP },
      { link: 'A', p: [30, 0, 0], n: UP },
    ];
    const segs = segmentsFromPoints(pts);
    expect(segs.map((x) => [x.link, x.points_mm.length])).toEqual([
      ['A', 2],
      ['B', 2],
      ['A', 1],
    ]);
    expect(segs[1]!.normals).toEqual([
      [0, 0, 0],
      [0, 0, 1],
    ]);
  });

  it('editing points keeps the segment structure consistent', () => {
    const route: Route = { id: 'r', cable: 'c', crossings: [], segments: segmentsFromPoints([
      { link: 'A', p: [0, 0, 0], n: UP },
      { link: 'A', p: [10, 0, 0], n: UP },
      { link: 'B', p: [0, 5, 0], n: UP },
    ]) };
    // moving the last point onto link A merges everything into one segment
    const merged = movePoint(route, 2, { link: 'A', p: [20, 0, 0], n: UP });
    expect(merged.segments).toHaveLength(1);
    const inserted = insertPoint(route, 1, { link: 'C', p: [5, 5, 5], n: UP });
    expect(inserted.segments.map((x) => x.link)).toEqual(['A', 'C', 'A', 'B']);
    expect(pointsOfRoute(deletePoint(inserted, 1)!)).toEqual(pointsOfRoute(route));
    expect(deletePoint(merged.segments.length === 1 ? { ...route, segments: segmentsFromPoints(pointsOfRoute(route).slice(0, 2)) } : route, 0)).toBeNull();
  });
});

// ---------------------------------------------------------------- fit on generated channels

/** A floor 100 x 40 x 2 (top at z = 0) and two walls 10 high leaving a channel `w` wide along x, centred on y = 0. */
function channelDesign(w: number): Design {
  const floor = new BoxGeometry(100, 40, 2).translate(50, 0, -1);
  const wallL = new BoxGeometry(100, 5, 10).translate(50, w / 2 + 2.5, 5);
  const wallR = new BoxGeometry(100, 5, 10).translate(50, -w / 2 - 2.5, 5);
  registry.replace([
    { id: 'floor', link: 'L', geometry: floor, color: [1, 1, 1] },
    { id: 'wallL', link: 'L', geometry: wallL, color: [1, 1, 1] },
    { id: 'wallR', link: 'L', geometry: wallR, color: [1, 1, 1] },
  ]);
  const d = emptyDesign('channel');
  return {
    ...d,
    scene: {
      sources: [{ id: 's', kind: 'builtin', uri: 'builtin:demo-arm', mm_per_unit: 1 }],
      links: [{ id: 'L', name: 'L', meshes: ['floor', 'wallL', 'wallR'].map((id) => ({ id, source: 's', node: id, tri_count: 12 })) }],
      joints: [],
    },
  };
}

function floorRoute(): Route {
  return {
    id: 'r1',
    cable: 'c1',
    crossings: [],
    segments: segmentsFromPoints([
      { link: 'L', p: [10, 0, 0], n: UP },
      { link: 'L', p: [50, 0, 0], n: UP },
      { link: 'L', p: [90, 0, 0], n: UP },
    ]),
  };
}

const build1 = { count: 1, twisted: false, sleeve_wall_mm: 0 };

describe('fit check', () => {
  beforeEach(() => useApp.setState({ library: loadLibrary() }));

  it('a channel wider than the cable passes, with the clearance to the walls', async () => {
    const d = channelDesign(3);
    await waitForBvh();
    const ev = evaluateWire(d, floorRoute(), roundType('thin', 2, 5), build1, {});
    expect(ev.fit!.fits).toBe(true);
    // wall faces at y = +-1.5, cable radius 1: 0.5 mm each side
    expect(ev.fit!.tightest_mm).toBeCloseTo(0.5, 3);
    expect(['wallL', 'wallR']).toContain(ev.fit!.tightestWhat);
  });

  it('a channel narrower than the cable fails and names the tightest point', async () => {
    const d = channelDesign(1.6);
    await waitForBvh();
    const ev = evaluateWire(d, floorRoute(), roundType('thin', 2, 5), build1, {});
    expect(ev.fit!.fits).toBe(false);
    expect(ev.fit!.tightest_mm).toBeCloseTo(-0.2, 3);
    expect(ev.fit!.failing.length).toBeGreaterThan(0);
    expect(ev.fit!.tightestAt).not.toBeNull();
    expect(Math.abs(ev.fit!.tightestAt![2] - 1)).toBeLessThan(1e-6); // centre line at half the height
  });

  it('on the same route a thicker type fails where a thinner one passes', async () => {
    const d = channelDesign(3);
    await waitForBvh();
    expect(evaluateWire(d, floorRoute(), roundType('thin', 2, 5), build1, {}).fit!.fits).toBe(true);
    const thick = evaluateWire(d, floorRoute(), roundType('thick', 4, 20), build1, {});
    expect(thick.fit!.fits).toBe(false);
    expect(thick.fit!.tightest_mm).toBeCloseTo(-0.5, 3);
  });
});

// ---------------------------------------------------------------- comparison numbers by hand

describe('comparison table', () => {
  it('matches hand-computed numbers for a fixed L-shaped route', () => {
    registry.replace([]);
    const d: Design = { ...emptyDesign('t'), scene: { sources: [], links: [{ id: 'L', name: 'L', meshes: [] }], joints: [] } };
    const route: Route = {
      id: 'r',
      cable: 'c',
      crossings: [],
      segments: segmentsFromPoints([
        { link: 'L', p: [0, 0, 0], n: UP },
        { link: 'L', p: [50, 0, 0], n: UP },
        { link: 'L', p: [50, 30, 0], n: UP },
      ]),
    };
    const t = roundType('w', 2, 5, { mass_g_per_m: 10 });
    const one = compareRow(d, route, t, build1, {});
    // The wire is a stiff rod laid snug (lay length 1.6 x the 5 mm limit = 8 mm) and held at the corner it was
    // placed at. Pulled round a 90 degree turn with its ties far away it would bend to 8 / (2 sin 22.5 deg) =
    // 10.45 mm (stiffness.ts); ties nearer than that only tighten it. It still clears the 5 mm limit.
    expect(one.tightest_bend_mm).toBeLessThanOrEqual(10.46);
    expect(one.tightest_bend_mm).toBeGreaterThan(5);
    expect(one.bend_passes).toBe(true);
    // A smooth curve through the three placed points is at least as long as the two straight legs (80 mm).
    expect(one.cut_mm).toBeGreaterThanOrEqual(80 + 2 * 10);
    expect(one.cut_mm).toBeLessThan(80 + 2 * 10 + 4);
    expect(one.mass_g).toBeCloseTo((10 * one.cut_mm) / 1000, 9);
    expect(one.width_mm).toBe(2);
    // three twisted with a 30 mm lay
    const three = compareRow(d, route, t, { count: 3, twisted: true, lay_length_mm: 30, sleeve_wall_mm: 0 }, {});
    const D = 2.1547 * 2;
    const offset = (D - 2) / 2;
    const factor = Math.hypot(1, (2 * Math.PI * offset) / 30);
    expect(three.width_mm).toBeCloseTo(D, 9);
    expect(three.bend_static_mm).toBeCloseTo(5 + offset, 9);
    expect(three.cut_mm).toBeGreaterThanOrEqual(80 * factor + 20);
    expect(three.mass_g).toBeCloseTo((10 * 3 * three.cut_mm) / 1000, 9);
    // a corner too tight for a stiff cable
    const stiff = compareRow(d, route, roundType('stiff', 2, 20), build1, {});
    expect(stiff.bend_passes).toBe(false);
    // ...which only warns when the limit is a size rule, and fails when it is the maker's figure
    expect(stiff.bend_source).toBe('generic');
    expect(stiff.bend_grade).toBe('warn');
    const firm = compareRow(d, route, roundType('firm', 2, 20, { confidence: 'datasheet' }), build1, {});
    expect(firm.bend_grade).toBe('fail');
    expect(one.bend_grade).toBe('ok');
    // the user's own radius replaces the library's and is graded as firm
    const own = compareRow(d, route, roundType('stiff', 2, 20), { ...build1, bend_override_mm: 12 }, {});
    expect(own.bend_static_mm).toBe(12);
    expect(own.bend_source).toBe('user');
    expect(own.bend_grade).toBe('ok');
    // The user's radius sets the lay length too (1.6 x it): a radius close to the corner's forces a fail.
    expect(compareRow(d, route, roundType('stiff', 2, 20), { ...build1, bend_override_mm: 19 }, {}).bend_grade).toBe('fail');
    // sorting by the bend here keeps ok, warns and fails apart
    expect(sortRows([firm, stiff, one], 'tightest_bend_mm', true).map((r) => r.bend_grade)).toEqual(['ok', 'warn', 'fail']);
  });

  it('the bend override belongs to the cable type it was set for', () => {
    const cable = { id: 'c', connections: [], type: 'a', count: 2, twisted: false, sleeve_wall_mm: 0, reasons: [], bend_override_mm: 7 };
    expect(buildFor(cable, 'a').bend_override_mm).toBe(7);
    expect(buildFor(cable, 'b').bend_override_mm).toBeUndefined();
    expect(buildFor(cable, 'b').count).toBe(2);
  });
});

describe('cut list CSV', () => {
  it('one line per wire and totals per type', () => {
    const t = roundType('w26', 1.3, 5);
    const csv = cutListCsv([
      { cable: { id: 'wire-1', name: 'A, "main"', connections: [], type: 'w26', count: 2, twisted: true, sleeve_wall_mm: 0, reasons: [] }, type: t, cut_mm: 120, status: 'ok' },
      { cable: { id: 'wire-2', name: 'B', connections: [], type: 'w26', count: 1, twisted: false, sleeve_wall_mm: 0, reasons: [] }, type: t, cut_mm: 80.25, status: 'does not fit' },
    ]);
    expect(csv.split('\n')).toEqual([
      'wire,name,type,type_name,count,twisted,cut_length_mm,total_wire_mm,required_mm,length_basis,crossings,slack_mm,joint_bend_min_mm,lay_assumed_mm,from_port,to_port,status,notes',
      'wire-1,"A, ""main""",w26,w26,2,yes,120.0,240.0,,,,,,,,,ok,',
      'wire-2,B,w26,w26,1,no,80.3,80.3,,,,,,,,,does not fit,',
      '',
      'total_for_type,type_name,wires,total_wire_mm',
      'w26,w26,2,320.3',
      '',
    ]);
  });
});

describe('reopen with a missing cable type', () => {
  it('keeps the wire and says the type is missing', async () => {
    useApp.setState({ library: loadLibrary(), cableLibrary: loadCableLibrary(), notices: [] });
    let d = armDesign();
    const added = addWire(d, { type: 'no-such-cable', count: 1, twisted: false, sleeve_wall_mm: 0 }, [
      { link: 'base', p: [100, 60, 12], n: UP },
      { link: 'base', p: [100, -60, 12], n: UP },
    ]);
    d = added.design;
    await openProject(designFile(d), [fileOf('arm.glb')], stubImporter());
    expect(s().design.cables.map((c) => c.type)).toEqual(['no-such-cable']);
    expect(routeOfCable(s().design, added.cableId)).toBeDefined();
    const text = s().notices.map((n) => `${n.title} ${n.details.join(' ')}`).join('\n');
    expect(text).toMatch(/no-such-cable/);
  });
});
