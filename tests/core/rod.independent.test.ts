// Independent checks of settleRod, each against closed-form physics or a direct construction.
import { describe, expect, it } from 'vitest';
import { relaxSpan, settleRod, type RodContact, type RodInput, type RodShape, type Vec3 } from '@core';

const rel = (got: number, want: number) => Math.abs(got - want) / Math.abs(want);
const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
const timings: string[] = [];

/** mulberry32: a small seeded generator. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- energy of a chain

type V = [number, number, number];
const sub = (a: readonly number[], b: readonly number[]): V => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
const norm = (v: readonly number[]) => Math.hypot(v[0]!, v[1]!, v[2]!);
const unitOf = (v: readonly number[]): V => {
  const n = norm(v);
  return [v[0]! / n, v[1]! / n, v[2]! / n];
};

/** The discrete bending energy of the header: sum |d_b - d_a|^2 / (h_a + h_b) plus |d - t|^2 / h at held ends. */
function energy(points: readonly Vec3[], ta?: Vec3, tb?: Vec3): number {
  const n = points.length - 1;
  const h: number[] = [];
  const d: V[] = [];
  for (let i = 0; i < n; i++) {
    const v = sub(points[i + 1]!, points[i]!);
    h.push(norm(v));
    d.push(unitOf(v));
  }
  let e = 0;
  for (let i = 0; i + 1 < n; i++) e += norm(sub(d[i + 1]!, d[i]!)) ** 2 / (h[i]! + h[i + 1]!);
  if (ta) e += norm(sub(d[0]!, ta)) ** 2 / h[0]!;
  if (tb) e += norm(sub(d[n - 1]!, tb)) ** 2 / h[n - 1]!;
  return e;
}

/** Chain of n equal pieces h from `a` with unit directions `d`, nudged until it closes on `b` (mean-residual projection). */
function closeChain(a: Vec3, b: Vec3, h: number, dirs: V[]): Vec3[] | null {
  const n = dirs.length;
  let d = dirs.map((x) => unitOf(x));
  for (let it = 0; it < 500; it++) {
    const s: V = [0, 0, 0];
    for (const x of d) for (let k = 0; k < 3; k++) s[k]! += h * x[k]!;
    const e: V = [b[0] - a[0] - s[0], b[1] - a[1] - s[1], b[2] - a[2] - s[2]];
    if (norm(e) < 1e-11) break;
    d = d.map((x) => unitOf([x[0] + e[0] / (n * h), x[1] + e[1] / (n * h), x[2] + e[2] / (n * h)]));
  }
  const pts: Vec3[] = [[a[0], a[1], a[2]]];
  for (const x of d) {
    const p = pts[pts.length - 1]!;
    pts.push([p[0] + h * x[0], p[1] + h * x[1], p[2] + h * x[2]]);
  }
  const end = pts[n]!;
  return dist(end, b) < 1e-8 ? pts : null;
}

/** Circular-arc-like chain in the xy plane: directions at angles from +phi to -phi, phi chosen to close on the chord. */
function arcChain(a: Vec3, b: Vec3, h: number, n: number, side: 1 | -1): Vec3[] {
  const chord = dist(a, b);
  const f = (phi: number) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += Math.cos(phi * (1 - (2 * (i + 0.5)) / n));
    return s - chord / h;
  };
  let lo = 0;
  let hi = Math.PI;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) > 0) lo = mid;
    else hi = mid;
  }
  const phi = (lo + hi) / 2;
  const c = unitOf(sub(b, a));
  const perp: V = [-c[1], c[0], 0];
  const dirs: V[] = [];
  for (let i = 0; i < n; i++) {
    const th = phi * (1 - (2 * (i + 0.5)) / n);
    dirs.push([Math.cos(th) * c[0] + side * Math.sin(th) * perp[0], Math.cos(th) * c[1] + side * Math.sin(th) * perp[1], Math.cos(th) * c[2]]);
  }
  return closeChain(a, b, h, dirs)!;
}

