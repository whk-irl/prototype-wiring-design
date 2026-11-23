// Shapes of a free cable with known exact answers: circles, the pinned elastica
// (complete elliptic integrals by the AGM) and the small-buckle limits.
import { describe, expect, it } from 'vitest';
import { relaxSpan, type SpanEnds, type Vec3 } from '@core';
import { ellipticKE } from './helpers';

const rel = (got: number, want: number) => Math.abs(got - want) / Math.abs(want);

describe('ellipticKE (test helper)', () => {
  it('matches known values', () => {
    const { K, E } = ellipticKE(Math.SQRT1_2);
    expect(K).toBeCloseTo(1.8540746773, 9);
    expect(E).toBeCloseTo(1.3506438810, 9);
    expect(ellipticKE(0).K).toBeCloseTo(Math.PI / 2, 12);
    expect(ellipticKE(0).E).toBeCloseTo(Math.PI / 2, 12);
  });
});

describe('relaxSpan, reference shapes', () => {
  const R = 50;

  it('a straight cable: huge radius, no bulge', () => {
    for (const ends of [
      { a: [0, 0, 0], b: [100, 0, 0], ta: [1, 0, 0], tb: [1, 0, 0] },
      { a: [0, 0, 0], b: [100, 0, 0] },
      { a: [0, 0, 0], b: [0, 60, 80], ta: [0, 0.6, 0.8], tb: [0, 0.6, 0.8] },
    ] as SpanEnds[]) {
      const s = relaxSpan(ends, 100);
      expect(s.reaches).toBe(true);
      expect(s.short_by_mm).toBe(0);
      expect(s.min_radius_mm).toBeGreaterThan(1e4);
      expect(s.bulge_mm).toBeLessThan(1e-3);
    }
  });

  it('a semicircle: radius R, bulge R', () => {
    const s = relaxSpan({ a: [0, 0, 0], ta: [0, 1, 0], b: [2 * R, 0, 0], tb: [0, -1, 0] }, Math.PI * R);
    expect(s.converged).toBe(true);
    expect(rel(s.min_radius_mm, R)).toBeLessThan(0.015);
    expect(rel(s.bulge_mm, R)).toBeLessThan(0.015);
  });

  it('a quarter circle: radius R, bulge R (1 - 1/sqrt 2)', () => {
    const s = relaxSpan({ a: [0, 0, 0], ta: [1, 0, 0], b: [R, R, 0], tb: [0, 1, 0] }, (Math.PI * R) / 2);
    expect(rel(s.min_radius_mm, R)).toBeLessThan(0.015);
    expect(rel(s.bulge_mm, R * (1 - Math.SQRT1_2))).toBeLessThan(0.015);
  });

  it('the error shrinks with more segments', () => {
    const ends: SpanEnds = { a: [0, 0, 0], ta: [0, 1, 0], b: [2 * R, 0, 0], tb: [0, -1, 0] };
    const e20 = rel(relaxSpan(ends, Math.PI * R, { segments: 20 }).min_radius_mm, R);
    const e40 = rel(relaxSpan(ends, Math.PI * R, { segments: 40 }).min_radius_mm, R);
    expect(e40).toBeLessThan(e20);
    expect(e40).toBeLessThan(0.005);
    const q: SpanEnds = { a: [0, 0, 0], ta: [1, 0, 0], b: [R, R, 0], tb: [0, 1, 0] };
    const q20 = rel(relaxSpan(q, (Math.PI * R) / 2, { segments: 20 }).bulge_mm, R * (1 - Math.SQRT1_2));
    const q40 = rel(relaxSpan(q, (Math.PI * R) / 2, { segments: 40 }).bulge_mm, R * (1 - Math.SQRT1_2));
    expect(q40).toBeLessThan(q20);
  });

  it('a semicircle in a tilted plane, with the bias perpendicular to neither end direction', () => {
    // Rotate the planar semicircle about (1,2,3) by 0.7 rad (Rodrigues, written out).
    const k = [1 / Math.sqrt(14), 2 / Math.sqrt(14), 3 / Math.sqrt(14)];
    const th = 0.7;
    const rot = (v: Vec3): Vec3 => {
      const cr = [k[1]! * v[2] - k[2]! * v[1], k[2]! * v[0] - k[0]! * v[2], k[0]! * v[1] - k[1]! * v[0]];
      const d = k[0]! * v[0] + k[1]! * v[1] + k[2]! * v[2];
      return [0, 1, 2].map((i) => v[i]! * Math.cos(th) + cr[i]! * Math.sin(th) + k[i]! * d * (1 - Math.cos(th))) as Vec3;
    };
    const s = relaxSpan({ a: rot([0, 0, 0]), ta: rot([0, 1, 0]), b: rot([2 * R, 0, 0]), tb: rot([0, -1, 0]), bias: [0.3, 0.3, 0.3] }, Math.PI * R);
    expect(rel(s.min_radius_mm, R)).toBeLessThan(0.015);
    expect(rel(s.bulge_mm, R)).toBeLessThan(0.015);
  });

  describe('the pinned elastica', () => {
    it.each([60, 90, 120])('end angle %d degrees', (deg) => {
      const k = Math.sin((deg * Math.PI) / 360); // sin(alpha / 2)
      const { K, E } = ellipticKE(k);
      const L = 100;
      const chord = L * (2 * E / K - 1);
      const s = relaxSpan({ a: [0, 0, 0], b: [chord, 0, 0], bias: [0, 1, 0] }, L);
      expect(s.reaches).toBe(true);
      expect(rel(s.bulge_mm, (L * k) / K)).toBeLessThan(0.015);
      expect(rel(s.min_radius_mm, L / (4 * k * K))).toBeLessThan(0.015);
    });

    it('matches the quoted values at 90 degrees', () => {
      const L = 100;
      const s = relaxSpan({ a: [0, 0, 0], b: [45.69, 0, 0], bias: [0, 1, 0] }, L);
      expect(rel(s.bulge_mm, 38.14)).toBeLessThan(0.015);
      expect(rel(s.min_radius_mm, 19.07)).toBeLessThan(0.015);
    });
  });

  describe('a small buckle (distance c, extra e = 0.01 c)', () => {
    const c = 100;
    const e = 0.01 * c;
    const bulge = (2 / Math.PI) * Math.sqrt(c * e);
    it('pinned ends', () => {
      const s = relaxSpan({ a: [0, 0, 0], b: [c, 0, 0], bias: [0, 1, 0] }, c + e);
      expect(rel(s.bulge_mm, bulge)).toBeLessThan(0.03);
      expect(rel(s.min_radius_mm, (c * c) / (Math.PI ** 2 * bulge))).toBeLessThan(0.03);
    });
    it('both ends held along the chord', () => {
      const s = relaxSpan({ a: [0, 0, 0], ta: [1, 0, 0], b: [c, 0, 0], tb: [1, 0, 0], bias: [0, 1, 0] }, c + e);
      expect(rel(s.bulge_mm, bulge)).toBeLessThan(0.03);
      expect(rel(s.min_radius_mm, (c * c) / (2 * Math.PI ** 2 * bulge))).toBeLessThan(0.03);
    });
  });

  it('bows toward the bias', () => {
    const up = relaxSpan({ a: [0, 0, 0], b: [90, 0, 0], bias: [0, 1, 0] }, 100);
    const down = relaxSpan({ a: [0, 0, 0], b: [90, 0, 0], bias: [0, -1, 0] }, 100);
    const mid = (pts: Vec3[]) => pts[Math.floor(pts.length / 2)]![1];
    expect(mid(up.points)).toBeGreaterThan(1);
    expect(mid(down.points)).toBeLessThan(-1);
  });

  it('does not reach when the length is shorter than the distance', () => {
    const s = relaxSpan({ a: [0, 0, 0], b: [10, 0, 0], ta: [0, 1, 0] }, 7);
    expect(s.reaches).toBe(false);
    expect(s.short_by_mm).toBeCloseTo(3, 12);
    expect(s.min_radius_mm).toBe(Infinity);
    expect(s.bulge_mm).toBe(0);
    expect(s.points).toHaveLength(21);
    s.points.forEach((p, i) => {
      expect(p[0]).toBeCloseTo((10 * i) / 20, 12);
      expect(p[1]).toBe(0);
      expect(p[2]).toBe(0);
    });
  });

  it('honours the segment count, with a minimum of 4', () => {
    expect(relaxSpan({ a: [0, 0, 0], b: [90, 0, 0] }, 100, { segments: 33 }).points).toHaveLength(34);
    expect(relaxSpan({ a: [0, 0, 0], b: [90, 0, 0] }, 100, { segments: 2 }).points).toHaveLength(5);
  });

  it('reports a shape that did not settle as not converged', () => {
    const s = relaxSpan({ a: [0, 0, 0], ta: [0, 1, 0], b: [2 * R, 0, 0], tb: [0, -1, 0] }, Math.PI * R, { max_sweeps: 1 });
    expect(s.converged).toBe(false);
    expect(s.points).toHaveLength(21);
  });
});

