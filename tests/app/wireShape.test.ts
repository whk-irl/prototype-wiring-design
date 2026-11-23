/**
 * The wire's real shape: a stiff wire laid snug on a body (settled from the
 * drape), and the free loop over a joint (settled in cut mode, with gravity and
 * contact). Expected values are worked out by hand or from the core's analytic
 * cases (stiffness.ts: a wire pulled round a sharp edge through a turn theta
 * bends to lambda / (2 sin(theta / 4)) with its ties far away).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { BoxGeometry } from 'three';
import { emptyDesign, polylineLength, relaxSpan, segmentCentreLine, type CableType, type Design, type Route, type Vec3 } from '@core';
import { registry } from '../../src/app/scene/registry';
import '../../src/app/scene/bvh';
import { useApp } from '../../src/app/state/store';
import { bendReport, segmentLine } from '../../src/app/wires/checks';
import { evaluateWire } from '../../src/app/wires/compare';
import { drapePoints } from '../../src/app/wires/drape';
import { segmentsFromPoints, type RoutePoint } from '../../src/app/wires/routeEdit';
import { clearSettled, crossingSettle, rodOfEnvelope, segmentPins, segmentSettle, wirePlan, type RodCable } from '../../src/app/wires/settle';
import { cableEnvelope } from '@core';

const s = () => useApp.getState();
const UP: Vec3 = [0, 0, 1];
const build = { count: 1, twisted: false, sleeve_wall_mm: 0 };

function wire(od: number, bend: number, extra: Partial<CableType> = {}): CableType {
  return { id: `w${od}`, name: 'wire', family: 'hookup_wire', section: { shape: 'round', od_mm: od }, conductors: 1, min_bend_mm: { static: bend }, flex: 'flexible', connectors: [], interfaces: [], confidence: 'generic', ...extra };
}

async function waitForBvh(): Promise<void> {
  for (let i = 0; i < 300 && s().bvhPending > 0; i++) await new Promise((r) => setTimeout(r, 10));
}

/** A design whose link L holds the given boxes (min, max corners). */
async function boxes(list: Array<[Vec3, Vec3]>): Promise<Design> {
  registry.replace(
    list.map(([a, b], i) => ({
      id: `box${i}`,
      link: 'L',
      geometry: new BoxGeometry(b[0] - a[0], b[1] - a[1], b[2] - a[2]).translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2),
      color: [0.6, 0.6, 0.6] as [number, number, number],
    })),
  );
  await waitForBvh();
  return {
    ...emptyDesign('t'),
    scene: {
      sources: [{ id: 's', kind: 'builtin', uri: 'builtin:test', mm_per_unit: 1 }],
      links: [{ id: 'L', name: 'L', meshes: list.map((_, i) => ({ id: `box${i}`, source: 's', node: `box${i}`, tri_count: 12 })) }],
      joints: [],
    },
  };
}

function routeOf(points: RoutePoint[]): Route {
  return { id: 'r', cable: 'c', crossings: [], segments: segmentsFromPoints(points) };
}

const p = (x: number, y: number, z: number, n: Vec3 = UP): RoutePoint => ({ link: 'L', p: [x, y, z], n });

beforeEach(() => {
  clearSettled();
});

