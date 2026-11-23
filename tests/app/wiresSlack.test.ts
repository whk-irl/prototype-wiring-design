/**
 * Joint crossings from the joint-slack model: cut length from free lengths,
 * the stated slack control (save/reopen, undo), reach, the drawn loop meeting
 * the segments, the ribbon twist warning, and "Show tightest pose".
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { cableEnvelope, emptyDesign, routeSlack, statedSlack, type CableType, type Design, type Route } from '@core';
import { openProject } from '../../src/app/io/load';
import { registry } from '../../src/app/scene/registry';
import '../../src/app/scene/bvh';
import { useApp } from '../../src/app/state/store';
import { wireShape } from '../../src/app/wires/checks';
import { compareRow, evaluateWire } from '../../src/app/wires/compare';
import { FLAT_TWIST_WARN_DEG } from '../../src/app/wires/crossings';
import { showPose } from '../../src/app/wires/editing';
import { addWire, routeOfCable, segmentsFromPoints, setCrossingSlack } from '../../src/app/wires/routeEdit';
import { armDesign, designFile, fileOf, loadLibrary, stubImporter } from './helpers';

const s = () => useApp.getState();
const UP: [number, number, number] = [0, 0, 1];
const build1 = { count: 1, twisted: false, sleeve_wall_mm: 0 };

function roundType(id: string, od: number, bend: number, extra: Partial<CableType> = {}): CableType {
  return { id, name: id, family: 'hookup_wire', section: { shape: 'round', od_mm: od }, conductors: 1, min_bend_mm: { static: bend }, flex: 'flexible', connectors: [], interfaces: [], confidence: 'generic', ...extra };
}
function flatType(id: string, width: number, thickness: number): CableType {
  return { id, name: id, family: 'ffc', section: { shape: 'flat', width_mm: width, thickness_mm: thickness }, conductors: 10, min_bend_mm: { static: 2 }, flex: 'flexible', connectors: [], interfaces: [], confidence: 'generic' };
}

/** The demo arm with a wire from the base plate up onto the turret (across j1). */
function armWire(): { d: Design; cableId: string; routeId: string } {
  const r = addWire(armDesign(), { type: 'w', count: 1, twisted: false, sleeve_wall_mm: 0 }, [
    { link: 'base', p: [100, 0, 12], n: UP },
    { link: 'base', p: [70, 0, 12], n: UP },
    { link: 'turret', p: [60, 0, 25], n: [1, 0, 0] },
    { link: 'turret', p: [60, 0, 45], n: [1, 0, 0] },
  ]);
  return { d: r.design, cableId: r.cableId, routeId: routeOfCable(r.design, r.cableId)!.id };
}

beforeEach(() => {
  registry.replace([]);
  useApp.setState({ library: loadLibrary(), notices: [] });
});

describe('cut length', () => {
  it('uses the crossings\' free lengths, not the straight span', () => {
    const { d, cableId } = armWire();
    const route = routeOfCable(d, cableId)!;
    const t = roundType('w', 2, 5);
    const env = cableEnvelope(t, build1);
    const slack = routeSlack(d, route, env.height_mm / 2, { bend_static_mm: env.bend_static_mm });
    const row = compareRow(d, route, t, build1, {}, { allowance_mm: 10 });
    expect(row.cut_mm).toBeCloseTo((slack.on_links_mm + slack.crossings[0]!.free_length_mm) * env.length_factor + 20, 6);
    expect(slack.crossings[0]!.free_length_mm).toBeGreaterThanOrEqual(slack.crossings[0]!.chord_max_mm);
    expect(row.complete).toBe(true);
  });
});

