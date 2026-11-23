// What the crossing and slack functions mean, on small hand-built hinge designs.
import { describe, expect, it } from 'vitest';
import {
  crossingEnds,
  crossingSlack,
  DesignSchema,
  flatDemand,
  naturalLength,
  relaxSpan,
  routeLength,
  routeSlack,
  SLACK_ALLOWANCE,
  statedSlack,
  type CrossingEnds,
  type Design,
  type Route,
  type Vec3,
} from '@core';

const Q: [number, number, number, number] = [0, 0, 0, 1];
const UP: Vec3 = [0, 1, 0];

interface HingeOptions {
  ra?: number;
  rb?: number;
  h?: number;
  type?: 'revolute' | 'fixed' | 'continuous';
  axis?: Vec3;
  limit?: { lower: number; upper: number };
  normals?: boolean;
  armPoints?: Vec3[];
  crossings?: Route['crossings'];
}

/** Two links joined by one joint at the origin; a segment of two points on each. */
function hinge(o: HingeOptions = {}): { design: Design; route: Route } {
  const { ra = 30, rb = 30, h = 0, type = 'revolute', axis = [0, 0, 1], limit = { lower: -Math.PI / 2, upper: Math.PI / 2 }, normals = true } = o;
  const d = DesignSchema.parse({ schema: 1 });
  d.scene.links.push({ id: 'base', name: 'base', meshes: [] }, { id: 'arm', name: 'arm', meshes: [] });
  d.scene.joints.push({
    id: 'j',
    name: 'j',
    type,
    parent: 'base',
    child: 'arm',
    origin: { p_mm: [0, 0, 0], q: Q },
    axis: type === 'fixed' ? [0, 0, 0] : axis,
    ...(type === 'revolute' ? { limit } : {}),
    value: 0,
  });
  const base: Vec3[] = [
    [-ra - 20, h, 0],
    [-ra, h, 0],
  ];
  const arm: Vec3[] = o.armPoints ?? [
    [rb, h, 0],
    [rb + 20, h, 0],
  ];
  const route: Route = {
    id: 'r',
    cable: 'c',
    segments: [
      { link: 'base', points_mm: base, ...(normals ? { normals: base.map(() => UP) } : {}) },
      { link: 'arm', points_mm: arm, ...(normals ? { normals: arm.map(() => UP) } : {}) },
    ],
    crossings: o.crossings ?? [],
  };
  d.routes.push(route);
  return { design: d, route };
}

/** A chain of n revolute joints about z from link c0 to link cn; one segment on c0, one on cn. */
function chain(n: number, types: Array<'revolute' | 'fixed'> = []): { design: Design; route: Route } {
  const d = DesignSchema.parse({ schema: 1 });
  for (let i = 0; i <= n; i++) d.scene.links.push({ id: `c${i}`, name: `c${i}`, meshes: [] });
  for (let i = 1; i <= n; i++) {
    const type = types[i - 1] ?? 'revolute';
    d.scene.joints.push({
      id: `j${i}`,
      name: `j${i}`,
      type,
      parent: `c${i - 1}`,
      child: `c${i}`,
      origin: { p_mm: i === 1 ? [0, 0, 0] : [20, 0, 0], q: Q },
      axis: type === 'fixed' ? [0, 0, 0] : [0, 0, 1],
      ...(type === 'revolute' ? { limit: { lower: -0.5, upper: 0.5 } } : {}),
      value: 0,
    });
  }
  const route: Route = {
    id: 'r',
    cable: 'c',
    segments: [
      { link: 'c0', points_mm: [[-60, 0, 0], [-30, 0, 0]], normals: [UP, UP] },
      { link: `c${n}`, points_mm: [[30, 0, 0], [60, 0, 0]], normals: [UP, UP] },
    ],
    crossings: [],
  };
  d.routes.push(route);
  return { design: d, route };
}

const close = (got: readonly number[], want: readonly number[], tol = 1e-9) => got.forEach((g, i) => expect(Math.abs(g - want[i]!), `${got} vs ${want}`).toBeLessThan(tol));