describe('a wire laid on a body', () => {
  it('over an outside edge, placed far from it, rounds the edge at no less than its limit (no tight corner)', async () => {
    // A 100 mm cube, the wire from the top face 30 mm short of the +x edge down the +x face 30 mm below it.
    const d = await boxes([[[-50, -50, -50], [50, 50, 50]]]);
    const t = wire(1.56, 12.5);
    const env = cableEnvelope(t, build);
    const pts = drapePoints(d, [p(20, 0, 50), p(50, 0, 20, [1, 0, 0])], env.height_mm / 2);
    const route = routeOf(pts);
    // The drape glued to the surface wraps the edge at the wire's own radius: the old check called that a corner.
    expect(bendReport(d, route, env).tight.length).toBeGreaterThan(0);
    const ev = evaluateWire(d, route, t, build, {});
    expect(ev.settle.approximate).toEqual([]);
    expect(ev.bend.tightest_mm).toBeGreaterThanOrEqual(12.5);
    expect(ev.bend.grade).toBe('ok');
    expect(ev.bend.tight).toEqual([]);
  });

  it('the settled length is the drape plus what rounding the edge costs (the glued drape is the shortest path round it)', async () => {
    const d = await boxes([[[-50, -50, -50], [50, 50, 50]]]);
    const t = wire(1.56, 12.5);
    const env = cableEnvelope(t, build);
    const route = routeOf(drapePoints(d, [p(20, 0, 50), p(50, 0, 20, [1, 0, 0])], env.height_mm / 2));
    const draped = polylineLength(segmentCentreLine(route.segments[0]!, env.height_mm / 2));
    const st = segmentSettle(d, null, route, 0, rodOfEnvelope(env), true)!;
    expect(st.ok).toBe(true);
    // Rounding a 90 degree edge at a radius R instead of the wire's own r costs at most (2 - pi/2)(R - r) for a
    // circular arc; the wire's curve is gentler away from the edge, so it costs less. R is at most
    // lambda / (2 sin 22.5 deg) = 20 / 0.765 = 26.1 mm (lambda = 1.6 x 12.5 mm).
    const len = st.ok ? st.line.length_mm : NaN;
    expect(len).toBeGreaterThan(draped);
    expect(len - draped).toBeLessThan((2 - Math.PI / 2) * (26.2 - 0.78));
  });

  it('across an inside corner it bridges the corner', async () => {
    // A floor (top at z = 0) and a wall (its face at x = 40).
    const d = await boxes([
      [[-50, -50, -20], [60, 50, 0]],
      [[40, -50, 0], [60, 50, 60]],
    ]);
    const t = wire(2, 10);
    const env = cableEnvelope(t, build);
    const route = routeOf([p(0, 0, 0), p(40, 0, 30, [-1, 0, 0])]);
    const st = segmentSettle(d, null, route, 0, rodOfEnvelope(env), true)!;
    expect(st.ok).toBe(true);
    // The corner line is x = 40, z = 0: the wire stays well off it (a glued wire would run into it).
    const off = Math.min(...(st.ok ? st.line.points : []).map((q) => Math.hypot(q[0] - 40, q[2] - 0)));
    expect(off).toBeGreaterThan(5);
  });

  it('two placed points that force a turn tighter than the limit are still reported', async () => {
    const d = await boxes([[[-50, -50, -50], [50, 50, 50]]]);
    const t = wire(1.56, 12.5);
    // Held 2 mm each side of the edge: the wire must turn 90 degrees within about 3 mm.
    const route = routeOf([p(48, 0, 50), p(50, 0, 48, [1, 0, 0])]);
    const ev = evaluateWire(d, route, t, build, {});
    expect(ev.bend.tightest_mm).toBeLessThan(12.5);
    expect(ev.bend.grade).not.toBe('ok');
  });

  it('a flat cable keeps its face to the surface', async () => {
    const d = await boxes([[[-100, -50, -20], [100, 50, 0]]]);
    const flat: CableType = { id: 'f', name: 'ffc', family: 'ffc', section: { shape: 'flat', width_mm: 10, thickness_mm: 0.3 }, conductors: 10, pitch_mm: 1, min_bend_mm: { static: 2.4 }, flex: 'flexible', connectors: [], interfaces: [], confidence: 'generic' };
    const env = cableEnvelope(flat, build);
    const route = routeOf([p(-60, 0, 0), p(0, 0, 0), p(60, 0, 0)]);
    const st = segmentSettle(d, null, route, 0, rodOfEnvelope(env), true)!;
    expect(st.ok).toBe(true);
    if (st.ok) for (const n of st.line.normals) expect(n[2]).toBeGreaterThan(0.99);
  });

  it('the same input gives the same shape', async () => {
    const d = await boxes([[[-50, -50, -50], [50, 50, 50]]]);
    const env = cableEnvelope(wire(1.56, 12.5), build);
    const route = routeOf(drapePoints(d, [p(20, 0, 50), p(50, 0, 20, [1, 0, 0])], env.height_mm / 2));
    const a = segmentSettle(d, null, route, 0, rodOfEnvelope(env), true)!;
    clearSettled();
    const b = segmentSettle(d, null, route, 0, rodOfEnvelope(env), true)!;
    expect(a.ok && b.ok && a.line.points).toEqual(b.ok && b.line.points);
  });

  it('holds the placed points and lets the drape contacts go', () => {
    // On a flat face a sideways turn is a placed point; bending over an edge (the turn points into the surface) is not.
    const pins = segmentPins(
      [
        [0, 0, 1],
        [10, 0, 1],
        [10, 10, 1],
        [20, 10, 1],
      ],
      [UP, UP, UP, UP],
    );
    expect(pins).toEqual([0, 1, 2, 3]);
    const overEdge = segmentPins(
      [
        [0, 0, 51],
        [50.7, 0, 50.7],
        [51, 0, 0],
      ],
      [UP, [Math.SQRT1_2, 0, Math.SQRT1_2], [1, 0, 0]],
    );
    expect(overEdge).toEqual([0, 2]);
  });
});