function directionsOf(points: readonly Vec3[]): V[] {
  const out: V[] = [];
  for (let i = 0; i + 1 < points.length; i++) out.push(unitOf(sub(points[i + 1]!, points[i]!)));
  return out;
}

describe('a cut span with held end directions is an energy minimum', () => {
  const cases: Array<{ name: string; a: Vec3; b: Vec3; ta: Vec3; tb: Vec3; L: number }> = [
    { name: 'opposed ends', a: [0, 0, 0], b: [40, 0, 0], ta: [0, 1, 0], tb: [0, -1, 0], L: 70 },
    { name: 'parallel ends', a: [0, 0, 0], b: [40, 0, 0], ta: [1, 0, 0], tb: [1, 0, 0], L: 60 },
    { name: 'askew ends', a: [0, 0, 0], b: [40, 10, 5], ta: unitOf([0, 0.6, 0.8]), tb: unitOf([0.6, 0, 0.8]), L: 70 },
  ];

  for (const c of cases) {
    it(c.name + ': no other chain of the same length and ends has less energy', () => {
      const s = settleRod({ path: [c.a, c.b], pins: [{ index: 0, tangent: c.ta }, { index: 1, tangent: c.tb }], radius_mm: 1, mode: { kind: 'cut', lengths_mm: [c.L] } });
      expect(s.converged).toBe(true);
      const n = s.points.length - 1;
      const h = c.L / n;
      // the pieces really are L / n each, and the ends are the pins
      for (let i = 0; i < n; i++) expect(rel(dist(s.points[i]!, s.points[i + 1]!), h)).toBeLessThan(1e-6);
      expect(s.points[0]).toEqual(c.a);
      expect(s.points[n]).toEqual(c.b);
      const e0 = energy(s.points, c.ta, c.tb);

      const candidates: Vec3[][] = [];
      // arcs through both ends, bowed either way (planar candidates; only the xy-plane ones can close)
      if (c.a[2] === 0 && c.b[2] === 0) {
        candidates.push(arcChain(c.a, c.b, h, n, 1), arcChain(c.a, c.b, h, n, -1));
      }
      // relaxSpan's shape (same energy, finer chain) perturbed and re-projected, and the settled shape perturbed
      const ref = relaxSpan({ a: c.a, b: c.b, ta: c.ta, tb: c.tb }, c.L, { segments: n, max_sweeps: 200000, tolerance: 1e-9 });
      const bases = [directionsOf(ref.points as Vec3[]), directionsOf(s.points)];
      const rand = rng(12345);
      for (const base of bases) {
        for (let k = 0; k < 10; k++) {
          const amp = 0.02 + 0.05 * rand();
          const pert = base.map((d) => unitOf([d[0] + amp * (rand() - 0.5), d[1] + amp * (rand() - 0.5), d[2] + amp * (rand() - 0.5)]) as V);
          const pts = closeChain(c.a, c.b, h, pert);
          if (pts) candidates.push(pts);
        }
      }
      expect(candidates.length).toBeGreaterThanOrEqual(20);
      for (const [i, pts] of candidates.entries()) {
        expect(e0, `candidate ${i}: ${energy(pts, c.ta, c.tb)}`).toBeLessThanOrEqual(energy(pts, c.ta, c.tb) * (1 + 1e-6) + 1e-12);
      }
      // and it is as low as relaxSpan's own minimum of the same discrete energy
      expect(e0).toBeLessThanOrEqual(energy(ref.points as Vec3[], c.ta, c.tb) * (1 + 1e-3));
    });
  }
});

// ---------------------------------------------------------------- pins on a plane

