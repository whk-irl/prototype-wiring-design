// Properties of relaxSpan over random ends: structure, determinism, invariance
// under rigid motion, mirroring and scaling, and robustness.
import fc from 'fast-check';
import { afterAll, describe, expect, it } from 'vitest';
import { relaxSpan, type SpanEnds, type SpanShape, type Vec3 } from '@core';

fc.configureGlobal({ seed: 20261121 });

const num = (lo: number, hi: number) => fc.double({ min: lo, max: hi, noNaN: true, noDefaultInfinity: true });
const vec = fc.tuple(num(-100, 100), num(-100, 100), num(-100, 100)) as fc.Arbitrary<Vec3>;
const unitVec = fc
  .tuple(num(-1, 1), num(-1, 1), num(-1, 1))
  .filter((v) => Math.hypot(...v) > 0.1)
  .map((v) => {
    const n = Math.hypot(...v);
    return [v[0] / n, v[1] / n, v[2] / n] as Vec3;
  });
const opt = <T>(a: fc.Arbitrary<T>) => fc.option(a, { nil: undefined });

const caseArb = fc.record({
  a: vec,
  b: vec,
  ta: opt(unitVec),
  tb: opt(unitVec),
  bias: opt(vec),
  extra: num(0, 1.2),
  segments: fc.integer({ min: 6, max: 30 }),
});
type Case = typeof caseArb extends fc.Arbitrary<infer T> ? T : never;

const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
const endsOf = (c: Case): SpanEnds => ({ a: c.a, b: c.b, ...(c.ta ? { ta: c.ta } : {}), ...(c.tb ? { tb: c.tb } : {}), ...(c.bias ? { bias: c.bias } : {}) });
const lengthOf = (c: Case) => dist(c.a, c.b) * (1 + c.extra) + 1; // always at least 1 mm longer than the chord's own 1 + extra
const close = (a: number, b: number, rel: number) => (a === Infinity && b === Infinity) || Math.abs(a - b) <= rel * (1 + Math.abs(a) + Math.abs(b));

let runs = 0;
let notConverged = 0;
const tally = (s: SpanShape) => {
  runs++;
  if (!s.converged) notConverged++;
};
afterAll(() => {
  console.info(`relaxSpan property runs: ${runs}, not converged: ${notConverged} (${((100 * notConverged) / Math.max(1, runs)).toFixed(1)} %)`);
});

describe('relaxSpan, structure', () => {
  it('returns segments + 1 points, from a to b exactly, with equal pieces when converged', () => {
    fc.assert(
      fc.property(caseArb, (c) => {
        const L = lengthOf(c);
        const s = relaxSpan(endsOf(c), L, { segments: c.segments });
        tally(s);
        expect(s.reaches).toBe(true);
        expect(s.points).toHaveLength(c.segments + 1);
        expect(s.points[0]).toEqual(c.a);
        expect(s.points[c.segments]).toEqual(c.b);
        if (s.converged) {
          for (let i = 1; i < s.points.length; i++) expect(Math.abs(dist(s.points[i]!, s.points[i - 1]!) / (L / c.segments) - 1), `piece ${i}`).toBeLessThan(1e-4);
        }
        expect(s.bulge_mm).toBeLessThanOrEqual(L / 2 + 1e-9);
      }),
      { numRuns: 300 },
    );
  });

  it('gives the identical output for identical input', () => {
    fc.assert(
      fc.property(caseArb, (c) => {
        expect(relaxSpan(endsOf(c), lengthOf(c), { segments: c.segments })).toEqual(relaxSpan(endsOf(c), lengthOf(c), { segments: c.segments }));
      }),
      { numRuns: 100 },
    );
  });
});