describe('crossingEnds', () => {
  it('gives positions, directions and normals at pose 0', () => {
    const { design, route } = hinge({ ra: 30, rb: 40, h: 5 });
    const e = crossingEnds(design, route, 0, 0);
    close(e.a, [-30, 5, 0]);
    close(e.b, [40, 5, 0]);
    close(e.ta!, [1, 0, 0]);
    close(e.tb!, [1, 0, 0]);
    close(e.na!, UP);
    close(e.nb!, UP);
    close(e.bias!, [0, 2, 0]);
  });

  it('turns the far end, its direction and its normal with the joint, and not the near end', () => {
    const { design, route } = hinge({ ra: 30, rb: 40, h: 5 });
    const th = 0.6;
    const e = crossingEnds(design, route, 0, 0, { j: th });
    const c = Math.cos(th);
    const s = Math.sin(th);
    close(e.a, [-30, 5, 0]);
    close(e.ta!, [1, 0, 0]);
    close(e.na!, UP);
    close(e.b, [40 * c - 5 * s, 40 * s + 5 * c, 0]);
    close(e.tb!, [c, s, 0]);
    close(e.nb!, [-s, c, 0]);
  });

  it('lifts surface points along their normals', () => {
    const { design, route } = hinge({ ra: 30, rb: 40, h: 0 });
    const e = crossingEnds(design, route, 2.5, 0);
    close(e.a, [-30, 2.5, 0]);
    close(e.b, [40, 2.5, 0]);
  });

  it('a one-point segment gives no direction at that end', () => {
    const { design, route } = hinge({ armPoints: [[30, 0, 0]] });
    const e = crossingEnds(design, route, 0, 0);
    expect(e.tb).toBeUndefined();
    expect(e.ta).toBeDefined();
  });

  it('repeated points give no direction, and the next distinct point is used when there is one', () => {
    const { design, route } = hinge({ armPoints: [[30, 0, 0], [30, 0, 0], [50, 0, 0]] });
    expect(crossingEnds(design, route, 0, 0).tb).toBeDefined();
    const same = hinge({ armPoints: [[30, 0, 0], [30, 0, 0]] });
    expect(crossingEnds(same.design, same.route, 0, 0).tb).toBeUndefined();
  });

  it('zero normals give no na, nb or bias; absent normals likewise', () => {
    const zero = hinge();
    for (const s of zero.route.segments) s.normals = s.points_mm.map(() => [0, 0, 0] as Vec3);
    const e = crossingEnds(zero.design, zero.route, 0, 0);
    expect(e.na).toBeUndefined();
    expect(e.nb).toBeUndefined();
    expect(e.bias).toBeUndefined();
    const none = hinge({ normals: false });
    const f = crossingEnds(none.design, none.route, 0, 0);
    expect(f.na).toBeUndefined();
    expect(f.bias).toBeUndefined();
  });

  it('throws for a crossing that does not exist', () => {
    const { design, route } = hinge();
    expect(() => crossingEnds(design, route, 0, 1)).toThrow(RangeError);
    expect(() => crossingEnds(design, route, 0, -1)).toThrow(RangeError);
  });
});

describe('naturalLength', () => {
  it('is the distance for ends that face each other', () => {
    expect(naturalLength({ a: [0, 0, 0], ta: [1, 0, 0], b: [100, 0, 0], tb: [1, 0, 0] })).toBeCloseTo(100, 6);
  });

  it('is a quarter circle for ends at a right angle', () => {
    const R = 40;
    const L = naturalLength({ a: [0, 0, 0], ta: [1, 0, 0], b: [R, R, 0], tb: [0, 1, 0] });
    expect(Math.abs(L / ((Math.PI / 2) * R) - 1)).toBeLessThan(0.02);
  });

  it('is zero for coincident ends', () => {
    expect(naturalLength({ a: [3, 4, 5], b: [3, 4, 5], ta: [1, 0, 0], tb: [0, 1, 0] })).toBe(0);
    expect(naturalLength({ a: [3, 4, 5], b: [3, 4, 5] })).toBe(0);
  });

  it('is at least the distance and at most 1.6 times it', () => {
    const cases: Array<[CrossingEnds, number]> = [
      [{ a: [0, 0, 0], ta: [1, 0, 0], b: [50, 20, 0], tb: [0, 1, 0] }, Math.hypot(50, 20)],
      [{ a: [0, 0, 0], ta: [1, 0, 0], b: [50, 0, 0], tb: [-1, 0, 0] }, 50],
      [{ a: [0, 0, 0], ta: [0, 1, 0], b: [50, 0, 0], tb: [0, -1, 0] }, 50],
    ];
    for (const [ends, chord] of cases) {
      const L = naturalLength(ends);
      expect(L).toBeGreaterThanOrEqual(chord - 1e-9);
      expect(L).toBeLessThanOrEqual(chord * 1.6 + 1e-9);
    }
  });
});