function rotateAbout(v: Vec3, axis: Vec3, angle: number): Vec3 {
  const n = Math.hypot(...axis);
  const k = [axis[0] / n, axis[1] / n, axis[2] / n];
  const c = Math.cos(angle);
  const sn = Math.sin(angle);
  const cr = [k[1]! * v[2] - k[2]! * v[1], k[2]! * v[0] - k[0]! * v[2], k[0]! * v[1] - k[1]! * v[0]];
  const d = k[0]! * v[0] + k[1]! * v[1] + k[2]! * v[2];
  return [0, 1, 2].map((i) => v[i]! * c + cr[i]! * sn + k[i]! * d * (1 - c)) as Vec3;
}

const rotations: Array<[Vec3, number]> = [
  [[0, 0, 1], 0.9],
  [[1, 0, 0], 1.3],
  [[0, 1, 0], -2.1],
  [[1, 2, 3], 0.7],
  [[-3, 1, 2], 2.6],
  [[1, 1, 1], 3.0],
];

function turned(ends: SpanEnds, axis: Vec3, angle: number): SpanEnds {
  const r = (v: Vec3) => rotateAbout(v, axis, angle);
  return { a: r(ends.a), b: r(ends.b), ...(ends.ta ? { ta: r(ends.ta) } : {}), ...(ends.tb ? { tb: r(ends.tb) } : {}), ...(ends.bias ? { bias: r(ends.bias) } : {}) };
}

