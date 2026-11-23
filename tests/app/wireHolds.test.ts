/**
 * The wire is held only where the user holds it (route `ties`): stretches run
 * from hold to hold, a change of body under the drape is never a pin, and the
 * slack model and crossing checks read the derived route (one segment per run
 * of holds, the settled centre line).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { BoxGeometry, Vector3 } from 'three';
import { cableEnvelope, crossingEnds, emptyDesign, type CableType, type Design, type Route, type Vec3 } from '@core';
import { openProject } from '../../src/app/io/load';
import { registry } from '../../src/app/scene/registry';
import '../../src/app/scene/bvh';
import { useApp } from '../../src/app/state/store';
import { demoArm } from '../../src/app/demo/builtin';
import { bendReport, fitCheck, lengthReport, wireShape } from '../../src/app/wires/checks';
import { evaluateWire } from '../../src/app/wires/compare';
import { drapePoints } from '../../src/app/wires/drape';
import { addWire, pointsOfRoute, routeOfCable, segmentsFromPoints, setCrossingSlack, withPoints, type RoutePoint } from '../../src/app/wires/routeEdit';
import { clearSettled, rodOfEnvelope, wirePlan } from '../../src/app/wires/settle';
import { armDesign, designFile, fileOf, loadLibrary, stubImporter } from './helpers';

const s = () => useApp.getState();
const UP: Vec3 = [0, 0, 1];
const build = { count: 1, twisted: false, sleeve_wall_mm: 0 };

function wire(od: number, bend: number): CableType {
  return { id: 'w', name: 'wire', family: 'hookup_wire', section: { shape: 'round', od_mm: od }, conductors: 1, min_bend_mm: { static: bend }, flex: 'flexible', connectors: [], interfaces: [], confidence: 'generic' };
}

async function waitForBvh(): Promise<void> {
  for (let i = 0; i < 300 && s().bvhPending > 0; i++) await new Promise((r) => setTimeout(r, 10));
}

/**
 * Two links on a hinge at the origin (axis y): A holds a slab under x < -1, B
 * a slab under x > 1, both with their tops at z = 0 and B's raised to z = 4
 * from x = 1 to 3 (a lip the drape climbs over at the body change).
 */
async function hinge(): Promise<Design> {
  const box = (id: string, link: string, a: Vec3, b: Vec3) => ({
    id,
    link,
    geometry: new BoxGeometry(b[0] - a[0], b[1] - a[1], b[2] - a[2]).translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2),
    color: [0.6, 0.6, 0.6] as [number, number, number],
  });
  registry.replace([box('a', 'A', [-100, -30, -20], [-1, 30, 0]), box('b', 'B', [1, -30, -20], [100, 30, 0]), box('lip', 'B', [1, -30, 0], [3, 30, 4])]);
  await waitForBvh();
  const ref = (id: string) => ({ id, source: 's', node: id, tri_count: 12 });
  return {
    ...emptyDesign('h'),
    scene: {
      sources: [{ id: 's', kind: 'builtin', uri: 'builtin:test', mm_per_unit: 1 }],
      links: [
        { id: 'A', name: 'A', meshes: [ref('a')] },
        { id: 'B', name: 'B', meshes: [ref('b'), ref('lip')] },
      ],
      joints: [{ id: 'J', name: 'J', type: 'revolute', parent: 'A', child: 'B', origin: { p_mm: [0, 0, 0], q: [0, 0, 0, 1] }, axis: [0, 1, 0], limit: { lower: -0.5, upper: 0.5 }, value: 0 }],
    },
  };
}

const click = (link: string, x: number, z = 0): RoutePoint => ({ link, p: [x, 0, z], n: UP, tie: true });

function routeOf(points: RoutePoint[]): Route {
  return { id: 'r', cable: 'c', crossings: [], segments: segmentsFromPoints(points) };
}

beforeEach(() => {
  clearSettled();
});