describe('crossingSlack, automatic length', () => {
  const { design, route } = hinge({ ra: 30, rb: 30 });
  const slack = crossingSlack(design, route, 0, 0, { bend_limit_mm: 5 });

  it('reaches at every pose with a free length of at least the longest chord', () => {
    expect(slack.basis).toBe('auto');
    expect(slack.free_length_mm).toBeGreaterThanOrEqual(slack.chord_max_mm);
    expect(slack.slack_mm).toBeCloseTo(slack.free_length_mm - slack.chord_max_mm, 9);
    expect(slack.reaches).toBe(true);
    for (const p of slack.poses) expect(p.short_by_mm).toBe(0);
    expect(slack.joints).toEqual(['j']);
    expect(slack.unsampled).toEqual([]);
    expect(slack.from_link).toBe('base');
    expect(slack.to_link).toBe('arm');
  });

  it('is the largest natural length over the poses (times 1 + SLACK_ALLOWANCE), by an independent loop', () => {
    let want = 0;
    for (const p of slack.poses) {
      const ends = crossingEnds(design, route, 0, 0, p.values);
      want = Math.max(want, Math.hypot(ends.b[0] - ends.a[0], ends.b[1] - ends.a[1], ends.b[2] - ends.a[2]), naturalLength(ends, { bend_limit_mm: 5 }));
    }
    expect(Math.abs(slack.free_length_mm / (want * (1 + SLACK_ALLOWANCE)) - 1)).toBeLessThan(0.01);
  });

  it('chord_min and chord_max come from a finer sweep than routeLength, so they bound its figures', () => {
    const len = routeLength(design, route, 0).crossings[0]!;
    expect(slack.chord_min_mm).toBeLessThanOrEqual(len.min_mm + 1e-9);
    expect(slack.chord_max_mm).toBeGreaterThanOrEqual(len.max_mm - 1e-9);
    // symmetric hinge: the longest distance is on the grid, so the two agree
    expect(slack.chord_max_mm).toBeCloseTo(len.max_mm, 9);
    expect(slack.poses).toHaveLength(9);
  });

  it('samples 9 poses for one joint, 25 for two, 27 for three, and flags a fourth as unsampled', () => {
    const results = [1, 2, 3, 4].map((n) => {
      const c = chain(n);
      return crossingSlack(c.design, c.route, 0, 0, { bend_limit_mm: 5 });
    });
    expect(results.map((c) => c.poses.length)).toEqual([9, 25, 27, 27]);
    expect(results.map((c) => c.unsampled)).toEqual([[], [], [], ['j4']]);
    expect(results[3]!.joints).toEqual(['j1', 'j2', 'j3', 'j4']);
  });

  it('a crossing with no moving joint has exactly one pose', () => {
    const fixed = hinge({ type: 'fixed' });
    const s = crossingSlack(fixed.design, fixed.route, 0, 0, { bend_limit_mm: 5 });
    expect(s.poses).toHaveLength(1);
    expect(s.joints).toEqual([]);
    expect(s.chord_min_mm).toBe(s.chord_max_mm);
    const c = chain(2, ['fixed', 'fixed']);
    expect(crossingSlack(c.design, c.route, 0, 0, { bend_limit_mm: 5 }).poses).toHaveLength(1);
  });

  it('honours the samples option', () => {
    expect(crossingSlack(design, route, 0, 0, { bend_limit_mm: 5, samples: 5 }).poses).toHaveLength(5);
  });
});

describe('crossingSlack, stated slack', () => {
  it.each([0, 3, 12])('slack_mm %d: free length is the longest chord plus it', (extra) => {
    const { design, route } = hinge();
    const s = crossingSlack(design, route, 0, 0, { bend_limit_mm: 5, slack_mm: extra });
    expect(s.basis).toBe('user');
    expect(s.free_length_mm).toBeCloseTo(s.chord_max_mm + extra, 9);
    expect(s.slack_mm).toBeCloseTo(extra, 9);
  });

  it('slack 0 on a moving crossing still reaches, exactly taut at the longest pose', () => {
    const { design, route } = hinge();
    const s = crossingSlack(design, route, 0, 0, { bend_limit_mm: 5, slack_mm: 0 });
    expect(s.reaches).toBe(true);
    for (const p of s.poses) expect(p.short_by_mm).toBe(0);
    const longest = s.poses.reduce((m, p) => (p.chord_mm > m.chord_mm ? p : m));
    expect(longest.chord_mm).toBe(s.chord_max_mm);
    expect(longest.bulge_mm).toBeLessThan(1e-3);
  });
});