describe('the free loop over a joint', () => {
  const rod = (sag?: number): RodCable => ({ radius_mm: 1, lay_length_mm: 16, flat: false, ...(sag !== undefined ? { sag_length_mm: sag } : {}) });

  it('with gravity, a slack loop between level ends bows downward', async () => {
    const d = await boxes([]);
    const ends = { a: [0, 0, 0] as Vec3, b: [100, 0, 0] as Vec3, ta: [1, 0, 0] as Vec3, tb: [1, 0, 0] as Vec3 };
    const start = relaxSpan(ends, 130).points;
    const loop = crossingSettle(d, null, ends, start, 130, rod(20), {})!;
    expect(loop.converged).toBe(true);
    // The lowest point is well below the ends, and the middle hangs down.
    expect(Math.min(...loop.points.map((q) => q[2]))).toBeLessThan(-20);
    const mid = loop.points[Math.floor(loop.points.length / 2)]!;
    expect(mid[2]).toBeLessThan(-20);
    expect(loop.length_mm).toBeCloseTo(130, 1);
  });

  it('next to a block, it ends outside it', async () => {
    // A block under the middle of the span, its top 15 mm below the ends.
    const d = await boxes([[[30, -40, -80], [70, 40, -15]]]);
    const ends = { a: [0, 0, 0] as Vec3, b: [100, 0, 0] as Vec3, ta: [1, 0, 0] as Vec3, tb: [1, 0, 0] as Vec3 };
    const start = relaxSpan(ends, 150).points;
    const loop = crossingSettle(d, null, ends, start, 150, rod(20), {})!;
    // Nothing of the centre line is nearer the block than the wire's radius (within the contact tolerance).
    const sdf = (q: Vec3) => {
      const dx = Math.max(30 - q[0], 0, q[0] - 70);
      const dy = Math.max(-40 - q[1], 0, q[1] - 40);
      const dz = Math.max(-80 - q[2], 0, q[2] + 15);
      const out = Math.hypot(dx, dy, dz);
      return out > 0 ? out : -Math.min(q[0] - 30, 70 - q[0], q[1] + 40, 40 - q[1], q[2] + 80, -15 - q[2]);
    };
    expect(Math.min(...loop.points.map(sdf))).toBeGreaterThan(1 - 0.01);
    expect(loop.worst_penetration_mm).toBeLessThan(0.01);
    // It rests on the block's top.
    expect(loop.touching.some(Boolean)).toBe(true);
  });
});

describe('a shape that does not settle', () => {
  it('is drawn as the drape and nothing passes on it', async () => {
    const d = await boxes([[[-50, -50, -50], [50, 50, 50]]]);
    const env = cableEnvelope(wire(1.56, 12.5), build);
    const route = routeOf(drapePoints(d, [p(20, 0, 50), p(50, 0, 20, [1, 0, 0])], env.height_mm / 2));
    // A fake result: the drape kept, and why.
    const settles = [{ ok: false as const, reason: 'the stiff-wire shape did not settle' }];
    const drawn = segmentLine(route.segments[0]!, env, settles[0]);
    expect(drawn.length).toBeGreaterThanOrEqual(route.segments[0]!.points_mm.length);
    // The bend is judged on the drape (its glued corner is reported), never a clean pass.
    const plan = wirePlan(d, null, route, rodOfEnvelope(env), 'none');
    expect(bendReport(d, route, env, { ...plan, settles }).grade).not.toBe('ok');
  });
});
