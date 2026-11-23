// The optional detour callback of crossingSlack and routeSlack, route segment ties, and a rod that starts inside solid.
import { describe, expect, it } from 'vitest';
import { crossingSlack, designJsonSchema, DesignSchema, parseDesign, routeSlack, settleRod, validateDesign, type CrossingEnds, type Design, type RodContact, type Route, type Vec3 } from '@core';
import { fullDesign, readText } from './helpers';

const Q: [number, number, number, number] = [0, 0, 0, 1];
const UP: Vec3 = [0, 1, 0];
const chordOf = (e: CrossingEnds) => Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1], e.b[2] - e.a[2]);
const same = (a: unknown, b: unknown) => expect(JSON.parse(JSON.stringify(a))).toEqual(JSON.parse(JSON.stringify(b)));

/** Two links, one revolute joint about z at the origin (limit +-90 degrees), a facing segment on each: chord 60 at pose 0. */
function hinge(): { design: Design; route: Route } {
  const d = DesignSchema.parse({ schema: 1 });
  d.scene.links.push({ id: 'base', name: 'base', meshes: [] }, { id: 'arm', name: 'arm', meshes: [] });
  d.scene.joints.push({ id: 'j', name: 'j', type: 'revolute', parent: 'base', child: 'arm', origin: { p_mm: [0, 0, 0], q: Q }, axis: [0, 0, 1], limit: { lower: -Math.PI / 2, upper: Math.PI / 2 }, value: 0 });
  const route: Route = {
    id: 'r',
    cable: 'c',
    segments: [
      { link: 'base', points_mm: [[-50, 0, 0], [-30, 0, 0]], normals: [UP, UP] },
      { link: 'arm', points_mm: [[30, 0, 0], [50, 0, 0]], normals: [UP, UP] },
    ],
    crossings: [],
  };
  d.routes.push(route);
  return { design: d, route };
}

describe('detour_mm in crossingSlack', () => {
  const { design, route } = hinge();
  const base = crossingSlack(design, route, 0, 0, { bend_limit_mm: 5 });

  it('without a callback, or with one that says nothing, the result is the same', () => {
    expect(base.detour_max_mm).toBeUndefined();
    for (const p of base.poses) expect(p.detour_mm).toBeUndefined();
    same(crossingSlack(design, route, 0, 0, { bend_limit_mm: 5, detour_mm: () => undefined }), base);
  });

  it('a detour longer than every straight distance sets the free length to detour x 1.02', () => {
    // chords are at most 60 (pose 0); a way round of 100 mm at every pose: 100 x 1.02 = 102
    const s = crossingSlack(design, route, 0, 0, { bend_limit_mm: 5, detour_mm: () => 100 });
    expect(s.basis).toBe('auto');
    expect(s.free_length_mm).toBeCloseTo(102, 9);
    expect(s.slack_mm).toBeCloseTo(102 - 60, 9);
    expect(s.detour_max_mm).toBe(100);
    for (const p of s.poses) expect(p.detour_mm).toBe(100);
    expect(s.reaches).toBe(true);
    for (const p of s.poses) expect(p.short_by_mm).toBe(0);
  });

  it('the longest of the detours sets the length, and each pose reports its own', () => {
    // 80 at pose 0, 70 elsewhere: the longest is 80 -> 81.6
    const s = crossingSlack(design, route, 0, 0, { bend_limit_mm: 5, detour_mm: (v) => (Math.abs(v.j ?? 0) < 1e-9 ? 80 : 70) });
    expect(s.free_length_mm).toBeCloseTo(81.6, 9);
    expect(s.detour_max_mm).toBe(80);
    for (const p of s.poses) expect(p.detour_mm).toBe(Math.abs(p.values.j ?? 0) < 1e-9 ? 80 : 70);
  });

  it('is given the values and the ends of each solved pose', () => {
    const seen: Array<{ j: number | undefined; chord: number }> = [];
    crossingSlack(design, route, 0, 0, {
      bend_limit_mm: 5,
      detour_mm: (v, e) => {
        seen.push({ j: v.j, chord: chordOf(e) });
        return undefined;
      },
    });
    expect(seen.length).toBe(base.poses.length);
    for (const p of base.poses) expect(seen.some((x) => x.j === p.values.j && Math.abs(x.chord - p.chord_mm) < 1e-9)).toBe(true);
  });

  it('a detour at or below the straight distance is ignored', () => {
    for (const f of [(c: number) => c, (c: number) => c * 0.5, () => 10]) {
      same(crossingSlack(design, route, 0, 0, { bend_limit_mm: 5, detour_mm: (_v, e) => f(chordOf(e)) }), base);
    }
  });

  it.each([NaN, Infinity, -Infinity])('a detour of %s is ignored', (bad) => {
    same(crossingSlack(design, route, 0, 0, { bend_limit_mm: 5, detour_mm: () => bad }), base);
  });

  it('with a stated slack shorter than the detour, a pose is short by the difference and the cable does not reach', () => {
    // slack 0: free length = longest chord = 60; detour 100 at every pose -> short by 40
    const zero = crossingSlack(design, route, 0, 0, { bend_limit_mm: 5, slack_mm: 0, detour_mm: () => 100 });
    expect(zero.basis).toBe('user');
    expect(zero.free_length_mm).toBeCloseTo(60, 9);
    expect(zero.reaches).toBe(false);
    expect(zero.bend_ok).toBe(false);
    for (const p of zero.poses) expect(p.short_by_mm).toBeCloseTo(40, 9);
    // slack 10: free 70 -> short by 30
    const ten = crossingSlack(design, route, 0, 0, { bend_limit_mm: 5, slack_mm: 10, detour_mm: () => 100 });
    expect(ten.free_length_mm).toBeCloseTo(70, 9);
    for (const p of ten.poses) expect(p.short_by_mm).toBeCloseTo(30, 9);
    // slack 45: free 105 -> reaches
    expect(crossingSlack(design, route, 0, 0, { bend_limit_mm: 5, slack_mm: 45, detour_mm: () => 100 }).reaches).toBe(true);
  });
});

