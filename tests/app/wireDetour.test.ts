/**
 * The loop's length knows the model is there: the slack model is told the way
 * round (the drape between the two holds at each sampled pose, detour.ts) and
 * cuts the loop at least that long.
 *
 * The scene (`scene(true)`): link A holds a block whose top is at z = 10; link B turns about
 * the z axis (range -180 to 180 degrees) and holds a cylinder of radius 30
 * standing on z = 0. One hold on the block at x = 60, one on the cylinder's
 * side at x = 30 (B's frame), both with their centre lines at the same height,
 * so at 180 degrees the way round lies in one level plane: from a point 60 mm
 * from the axis, tangent to the circle of radius R = 30 + r the centre line
 * keeps to, then round it to the far side:
 *   L = sqrt(60^2 - R^2) + R (pi - acos(R / 60)).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { BoxGeometry, CylinderGeometry } from 'three';
import { cableEnvelope, emptyDesign, routeSlack, type CableType, type Design, type Route } from '@core';
import { registry } from '../../src/app/scene/registry';
import '../../src/app/scene/bvh';
import { useApp } from '../../src/app/state/store';
import { crossingLoop, lengthReport, planSlack } from '../../src/app/wires/checks';
import { evaluateWire } from '../../src/app/wires/compare';
import { segmentsFromPoints, setCrossingSlack, type RoutePoint } from '../../src/app/wires/routeEdit';
import { clearSettled, rodOfEnvelope, wirePlan, worldContact } from '../../src/app/wires/settle';

const build = { count: 1, twisted: false, sleeve_wall_mm: 0 };
const t: CableType = { id: 'w', name: 'wire', family: 'hookup_wire', section: { shape: 'round', od_mm: 2 }, conductors: 1, min_bend_mm: { static: 5 }, flex: 'flexible', connectors: [], interfaces: [], confidence: 'generic' };
const env = cableEnvelope(t, build);
const r = env.height_mm / 2;

async function scene(withCylinder: boolean, range = Math.PI): Promise<Design> {
  const color = [0.6, 0.6, 0.6] as [number, number, number];
  registry.replace([
    { id: 'block', link: 'A', geometry: new BoxGeometry(35, 40, 10).translate(62.5, 0, 5), color },
    ...(withCylinder ? [{ id: 'cyl', link: 'B', geometry: new CylinderGeometry(30, 30, 50, 96).rotateX(Math.PI / 2).translate(0, 0, 25), color }] : []),
  ]);
  for (let i = 0; i < 300 && useApp.getState().bvhPending > 0; i++) await new Promise((res) => setTimeout(res, 10));
  const ref = (id: string) => ({ id, source: 's', node: id, tri_count: 12 });
  return {
    ...emptyDesign('d'),
    scene: {
      sources: [{ id: 's', kind: 'builtin', uri: 'builtin:test', mm_per_unit: 1 }],
      links: [
        { id: 'A', name: 'Base', meshes: [ref('block')] },
        { id: 'B', name: 'Turret', meshes: withCylinder ? [ref('cyl')] : [] },
      ],
      joints: [{ id: 'J', name: 'Yaw', type: 'revolute', parent: 'A', child: 'B', origin: { p_mm: [0, 0, 0], q: [0, 0, 0, 1] }, axis: [0, 0, 1], limit: { lower: -range, upper: range }, value: 0 }],
    },
  };
}

function route(): Route {
  const pts: RoutePoint[] = [
    { link: 'A', p: [60, 0, 10], n: [0, 0, 1], tie: true },
    // Same centre-line height as the block hold: 10 + r.
    { link: 'B', p: [30, 0, 10 + r], n: [1, 0, 0], tie: true },
  ];
  return { id: 'r', cable: 'c', crossings: [], segments: segmentsFromPoints(pts) };
}

beforeEach(() => clearSettled());

describe('the way round the model', () => {
  it('a turret turning half way round gets a loop at least as long as the wrapped path, and the loop there ends outside the cylinder', async () => {
    const d = await scene(true);
    const rt = route();
    const R = 30 + r;
    const wrapped = Math.sqrt(60 * 60 - R * R) + R * (Math.PI - Math.acos(R / 60));
    expect(wrapped).toBeCloseTo(116.9, 1);
    const plan = wirePlan(d, null, rt, rodOfEnvelope(env), 'solve');
    const slack = planSlack(d, plan, env, true);
    const c = slack.crossings[0]!;
    expect(c.detour_max_mm).toBeGreaterThan(wrapped * 0.995);
    expect(c.free_length_mm).toBeGreaterThanOrEqual(wrapped);
    expect(c.reaches).toBe(true);
    // At 180 degrees the settled loop goes round the cylinder, not through it.
    const loop = crossingLoop(d, plan, null, 0, c.free_length_mm, { J: Math.PI }, true).settled!;
    const contact = worldContact(d, null, { J: Math.PI });
    const clearance = Math.min(...loop.points.map((p) => contact(p, 50)?.distance_mm ?? 50));
    expect(clearance).toBeGreaterThan(r - 0.05);
    // The report says the model set the length, and where.
    const ev = evaluateWire(d, rt, t, build, {}, { solve: true, skipFit: true });
    expect(ev.crossings[0]!.detour?.setsLength).toBe(true);
    expect(ev.crossings[0]!.detour?.around).toContain('B');
    expect(Math.abs(Math.abs(ev.crossings[0]!.detour!.values.J!) - Math.PI)).toBeLessThan(1e-9);
  });

  it('from a point in free space (a port lead-out) the way round is measured from the surface under it', async () => {
    const d = await scene(true);
    // The block hold replaced by a free point 20 mm above the block's top (no surface normal), as a lead-out is.
    const rt: Route = {
      id: 'r',
      cable: 'c',
      crossings: [],
      segments: segmentsFromPoints([
        { link: 'A', p: [70, 0, 10 + r + 20], n: [0, 0, 0], tie: true },
        { link: 'A', p: [60, 0, 10 + r + 20], n: [0, 0, 0], tie: true },
        { link: 'B', p: [30, 0, 10 + r], n: [1, 0, 0], tie: true },
      ]),
    };
    const plan = wirePlan(d, null, rt, rodOfEnvelope(env), 'solve');
    const slack = planSlack(d, plan, env, true);
    const c = slack.crossings[0]!;
    const R = 30 + r;
    const wrapped = Math.sqrt(60 * 60 - R * R) + R * (Math.PI - Math.acos(R / 60));
    // Down 20 mm to the block, then round the cylinder as from a hold on the block: at least the wrapped path.
    expect(c.detour_max_mm).toBeGreaterThan(wrapped);
    expect(c.free_length_mm).toBeGreaterThan(wrapped);
    const ev = evaluateWire(d, rt, t, build, {}, { solve: true, skipFit: true });
    expect(ev.crossings[0]!.detourFailed).toEqual([]);
    const loop = crossingLoop(d, plan, null, 0, c.free_length_mm, { J: Math.PI }, true).settled!;
    const contact = worldContact(d, null, { J: Math.PI });
    expect(Math.min(...loop.points.map((p) => contact(p, 50)?.distance_mm ?? 50))).toBeGreaterThan(r - 0.05);
  });

  it('a stated slack shorter than the way round does not reach, and says by how much', async () => {
    const d = await scene(true);
    const design = { ...d, routes: [route()] };
    const stated = setCrossingSlack(design, 'r', 0, 5);
    const rt = stated.routes[0]!;
    const ev = evaluateWire(stated, rt, t, build, {}, { solve: true, skipFit: true });
    const c = ev.crossings[0]!;
    expect(c.basis).toBe('user');
    expect(c.reaches).toBe(false);
    expect(c.grade).toBe('fail');
    expect(c.short!.round_mm).toBeGreaterThan(c.free_length_mm);
    expect(c.short!.by_mm).toBeCloseTo(c.short!.round_mm! - c.free_length_mm, 6);
  });

  it('with nothing in the way the length is what it was without the way round', async () => {
    // The turret turns only 30 degrees each way: the straight line between the holds stays clear.
    const d = await scene(true, Math.PI / 6);
    const rt = route();
    const plan = wirePlan(d, null, rt, rodOfEnvelope(env), 'solve');
    const withDetour = lengthReport(d, rt, env, 10, plan, true).slack.crossings[0]!;
    const without = routeSlack(d, plan.derived, r, { bend_static_mm: env.bend_static_mm }).crossings[0]!;
    expect(withDetour.free_length_mm).toBeCloseTo(without.free_length_mm, 9);
  });
});