describe('relaxSpan, convergence', () => {
  it('settles for every cable with distinct ends and at least 10 % spare length', () => {
    fc.assert(
      fc.property(
        caseArb.filter((c) => dist(c.a, c.b) > 5 && c.extra >= 0.1),
        (c) => {
          const s = relaxSpan(endsOf(c), dist(c.a, c.b) * (1 + c.extra), { segments: 20 });
          expect(s.converged, JSON.stringify(c)).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('relaxSpan, symmetry', () => {
  const settled = (s: SpanShape) => s.reaches && s.converged;

  /** Compare radius and bulge of a transformed case with the original, when both settled. */
  const same = (c: Case, t: (v: Vec3) => Vec3, factor = 1, scaleLen = 1) => {
    const base = relaxSpan(endsOf(c), lengthOf(c), { segments: c.segments });
    const other: SpanEnds = {
      a: t(c.a),
      b: t(c.b),
      ...(c.ta ? { ta: dirOf(t, c.ta) } : {}),
      ...(c.tb ? { tb: dirOf(t, c.tb) } : {}),
      ...(c.bias ? { bias: dirOf(t, c.bias) } : {}),
    };
    const moved = relaxSpan(other, lengthOf(c) * scaleLen, { segments: c.segments });
    tally(base);
    tally(moved);
    if (!settled(base) || !settled(moved)) return;
    expect(close(moved.min_radius_mm, base.min_radius_mm * factor, 1e-3), `radius ${moved.min_radius_mm} vs ${base.min_radius_mm * factor}`).toBe(true);
    expect(close(moved.bulge_mm, base.bulge_mm * factor, 1e-3), `bulge ${moved.bulge_mm} vs ${base.bulge_mm * factor}`).toBe(true);
  };
  // A direction is transformed by the linear part of t (t(v) - t(0)); t is linear plus a translation.
  const dirOf = (t: (v: Vec3) => Vec3, v: Vec3): Vec3 => {
    const o = t([0, 0, 0]);
    const w = t(v);
    return [w[0] - o[0], w[1] - o[1], w[2] - o[2]];
  };

  it('is unchanged by a rigid motion of all inputs', () => {
    fc.assert(
      fc.property(caseArb, unitVec, num(-3, 3), vec, (c, axis, angle, shift) => {
        const cs = Math.cos(angle);
        const sn = Math.sin(angle);
        const rot = (v: Vec3): Vec3 => {
          const cr = [axis[1] * v[2] - axis[2] * v[1], axis[2] * v[0] - axis[0] * v[2], axis[0] * v[1] - axis[1] * v[0]];
          const d = axis[0] * v[0] + axis[1] * v[1] + axis[2] * v[2];
          return [0, 1, 2].map((i) => v[i]! * cs + cr[i]! * sn + axis[i]! * d * (1 - cs)) as Vec3;
        };
        same(c, (v) => {
          const r = rot(v);
          return [r[0] + shift[0], r[1] + shift[1], r[2] + shift[2]];
        });
      }),
      { numRuns: 100 },
    );
  });

  it('is unchanged by a rigid motion, for parallel end directions too (with and without a bias)', () => {
    const parallel = fc.record({ c: caseArb, t: unitVec, keepBias: fc.boolean() }).map(({ c, t, keepBias }) => ({ ...c, ta: t, tb: t, bias: keepBias ? (c.bias ?? ([0, 1, 0] as Vec3)) : undefined }));
    fc.assert(
      fc.property(parallel, unitVec, num(-3, 3), (c, axis, angle) => {
        const cs = Math.cos(angle);
        const sn = Math.sin(angle);
        const rot = (v: Vec3): Vec3 => {
          const cr = [axis[1] * v[2] - axis[2] * v[1], axis[2] * v[0] - axis[0] * v[2], axis[0] * v[1] - axis[1] * v[0]];
          const d = axis[0] * v[0] + axis[1] * v[1] + axis[2] * v[2];
          return [0, 1, 2].map((i) => v[i]! * cs + cr[i]! * sn + axis[i]! * d * (1 - cs)) as Vec3;
        };
        same(c, rot);
      }),
      { numRuns: 200 },
    );
  });

  it('is unchanged by mirroring', () => {
    fc.assert(fc.property(caseArb, (c) => same(c, (v) => [-v[0], v[1], v[2]])), { numRuns: 100 });
  });

  it('scales radius and bulge with every length', () => {
    fc.assert(
      fc.property(caseArb, num(0.2, 8), (c, k) => {
        same(c, (v) => [v[0] * k, v[1] * k, v[2] * k], k, k);
      }),
      { numRuns: 100 },
    );
  });
});

describe('relaxSpan, robustness', () => {
  const nasty = fc.record({
    a: vec,
    coincident: fc.boolean(),
    b: vec,
    ta: opt(unitVec),
    opposite: fc.boolean(),
    tb: opt(unitVec),
    bias: opt(fc.oneof(vec, fc.constant<Vec3>([0, 0, 0]))),
    length: num(0, 300).filter((v) => v === 0 || v > 1e-6),
    exact: fc.boolean(),
    segments: fc.integer({ min: 4, max: 25 }),
  });

  it('never returns NaN, for coincident ends, zero bias, opposite directions or length equal to the distance', () => {
    fc.assert(
      fc.property(nasty, (c) => {
        const b = c.coincident ? c.a : c.b;
        const tb = c.opposite && c.ta ? ([-c.ta[0], -c.ta[1], -c.ta[2]] as Vec3) : c.tb;
        const length = c.exact ? dist(c.a, b) : c.length;
        const s = relaxSpan({ a: c.a, b, ...(c.ta ? { ta: c.ta } : {}), ...(tb ? { tb } : {}), ...(c.bias ? { bias: c.bias } : {}) }, length, { segments: c.segments });
        tally(s);
        expect(s.points).toHaveLength(c.segments + 1);
        for (const p of s.points) for (const x of p) expect(Number.isFinite(x), JSON.stringify(s.points)).toBe(true);
        expect(Number.isNaN(s.min_radius_mm)).toBe(false);
        expect(Number.isFinite(s.bulge_mm)).toBe(true);
        expect(Number.isFinite(s.short_by_mm)).toBe(true);
        expect(s.min_radius_mm).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 500 },
    );
  });

  it('a subnormal length gives a degenerate shape, not NaN', () => {
    const s = relaxSpan({ a: [0, 0, 0], b: [0, 0, 0] }, 5e-324, { segments: 4 });
    for (const p of s.points) for (const x of p) expect(Number.isNaN(x), JSON.stringify(s.points)).toBe(false);
  });

  it('a length shorter than the distance never reaches and reports the shortfall', () => {
    fc.assert(
      fc.property(vec, vec, num(0.01, 0.99), (a, b, f) => {
        const d = dist(a, b);
        fc.pre(d > 1e-3);
        const s = relaxSpan({ a, b }, d * f);
        expect(s.reaches).toBe(false);
        expect(Math.abs(s.short_by_mm - d * (1 - f))).toBeLessThan(1e-9 * (1 + d));
      }),
    );
  });
});