describe('detour_mm in routeSlack', () => {
  // base --j1 (revolute, +-90 deg)--> arm --j2 (fixed, 80 mm along x)--> tip; one segment on each link
  const d = DesignSchema.parse({ schema: 1 });
  d.scene.links.push({ id: 'base', name: 'b', meshes: [] }, { id: 'arm', name: 'a', meshes: [] }, { id: 'tip', name: 't', meshes: [] });
  d.scene.joints.push(
    { id: 'j1', name: 'j1', type: 'revolute', parent: 'base', child: 'arm', origin: { p_mm: [0, 0, 0], q: Q }, axis: [0, 0, 1], limit: { lower: -Math.PI / 2, upper: Math.PI / 2 }, value: 0 },
    { id: 'j2', name: 'j2', type: 'fixed', parent: 'arm', child: 'tip', origin: { p_mm: [80, 0, 0], q: Q }, axis: [0, 0, 0], value: 0 },
  );
  const route: Route = {
    id: 'r',
    cable: 'c',
    segments: [
      { link: 'base', points_mm: [[-50, 0, 0], [-30, 0, 0]], normals: [UP, UP] },
      { link: 'arm', points_mm: [[30, 0, 0], [50, 0, 0]], normals: [UP, UP] },
      { link: 'tip', points_mm: [[10, 0, 0], [30, 0, 0]], normals: [UP, UP] },
    ],
    crossings: [],
  };
  d.routes.push(route);
  const plain = routeSlack(d, route, 0, { bend_static_mm: 5 });

  it('is given the index of the segment each crossing leaves from', () => {
    const calls = new Set<number>();
    routeSlack(d, route, 0, {
      bend_static_mm: 5,
      detour_mm: (i) => {
        calls.add(i);
        return undefined;
      },
    });
    expect([...calls].sort()).toEqual([0, 1]);
  });

  it('applies a detour to the crossing it was given for, and only that one', () => {
    const r = routeSlack(d, route, 0, { bend_static_mm: 5, detour_mm: (i) => (i === 0 ? 100 : undefined) });
    // crossing 0: 100 x 1.02 = 102 ; crossing 1 (fixed joint, chord 40) is as before
    expect(r.crossings[0]!.free_length_mm).toBeCloseTo(102, 9);
    expect(r.crossings[0]!.detour_max_mm).toBe(100);
    same(r.crossings[1], plain.crossings[1]);
    expect(r.length_mm).toBeCloseTo(plain.length_mm - plain.crossings[0]!.free_length_mm + 102, 9);
  });

  it('the other way round', () => {
    const r = routeSlack(d, route, 0, { bend_static_mm: 5, detour_mm: (i) => (i === 1 ? 70 : undefined) });
    expect(r.crossings[1]!.free_length_mm).toBeCloseTo(71.4, 9); // 70 x 1.02
    same(r.crossings[0], plain.crossings[0]);
  });
});