describe('relaxSpan does not stop at a flat shape that is only balanced', () => {
  const sameRadiusAndBulge = (ends: SpanEnds, length: number) => {
    const base = relaxSpan(ends, length);
    expect(base.converged).toBe(true);
    for (const [axis, angle] of rotations) {
      const other = relaxSpan(turned(ends, axis, angle), length);
      expect(other.converged, 'rotation ' + axis + ' ' + angle).toBe(true);
      expect(rel(other.min_radius_mm, base.min_radius_mm), 'radius, rotation ' + axis + ' ' + angle).toBeLessThan(1e-3);
      expect(rel(other.bulge_mm, base.bulge_mm), 'bulge, rotation ' + axis + ' ' + angle).toBeLessThan(1e-3);
    }
    return base;
  };

  it('both ends along the same slanted direction, no bias: about 12.86 mm in every orientation', () => {
    const ends: SpanEnds = { a: [0, 0, 0], b: [40, 10, 0], ta: [0.6, 0.8, 0], tb: [0.6, 0.8, 0] };
    const base = sameRadiusAndBulge(ends, 55);
    expect(rel(base.min_radius_mm, 12.86)).toBeLessThan(0.02);
  });

  it('the same with a bias, in and out of the plane', () => {
    for (const bias of [[0, 0, 1], [0, 1, 0], [-1, 0.5, 0.2]] as Vec3[]) {
      const ends: SpanEnds = { a: [0, 0, 0], b: [40, 10, 0], ta: [0.6, 0.8, 0], tb: [0.6, 0.8, 0], bias };
      const base = sameRadiusAndBulge(ends, 55);
      expect(base.min_radius_mm, 'bias ' + bias).toBeLessThan(30);
    }
  });

  it('a sidestep (parallel ends, the far one offset sideways), with and without a bias', () => {
    for (const bias of [undefined, [0, 1, 0], [0, 0, 1]] as Array<Vec3 | undefined>) {
      const ends: SpanEnds = { a: [0, 0, 0], b: [40, 10, 0], ta: [1, 0, 0], tb: [1, 0, 0], ...(bias ? { bias } : {}) };
      sameRadiusAndBulge(ends, 52);
    }
  });
});

describe('relaxSpan keeps planar shapes flat', () => {
  const flat = (s: { points: Vec3[] }, length: number) => Math.max(...s.points.map((p) => Math.abs(p[2]))) / length;

  it('semicircle, quarter circle and small buckles stay in their plane', () => {
    const R = 50;
    const cases: Array<[SpanEnds, number]> = [
      [{ a: [0, 0, 0], ta: [0, 1, 0], b: [2 * R, 0, 0], tb: [0, -1, 0] }, Math.PI * R],
      [{ a: [0, 0, 0], ta: [0, 1, 0], b: [2 * R, 0, 0], tb: [0, -1, 0], bias: [0, 1, 0] }, Math.PI * R],
      [{ a: [0, 0, 0], ta: [1, 0, 0], b: [R, R, 0], tb: [0, 1, 0] }, (Math.PI * R) / 2],
      [{ a: [0, 0, 0], b: [100, 0, 0], bias: [0, 1, 0] }, 101],
      [{ a: [0, 0, 0], ta: [1, 0, 0], b: [100, 0, 0], tb: [1, 0, 0], bias: [0, 1, 0] }, 101],
      [{ a: [0, 0, 0], b: [45.69, 0, 0], bias: [0, 1, 0] }, 100],
    ];
    for (const [ends, length] of cases) {
      const s = relaxSpan(ends, length);
      expect(flat(s, length), JSON.stringify(ends)).toBeLessThan(1e-3);
    }
  });
});

describe('relaxSpan, zero length', () => {
  it('coincident ends reach with nothing short', () => {
    const s = relaxSpan({ a: [3, 4, 5], b: [3, 4, 5] }, 0);
    expect(s.reaches).toBe(true);
    expect(s.short_by_mm).toBe(0);
  });

  it('ends apart do not reach, short by the distance', () => {
    const s = relaxSpan({ a: [0, 0, 0], b: [3, 4, 0] }, 0);
    expect(s.reaches).toBe(false);
    expect(s.short_by_mm).toBeCloseTo(5, 12);
  });
});