describe('laid wire on a flat plane through pins', () => {
  const floor: RodContact = (p) => ({ distance_mm: p[2], normal: [0, 0, 1] });
  const r = 0.5;
  const run = (offset: number) => {
    const path: Vec3[] = [];
    // start: straight run along x, with the middle pin's offset reached in two straight runs
    for (let i = 0; i <= 20; i++) {
      const x = 5 * i;
      path.push([x, x <= 50 ? (offset * x) / 50 : (offset * (100 - x)) / 50, r]);
    }
    return settleRod({
      path,
      pins: [{ index: 0 }, { index: 10 }, { index: 20 }],
      radius_mm: r,
      mode: { kind: 'laid', bend_length_mm: 5 },
      contact: floor,
    });
  };

  it('three pins in a line: straight, touching the plane, through the pins', () => {
    const s = run(0);
    expect(s.converged).toBe(true);
    for (const p of s.points) {
      expect(Math.abs(p[1])).toBeLessThan(1e-6);
      expect(Math.abs(p[2] - r)).toBeLessThan(2e-3);
    }
    for (const t of s.touching) expect(t).toBe(true);
    expect(s.min_radius_mm).toBe(Infinity);
    expect(rel(s.length_mm, 100)).toBeLessThan(1e-6);
    expect(s.pin_indices).toHaveLength(3);
  });

  it('middle pin offset sideways by 4 mm: through all three pins, tightest bend at the middle one', () => {
    const s = run(4);
    expect(s.converged).toBe(true);
    const [i0, i1, i2] = s.pin_indices as [number, number, number];
    expect(s.points[i0]).toEqual([0, 0, r]);
    expect(s.points[i1]).toEqual([50, 4, r]);
    expect(s.points[i2]).toEqual([100, 0, r]);
    expect(Math.abs(s.tightest_index - i1)).toBeLessThanOrEqual(1);
    expect(Number.isFinite(s.min_radius_mm)).toBe(true);
    // away from the pin the wire is straight: the radius is far above the one at the pin
    expect(s.radius_mm[Math.floor(i1 / 2)]).toBeGreaterThan(20 * s.min_radius_mm);
    // it stays on the plane
    for (const p of s.points) expect(Math.abs(p[2] - r)).toBeLessThan(2e-3);
  });
});

// ---------------------------------------------------------------- a hanging loop