describe('route segment ties', () => {
  const withTies = (ties?: boolean[]) => {
    const d = fullDesign();
    if (ties) d.routes[0]!.segments[0]!.ties = ties;
    return d;
  };

  it('absent is fine', () => {
    expect(validateDesign(withTies()).filter((i) => i.severity === 'error')).toEqual([]);
    expect(withTies().routes[0]!.segments[0]!.ties).toBeUndefined();
  });

  it('round-trips through JSON and parseDesign', () => {
    const d = withTies([true, false]);
    const r = parseDesign(JSON.parse(JSON.stringify(d)));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.design.routes[0]!.segments[0]!.ties).toEqual([true, false]);
  });

  it.each([[[true]], [[true, false, true]], [[]]])('a wrong length %j is an error at routes[0].segments[0].ties', (ties) => {
    const e = validateDesign(withTies(ties)).filter((i) => i.severity === 'error');
    expect(e.map((i) => i.path)).toEqual(['routes[0].segments[0].ties']);
    expect(e[0]!.message).toMatch(/entries for 2 points/);
  });

  it('must be booleans', () => {
    const raw = JSON.parse(JSON.stringify(withTies([true, false])));
    raw.routes[0].segments[0].ties = [1, 0];
    expect(DesignSchema.safeParse(raw).success).toBe(false);
  });

  it('the generated JSON schema includes it, and so does the committed file', () => {
    expect(JSON.stringify(designJsonSchema())).toContain('"ties"');
    expect(readText('schema/design.schema.json')).toContain('"ties"');
  });
});

describe('a cut loop that starts inside a sphere', () => {
  const Rs = 10;
  const r = 0.5;
  const sphere: RodContact = (p) => {
    const rho = Math.hypot(p[0], p[1], p[2]);
    return { distance_mm: rho - Rs, normal: rho < 1e-12 ? [1, 0, 0] : [p[0] / rho, p[1] / rho, p[2] / rho] };
  };

  it('ends clear of it, with the exact length, converged', () => {
    // pins 0.6 mm outside the surface (0.1 mm clear of the wire radius) and 2 mm apart on the sphere of radius 10.6:
    // central angle 2 asin(1 / 10.6) = 0.18903 rad
    const R = Rs + 0.6;
    const phi = 2 * Math.asin(1 / R);
    const a: Vec3 = [R, 0, 0];
    const b: Vec3 = [R * Math.cos(phi), R * Math.sin(phi), 0];
    // the start is a spike straight through the middle of the ball
    const path: Vec3[] = [a, [0, 0, 0], b];
    const s = settleRod({ path, pins: [{ index: 0 }, { index: 2 }], radius_mm: r, mode: { kind: 'cut', lengths_mm: [60] }, contact: sphere });
    expect(s.converged).toBe(true);
    expect(s.reaches).toBe(true);
    expect(Math.abs(s.length_mm - 60) / 60).toBeLessThan(1e-6);
    for (const p of s.points) expect(Math.hypot(p[0], p[1], p[2]) - Rs).toBeGreaterThanOrEqual(r - 2e-3);
    expect(s.points[s.pin_indices[0]!]).toEqual(a);
    expect(s.points[s.pin_indices[1]!]).toEqual(b);
  }, 20_000);
});
