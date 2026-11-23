/**
 * Regressions for the review's first-tier findings that can run in Node:
 * slack worked out before the bodies' BVHs exist, a run solved without the
 * part library, a throwing job stopping the queue, statuses reading as passing
 * while they are being worked out, a double-click on a port, and a stale
 * selected wire point.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BoxGeometry, CylinderGeometry } from 'three';
import { cableEnvelope, emptyDesign, type CableType, type Design, type Route } from '@core';
import { registry } from '../../src/app/scene/registry';
import '../../src/app/scene/bvh';
import { useApp } from '../../src/app/state/store';
import { dropRepeatedClick } from '../../src/app/tools/wireTool';
import { lengthApproximateWhy, statusText } from '../../src/app/ui/WiresPanel';
import { wireVerdict } from '../../src/app/ui/wireStatus';
import { planSlack } from '../../src/app/wires/checks';
import { cutListCsv } from '../../src/app/wires/compare';
import { commitWireEdit } from '../../src/app/wires/editing';
import { addWire, pointsOfRoute, routeOfCable, segmentsFromPoints, type RoutePoint } from '../../src/app/wires/routeEdit';
import { clearSettled, requestWork, rodOfEnvelope, setSettleMode, whenSettled, wirePlan } from '../../src/app/wires/settle';
import { loadLibrary } from './helpers';

const s = () => useApp.getState();
const UP: [number, number, number] = [0, 0, 1];
const build = { count: 1, twisted: false, sleeve_wall_mm: 0 };
const wire: CableType = { id: 'w', name: 'wire', family: 'hookup_wire', section: { shape: 'round', od_mm: 2 }, conductors: 1, min_bend_mm: { static: 5 }, flex: 'flexible', connectors: [], interfaces: [], confidence: 'generic' };
const env = cableEnvelope(wire, build);
const r = env.height_mm / 2;
const color = [0.6, 0.6, 0.6] as [number, number, number];

async function waitForBvh(): Promise<void> {
  for (let i = 0; i < 300 && s().bvhPending > 0; i++) await new Promise((res) => setTimeout(res, 10));
}

beforeEach(() => {
  clearSettled();
  setSettleMode('sync');
});
afterEach(() => setSettleMode('sync'));

describe('2. slack before the bodies can be seen', () => {
  it('a body whose BVH is still being built counts as not known yet, and the length is worked out again once it can be seen', async () => {
    // A block under link A's hold, a cylinder of radius 30 on link B turning half way round (as in wireDetour.test.ts).
    registry.replace([
      { id: 'block', link: 'A', geometry: new BoxGeometry(35, 40, 10).translate(62.5, 0, 5), color },
      { id: 'cyl', link: 'B', geometry: new CylinderGeometry(30, 30, 50, 96).rotateX(Math.PI / 2).translate(0, 0, 25), color },
    ]);
    const ref = (id: string) => ({ id, source: 's', node: id, tri_count: 12 });
    const d: Design = {
      ...emptyDesign('d'),
      scene: {
        sources: [{ id: 's', kind: 'builtin', uri: 'builtin:test', mm_per_unit: 1 }],
        links: [
          { id: 'A', name: 'Base', meshes: [ref('block')] },
          { id: 'B', name: 'Turret', meshes: [ref('cyl')] },
        ],
        joints: [{ id: 'J', name: 'Yaw', type: 'revolute', parent: 'A', child: 'B', origin: { p_mm: [0, 0, 0], q: [0, 0, 0, 1] }, axis: [0, 0, 1], limit: { lower: -Math.PI, upper: Math.PI }, value: 0 }],
      },
    };
    const route: Route = {
      id: 'r',
      cable: 'c',
      crossings: [],
      segments: segmentsFromPoints([
        { link: 'A', p: [60, 0, 10], n: UP, tie: true },
        { link: 'B', p: [30, 0, 10 + r], n: [1, 0, 0], tie: true },
      ]),
    };
    await waitForBvh();
    // As just after a model loads: the cylinder's BVH is not built yet.
    const cyl = registry.get('cyl')!.geometry;
    const bvh = cyl.boundsTree;
    cyl.boundsTree = undefined;
    const before = planSlack(d, wirePlan(d, null, route, rodOfEnvelope(env), 'none'), env, true);
    expect(before.crossings[0]!.detour_max_mm).toBeUndefined();
    cyl.boundsTree = bvh;
    const after = planSlack(d, wirePlan(d, null, route, rodOfEnvelope(env), 'none'), env, true);
    // The way round the cylinder (116.9 mm by hand, wireDetour.test.ts), not the straight distance remembered from before.
    expect(after.crossings[0]!.detour_max_mm).toBeGreaterThan(116);
    expect(after.crossings[0]!.free_length_mm).toBeGreaterThan(before.crossings[0]!.free_length_mm + 10);
  });
});

describe('3. a run solved without the part library', () => {
  it('is not reused once the library is known: the wire then goes over the placed part', async () => {
    registry.replace([{ id: 'floor', link: 'L', geometry: new BoxGeometry(200, 100, 10).translate(0, 0, -5), color }]);
    await waitForBvh();
    const library = loadLibrary();
    const d: Design = {
      ...emptyDesign('d'),
      scene: { sources: [{ id: 's', kind: 'builtin', uri: 'builtin:test', mm_per_unit: 1 }], links: [{ id: 'L', name: 'L', meshes: [{ id: 'floor', source: 's', node: 'floor', tri_count: 12 }] }], joints: [] },
      // A 25 x 18 x 5 mm board across the wire's path.
      components: [{ id: 'b1', name: 'Board', part: 'generic-breakout-25x18', link: 'L', pose: { p_mm: [0, 0, 0], q: [0, 0, 0, 1] } }],
    };
    const route: Route = {
      id: 'r',
      cable: 'c',
      crossings: [],
      segments: segmentsFromPoints([
        { link: 'L', p: [-60, 0, 0], n: UP, tie: true },
        { link: 'L', p: [60, 0, 0], n: UP, tie: true },
      ]),
    };
    const rod = rodOfEnvelope(env);
    const blind = wirePlan(d, null, route, rod, 'solve').settles[0]!;
    const seen = wirePlan(d, library, route, rod, 'solve').settles[0]!;
    const top = (st: typeof seen) => Math.max(...st.line!.points.map((p) => p[2]));
    // Without the library the board is unknown: the wire lies flat on the floor, its centre at r.
    expect(top(blind)).toBeCloseTo(r, 3);
    // With it, a different solve: the wire goes over the 5 mm board.
    expect(seen).not.toBe(blind);
    expect(top(seen)).toBeGreaterThan(5 + r - 0.01);
  });
});

describe('4. a job that throws', () => {
  it('is kept as failed with its reason, and the queue goes on', async () => {
    setSettleMode('async');
    type Result = { kind: 'clear' } | { kind: 'failed'; why: string };
    const fail = (why: string): Result => ({ kind: 'failed', why });
    const clear = (): Result => ({ kind: 'clear' });
    expect(requestWork<Result>('t4-bad', 'detour', () => { throw new Error('boom'); }, fail)).toBeNull();
    expect(requestWork<Result>('t4-good', 'detour', clear, fail)).toBeNull();
    await whenSettled();
    expect(requestWork<Result>('t4-bad', 'detour', clear, fail)).toEqual({ kind: 'failed', why: 'the shape could not be worked out (boom)' });
    expect(requestWork<Result>('t4-good', 'detour', clear, fail)).toEqual({ kind: 'clear' });
  });
});

describe('5. nothing reads as passing while it is being worked out', () => {
  const passing = { known: true, fits: true, bendGrade: 'ok' as const, crossingGrade: 'ok' as const, crossings: [], ends: [], keepClear: [], folds: [] };

  it('a stale or pending status is checking, and its length is marked approximate', () => {
    expect(wireVerdict(passing)).toBe('ok');
    expect(wireVerdict({ ...passing, stale: true })).toBe('checking');
    expect(wireVerdict({ ...passing, shapePending: true })).toBe('checking');
    expect(statusText({ ...passing, stale: true })).toBe('checking: working out the shape');
    expect(lengthApproximateWhy({ ...passing, shapePending: true })).toBe('approximate: the shape is still being worked out');
    expect(lengthApproximateWhy({ ...passing, shapeApproximate: ['did not settle'] })).toBe('approximate: part of the shape did not settle');
    expect(lengthApproximateWhy(passing)).toBe('');
  });

  it('the cut list says which lengths are approximate', () => {
    const csv = cutListCsv([
      {
        cable: { id: 'w1', name: 'W', connections: [], type: 'w', count: 1, twisted: false, sleeve_wall_mm: 0, reasons: [] },
        cut_mm: 120,
        required_mm: 120,
        approximate: 'approximate: the shape is still being worked out',
        status: 'checking: working out the shape',
      },
    ]);
    expect(csv.split('\n')[1]).toBe('w1,W,w,(not in library),1,no,120.0,120.0,120.0,approximate: the shape is still being worked out; on links only,,,,,,,checking: working out the shape,');
  });
});

describe('7. a double-click on a port to finish', () => {
  it('drops the second click: no lead-out, port, lead-out, port at the end', () => {
    const pt = (x: number, tie = true): RoutePoint => ({ link: 'L', p: [x, 0, 0], n: [0, 0, 0], tie });
    // Click 1 at x = 0; click 2 on a port: its lead-out (x = 90) then the port (x = 100); click 3, the double-click's second, the same again.
    const draft = { points: [pt(0), pt(40, false), pt(90), pt(100), pt(90), pt(100)], marks: [0, 1, 4], markPorts: [null, { component: 'c', port: 'p' }, { component: 'c', port: 'p' }] };
    const out = dropRepeatedClick(draft);
    expect(out.points.map((p) => p.p[0])).toEqual([0, 40, 90, 100]);
    expect(out.marks).toEqual([0, 1]);
    expect(out.markPorts).toEqual([null, { component: 'c', port: 'p' }]);
    // Two different clicks are both kept.
    const two = { points: [pt(0), pt(50)], marks: [0, 1], markPorts: [null, null] };
    expect(dropRepeatedClick(two)).toBe(two);
  });
});

describe('8. a stale selected wire point', () => {
  it('is dropped when another wire is selected, and an index past the end edits nothing', () => {
    let d = emptyDesign('d');
    const pts = (y: number): RoutePoint[] => [0, 20, 40].map((x) => ({ link: 'L', p: [x, y, 0], n: UP, tie: true }));
    const a = addWire(d, { type: 'w', ...build }, pts(0));
    const b = addWire(a.design, { type: 'w', ...build }, pts(30));
    d = b.design;
    useApp.setState({ design: d, past: [], future: [] });
    s().select({ kind: 'cable', id: a.cableId });
    useApp.setState({ wirePoint: { cableId: a.cableId, index: 1 } });
    s().select({ kind: 'cable', id: b.cableId });
    expect(s().wirePoint).toBeNull();
    // Selecting the same wire again keeps its point.
    useApp.setState({ wirePoint: { cableId: b.cableId, index: 1 } });
    s().select({ kind: 'cable', id: b.cableId });
    expect(s().wirePoint).toEqual({ cableId: b.cableId, index: 1 });
    // Undo drops it too.
    s().commit((x) => ({ ...x, meta: { ...x.meta, name: 'changed' } }));
    useApp.setState({ wirePoint: { cableId: b.cableId, index: 1 } });
    s().undo();
    expect(s().wirePoint).toBeNull();
    const before = pointsOfRoute(routeOfCable(s().design, b.cableId)!);
    expect(commitWireEdit(b.cableId, { kind: 'delete', index: 7 })).toBe(false);
    expect(pointsOfRoute(routeOfCable(s().design, b.cableId)!)).toEqual(before);
  });
});