describe('crossingSlack, judging', () => {
  const { design, route } = hinge({ ra: 30, rb: 30, h: 8 });

  it('bend_ok is exactly "reaches and the tightest pose is at or above the limit"', () => {
    const probe = crossingSlack(design, route, 0, 0, { bend_limit_mm: 1 });
    const r = probe.poses[probe.tightest]!.min_radius_mm;
    expect(Number.isFinite(r)).toBe(true);
    const cases: Array<[number, boolean]> = [
      [r * 0.99, true],
      [r * 1.01, false],
      [0, true],
      [1e9, false],
    ];
    for (const [limit, ok] of cases) {
      const s = crossingSlack(design, route, 0, 0, { bend_limit_mm: limit });
      expect(s.bend_limit_mm).toBe(limit);
      expect(s.bend_ok, `limit ${limit} vs tightest ${r}`).toBe(ok);
    }
  });

  it('bend_ok is false when the cable does not reach, whatever the limit', () => {
    const s = crossingSlack(design, route, 0, 0, { bend_limit_mm: 0, slack_mm: -5 });
    expect(s.reaches).toBe(false);
    expect(s.bend_ok).toBe(false);
    expect(s.poses.some((p) => p.short_by_mm > 0)).toBe(true);
  });

  it('tightest indexes the smallest radius, and bulge_mm is the largest bulge', () => {
    const s = crossingSlack(design, route, 0, 0, { bend_limit_mm: 5 });
    const radii = s.poses.map((p) => p.min_radius_mm);
    expect(radii[s.tightest]).toBe(Math.min(...radii));
    expect(s.bulge_mm).toBe(Math.max(...s.poses.map((p) => p.bulge_mm)));
  });

  it('each pose is the free length relaxed between the ends at that pose', () => {
    const s = crossingSlack(design, route, 0, 0, { bend_limit_mm: 5 });
    for (const p of s.poses) {
      const shape = relaxSpan(crossingEnds(design, route, 0, 0, p.values), s.free_length_mm);
      expect(p.min_radius_mm).toBe(shape.min_radius_mm);
      expect(p.bulge_mm).toBe(shape.bulge_mm);
    }
  });
});