describe('stated slack', () => {
  it('writes one entry for the crossing, survives save/reopen, and undoes', async () => {
    const { d, routeId } = armWire();
    const stated = setCrossingSlack(d, routeId, 0, 25);
    const route = stated.routes.find((r) => r.id === routeId)!;
    expect(route.crossings).toEqual([{ joint: 'j1', strategy: 'service_loop', slack_mm: 25 }]);
    expect(statedSlack(stated, route, 0)).toBe(25);
    // the slack model follows it
    const env = cableEnvelope(roundType('w', 2, 5), build1);
    const sl = routeSlack(stated, route, env.height_mm / 2, { bend_static_mm: 5 });
    expect(sl.crossings[0]!.basis).toBe('user');
    expect(sl.crossings[0]!.free_length_mm).toBeCloseTo(sl.crossings[0]!.chord_max_mm + 25, 6);
    // Auto removes it
    expect(setCrossingSlack(stated, routeId, 0, undefined).routes.find((r) => r.id === routeId)!.crossings).toEqual([]);

    await openProject(designFile(stated), [fileOf('arm.glb')], stubImporter());
    expect(s().design.routes.find((r) => r.id === routeId)!.crossings).toEqual([{ joint: 'j1', strategy: 'service_loop', slack_mm: 25 }]);
    s().commit((x) => setCrossingSlack(x, routeId, 0, 40));
    expect(s().design.routes.find((r) => r.id === routeId)!.crossings[0]!.slack_mm).toBe(40);
    s().undo();
    expect(s().design.routes.find((r) => r.id === routeId)!.crossings[0]!.slack_mm).toBe(25);
  });

  it('a stated slack too small to reach fails, naming the pose', () => {
    const { d, routeId } = armWire();
    // The schema allows no negative slack; built directly to make the crossing too short.
    const route = { ...d.routes.find((r) => r.id === routeId)!, crossings: [{ joint: 'j1', strategy: 'service_loop' as const, slack_mm: -5 }] };
    const ev = evaluateWire({ ...d, routes: [route] }, route, roundType('w', 2, 5), build1, {}, { skipFit: true });
    const c = ev.crossings[0]!;
    expect(c.reaches).toBe(false);
    expect(c.grade).toBe('fail');
    expect(c.short!.by_mm).toBeGreaterThan(0);
    expect(Object.keys(c.short!.values)).toEqual(['j1']);
    expect(ev.lengths.complete).toBe(false);
  });
});

describe('the drawn crossing', () => {
  it('starts and ends exactly at the neighbouring segments\' end points, at every pose', () => {
    const { d, cableId } = armWire();
    const route = routeOfCable(d, cableId)!;
    const t = roundType('w', 2, 5);
    const env = cableEnvelope(t, build1);
    const slack = routeSlack(d, route, env.height_mm / 2, { bend_static_mm: env.bend_static_mm });
    for (const v of [-2, -0.5, 0, 1, 2]) {
      const shape = wireShape(d, route, env, { j1: v }, slack);
      const c = shape.crossings[0]!;
      expect(c.points[0]!.distanceTo(shape.segments[0]!.line.at(-1)!.p)).toBeLessThan(1e-9);
      expect(c.points.at(-1)!.distanceTo(shape.segments[1]!.line[0]!.p)).toBeLessThan(1e-9);
      expect(c.length_mm).toBe(slack.crossings[0]!.free_length_mm);
    }
  });
});

describe('flat cables over a joint', () => {
  /** Two links on a floor-level hinge at x = 0; a ribbon along x. `axis`: the hinge axis. */
  function hinge(axis: [number, number, number]): { d: Design; route: Route } {
    const d: Design = {
      ...emptyDesign('h'),
      scene: {
        sources: [],
        links: [
          { id: 'A', name: 'A', meshes: [] },
          { id: 'B', name: 'B', meshes: [] },
        ],
        joints: [{ id: 'J', name: 'J', type: 'revolute', parent: 'A', child: 'B', origin: { p_mm: [0, 0, 0], q: [0, 0, 0, 1] }, axis, limit: { lower: -1, upper: 1 }, value: 0 }],
      },
    };
    const route: Route = {
      id: 'r',
      cable: 'c',
      crossings: [],
      segments: segmentsFromPoints([
        { link: 'A', p: [-40, 0, 0], n: UP },
        { link: 'A', p: [-10, 0, 0], n: UP },
        { link: 'B', p: [10, 0, 0], n: UP },
        { link: 'B', p: [40, 0, 0], n: UP },
      ]),
    };
    return { d, route };
  }

  it('warns when the hinge axis is not along the ribbon\'s width; not when it is', () => {
    const ffc = flatType('ffc', 10, 0.3);
    // Width axis of a ribbon on +z running along +x is y. A hinge about z twists it.
    const twisted = hinge([0, 0, 1]);
    const bad = evaluateWire(twisted.d, twisted.route, ffc, build1, {}, { skipFit: true }).crossings[0]!;
    expect(bad.twist_deg!).toBeGreaterThan(FLAT_TWIST_WARN_DEG);
    expect(bad.flatWarning).toMatch(/twist/);
    expect(bad.grade).not.toBe('ok');
    const fine = hinge([0, 1, 0]);
    const ok = evaluateWire(fine.d, fine.route, ffc, build1, {}, { skipFit: true }).crossings[0]!;
    expect(ok.twist_deg!).toBeLessThan(1);
    expect(ok.flatWarning).toBeUndefined();
  });
});

describe('Show tightest pose', () => {
  it('sets the previewed joint values to the tightest pose', () => {
    const { d, cableId } = armWire();
    s().replaceDesign(d);
    const route = routeOfCable(d, cableId)!;
    const ev = evaluateWire(d, route, roundType('w', 2, 5), build1, {}, { skipFit: true });
    const tight = ev.crossings[0]!.tightestValues;
    expect(Object.keys(tight)).toEqual(['j1']);
    showPose(tight);
    expect(s().jointValues['j1']).toBe(tight['j1']);
  });
});