describe('holds', () => {
  it('holds on two links either side of a joint, with draped points between: one loop from hold to hold, no pin where the body changes', async () => {
    const d = await hinge();
    const env = cableEnvelope(wire(1.5, 10), build);
    const r = env.height_mm / 2;
    const pts = drapePoints(d, [click('A', -60), click('A', -30), click('B', 40)], r, {});
    const route = routeOf(pts);
    // The drape added points over the lip, on B (the path changes body there).
    expect(route.segments.map((x) => x.link)).toEqual(['A', 'B']);
    const lipPoints = pts.filter((p) => p.link === 'B' && !p.tie);
    expect(lipPoints.length).toBeGreaterThan(0);
    expect(route.segments[1]!.ties![0]).toBe(false);
    const plan = wirePlan(d, null, route, rodOfEnvelope(env), 'solve');
    // Runs: A with two holds (one laid stretch), B with one (a pivot). One loop between them.
    expect(plan.runs.map((x) => [x.link, x.holds.length])).toEqual([
      ['A', 2],
      ['B', 1],
    ]);
    expect(plan.loops.length).toBe(1);
    expect(plan.loops[0]!.between.length).toBe(pts.length - 3);
    // The A stretch is pinned at its two holds only, and the loop runs from the A hold at x = -30 to the B hold at x = 40.
    expect(plan.settles[0]!.ok).toBe(true);
    expect(plan.settles[0]!.line!.pin_indices.length).toBe(2);
    const ends = crossingEnds(d, plan.derived, r, 0, {});
    expect(ends.a[0]).toBeCloseTo(-30, 9);
    expect(ends.a[2]).toBeCloseTo(r, 9);
    expect(ends.b[0]).toBeCloseTo(40, 9);
    expect(ends.b[2]).toBeCloseTo(r, 9);
    // The slack model sees exactly one crossing.
    expect(lengthReport(d, route, env, 10, plan).slack.crossings.length).toBe(1);
  });

  it('a short piece of drape between the body change and a hold is not a stretch any more', async () => {
    const d = await hinge();
    const env = cableEnvelope(wire(1.5, 10), build);
    const r = env.height_mm / 2;
    // The hold on B 9 mm beyond the lip's far side: the drape's B points start at the lip.
    const pts = drapePoints(d, [click('A', -60), click('A', -30), click('B', 12)], r, {});
    const route = routeOf(pts);
    const bPoints = route.segments[1]!.points_mm;
    expect(bPoints[bPoints.length - 1]![0] - bPoints[0]![0]).toBeGreaterThan(8.5);
    expect(bPoints[bPoints.length - 1]![0] - bPoints[0]![0]).toBeLessThan(11.5);
    // Read as an old file (no holds recorded), the drape's first B point ends a segment and is a pin: a ~9 mm stretch.
    const legacy: Route = {
      ...route,
      segments: route.segments.map((seg) => {
        const copy = { ...seg };
        delete copy.ties;
        return copy;
      }),
    };
    const old = wirePlan(d, null, legacy, rodOfEnvelope(env), 'none');
    expect(old.runs[1]!.holds.length).toBe(2);
    // With holds: B is a single hold the wire pivots at, no stretch of its own.
    const plan = wirePlan(d, null, route, rodOfEnvelope(env), 'solve');
    expect(plan.runs[1]!.holds.length).toBe(1);
    expect(plan.derived.segments[1]!.points_mm.length).toBe(1);
    const bend = bendReport(d, route, env, plan);
    expect(bend.tight.filter((t) => t.link === 'B')).toEqual([]);
    expect(bend.grade).toBe('ok');
  });

  it('the derived route leaves a run along its settled end direction', async () => {
    const d = await hinge();
    const env = cableEnvelope(wire(1.5, 10), build);
    const pts = drapePoints(d, [click('A', -70), click('A', -40), click('B', 40), click('B', 70)], env.height_mm / 2, {});
    const route = routeOf(pts);
    const plan = wirePlan(d, null, route, rodOfEnvelope(env), 'solve');
    const line = plan.settles[0]!.line!.points;
    const p = line[line.length - 1]!;
    const q = line[line.length - 2]!;
    const t = new Vector3(p[0] - q[0], p[1] - q[1], p[2] - q[2]).normalize();
    // The hinge is at zero, so link A's frame is the world.
    const ends = crossingEnds(d, plan.derived, env.height_mm / 2, 0, {});
    expect(ends.ta![0]).toBeCloseTo(t.x, 9);
    expect(ends.ta![1]).toBeCloseTo(t.y, 9);
    expect(ends.ta![2]).toBeCloseTo(t.z, 9);
    // The other end leaves the B run the same way.
    const lb = plan.settles[1]!.line!.points;
    const tb = new Vector3(lb[1]![0] - lb[0]![0], lb[1]![1] - lb[0]![1], lb[1]![2] - lb[0]![2]).normalize();
    expect(ends.tb![0]).toBeCloseTo(tb.x, 9);
    expect(ends.tb![2]).toBeCloseTo(tb.z, 9);
  });
});