describe('routeSlack', () => {
  it('length is on_links plus the free lengths of the crossings', () => {
    const { design, route } = hinge();
    const r = routeSlack(design, route, 0, { bend_static_mm: 5, bend_dynamic_mm: 12 });
    expect(r.on_links_mm).toBeCloseTo(40, 9);
    expect(r.crossings).toHaveLength(1);
    expect(r.length_mm).toBeCloseTo(40 + r.crossings[0]!.free_length_mm, 9);
    expect(r.complete).toBe(true);
  });

  it('uses the dynamic limit across a moving joint and the static one across a fixed joint', () => {
    const moving = hinge();
    expect(routeSlack(moving.design, moving.route, 0, { bend_static_mm: 5, bend_dynamic_mm: 12 }).crossings[0]!.bend_limit_mm).toBe(12);
    const fixed = hinge({ type: 'fixed' });
    expect(routeSlack(fixed.design, fixed.route, 0, { bend_static_mm: 5, bend_dynamic_mm: 12 }).crossings[0]!.bend_limit_mm).toBe(5);
  });

  it('falls back to the static limit when no dynamic one is given', () => {
    const moving = hinge();
    expect(routeSlack(moving.design, moving.route, 0, { bend_static_mm: 5 }).crossings[0]!.bend_limit_mm).toBe(5);
  });

  it('honours a stated slack that names a joint on the path, and ignores one that does not', () => {
    const named = hinge({ crossings: [{ joint: 'j', strategy: 'service_loop', slack_mm: 7 }] });
    expect(statedSlack(named.design, named.route, 0)).toBe(7);
    const r = routeSlack(named.design, named.route, 0, { bend_static_mm: 5 });
    expect(r.crossings[0]!.basis).toBe('user');
    expect(r.crossings[0]!.slack_mm).toBeCloseTo(7, 9);

    const other = hinge({ crossings: [{ joint: 'elsewhere', strategy: 'service_loop', slack_mm: 7 }] });
    expect(statedSlack(other.design, other.route, 0)).toBeUndefined();
    expect(routeSlack(other.design, other.route, 0, { bend_static_mm: 5 }).crossings[0]!.basis).toBe('auto');
  });

  it('takes the first stated entry that names a joint on the path', () => {
    const { design, route } = hinge({
      crossings: [
        { joint: 'elsewhere', strategy: 'axial', slack_mm: 1 },
        { joint: 'j', strategy: 'service_loop', slack_mm: 4 },
        { joint: 'j', strategy: 'service_loop', slack_mm: 9 },
      ],
    });
    expect(statedSlack(design, route, 0)).toBe(4);
  });

  it('is not complete with a fourth unswept joint, and reports it', () => {
    const c = chain(4);
    const r = routeSlack(c.design, c.route, 0, { bend_static_mm: 5 });
    expect(r.crossings[0]!.unsampled).toEqual(['j4']);
    expect(r.complete).toBe(false);
  });

  it('is not complete when a crossing does not reach', () => {
    const { design, route } = hinge({ crossings: [{ joint: 'j', strategy: 'service_loop', slack_mm: -10 }] });
    expect(routeSlack(design, route, 0, { bend_static_mm: 5 }).complete).toBe(false);
  });

  it('a route of one segment has no crossings', () => {
    const { design, route } = hinge();
    const single: Route = { ...route, segments: [route.segments[0]!] };
    const r = routeSlack(design, single, 0, { bend_static_mm: 5 });
    expect(r.crossings).toEqual([]);
    expect(r.length_mm).toBeCloseTo(r.on_links_mm, 12);
    expect(r.complete).toBe(true);
  });
});

describe('flatDemand', () => {
  it('a hinge along the ribbon width asks for no twist and no sideways shift at any pose', () => {
    const { design, route } = hinge({ h: 6 });
    for (const th of [-1.5, -0.7, 0, 0.4, 1.5]) {
      const d = flatDemand(crossingEnds(design, route, 0, 0, { j: th }))!;
      expect(d.twist_deg).toBeCloseTo(0, 6);
      expect(d.sideways_mm).toBeCloseTo(0, 6);
    }
    const s = crossingSlack(design, route, 0, 0, { bend_limit_mm: 5 });
    expect(s.twist_deg).toBeCloseTo(0, 6);
    expect(s.sideways_mm).toBeCloseTo(0, 6);
    for (const p of s.poses) expect(p.twist_deg).toBeCloseTo(0, 6);
  });

  it('a joint about the surface normal twists the ribbon by the joint angle', () => {
    const { design, route } = hinge({ h: 6, axis: [0, 1, 0], limit: { lower: -1.2, upper: 1.2 } });
    for (const th of [-1.2, -0.5, 0.3, 1.2]) {
      const d = flatDemand(crossingEnds(design, route, 0, 0, { j: th }))!;
      expect(d.twist_deg).toBeCloseTo((Math.abs(th) * 180) / Math.PI, 6);
    }
    const s = crossingSlack(design, route, 0, 0, { bend_limit_mm: 5 });
    expect(s.twist_deg).toBeCloseTo((1.2 * 180) / Math.PI, 6);
    for (const p of s.poses) expect(p.twist_deg).toBeCloseTo((Math.abs(p.values.j!) * 180) / Math.PI, 6);
  });

  it('shifts the far end sideways when the ends are offset along the width axis', () => {
    const e: CrossingEnds = { a: [0, 0, 0], b: [10, 0, 7], ta: [1, 0, 0], tb: [1, 0, 0], na: UP, nb: UP };
    const d = flatDemand(e)!;
    expect(d.twist_deg).toBeCloseTo(0, 9);
    expect(d.sideways_mm).toBeCloseTo(7, 9);
  });

  it('is undefined when a normal or a direction is missing, and when a cable leaves along its normal', () => {
    const base: CrossingEnds = { a: [0, 0, 0], b: [10, 0, 0], ta: [1, 0, 0], tb: [1, 0, 0], na: UP, nb: UP };
    expect(flatDemand(base)).toBeDefined();
    for (const key of ['ta', 'tb', 'na', 'nb'] as const) {
      const e = { ...base };
      delete e[key];
      expect(flatDemand(e), key).toBeUndefined();
    }
    expect(flatDemand({ ...base, ta: [0, 1, 0] })).toBeUndefined();

    const noNormals = hinge({ normals: false });
    expect(flatDemand(crossingEnds(noNormals.design, noNormals.route, 0, 0))).toBeUndefined();
    expect(crossingSlack(noNormals.design, noNormals.route, 0, 0, { bend_limit_mm: 5 }).twist_deg).toBeUndefined();
    const onePoint = hinge({ armPoints: [[30, 0, 0]] });
    expect(flatDemand(crossingEnds(onePoint.design, onePoint.route, 0, 0))).toBeUndefined();
  });
});