describe('a cut loop with gravity between level pins, no held directions', () => {
  const run = (up: Vec3) =>
    settleRod({
      path: [[0, 0, 0], [40, 0, 0]],
      pins: [],
      radius_mm: 1,
      mode: { kind: 'cut', lengths_mm: [60] },
      gravity: { up, sag_length_mm: 30 },
    });

  it('is symmetric about the mid-plane and lowest at mid-span', () => {
    const s = run([0, 0, 1]);
    expect(s.converged).toBe(true);
    const n = s.points.length - 1;
    for (let i = 0; i <= n; i++) {
      const p = s.points[i]!;
      const q = s.points[n - i]!;
      expect(Math.abs(p[0] + q[0] - 40), `x ${i}`).toBeLessThan(2e-3);
      expect(Math.abs(p[2] - q[2]), `z ${i}`).toBeLessThan(2e-3);
      expect(Math.abs(p[1])).toBeLessThan(1e-6);
    }
    let low = 0;
    for (let i = 0; i <= n; i++) if (s.points[i]![2] < s.points[low]![2]) low = i;
    expect(Math.abs(low - n / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(s.points[low]![0] - 20)).toBeLessThan(0.5);
    expect(s.points[low]![2]).toBeLessThan(-5);
  });

  it('reversing up mirrors it', () => {
    const down = run([0, 0, 1]);
    const upward = run([0, 0, -1]);
    expect(upward.points.length).toBe(down.points.length);
    for (let i = 0; i < down.points.length; i++) {
      expect(Math.abs(upward.points[i]![0] - down.points[i]![0])).toBeLessThan(2e-3);
      expect(Math.abs(upward.points[i]![2] + down.points[i]![2])).toBeLessThan(2e-3);
    }
  });
});

// ---------------------------------------------------------------- scaling

const cylinder =
  (rc: number): RodContact =>
  (p) => {
    const rho = Math.hypot(p[0], p[1]);
    return { distance_mm: rho - rc, normal: rho < 1e-12 ? [1, 0, 0] : [p[0] / rho, p[1] / rho, 0] };
  };
const scaled = (c: RodContact, k: number): RodContact => (p, reach) => {
  const q = c([p[0] / k, p[1] / k, p[2] / k], reach / k);
  return q ? { distance_mm: q.distance_mm * k, normal: q.normal } : null;
};

describe('scaling every length by 3 scales the answer by 3', () => {
  const check = (a: RodInput, b: RodInput, opt1: object, opt2: object) => {
    const s1 = settleRod(a, opt1);
    const s3 = settleRod(b, opt2);
    expect(s1.converged).toBe(true);
    expect(s3.converged).toBe(true);
    expect(s3.points.length).toBe(s1.points.length);
    for (let i = 0; i < s1.points.length; i++) expect(dist(s3.points[i]!, s1.points[i]!.map((v) => 3 * v))).toBeLessThan(3e-3);
    expect(rel(s3.length_mm, 3 * s1.length_mm)).toBeLessThan(1e-4);
    expect(rel(s3.min_radius_mm, 3 * s1.min_radius_mm)).toBeLessThan(2e-3);
  };

  it('a laid wire over a cylinder', () => {
    const R = 30.78;
    const path = (k: number): Vec3[] => Array.from({ length: 21 }, (_, i) => {
      const t = (Math.PI / 2) * (i / 20);
      return [k * R * Math.cos(t), k * R * Math.sin(t), 0];
    });
    const base = (k: number): RodInput => ({
      path: path(k),
      pins: [{ index: 0, tangent: [0, 1, 0] }, { index: 20, tangent: [-1, 0, 0] }],
      radius_mm: k * 0.78,
      mode: { kind: 'laid', bend_length_mm: k * 3 },
      contact: k === 1 ? cylinder(30) : scaled(cylinder(30), k),
    });
    check(base(1), base(3), { spacing_mm: 1.5 }, { spacing_mm: 4.5 });
  });

  it('a cut loop hanging under gravity', () => {
    const base = (k: number): RodInput => ({
      path: [[0, 0, 0], [k * 40, 0, 0]],
      pins: [],
      radius_mm: k,
      mode: { kind: 'cut', lengths_mm: [k * 60] },
      gravity: { up: [0, 0, 1], sag_length_mm: k * 30 },
    });
    check(base(1), base(3), { spacing_mm: 2 }, { spacing_mm: 6 });
  });
});

// ---------------------------------------------------------------- a sphere

describe('laid over a sphere between two pins a quarter of a great circle apart', () => {
  const lam = 3;
  const r = 0.78;
  const Rs = 10 * lam; // 30 mm
  const R = Rs + r; // the centre line lies on the sphere of radius 30.78
  const sphere: RodContact = (p) => {
    const rho = Math.hypot(p[0], p[1], p[2]);
    return { distance_mm: rho - Rs, normal: rho < 1e-12 ? [1, 0, 0] : [p[0] / rho, p[1] / rho, p[2] / rho] };
  };

  it('the pins are returned exactly', () => {
    const a: Vec3 = [R, 0, 0];
    const b: Vec3 = [0, R, 0];
    const path: Vec3[] = [a, [R * Math.cos(Math.PI / 4), R * Math.sin(Math.PI / 4), 0], b];
    const s = settleRod({ path, pins: [{ index: 0 }, { index: 2 }], radius_mm: r, mode: { kind: 'laid', bend_length_mm: lam }, contact: sphere });
    expect(s.points[s.pin_indices[0]!]).toEqual(a);
    expect(s.points[s.pin_indices[1]!]).toEqual(b);
  });

  it('follows the great circle: radius Rc + r, in its plane, length (pi / 2) R', () => {
    // The start wanders 1.2 mm out of the plane z = 0, in a bump, at radius R (outside solid).
    const path: Vec3[] = Array.from({ length: 21 }, (_, i) => {
      const t = (Math.PI / 2) * (i / 20);
      const z = 1.2 * Math.sin((Math.PI * i) / 20);
      const rho = Math.hypot(R * Math.cos(t), R * Math.sin(t), z);
      const f = R / rho;
      return [R * Math.cos(t) * f, R * Math.sin(t) * f, z * f];
    });
    const s = settleRod({ path, pins: [{ index: 0 }, { index: 20 }], radius_mm: r, mode: { kind: 'laid', bend_length_mm: lam }, contact: sphere });
    expect(s.converged).toBe(true);
    expect(s.points[0]).toEqual(path[0]);
    expect(dist(s.points[s.pin_indices[1]!]!, path[20]!)).toBeLessThan(1e-9);
    // the same pin, bit for bit (it sits on the surface only to rounding: x = 1.88e-15, z = 1.4e-16)
    expect(s.points[s.pin_indices[1]!]).toEqual(path[20]);
    for (const p of s.points) {
      expect(Math.abs(p[2]), 'out of the great-circle plane').toBeLessThan(0.1);
      expect(Math.abs(Math.hypot(p[0], p[1], p[2]) - R), 'radius from the centre').toBeLessThan(0.05);
    }
    for (let i = 1; i < s.points.length - 1; i++) expect(rel(s.radius_mm[i]!, R), `radius ${i}`).toBeLessThan(0.03);
    expect(rel(s.length_mm, (Math.PI / 2) * R)).toBeLessThan(2e-3);
    expect(s.worst_penetration_mm).toBe(0);
  });
});

// ---------------------------------------------------------------- contact honesty and pins

/** Exact signed distance to an axis-aligned box. */
function boxDistance(p: readonly number[], lo: Vec3, hi: Vec3): number {
  const q = [0, 1, 2].map((i) => Math.max(lo[i]! - p[i]!, p[i]! - hi[i]!));
  const out = Math.hypot(Math.max(q[0]!, 0), Math.max(q[1]!, 0), Math.max(q[2]!, 0));
  return out > 0 ? out : Math.max(q[0]!, q[1]!, q[2]!);
}
function boxContact(lo: Vec3, hi: Vec3): RodContact {
  return (p) => {
    const q = [0, 1, 2].map((i) => Math.max(lo[i]! - p[i]!, p[i]! - hi[i]!));
    const sg = [0, 1, 2].map((i) => (p[i]! < lo[i]! ? -1 : p[i]! > hi[i]! ? 1 : p[i]! - lo[i]! < hi[i]! - p[i]! ? -1 : 1));
    const out = Math.hypot(Math.max(q[0]!, 0), Math.max(q[1]!, 0), Math.max(q[2]!, 0));
    if (out > 0) return { distance_mm: out, normal: [0, 1, 2].map((i) => (Math.max(q[i]!, 0) * sg[i]!) / out) as Vec3 };
    let k = 0;
    if (q[1]! > q[k]!) k = 1;
    if (q[2]! > q[k]!) k = 2;
    const n: Vec3 = [0, 0, 0];
    n[k] = sg[k]!;
    return { distance_mm: q[k]!, normal: n };
  };
}

describe('contact honesty over 50 seeded random boxes', () => {
  const radius = 1;
  const rand = rng(20261121);
  const cases = Array.from({ length: 50 }, (_, i) => {
    const centre: V = [rand() * 20 - 10, rand() * 20 - 10, rand() * 20 - 10];
    const half: V = [4 + rand() * 8, 4 + rand() * 8, 4 + rand() * 8];
    const lo = [0, 1, 2].map((k) => centre[k]! - half[k]!) as Vec3;
    const hi = [0, 1, 2].map((k) => centre[k]! + half[k]!) as Vec3;
    // pins outside the box on opposite sides, along a random axis, at least 3 mm clear
    const axis = Math.floor(rand() * 3);
    const gap = 3 + rand() * 8;
    const a = [...centre] as V;
    const b = [...centre] as V;
    a[axis] = lo[axis]! - gap;
    b[axis] = hi[axis]! + gap;
    for (let k = 0; k < 3; k++) {
      if (k !== axis) {
        a[k]! += (rand() - 0.5) * half[k]!;
        b[k]! += (rand() - 0.5) * half[k]!;
      }
    }
    return { i, lo, hi, a: a as Vec3, b: b as Vec3 };
  });

  it.each(cases.map((c) => [c.i, c] as const))('case %d', (_i, c) => {
    const contact = boxContact(c.lo, c.hi);
    const path: Vec3[] = Array.from({ length: 13 }, (_, k) => [0, 1, 2].map((m) => c.a[m]! + ((c.b[m]! - c.a[m]!) * k) / 12) as Vec3);
    const s = settleRod({ path, pins: [{ index: 0 }, { index: 12 }], radius_mm: radius, mode: { kind: 'laid', bend_length_mm: 4 }, contact });
    // pins are exactly where they were put
    expect(s.points[s.pin_indices[0]!]).toEqual(path[0]);
    expect(s.points[s.pin_indices[1]!]).toEqual(path[12]);
    let worst = 0;
    for (const p of s.points) worst = Math.max(worst, radius - boxDistance(p, c.lo, c.hi));
    if (s.converged) {
      for (const p of s.points) expect(boxDistance(p, c.lo, c.hi)).toBeGreaterThanOrEqual(radius - 2e-3);
    }
    // the penetration it reports is the truth, converged or not
    if (worst > 1e-3) expect(Math.abs(s.worst_penetration_mm - worst)).toBeLessThan(1e-6 + 1e-6 * worst);
    else expect(s.worst_penetration_mm).toBeLessThanOrEqual(1e-3 + 1e-9);
  });
});

describe('pins are returned exactly', () => {
  it('an interior pin with a held direction and a laid wire', () => {
    const path: Vec3[] = [[0, 0, 0], [10, 3, 0], [20, -2, 1], [30, 0, 0], [40, 5, 0]];
    const s = settleRod({
      path,
      pins: [{ index: 0 }, { index: 2, tangent: [1, 0, 0] }, { index: 4 }],
      radius_mm: 1,
      mode: { kind: 'laid', bend_length_mm: 6 },
    });
    expect(s.pin_indices).toHaveLength(3);
    expect(s.points[s.pin_indices[0]!]).toEqual(path[0]);
    expect(s.points[s.pin_indices[1]!]).toEqual(path[2]);
    expect(s.points[s.pin_indices[2]!]).toEqual(path[4]);
  });
});

// ---------------------------------------------------------------- documented failures

describe('the documented failure cases give an honest answer without hanging', () => {
  const finite = (s: RodShape) => {
    for (const p of s.points) for (const v of p) expect(Number.isFinite(v)).toBe(true);
    expect(Number.isFinite(s.length_mm)).toBe(true);
  };

  it('a cut length that cannot get round an obstacle: not converged, finite', () => {
    // A 40 x 40 x 40 box between pins 70 mm apart through its centre; going round needs
    // at least 2 x sqrt(35^2 + 20^2) = 80.6 mm, and the cut length is 72.
    const contact = boxContact([-20, -20, -20], [20, 20, 20]);
    const t0 = performance.now();
    const s = settleRod({
      path: [[-35, 0, 0], [35, 0, 0]],
      pins: [],
      radius_mm: 1,
      mode: { kind: 'cut', lengths_mm: [72] },
      contact,
    });
    timings.push(`cut length too short to get round: ${(performance.now() - t0).toFixed(0)} ms, converged ${s.converged}, penetration ${s.worst_penetration_mm.toFixed(2)}`);
    finite(s);
    expect(s.converged).toBe(false);
    expect(s.worst_penetration_mm).toBeGreaterThan(1e-3);
  }, 20_000);

  it('laid with gravity in free air: not converged, finite', () => {
    const t0 = performance.now();
    const s = settleRod({
      // starts hanging 100 mm below its pins: more than l_g^3 / lambda^2 = 1000 / 25 = 40 mm
      path: [[0, 0, 0], [20, 0, -100], [40, 0, 0]],
      pins: [{ index: 0 }, { index: 2 }],
      radius_mm: 1,
      mode: { kind: 'laid', bend_length_mm: 5 },
      gravity: { up: [0, 0, 1], sag_length_mm: 10 },
    });
    timings.push(`laid with gravity in free air: ${(performance.now() - t0).toFixed(0)} ms, converged ${s.converged}, ${s.points.length} points`);
    finite(s);
    expect(s.converged).toBe(false);
  }, 20_000);

  it('reports the times', () => {
    console.info(timings.join('\n'));
    expect(timings.length).toBeGreaterThan(0);
  });
});