describe('saved holds', () => {
  beforeEach(() => {
    registry.replace([]);
    useApp.setState({ library: loadLibrary(), notices: [] });
  });

  it('a route saved and reopened keeps its holds', async () => {
    const pts: RoutePoint[] = [
      { link: 'base', p: [100, 0, 12], n: UP, tie: true },
      { link: 'base', p: [80, 0, 12], n: UP, tie: false },
      { link: 'turret', p: [60, 0, 25], n: [1, 0, 0], tie: false },
      { link: 'turret', p: [60, 0, 45], n: [1, 0, 0], tie: true },
    ];
    const r = addWire(armDesign(), { type: 'w', ...build }, pts);
    const id = routeOfCable(r.design, r.cableId)!.id;
    expect(r.design.routes[0]!.segments.map((x) => x.ties)).toEqual([
      [true, false],
      [false, true],
    ]);
    await openProject(designFile(r.design), [fileOf('arm.glb')], stubImporter());
    const back = s().design.routes.find((x) => x.id === id)!;
    expect(back.segments.map((x) => x.ties)).toEqual([
      [true, false],
      [false, true],
    ]);
    expect(pointsOfRoute(back).map((p) => p.tie)).toEqual([true, false, false, true]);
  });

  it('a file from before holds were recorded opens and shows a shape; its first edit writes them', async () => {
    const legacy: Design = {
      ...armDesign(),
      cables: [{ id: 'c1', name: 'Wire', connections: [], type: 'ul1007-22awg', count: 1, twisted: false, sleeve_wall_mm: 0, reasons: [] }],
      routes: [
        {
          id: 'r1',
          cable: 'c1',
          crossings: [],
          segments: [
            { link: 'base', points_mm: [[100, 0, 12], [70, 0, 12]], normals: [UP, UP] },
            { link: 'turret', points_mm: [[60, 0, 25], [60, 0, 45]], normals: [[1, 0, 0], [1, 0, 0]] },
          ],
        },
      ],
    };
    await openProject(designFile(legacy), [fileOf('arm.glb')], stubImporter());
    const route = s().design.routes[0]!;
    expect(route.segments.every((x) => x.ties === undefined)).toBe(true);
    const env = cableEnvelope(wire(1.6, 10), build);
    const plan = wirePlan(s().design, null, route, rodOfEnvelope(env), 'solve');
    // Worked out from the path: each segment's two ends hold it.
    expect(plan.runs.map((x) => x.holds)).toEqual([
      [0, 1],
      [2, 3],
    ]);
    const shape = wireShape(s().design, route, env, {}, lengthReport(s().design, route, env, 10, plan).slack, { plan });
    expect(shape.segments.map((x) => x.line.length >= 2)).toEqual([true, true]);
    expect(shape.crossings.length).toBe(1);
    // Edited (here: re-saved through the point list), the holds are written.
    const edited = withPoints(route, pointsOfRoute(route));
    expect(edited.segments.map((x) => x.ties)).toEqual([
      [true, true],
      [true, true],
    ]);
  });
});