describe('physical sanity on the hinge', () => {
  // The wire runs on the +y side of the hinge. Turning the arm down (negative angle) opens the outside of that bend.
  const outside = (theta: number) => hinge({ ra: 40, rb: 40, h: 10, limit: { lower: -theta, upper: 0 } });

  it('with the wire on the outside of a one-sided bend, the tightest pose is the straight one', () => {
    for (const theta of [0.4, 0.8, 1.2]) {
      const { design, route } = outside(theta);
      const s = crossingSlack(design, route, 0, 0, { bend_limit_mm: 5 });
      expect(s.poses[s.tightest]!.values.j, `theta ${theta}`).toBeCloseTo(0, 9);
    }
  });

  it('widening the joint range never makes the tightest radius larger', () => {
    let previous = Infinity;
    for (const theta of [0.2, 0.4, 0.6, 0.8, 1.0, 1.2]) {
      const { design, route } = outside(theta);
      const s = crossingSlack(design, route, 0, 0, { bend_limit_mm: 5 });
      const r = s.poses[s.tightest]!.min_radius_mm;
      // The longest chord is at an interior angle, so a wider range moves the sample grid and the sampled
      // maximum (and with it the free length) wobbles by a few hundredths of a percent: allow 1 %.
      expect(r, `theta ${theta}`).toBeLessThanOrEqual(previous * 1.01);
      previous = r;
    }
  });

  it('widening a symmetric range never makes the tightest radius larger', () => {
    let previous = Infinity;
    for (const theta of [0.2, 0.5, 0.8, 1.1, 1.4]) {
      const { design, route } = hinge({ ra: 40, rb: 40, h: 10, limit: { lower: -theta, upper: theta } });
      const s = crossingSlack(design, route, 0, 0, { bend_limit_mm: 5 });
      const r = s.poses[s.tightest]!.min_radius_mm;
      expect(r, `theta ${theta}`).toBeLessThanOrEqual(previous * 1.01);
      previous = r;
    }
  });
});

describe('naturalLength with a bend limit', () => {
  const R = 40;
  const quarter: CrossingEnds = { a: [0, 0, 0], ta: [1, 0, 0], b: [R, R, 0], tb: [0, 1, 0] };
  const chord = Math.hypot(R, R);
  const radiusAt = (ends: CrossingEnds, length: number) => relaxSpan(ends, length).min_radius_mm;

  it('an easy limit gives the straight distance', () => {
    expect(naturalLength({ a: [0, 0, 0], ta: [1, 0, 0], b: [100, 0, 0], tb: [1, 0, 0] }, { bend_limit_mm: 20 })).toBeCloseTo(100, 6);
  });

  it('a limit met part-way gives the shortest length that meets it', () => {
    const peak = naturalLength(quarter);
    const peakRadius = radiusAt(quarter, peak);
    expect(peak).toBeGreaterThan(chord);
    const limit = 0.8 * peakRadius;
    const L = naturalLength(quarter, { bend_limit_mm: limit });
    expect(L).toBeGreaterThan(chord);
    expect(L).toBeLessThan(peak);
    expect(radiusAt(quarter, L)).toBeGreaterThanOrEqual(limit * 0.97);
    expect(0.97 * L).toBeGreaterThan(chord);
    expect(radiusAt(quarter, 0.97 * L)).toBeLessThan(limit);
  });

  it('a limit that cannot be met gives the same answer as no limit', () => {
    expect(naturalLength(quarter, { bend_limit_mm: 1e6 })).toBe(naturalLength(quarter));
  });

  it('one end held at 90 degrees to the chord with the other free has no peak and stays under the cap', () => {
    const ends: CrossingEnds = { a: [0, 0, 0], ta: [0, 1, 0], b: [100, 0, 0] };
    const L = naturalLength(ends);
    expect(L).toBeGreaterThan(100);
    expect(L).toBeLessThan(160);
    expect(naturalLength(ends, { bend_limit_mm: 1e6 })).toBe(L);
  });
});

describe('crossingSlack poses and chords with a longest distance between grid poses', () => {
  // The wire is on the outside of a one-sided bend: the longest chord is at an interior angle.
  const { design, route } = hinge({ ra: 40, rb: 40, h: 10, limit: { lower: -1.2, upper: 0 } });
  const s = crossingSlack(design, route, 0, 0, { bend_limit_mm: 5 });

  it('adds the longest-distance pose to the even grid', () => {
    expect(s.poses).toHaveLength(10);
    const grid = Array.from({ length: 9 }, (_, k) => -1.2 + (1.2 * k) / 8);
    const extra = s.poses.filter((p) => !grid.some((g) => Math.abs(g - p.values.j!) < 1e-9));
    expect(extra).toHaveLength(1);
    expect(extra[0]!.chord_mm).toBeCloseTo(s.chord_max_mm, 9);
    expect(extra[0]!.chord_mm).toBe(Math.max(...s.poses.map((p) => p.chord_mm)));
  });

  it('chord_max is at least routeLength, and strictly more here; chord_min at most', () => {
    const len = routeLength(design, route, 0).crossings[0]!;
    expect(s.chord_max_mm).toBeGreaterThan(len.max_mm + 1e-6);
    expect(s.chord_min_mm).toBeLessThanOrEqual(len.min_mm + 1e-9);
  });

  it('chord_max and chord_min equal an independent sweep with 8 steps between solved poses', () => {
    let max = 0;
    let min = Infinity;
    for (let k = 0; k <= 64; k++) {
      const e = crossingEnds(design, route, 0, 0, { j: -1.2 + (1.2 * k) / 64 });
      const d = Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1], e.b[2] - e.a[2]);
      max = Math.max(max, d);
      min = Math.min(min, d);
    }
    expect(s.chord_max_mm).toBeCloseTo(max, 9);
    expect(s.chord_min_mm).toBeCloseTo(min, 9);
  });

  it('every pose is reached, and the pose count is the grid or the grid plus one for any number of joints', () => {
    expect(s.reaches).toBe(true);
    for (const n of [1, 2, 3, 4]) {
      const c = chain(n);
      const r = crossingSlack(c.design, c.route, 0, 0, { bend_limit_mm: 5 });
      const grid = n === 1 ? 9 : n === 2 ? 25 : 27;
      expect([grid, grid + 1]).toContain(r.poses.length);
    }
  });
});

describe('the automatic length is not shorter than a brute-force search over the poses', () => {
  const layouts: Array<[string, HingeOptions]> = [
    ['symmetric, wire on the axis', { ra: 30, rb: 30, h: 0, limit: { lower: -Math.PI / 2, upper: Math.PI / 2 } }],
    ['outside of a one-sided bend', { ra: 40, rb: 40, h: 10, limit: { lower: -1.2, upper: 0 } }],
    ['uneven arms', { ra: 20, rb: 50, h: 5, limit: { lower: -1, upper: 1 } }],
    ['wire below the axis', { ra: 60, rb: 15, h: -8, limit: { lower: 0, upper: 1.5 } }],
  ];
  for (const [name, layout] of layouts) {
    for (const limit of [2, 10, 25, 60]) {
      it(name + ', limit ' + limit + ' mm', () => {
        const { design, route } = hinge(layout);
        const s = crossingSlack(design, route, 0, 0, { bend_limit_mm: limit });
        let brute = 0;
        for (const p of s.poses) {
          const ends = crossingEnds(design, route, 0, 0, p.values);
          if (Math.hypot(ends.b[0] - ends.a[0], ends.b[1] - ends.a[1], ends.b[2] - ends.a[2]) > 1e-9) brute = Math.max(brute, naturalLength(ends, { bend_limit_mm: limit }));
        }
        const want = Math.max(s.chord_max_mm, brute) * (1 + SLACK_ALLOWANCE) * 0.99;
        expect(s.free_length_mm, 'free ' + s.free_length_mm + ' vs brute ' + brute + ' chord_max ' + s.chord_max_mm).toBeGreaterThanOrEqual(want);
        expect(s.reaches).toBe(true);
      }, 120_000);
    }
  }
});