describe('fit agrees with the solver', () => {
  it('a wire settled round a faceted drum passes the fit check against the bodies it was settled on', async () => {
    registry.replace(demoArm().meshes);
    await waitForBvh();
    const d = armDesign();
    const values = Object.fromEntries(d.scene.joints.map((j) => [j.id, j.value]));
    const c45 = Math.SQRT1_2;
    const t = wire(1.57, 12.6);
    const env = cableEnvelope(t, build);
    const pts = drapePoints(
      d,
      [
        { link: 'turret', p: [60, 0, 30], n: [1, 0, 0], tie: true },
        { link: 'turret', p: [60 * c45, 60 * c45, 20], n: [c45, c45, 0], tie: true },
        { link: 'turret', p: [-60, 0, 30], n: [-1, 0, 0], tie: true },
      ],
      env.height_mm / 2,
      values,
    );
    const route = routeOf(pts);
    const ev = evaluateWire(d, route, t, build, values, { solve: true });
    expect(ev.settle.settles.map((x) => x?.ok)).toEqual([true]);
    expect(ev.settle.settles[0]!.line!.worst_penetration_mm).toBe(0);
    const shape = wireShape(d, route, env, values, ev.lengths.slack, { plan: ev.settle.plan });
    const fit = fitCheck(d, shape, env, values, {});
    expect(fit.failing).toEqual([]);
    expect(fit.fits).toBe(true);
  });
});

describe('stated slack', () => {
  beforeEach(() => {
    registry.replace([]);
    useApp.setState({ library: loadLibrary(), notices: [] });
  });

  /** Holds on the base, a lone hold on the turret, holds on the upper arm: loops over j1 and over j2. */
  function threeRuns(): { d: Design; routeId: string } {
    const r = addWire(armDesign(), { type: 'w', ...build }, [
      { link: 'base', p: [120, 0, 12], n: UP, tie: true },
      { link: 'base', p: [95, 0, 12], n: UP, tie: true },
      { link: 'turret', p: [60, 0, 30], n: [1, 0, 0], tie: true },
      { link: 'upper_arm', p: [23, 0, 40], n: [1, 0, 0], tie: true },
      { link: 'upper_arm', p: [23, 0, 120], n: [1, 0, 0], tie: true },
    ]);
    return { d: r.design, routeId: routeOfCable(r.design, r.cableId)!.id };
  }

  it('applies to the loop it was stated for', () => {
    const { d, routeId } = threeRuns();
    const stated = setCrossingSlack(d, routeId, 1, 30);
    const route = stated.routes.find((x) => x.id === routeId)!;
    expect(route.crossings).toEqual([{ joint: 'j2', strategy: 'service_loop', slack_mm: 30 }]);
    const ev = evaluateWire(stated, route, wire(2, 5), build, {}, { skipFit: true });
    expect(ev.crossings.map((c) => c.basis)).toEqual(['auto', 'user']);
    expect(ev.crossings[1]!.joints).toEqual(['j2']);
    expect(ev.crossings[1]!.slack_mm).toBeCloseTo(30, 9);
  });

  it('a loop over two joints (no hold between) takes the slack stated for it', () => {
    const r = addWire(armDesign(), { type: 'w', ...build }, [
      { link: 'base', p: [120, 0, 12], n: UP, tie: true },
      { link: 'base', p: [95, 0, 12], n: UP, tie: true },
      { link: 'upper_arm', p: [23, 0, 40], n: [1, 0, 0], tie: true },
      { link: 'upper_arm', p: [23, 0, 120], n: [1, 0, 0], tie: true },
    ]);
    const routeId = routeOfCable(r.design, r.cableId)!.id;
    const stated = setCrossingSlack(r.design, routeId, 0, 20);
    const route = stated.routes.find((x) => x.id === routeId)!;
    expect(route.crossings).toEqual([{ joint: 'j1', strategy: 'service_loop', slack_mm: 20 }]);
    const ev = evaluateWire(stated, route, wire(2, 5), build, {}, { skipFit: true, skipCrossings: true });
    expect(ev.lengths.slack.crossings.length).toBe(1);
    expect(ev.lengths.slack.crossings[0]!.joints).toEqual(['j1', 'j2']);
    expect(ev.lengths.slack.crossings[0]!.basis).toBe('user');
    expect(ev.lengths.slack.crossings[0]!.slack_mm).toBeCloseTo(20, 9);
  });
});