describe('flatDemand twist is between 0 and 90 degrees', () => {
  it('a ribbon on top of one plate continuing on the underside of the next is not twisted', () => {
    const e: CrossingEnds = { a: [0, 0, 0], b: [10, 0, 0], ta: [1, 0, 0], tb: [1, 0, 0], na: [0, 0, 1], nb: [0, 0, -1] };
    expect(flatDemand(e)!.twist_deg).toBeCloseTo(0, 6);
  });

  it('a turn t about the surface normal gives min(t, 180 - t) degrees', () => {
    for (let deg = 0; deg <= 180; deg += 15) {
      const t = (deg * Math.PI) / 180;
      const e: CrossingEnds = { a: [0, 0, 0], b: [10, 0, 0], ta: [1, 0, 0], tb: [Math.cos(t), 0, -Math.sin(t)], na: UP, nb: UP };
      const got = flatDemand(e)!.twist_deg;
      expect(got, 'turn ' + deg).toBeCloseTo(Math.min(deg, 180 - deg), 6);
      expect(got).toBeLessThanOrEqual(90 + 1e-9);
    }
  });
});

describe('crossingSlack with both extreme distances off the grid', () => {
  const { design, route } = hinge({ ra: 50, rb: 30, h: 12, limit: { lower: -0.7, upper: 2.6 } });
  const s = crossingSlack(design, route, 0, 0, { bend_limit_mm: 5 });
  const grid = Array.from({ length: 9 }, (_, k) => -0.7 + (3.3 * k) / 8);
  const extras = s.poses.filter((p) => !grid.some((g) => Math.abs(g - p.values.j!) < 1e-9));

  it('adds the longest and the shortest pose to the grid', () => {
    expect(s.poses).toHaveLength(11);
    expect(extras).toHaveLength(2);
    expect(extras.some((p) => Math.abs(p.chord_mm - s.chord_max_mm) < 1e-9)).toBe(true);
    expect(extras.some((p) => Math.abs(p.chord_mm - s.chord_min_mm) < 1e-9)).toBe(true);
    expect(Math.max(...s.poses.map((p) => p.chord_mm))).toBeCloseTo(s.chord_max_mm, 9);
    expect(Math.min(...s.poses.map((p) => p.chord_mm))).toBeCloseTo(s.chord_min_mm, 9);
  });

  it('the pose count is the grid plus zero, one or two for any number of joints', () => {
    for (const n of [1, 2, 3]) {
      const c = chain(n);
      const g = n === 1 ? 9 : n === 2 ? 25 : 27;
      expect([g, g + 1, g + 2]).toContain(crossingSlack(c.design, c.route, 0, 0, { bend_limit_mm: 5 }).poses.length);
    }
  });
});

describe('continuous joints', () => {
  const cont = hinge({ ra: 30, rb: 20, type: 'continuous' });

  it('a crossing over a continuous joint lists it and sweeps one turn, half each way', () => {
    const s = crossingSlack(cont.design, cont.route, 0, 0, { bend_limit_mm: 5 });
    expect(s.continuous).toEqual(['j']);
    expect(s.joints).toEqual(['j']);
    const values = s.poses.map((p) => p.values.j!);
    expect(Math.min(...values)).toBeCloseTo(-Math.PI, 9);
    expect(Math.max(...values)).toBeCloseTo(Math.PI, 9);
  });

  it('makes the route incomplete even when every pose reaches', () => {
    const r = routeSlack(cont.design, cont.route, 0, { bend_static_mm: 5 });
    expect(r.crossings[0]!.reaches).toBe(true);
    expect(r.crossings[0]!.unsampled).toEqual([]);
    expect(r.complete).toBe(false);
  });

  it('a revolute joint with limits does not', () => {
    const rev = hinge();
    expect(crossingSlack(rev.design, rev.route, 0, 0, { bend_limit_mm: 5 }).continuous).toEqual([]);
    expect(routeSlack(rev.design, rev.route, 0, { bend_static_mm: 5 }).complete).toBe(true);
  });
});
