// settleRod: a stiff wire as an inextensible elastic rod with contact, laid
// tension and gravity. Every expected value below is worked out by hand (or by
// an independent closed form) in the comments, or comes from relaxSpan
// (span.ts), never from settleRod itself.
import { describe, expect, it } from 'vitest';
import { relaxSpan, settleRod, type RodContact, type RodInput, type RodOptions, type RodShape, type Vec3 } from '@core';

const rel = (got: number, want: number) => Math.abs(got - want) / Math.abs(want);

function bulgeOf(pts: Vec3[]): number {
  const a = pts[0]!;
  const b = pts[pts.length - 1]!;
  const c = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const cl2 = c[0]! * c[0]! + c[1]! * c[1]! + c[2]! * c[2]!;
  let best = 0;
  for (const p of pts) {
    const r = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
    let t = cl2 > 0 ? (r[0]! * c[0]! + r[1]! * c[1]! + r[2]! * c[2]!) / cl2 : 0;
    t = Math.min(1, Math.max(0, t));
    best = Math.max(best, Math.hypot(r[0]! - t * c[0]!, r[1]! - t * c[1]!, r[2]! - t * c[2]!));
  }
  return best;
}

function expectFinite(s: RodShape): void {
  for (const p of s.points) for (const v of p) expect(Number.isFinite(v)).toBe(true);
  expect(Number.isFinite(s.length_mm)).toBe(true);
  for (const r of s.radius_mm) expect(Number.isNaN(r)).toBe(false);
  expect(Number.isNaN(s.min_radius_mm)).toBe(false);
  expect(Number.isFinite(s.worst_penetration_mm)).toBe(true);
  expect(s.touching.length).toBe(s.points.length);
  expect(s.radius_mm.length).toBe(s.points.length);
}

const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// ---- analytic contact functions --------------------------------------------

/** 90° wedge: solid x<0 and z<0, edge along y. */
const wedge: RodContact = (p) => {
  const [x, , z] = p;
  if (x <= 0 && z <= 0) return -x < -z ? { distance_mm: x, normal: [1, 0, 0] } : { distance_mm: z, normal: [0, 0, 1] };
  if (x <= 0) return { distance_mm: z, normal: [0, 0, 1] };
  if (z <= 0) return { distance_mm: x, normal: [1, 0, 0] };
  const d = Math.hypot(x, z);
  return { distance_mm: d, normal: [x / d, 0, z / d] };
};

/** Zero-thickness plate: the half plane z = 0, x < 0; edge along y. */
const plate: RodContact = (p) => {
  const [x, , z] = p;
  if (x <= 0) return { distance_mm: Math.abs(z), normal: [0, 0, z >= 0 ? 1 : -1] };
  const d = Math.hypot(x, z);
  return { distance_mm: d, normal: [x / d, 0, z / d] };
};

/** Solid cylinder of radius rc about the z axis. */
const cylinder =
  (rc: number): RodContact =>
  (p) => {
    const rho = Math.hypot(p[0], p[1]);
    if (rho < 1e-12) return { distance_mm: -rc, normal: [1, 0, 0] };
    return { distance_mm: rho - rc, normal: [p[0] / rho, p[1] / rho, 0] };
  };

/** Concave corner: floor (solid z<0) and wall (solid x<0); free where x>0 and z>0. */
const corner: RodContact = (p) => {
  const [x, , z] = p;
  if (x >= 0 && z >= 0) return x < z ? { distance_mm: x, normal: [1, 0, 0] } : { distance_mm: z, normal: [0, 0, 1] };
  if (x < 0 && z >= 0) return { distance_mm: x, normal: [1, 0, 0] };
  if (z < 0 && x >= 0) return { distance_mm: z, normal: [0, 0, 1] };
  const h = Math.hypot(x, z);
  return { distance_mm: -h, normal: [-x / h, 0, -z / h] };
};

/** Solid axis-aligned box, exact signed distance. */
function box(lo: Vec3, hi: Vec3): RodContact {
  return (p) => {
    const c = [0, 1, 2].map((i) => (lo[i]! + hi[i]!) / 2);
    const h = [0, 1, 2].map((i) => (hi[i]! - lo[i]!) / 2);
    const q = [0, 1, 2].map((i) => Math.abs(p[i]! - c[i]!) - h[i]!);
    const sgn = [0, 1, 2].map((i) => (p[i]! - c[i]! >= 0 ? 1 : -1));
    const out = Math.hypot(Math.max(q[0]!, 0), Math.max(q[1]!, 0), Math.max(q[2]!, 0));
    if (out > 0) {
      const v = [0, 1, 2].map((i) => Math.max(q[i]!, 0) * sgn[i]!);
      return { distance_mm: out, normal: [v[0]! / out, v[1]! / out, v[2]! / out] };
    }
    let k = 0;
    if (q[1]! > q[k]!) k = 1;
    if (q[2]! > q[k]!) k = 2;
    const n: Vec3 = [0, 0, 0];
    n[k] = sgn[k]!;
    return { distance_mm: q[k]!, normal: n };
  };
}

// ---- 1. cut, no contact, no gravity: agrees with relaxSpan ------------------

describe('cut mode, free span: agrees with relaxSpan', () => {
  const cases: { name: string; a: Vec3; b: Vec3; ta: Vec3; tb: Vec3; L: number }[] = [
    { name: 'opposed ends', a: [0, 0, 0], b: [40, 0, 0], ta: [0, 1, 0], tb: [0, -1, 0], L: 70 },
    { name: 'parallel ends', a: [0, 0, 0], b: [40, 0, 0], ta: [1, 0, 0], tb: [1, 0, 0], L: 60 },
    { name: 'askew ends', a: [0, 0, 0], b: [40, 10, 5], ta: [0, 0.6, 0.8], tb: [0.6, 0, 0.8], L: 70 },
    { name: 'nearly taut', a: [0, 0, 0], b: [50, 0, 0], ta: [0.8, 0.6, 0], tb: [0.8, -0.6, 0], L: 52 },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const s = settleRod({
        path: [c.a, c.b],
        pins: [
          { index: 0, tangent: c.ta },
          { index: 1, tangent: c.tb },
        ],
        radius_mm: 1,
        mode: { kind: 'cut', lengths_mm: [c.L] },
      });
      // Reference: the same elastica from span.ts, finely divided.
      const ref = relaxSpan({ a: c.a, b: c.b, ta: c.ta, tb: c.tb }, c.L, { segments: 100, max_sweeps: 200000, tolerance: 1e-9 });
      expect(s.converged).toBe(true);
      expect(s.reaches).toBe(true);
      expect(Math.abs(s.length_mm - c.L)).toBeLessThan(1e-6);
      expect(rel(s.min_radius_mm, ref.min_radius_mm)).toBeLessThan(0.01);
      expect(rel(bulgeOf(s.points), ref.bulge_mm)).toBeLessThan(0.01);
      expect(dist(s.points[0]!, c.a)).toBe(0);
      expect(dist(s.points[s.points.length - 1]!, c.b)).toBe(0);
    });
  }

  it('a stretch shorter than its chord does not reach and is the straight line', () => {
    const s = settleRod({ path: [[0, 0, 0], [50, 0, 0]], pins: [], radius_mm: 1, mode: { kind: 'cut', lengths_mm: [40] } });
    expect(s.reaches).toBe(false);
    for (const p of s.points) expect(Math.hypot(p[1], p[2])).toBeLessThan(1e-12);
    expect(s.min_radius_mm).toBe(Infinity);
  });
});

// ---- 2. laid, no contact: the straight line --------------------------------

describe('laid mode, nothing to touch: the straight line between pins', () => {
  it('from a wavy start', () => {
    const path: Vec3[] = [];
    for (let i = 0; i <= 60; i++) path.push([i * 2, 8 * Math.sin(i * 0.4), 3 * Math.cos(i * 0.7) - 3]);
    path[0] = [0, 0, 0];
    path[60] = [120, 0, 0];
    const s = settleRod({ path, pins: [], radius_mm: 1, mode: { kind: 'laid', bend_length_mm: 10 } });
    expect(s.converged).toBe(true);
    // Straight from (0,0,0) to (120,0,0): length 120, every point on the x axis.
    expect(Math.abs(s.length_mm - 120)).toBeLessThan(1e-6);
    for (const p of s.points) expect(Math.hypot(p[1], p[2])).toBeLessThan(1e-6);
    expect(s.min_radius_mm).toBeGreaterThan(1e6);
  });

  it('through an interior pin without a held direction: two straight runs', () => {
    // Pins (0,0,0), (50,30,0), (100,0,0): each stretch is straight, length 2·√(50²+30²) = 116.619.
    const path: Vec3[] = [
      [0, 0, 0],
      [20, 5, 5],
      [50, 30, 0],
      [70, 10, -4],
      [100, 0, 0],
    ];
    const s = settleRod({ path, pins: [{ index: 2 }], radius_mm: 1, mode: { kind: 'laid', bend_length_mm: 5 } });
    expect(s.converged).toBe(true);
    expect(s.pin_indices.length).toBe(3);
    expect(dist(s.points[s.pin_indices[1]!]!, [50, 30, 0])).toBe(0);
    // A rod is smooth through the pin, so it rounds the turn there over a few λ:
    // a little longer than the two chords, never shorter.
    expect(s.length_mm).toBeGreaterThan(116.619);
    expect(s.length_mm).toBeLessThan(116.619 * 1.02);
  });
});

// ---- 3. laid over a sharp convex edge ----------------------------------------
//
// Rod under tension T = B/λ²: B θ'' = T sin θ (θ from the far straight run),
// first integral θ' = (2/λ) sin(θ/2), so a side that has turned θ/2 at the
// edge has κ = (2/λ) sin(θ/4) there:
//   θ =  90°: R_min = λ / (2 sin 22.5°) = 1.306563 λ
//   θ = 180°: R_min = λ / (2 sin 45°)   = 0.707107 λ
// This is the limit of pins infinitely far away. With pins at distance D the
// straight run from each pin has to climb to the far-field line of that
// elastica, which is tilted by a small angle β; each side then turns θ/2 + β.
// Solving "distance from the contact point to the line through the pin at
// angle β = 2λ sin((θ/2 + β)/2)" (the elastica's offset from its asymptote)
// for β with λ = 5, r = 0.78 gives, at D = 60λ:
//   θ =  90°: β = 0.01216, R_min = 1.28769 λ   (1.5 % under the limit)
//   θ = 180°: β = 0.02117, R_min = 0.69974 λ   (1.0 % under the limit)
// and at D = 10λ: 1.19450 λ and 0.66431 λ (8.6 % and 6.1 % under the limit:
// "10 λ away" is not far enough for the limit formula to hold to 5 %).
// The centre line touches the offset surface: a cylinder of radius r round the
// edge, so the tightest point sits at distance r from the edge.

describe('laid round a sharp edge', () => {
  const lam = 5;
  const r = 0.78;

  it('90° wedge, pins 60 λ away: R_min = 1.3066 λ (limit) and 1.2877 λ (this distance), within 5 %', () => {
    const D = 60 * lam;
    const s = settleRod({
      path: [
        [-D, 0, r],
        [0, 0, r],
        [r, 0, 0],
        [r, 0, -D],
      ],
      pins: [],
      radius_mm: r,
      mode: { kind: 'laid', bend_length_mm: lam },
      contact: wedge,
    });
    expect(s.converged).toBe(true);
    expect(s.worst_penetration_mm).toBe(0);
    expect(rel(s.min_radius_mm / lam, 1.306563)).toBeLessThan(0.05);
    expect(rel(s.min_radius_mm / lam, 1.28769)).toBeLessThan(0.03);
    // The tightest point is on the rounded edge, r from it, and touching.
    const t = s.points[s.tightest_index]!;
    expect(t[0]).toBeGreaterThan(0);
    expect(t[2]).toBeGreaterThan(0);
    expect(Math.abs(Math.hypot(t[0], t[2]) - r)).toBeLessThan(2e-3);
    expect(s.touching[s.tightest_index]).toBe(true);
    // It lifts off the top face before the edge and comes down to the side
    // face after it: nothing touches between λ/2 and 20 λ from the edge.
    for (let i = 0; i < s.points.length; i++) {
      const p = s.points[i]!;
      const fromEdge = Math.hypot(p[0], p[2]);
      if (fromEdge > 0.5 * lam && fromEdge < 20 * lam) expect(s.touching[i]).toBe(false);
    }
  });

  it('90° wedge, pins 10 λ away: R_min = 1.1945 λ, not the far-pin limit', () => {
    const D = 10 * lam;
    const s = settleRod({
      path: [
        [-D, 0, r],
        [0, 0, r],
        [r, 0, 0],
        [r, 0, -D],
      ],
      pins: [],
      radius_mm: r,
      mode: { kind: 'laid', bend_length_mm: lam },
      contact: wedge,
    });
    expect(s.converged).toBe(true);
    expect(rel(s.min_radius_mm / lam, 1.1945)).toBeLessThan(0.03);
  });

  it('180° round a thin plate edge, pins 60 λ away: R_min = 0.7071 λ (limit) and 0.6997 λ, within 5 %', () => {
    const D = 60 * lam;
    const s = settleRod({
      path: [
        [-D, 0, r],
        [0, 0, r],
        [r, 0, 0],
        [0, 0, -r],
        [-D, 0, -r],
      ],
      pins: [],
      radius_mm: r,
      mode: { kind: 'laid', bend_length_mm: lam },
      contact: plate,
    });
    expect(s.converged).toBe(true);
    expect(s.worst_penetration_mm).toBe(0);
    expect(rel(s.min_radius_mm / lam, 0.707107)).toBeLessThan(0.05);
    expect(rel(s.min_radius_mm / lam, 0.69974)).toBeLessThan(0.03);
    const t = s.points[s.tightest_index]!;
    expect(Math.abs(Math.hypot(t[0], t[2]) - r)).toBeLessThan(2e-3);
    expect(s.touching[s.tightest_index]).toBe(true);
  });

  // Across the cable range (stiffness.ts): λ from 9 to 65 mm, wire radius from
  // 0.06 mm (flat flex) to 4.5 mm, default spacing. Same construction as above
  // at D = 20 λ, with r/λ entering through the contact point r(cos 45°, sin 45°):
  //   λ =  9, r = 0.06: 1.24661 λ     λ =  9, r = 4.5: 1.25833 λ
  //   λ = 65, r = 0.06: 1.24647 λ     λ = 65, r = 4.5: 1.24810 λ
  for (const [lam2, r2, want] of [
    [9, 0.06, 1.24661],
    [9, 4.5, 1.25833],
    [65, 0.06, 1.24647],
    [65, 4.5, 1.2481],
  ] as const) {
    it(`90° wedge across the cable range: λ = ${lam2}, r = ${r2}`, () => {
      const D = 20 * lam2;
      const s = settleRod({
        path: [
          [-D, 0, r2],
          [0, 0, r2],
          [r2, 0, 0],
          [r2, 0, -D],
        ],
        pins: [],
        radius_mm: r2,
        mode: { kind: 'laid', bend_length_mm: lam2 },
        contact: wedge,
      });
      expect(s.converged).toBe(true);
      expect(s.worst_penetration_mm).toBe(0);
      expect(rel(s.min_radius_mm / lam2, want)).toBeLessThan(0.03);
    });
  }
});

// ---- 4. laid round a large cylinder ------------------------------------------

describe('laid round a large cylinder', () => {
  it('hugs it: radius Rc + r, every point touching', () => {
    // Rc = 30 = 10 λ, r = 0.78: the centre line lies on the circle of radius
    // 30.78, a quarter turn of length (π/2)·30.78 = 48.349.
    const lam = 3;
    const r = 0.78;
    const Rc = 30;
    const R = Rc + r;
    const path: Vec3[] = [];
    for (let i = 0; i <= 20; i++) {
      const a = (Math.PI / 2) * (i / 20);
      path.push([R * Math.cos(a), R * Math.sin(a), 0]);
    }
    const s = settleRod({
      path,
      pins: [
        { index: 0, tangent: [0, 1, 0] },
        { index: 20, tangent: [-1, 0, 0] },
      ],
      radius_mm: r,
      mode: { kind: 'laid', bend_length_mm: lam },
      contact: cylinder(Rc),
    });
    expect(s.converged).toBe(true);
    expect(rel(s.min_radius_mm, R)).toBeLessThan(1e-4);
    for (let i = 1; i < s.points.length - 1; i++) {
      expect(rel(s.radius_mm[i]!, R)).toBeLessThan(1e-4);
      expect(s.touching[i]).toBe(true);
    }
    expect(rel(s.length_mm, (Math.PI / 2) * R)).toBeLessThan(1e-3);
    expect(s.worst_penetration_mm).toBe(0);
  });
});

// ---- 5. laid across a concave corner -----------------------------------------

describe('laid across a concave corner', () => {
  it('bridges the corner instead of following the walls into it', () => {
    // Floor z = 0 and wall x = 0. Pins on each, 15 λ from the corner, held along
    // the surfaces toward the corner; the start runs along both into the corner.
    const lam = 4;
    const r = 0.78;
    const s = settleRod({
      path: [
        [60, 0, r],
        [r, 0, r],
        [r, 0, 60],
      ],
      pins: [
        { index: 0, tangent: [-1, 0, 0] },
        { index: 2, tangent: [0, 0, 1] },
      ],
      radius_mm: r,
      mode: { kind: 'laid', bend_length_mm: lam },
      contact: corner,
    });
    expect(s.converged).toBe(true);
    expect(s.worst_penetration_mm).toBe(0);
    let nearest = Infinity;
    for (const p of s.points) {
      // No point is inside the free-space offset (x ≥ r and z ≥ r) beyond tolerance.
      expect(Math.min(p[0], p[2])).toBeGreaterThan(r - 1e-3);
      nearest = Math.min(nearest, Math.hypot(p[0], p[2]));
    }
    // Following the walls would pass r·√2 = 1.1 from the corner line; the
    // bridge passes far wide of it (at least 5 λ).
    expect(nearest).toBeGreaterThan(5 * lam);
    // Only the pins rest on the walls.
    const touching = s.touching.map((b, i) => (b ? i : -1)).filter((i) => i >= 0);
    expect(touching).toEqual([0, s.points.length - 1]);
  });
});

// ---- 6. gravity --------------------------------------------------------------
//
// Catenary of length L = 220 between pins 200 apart at equal height:
// L = 2a sinh(D/2a) → sinh(u)/u = 1.1 with u = D/2a → u = 0.763401,
// a = 130.992790, sag = a (cosh u - 1) = 40.060158.

describe('cut mode under gravity', () => {
  const D = 200;
  const L = 220;
  const CATENARY_SAG = 40.060158;

  it('floppy and heavy (ℓg = 3 mm): the catenary', () => {
    const s = settleRod({
      path: [
        [0, 0, 0],
        [D, 0, 0],
      ],
      pins: [],
      radius_mm: 1,
      mode: { kind: 'cut', lengths_mm: [L] },
      gravity: { up: [0, 0, 1], sag_length_mm: 3 },
    });
    expect(s.converged).toBe(true);
    let low = Infinity;
    for (const p of s.points) low = Math.min(low, p[2]);
    expect(rel(-low, CATENARY_SAG)).toBeLessThan(1e-4);
    // The bottom of a catenary has radius a = 130.993.
    expect(rel(s.min_radius_mm, 130.992790)).toBeLessThan(1e-4);
  });

  it('stiff and light (ℓg = 10 m): the elastica of relaxSpan, hanging down', () => {
    const s = settleRod({
      path: [
        [0, 0, 0],
        [D, 0, 0],
      ],
      pins: [],
      radius_mm: 1,
      mode: { kind: 'cut', lengths_mm: [L] },
      gravity: { up: [0, 0, 1], sag_length_mm: 1e4 },
    });
    const ref = relaxSpan({ a: [0, 0, 0], b: [D, 0, 0], bias: [0, 0, -1] }, L, { segments: 100, max_sweeps: 200000, tolerance: 1e-9 });
    expect(s.converged).toBe(true);
    expect(rel(s.min_radius_mm, ref.min_radius_mm)).toBeLessThan(0.01);
    expect(rel(bulgeOf(s.points), ref.bulge_mm)).toBeLessThan(0.01);
    // Gravity only picks the side: the bulge is straight down.
    let low = Infinity;
    for (const p of s.points) low = Math.min(low, p[2]);
    expect(rel(-low, ref.bulge_mm)).toBeLessThan(0.01);
  });
});

// ---- 7. invariance under a rigid motion ----------------------------------------

function rotation(axis: Vec3, ang: number): number[][] {
  const l = Math.hypot(axis[0], axis[1], axis[2]);
  const [x, y, z] = [axis[0] / l, axis[1] / l, axis[2] / l];
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const C = 1 - c;
  return [
    [c + x * x * C, x * y * C - z * s, x * z * C + y * s],
    [y * x * C + z * s, c + y * y * C, y * z * C - x * s],
    [z * x * C - y * s, z * y * C + x * s, c + z * z * C],
  ];
}

describe('a turned and moved copy gives the turned and moved shape', () => {
  const Rm = rotation([0.3, -0.5, 0.8], 1.234);
  const T: Vec3 = [123.4, -56.7, 89.01];
  const turn = (v: Vec3): Vec3 => [0, 1, 2].map((i) => Rm[i]![0]! * v[0] + Rm[i]![1]! * v[1] + Rm[i]![2]! * v[2]) as Vec3;
  const place = (v: Vec3): Vec3 => {
    const w = turn(v);
    return [w[0] + T[0], w[1] + T[1], w[2] + T[2]];
  };
  const back = (v: Vec3): Vec3 => {
    const w = [v[0] - T[0], v[1] - T[1], v[2] - T[2]];
    return [0, 1, 2].map((i) => Rm[0]![i]! * w[0]! + Rm[1]![i]! * w[1]! + Rm[2]![i]! * w[2]!) as Vec3;
  };
  function moved(inp: RodInput): RodInput {
    const c = inp.contact;
    return {
      ...inp,
      path: inp.path.map(place),
      pins: inp.pins.map((p) => (p.tangent ? { index: p.index, tangent: turn(p.tangent) } : { index: p.index })),
      ...(inp.gravity ? { gravity: { up: turn(inp.gravity.up), sag_length_mm: inp.gravity.sag_length_mm } } : {}),
      ...(c
        ? {
            contact: (p: Vec3, reach: number) => {
              const res = c(back(p), reach);
              return res ? { distance_mm: res.distance_mm, normal: turn(res.normal) } : null;
            },
          }
        : {}),
    };
  }
  function compare(inp: RodInput): void {
    const a = settleRod(inp);
    const b = settleRod(moved(inp));
    expect(a.converged).toBe(true);
    expect(b.converged).toBe(true);
    expect(b.points.length).toBe(a.points.length);
    expect(rel(b.min_radius_mm, a.min_radius_mm)).toBeLessThan(1e-3);
    expect(rel(b.length_mm, a.length_mm)).toBeLessThan(1e-3);
    let worst = 0;
    for (let i = 0; i < a.points.length; i++) worst = Math.max(worst, dist(back(b.points[i]!), a.points[i]!));
    expect(worst / a.length_mm).toBeLessThan(1e-3);
    expect(b.touching).toEqual(a.touching);
  }

  it('over a sharp edge (case 3; pins at 20 λ and 21 λ)', () => {
    // A set-up symmetric about the edge's bisector has two discrete minima of
    // equal standing (the rod on one node at the edge or straddling it with
    // two); a copy computed in another frame may pick the other one. Pins at
    // unequal distances break that tie.
    const lam = 5;
    const r = 0.78;
    compare({
      path: [
        [-20 * lam, 0, r],
        [0, 0, r],
        [r, 0, 0],
        [r, 0, -21 * lam],
      ],
      pins: [],
      radius_mm: r,
      mode: { kind: 'laid', bend_length_mm: lam },
      contact: wedge,
    });
  });

  it('a hanging loop (case 6)', () => {
    compare({
      path: [
        [0, 0, 0],
        [200, 0, 0],
      ],
      pins: [],
      radius_mm: 1,
      mode: { kind: 'cut', lengths_mm: [220] },
      gravity: { up: [0, 0, 1], sag_length_mm: 3 },
    });
  });

  it('is deterministic: the same input gives the same output', () => {
    const inp: RodInput = {
      path: [
        [-60, 0, 0.78],
        [0, 0, 0.78],
        [0.78, 0, 0],
        [0.78, 0, -70],
      ],
      pins: [],
      radius_mm: 0.78,
      mode: { kind: 'laid', bend_length_mm: 5 },
      contact: wedge,
    };
    expect(settleRod(inp)).toEqual(settleRod(inp));
  });
});

// ---- 8. degenerate inputs ------------------------------------------------------

describe('degenerate inputs do not throw and give finite output', () => {
  const floor: RodContact = (p) => ({ distance_mm: p[2], normal: [0, 0, 1] });
  const cases: [string, RodInput][] = [
    ['coincident pins, laid', { path: [[1, 2, 3], [1, 2, 3]], pins: [], radius_mm: 1, mode: { kind: 'laid', bend_length_mm: 5 } }],
    ['coincident pins, cut with length', { path: [[1, 2, 3], [1, 2, 3]], pins: [{ index: 0, tangent: [1, 0, 0] }, { index: 1, tangent: [-1, 0, 0] }], radius_mm: 1, mode: { kind: 'cut', lengths_mm: [30] } }],
    ['coincident pins, cut zero length', { path: [[1, 2, 3], [1, 2, 3]], pins: [], radius_mm: 1, mode: { kind: 'cut', lengths_mm: [0] } }],
    ['two-point path', { path: [[0, 0, 0], [10, 0, 0]], pins: [], radius_mm: 1, mode: { kind: 'laid', bend_length_mm: 5 } }],
    ['zero-length interior stretch', { path: [[0, 0, 0], [10, 0, 0], [10, 0, 0], [20, 5, 0]], pins: [{ index: 1 }, { index: 2 }], radius_mm: 1, mode: { kind: 'cut', lengths_mm: [12, 0, 12] } }],
    ['contact null everywhere', { path: [[0, 0, 0], [10, 3, 0], [20, 0, 0]], pins: [], radius_mm: 1, mode: { kind: 'laid', bend_length_mm: 5 }, contact: () => null }],
    ['contact that throws', { path: [[0, 0, 0], [20, 0, 0]], pins: [], radius_mm: 1, mode: { kind: 'cut', lengths_mm: [25] }, contact: () => { throw new Error('boom'); } }],
    ['contact with garbage', { path: [[0, 0, 0], [20, 0, 0]], pins: [], radius_mm: 1, mode: { kind: 'cut', lengths_mm: [25] }, contact: () => ({ distance_mm: NaN, normal: [0, 0, 0] }) }],
    ['start slightly inside solid', { path: [[0, 0, 1], [20, 0, 0.9], [40, 0, 0.95], [60, 0, 1]], pins: [], radius_mm: 1, mode: { kind: 'laid', bend_length_mm: 5 }, contact: floor }],
    ['non-finite path points', { path: [[0, 0, 0], [NaN, 1, 2], [10, Infinity, 0], [20, 0, 0]], pins: [], radius_mm: 1, mode: { kind: 'laid', bend_length_mm: 5 } }],
    ['pins out of range and zero tangent', { path: [[0, 0, 0], [5, 5, 0], [10, 0, 0]], pins: [{ index: -1 }, { index: 7 }, { index: 1, tangent: [0, 0, 0] }], radius_mm: -2, mode: { kind: 'laid', bend_length_mm: -1 } }],
    ['zero up vector and missing lengths', { path: [[0, 0, 0], [5, 5, 0], [10, 0, 0]], pins: [], radius_mm: 1, mode: { kind: 'cut', lengths_mm: [] }, gravity: { up: [0, 0, 0], sag_length_mm: 10 } }],
  ];
  for (const [name, inp] of cases) {
    it(name, () => {
      let s: RodShape | undefined;
      expect(() => {
        s = settleRod(inp);
      }).not.toThrow();
      expectFinite(s!);
      // The pins are where they were put (the first and last points always pinned).
      expect(s!.pin_indices[0]).toBe(0);
      expect(s!.pin_indices[s!.pin_indices.length - 1]).toBe(s!.points.length - 1);
    });
  }

  it('an empty path and a one-point path', () => {
    expect(settleRod({ path: [], pins: [], radius_mm: 1, mode: { kind: 'laid', bend_length_mm: 5 } }).points).toEqual([]);
    const one = settleRod({ path: [[1, 2, 3]], pins: [], radius_mm: 1, mode: { kind: 'laid', bend_length_mm: 5 } });
    expect(one.points).toEqual([[1, 2, 3]]);
  });

  it('a start slightly inside solid ends outside it', () => {
    const s = settleRod({
      path: [
        [0, 0, 1],
        [20, 0, 0.9],
        [40, 0, 0.95],
        [60, 0, 1],
      ],
      pins: [],
      radius_mm: 1,
      mode: { kind: 'laid', bend_length_mm: 5 },
      contact: floor,
    });
    expect(s.converged).toBe(true);
    expect(s.worst_penetration_mm).toBe(0);
    for (const p of s.points) expect(p[2]).toBeGreaterThan(1 - 1e-3);
  });
});

// ---- 9. a start through a solid box ----------------------------------------------

describe('a start that passes through solid', () => {
  it('is pushed out of the box', () => {
    // Box x, y in [-10, 10], z in [-2, 1]; the start runs straight through its
    // middle at z = 0 from x = -40 to x = 40 (pins outside the box).
    const r = 0.78;
    const path: Vec3[] = [];
    for (let i = 0; i <= 80; i++) path.push([-40 + i, 0, 0]);
    const s = settleRod({ path, pins: [], radius_mm: r, mode: { kind: 'laid', bend_length_mm: 4 }, contact: box([-10, -10, -2], [10, 10, 1]) });
    expect(s.worst_penetration_mm).toBeLessThanOrEqual(1e-3);
    expect(s.converged).toBe(true);
    // Every point is at least r from the box (checked here against the exact
    // distance, not the solver's own record).
    const sdf = box([-10, -10, -2], [10, 10, 1]);
    for (const p of s.points) expect(sdf(p, 10)!.distance_mm).toBeGreaterThan(r - 1e-3);
  });
});

// ---- 9b. a loop sunk into overlapping or nested bodies -----------------------------
//
// Several closed bodies that overlap (a drum in a housing). The callback gives
// the signed distance to the nearest face of whichever body has the nearest
// face, as a per-mesh BVH does: a point inside one body but nearer another
// body's outer face is called OUTSIDE. A 139 mm loop whose ends are 1 mm apart
// on the top face has sunk into the bodies (19 of its 21 start points in solid).
// Its length fits outside (above the top face), so it must end there.

type Box = [Vec3, Vec3];
function nearestFaceOf(boxes: Box[], withInside: boolean): RodContact {
  return (p, reach) => {
    let best: { distance_mm: number; normal: Vec3 } | null = null;
    for (const [lo, hi] of boxes) {
      const res = box(lo, hi)(p, Infinity)!;
      if (!best || Math.abs(res.distance_mm) < Math.abs(best.distance_mm)) best = res;
    }
    if (!best || Math.abs(best.distance_mm) > reach) return null;
    if (!withInside) return best;
    return { ...best, inside: boxes.some(([lo, hi]) => box(lo, hi)(p, Infinity)!.distance_mm < 0) };
  };
}
/** Exact distance to the union of the boxes from outside; negative anywhere inside any box. */
function unionDistance(boxes: Box[], p: Vec3): number {
  let d = Infinity;
  for (const [lo, hi] of boxes) {
    const res = box(lo, hi)(p, Infinity)!.distance_mm;
    if (res < 0) return -1;
    d = Math.min(d, res);
  }
  return d;
}

describe('a loop that starts sunk into overlapping or nested bodies', () => {
  const r = 1;
  const L = 139;
  const scenes: [string, Box[]][] = [
    [
      'two overlapping boxes',
      [
        [
          [-20, -10, -10],
          [10, 10, 10],
        ],
        [
          [0, -6, -6],
          [30, 6, 6],
        ],
      ],
    ],
    [
      'a box inside a bigger box',
      [
        [
          [-25, -12, -12],
          [25, 12, 12],
        ],
        [
          [-10, -5, -5],
          [10, 5, 5],
        ],
      ],
    ],
  ];
  function start(boxes: Box[], scale: number, drop: number): Vec3[] {
    // Pins 1 mm apart, 1.5 mm above the top face; a circle of radius
    // 22.1·scale hanging below them, sunk `drop` further into the bodies.
    const top = Math.max(...boxes.map(([, hi]) => hi[2])) + r + 0.5;
    const R = (L / (2 * Math.PI)) * scale;
    const path: Vec3[] = [];
    for (let i = 0; i <= 20; i++) {
      const a = (2 * Math.PI * i) / 20 + Math.PI / 2;
      path.push([R * Math.cos(a), 0, top - R + R * Math.sin(a) - drop]);
    }
    path[0] = [-0.5, 0, top];
    path[20] = [0.5, 0, top];
    return path;
  }
  for (const [name, boxes] of scenes) {
    for (const withInside of [false, true]) {
      for (const [scale, drop] of [
        [0.3, 8],
        [0.45, 2],
        [0.5, 5],
      ] as const) {
        it(`${name}, start scale ${scale} drop ${drop}${withInside ? ', callback says inside' : ''}: ends outside`, () => {
          const path = start(boxes, scale, drop);
          const inside = path.filter((p) => unionDistance(boxes, p) < 0).length;
          expect(inside).toBeGreaterThanOrEqual(11); // mostly inside (11 to 19 of 21)
          const s = settleRod({
            path,
            pins: [
              { index: 0, tangent: [-1, 0, 0] },
              { index: 20, tangent: [-1, 0, 0] },
            ],
            radius_mm: r,
            mode: { kind: 'cut', lengths_mm: [L] },
            contact: nearestFaceOf(boxes, withInside),
          });
          expect(s.converged).toBe(true);
          expect(s.worst_penetration_mm).toBe(0);
          expect(Math.abs(s.length_mm - L)).toBeLessThan(1e-6);
          // Checked against the true distance to the union, not the callback.
          for (const p of s.points) expect(unionDistance(boxes, p)).toBeGreaterThan(r - 1e-3);
          expect(s.points[0]).toEqual(path[0]);
          expect(s.points[s.points.length - 1]).toEqual(path[20]);
        });
      }
    }
  }

  it('without the length to get out: the least penetrating shape seen, never worse with more iterations', () => {
    // Pins at the centres of the top and bottom faces of a 20 mm cube, 1.5 mm
    // off them; 30 mm of wire. Going round the cube from pin to pin needs at
    // least 1.5 + 10 + 20 + 10 + 1.5 = 43 mm, so the wire cannot get out. The
    // start (the straight line through the centre) is 10 + r = 11 mm in.
    const cube = box([-10, -10, -10], [10, 10, 10]);
    let last = Infinity;
    for (const iterations of [5, 20, 80, 200]) {
      const s = settleRod(
        {
          path: [
            [0, 0, 11.5],
            [0, 0, -11.5],
          ],
          pins: [],
          radius_mm: r,
          mode: { kind: 'cut', lengths_mm: [30] },
          contact: cube,
        },
        { max_iterations: iterations },
      );
      expectFinite(s);
      expect(s.converged).toBe(false);
      expect(Math.abs(s.length_mm - 30)).toBeLessThan(1e-6);
      expect(s.worst_penetration_mm).toBeGreaterThan(0);
      expect(s.worst_penetration_mm).toBeLessThan(11);
      expect(s.worst_penetration_mm).toBeLessThanOrEqual(last + 1e-9);
      last = s.worst_penetration_mm;
    }
  });
});

// ---- 10. timing --------------------------------------------------------------------

describe('timing', () => {
  it('600 mm laid wire at 2 mm spacing over a cylinder on a floor', () => {
    // Cylinder radius 60 about the y axis standing on the floor z = -60; the
    // start is glued to the floor and over the top. λ = 20 gives the default
    // spacing 2 mm.
    const Rc = 60;
    const r = 0.78;
    let calls = 0;
    const scene: RodContact = (p) => {
      calls++;
      const rho = Math.hypot(p[0], p[2]);
      const dc = rho - Rc;
      const df = p[2] + Rc;
      if (dc < df) return { distance_mm: dc, normal: rho > 0 ? [p[0] / rho, 0, p[2] / rho] : [0, 0, 1] };
      return { distance_mm: df, normal: [0, 0, 1] };
    };
    const path: Vec3[] = [];
    const zf = -Rc + r;
    for (let x = -250; x <= -Rc - r; x += 5) path.push([x, 0, zf]);
    for (let i = 0; i <= 40; i++) {
      const a = Math.PI - (Math.PI * i) / 40;
      path.push([(Rc + r) * Math.cos(a), 0, (Rc + r) * Math.sin(a)]);
    }
    for (let x = Rc + r; x <= 250; x += 5) path.push([x, 0, zf]);
    path[path.length - 1] = [250, 0, zf];
    const inp: RodInput = { path, pins: [], radius_mm: r, mode: { kind: 'laid', bend_length_mm: 20 }, contact: scene };
    settleRod(inp); // warm up the JIT
    calls = 0;
    const t0 = performance.now();
    const s = settleRod(inp);
    const ms = performance.now() - t0;
    console.log(`600 mm laid wire: ${ms.toFixed(1)} ms, ${s.points.length} points, ${s.iterations} iterations, ${calls} contact calls`);
    expect(s.converged).toBe(true);
    expect(s.worst_penetration_mm).toBe(0);
    expect(ms).toBeLessThan(1200); // budget 300 ms, ×4 for CI
  });

  it('60 mm loop', () => {
    const inp: RodInput = {
      path: [
        [0, 0, 0],
        [40, 0, 0],
      ],
      pins: [
        { index: 0, tangent: [0, 0.6, 0.8] },
        { index: 1, tangent: [0.6, 0, -0.8] },
      ],
      radius_mm: 1,
      mode: { kind: 'cut', lengths_mm: [60] },
      gravity: { up: [0, 0, 1], sag_length_mm: 50 },
    };
    settleRod(inp);
    const t0 = performance.now();
    const s = settleRod(inp);
    const ms = performance.now() - t0;
    console.log(`60 mm loop: ${ms.toFixed(2)} ms, ${s.points.length} points, ${s.iterations} iterations`);
    expect(s.converged).toBe(true);
    expect(ms).toBeLessThan(120); // budget 30 ms, ×4 for CI
  });

  it('a time budget stops early and says so', () => {
    const path: Vec3[] = [];
    for (let i = 0; i <= 60; i++) path.push([i * 2, 8 * Math.sin(i * 0.4), 3 * Math.cos(i * 0.7) - 3]);
    const s = settleRod({ path, pins: [], radius_mm: 1, mode: { kind: 'laid', bend_length_mm: 10 } }, { time_budget_ms: 1e-6 });
    expect(s.converged).toBe(false);
    expectFinite(s);
  });
});

// ---- 11. minima, not saddles -----------------------------------------------------
//
// Discrete energy of a returned shape (the energy the solver minimises, per
// unit B), computed here independently: bending over joints, held directions
// over half a piece, gravity h · height per piece.
function discreteEnergy(pts: readonly Vec3[], lg: number, ta?: Vec3, tb?: Vec3): number {
  const n = pts.length - 1;
  const h: number[] = [];
  const d: number[][] = [];
  for (let i = 0; i < n; i++) {
    const v = [0, 1, 2].map((k) => pts[i + 1]![k]! - pts[i]![k]!);
    const l = Math.hypot(v[0]!, v[1]!, v[2]!);
    h.push(l);
    d.push(v.map((x) => x / l));
  }
  const sq = (a: readonly number[], b: readonly number[]) => (a[0]! - b[0]!) ** 2 + (a[1]! - b[1]!) ** 2 + (a[2]! - b[2]!) ** 2;
  let e = 0;
  for (let i = 0; i + 1 < n; i++) e += sq(d[i + 1]!, d[i]!) / (h[i]! + h[i + 1]!);
  if (ta) e += sq(d[0]!, ta) / h[0]!;
  if (tb) e += sq(d[n - 1]!, tb) / h[n - 1]!;
  for (let i = 0; i < n; i++) e += (h[i]! * 0.5 * (pts[i]![2] + pts[i + 1]![2])) / lg ** 3;
  return e;
}
/** The shape turned by phi about the x axis (the chord from (0,0,0) to (D,0,0)). */
const turnAboutX = (pts: readonly Vec3[], phi: number): Vec3[] =>
  pts.map((p) => [p[0], p[1] * Math.cos(phi) - p[2] * Math.sin(phi), p[1] * Math.sin(phi) + p[2] * Math.cos(phi)]);

describe('a loop that starts above its ends under gravity ends hanging (a minimum, not a saddle)', () => {
  it('ends held level, 70 mm of wire between pins 40 mm apart, ℓg 30, 80, 200 mm', () => {
    for (const lg of [30, 80, 200]) {
      const t: Vec3 = [1, 0, 0];
      const s = settleRod({
        path: [
          [0, 0, 0],
          [10, 0.001, 12],
          [30, 0.001, 12],
          [40, 0, 0],
        ],
        pins: [
          { index: 0, tangent: t },
          { index: 3, tangent: t },
        ],
        radius_mm: 1,
        mode: { kind: 'cut', lengths_mm: [70] },
        gravity: { up: [0, 0, 1], sag_length_mm: lg },
      });
      expect(s.converged).toBe(true);
      // Hanging: nowhere above the line between its ends.
      expect(Math.max(...s.points.map((p) => p[2]))).toBeLessThan(1e-6);
      const E = discreteEnergy(s.points, lg, t, t);
      // No lower than turned about its chord by small and large angles (each
      // an admissible shape: same pins, same lengths, same end directions).
      for (const phi of [0.01, -0.01, 0.3, -0.3, Math.PI / 2, Math.PI]) expect(E).toBeLessThanOrEqual(discreteEnergy(turnAboutX(s.points, phi), lg, t, t) + 1e-12);
    }
  });

  for (const t of [0, 1e-9, 1e-6, 1e-3]) {
    it(`an arch 15 mm above its pins, nudged sideways by ${t} mm, ℓg = 30 mm`, () => {
      const s = settleRod({
        path: [
          [0, 0, 0],
          [20, t, 15],
          [40, 0, 0],
        ],
        pins: [],
        radius_mm: 1,
        mode: { kind: 'cut', lengths_mm: [60] },
        gravity: { up: [0, 0, 1], sag_length_mm: 30 },
      });
      expect(s.converged).toBe(true);
      expect(Math.max(...s.points.map((p) => p[2]))).toBeLessThan(1e-6);
      const E = discreteEnergy(s.points, 30);
      for (const phi of [0.05, -0.05, 1, Math.PI]) expect(E).toBeLessThanOrEqual(discreteEnergy(turnAboutX(s.points, phi), 30) + 1e-12);
    });
  }

  it('the same arch with a floor 10 mm below the pins: it hangs and rests on the floor', () => {
    const r = 1;
    const floor: RodContact = (p) => ({ distance_mm: p[2] + 10, normal: [0, 0, 1] });
    const s = settleRod({
      path: [
        [0, 0, 0],
        [20, 0, 15],
        [40, 0, 0],
      ],
      pins: [],
      radius_mm: r,
      mode: { kind: 'cut', lengths_mm: [60] },
      gravity: { up: [0, 0, 1], sag_length_mm: 30 },
      contact: floor,
    });
    expect(s.converged).toBe(true);
    expect(Math.max(...s.points.map((p) => p[2]))).toBeLessThan(1e-6);
    // Lowest point on the floor: z = -10 + r = -9.
    expect(Math.abs(Math.min(...s.points.map((p) => p[2])) + 9)).toBeLessThan(1e-3);
    expect(s.worst_penetration_mm).toBe(0);
  });
});

// ---- 12. the contact report is the true depth ------------------------------------

describe('worst_penetration_mm is the true largest depth, also when unconverged', () => {
  // A cut wire (63.76 mm between pins 62.6 mm apart) whose start runs through
  // a sphere of radius 23.09 mm; its deepest node is about 16 mm in, far
  // beyond the query reach. The true depth is computed here from the sphere
  // and the returned points.
  const S = 23.086882715579122;
  const sphere: RodContact = (p, reach) => {
    const d = Math.hypot(p[0], p[1], p[2]);
    if (Math.abs(d - S) > reach) return null;
    return { distance_mm: d - S, normal: d > 0 ? [p[0] / d, p[1] / d, p[2] / d] : [0, 0, 1] };
  };
  const inp: RodInput = {
    path: [
      [31.281350248589124, -0.5094119467857416, 0.35423606354153814],
      [20.02535022357832, 0.7497842895317361, -1.027734788140954],
      [17.541559204210355, 3.5684664377457986, 2.410326468446421],
      [7.720040410603348, -2.5962612168859422, 5.465922875910975],
      [-2.323676342262107, -2.3588941770187635, 9.744949969980755],
      [-9.556206047308152, 2.161582040333801, 10.5716658012933],
      [-18.85628384053973, 5.000652388732149, 8.641156882599894],
      [-26.531228639635277, 0.6186565663499348, 8.777670133199411],
      [-31.10003186309973, 2.294409919768384, 12.888532491203062],
    ],
    pins: [{ index: 0, tangent: [0.33592777559533715, -0.0777608307544142, -0.47137820278294384] }, { index: 8 }],
    radius_mm: 0.23615737569435874,
    mode: { kind: 'cut', lengths_mm: [63.76490005439537] },
    contact: sphere,
  };
  for (const opts of [{ max_iterations: 0 }, { max_iterations: 3 }, { max_iterations: 40 }] as RodOptions[]) {
    it(`after ${opts.max_iterations} iterations`, () => {
      const s = settleRod(inp, opts);
      let trueWorst = 0;
      s.points.forEach((p, i) => {
        const depth = inp.radius_mm - (Math.hypot(p[0], p[1], p[2]) - S);
        if (depth > trueWorst) trueWorst = depth;
        expect(s.touching[i]).toBe(depth >= -1e-3);
      });
      expect(trueWorst).toBeGreaterThan(10);
      expect(Math.abs(s.worst_penetration_mm - trueWorst)).toBeLessThan(1e-6 * trueWorst);
    });
  }
});

// ---- 13. cost with many pins and the time budget -----------------------------------

describe('cost and time budget', () => {
  for (const nPins of [101, 401]) {
    it(`laid, ${nPins} pins, about 4000 points`, () => {
      const path: Vec3[] = [];
      for (let i = 0; i < nPins; i++) path.push([(i * 3000) / (nPins - 1), 20 * Math.sin(i), 0]);
      const inp: RodInput = { path, pins: path.map((_, i) => ({ index: i })), radius_mm: 1, mode: { kind: 'laid', bend_length_mm: 20 } };
      const t0 = performance.now();
      const s = settleRod(inp);
      const ms = performance.now() - t0;
      console.log(`laid, ${nPins} pins: ${ms.toFixed(0)} ms, ${s.points.length} points, ${s.iterations} iterations`);
      expect(s.converged).toBe(true);
      expect(ms).toBeLessThan(2000);
    });
  }

  it('a 50 ms budget at 4000 points is overrun by at most one step', () => {
    const path: Vec3[] = [];
    for (let i = 0; i <= 400; i++) path.push([i * 30, 20 * Math.sin(i), 0]);
    const inp: RodInput = { path, pins: [], radius_mm: 1, mode: { kind: 'laid', bend_length_mm: 20 } };
    settleRod(inp, { max_iterations: 1 });
    const t0 = performance.now();
    const s = settleRod(inp, { time_budget_ms: 50 });
    const ms = performance.now() - t0;
    console.log(`4000 points, 50 ms budget: returned after ${ms.toFixed(0)} ms, ${s.iterations} iterations`);
    expect(s.points.length).toBeGreaterThan(3900);
    expectFinite(s);
    expect(ms).toBeLessThan(50 + 250);
  });
});

// ---- 14. holds that (nearly) coincide ----------------------------------------------

describe('pins that nearly coincide', () => {
  it('laid through two holds g apart with a 26.6 degree turn: the tightest bend is continuous in g', () => {
    const radii: number[] = [];
    for (const g of [1e-7, 1e-5, 1e-3, 1e-2, 1e-1]) {
      const s = settleRod({
        path: [
          [0, 0, 0],
          [10, 0, 0],
          [10 + g, 0, 0],
          [20, 5, 0],
        ],
        pins: [{ index: 1 }, { index: 2 }],
        radius_mm: 1,
        mode: { kind: 'laid', bend_length_mm: 5 },
      });
      expect(s.converged).toBe(true);
      expect(s.pin_indices.length).toBe(4);
      radii.push(s.min_radius_mm);
      if (g < 5e-4) expect(s.repaired.some((r) => r.includes('merged'))).toBe(true);
    }
    for (const R of radii) {
      expect(Number.isFinite(R)).toBe(true);
      expect(rel(R, radii[0]!)).toBeLessThan(0.01);
    }
  });

  it('two holds at exactly the same point: one hold, a free pivot, the bend counted', () => {
    const s = settleRod({
      path: [
        [0, 0, 0],
        [10, 0, 0],
        [10, 0, 0],
        [20, 5, 0],
      ],
      pins: [{ index: 1 }, { index: 2 }],
      radius_mm: 1,
      mode: { kind: 'laid', bend_length_mm: 5 },
    });
    expect(s.converged).toBe(true);
    expect(s.pin_indices[1]).toBe(s.pin_indices[2]);
    expect(Number.isFinite(s.min_radius_mm)).toBe(true);
  });

  it('cut, holds 1e-5 mm apart with 2e-5 mm of wire between: merged, no hairpin of zero radius', () => {
    const s = settleRod({
      path: [
        [0, 0, 0],
        [10, 0, 0],
        [10 + 1e-5, 0, 0],
        [20, 5, 0],
      ],
      pins: [{ index: 1 }, { index: 2 }],
      radius_mm: 1,
      mode: { kind: 'cut', lengths_mm: [11, 2e-5, 12] },
    });
    expectFinite(s);
    expect(s.repaired.some((r) => r.includes('merged'))).toBe(true);
    expect(s.min_radius_mm).toBeGreaterThan(0.1);
  });
});

// ---- 15. invariance with a start that tells the sides apart ------------------------

describe('a turned copy of a free loop gives the turned loop', () => {
  it('cut, no gravity, no held directions, a start bowed to one side', () => {
    const c = Math.cos(0.7);
    const sn = Math.sin(0.7);
    const turn = (v: Vec3): Vec3 => [c * v[0] - sn * v[1], sn * v[0] + c * v[1], v[2]];
    const path: Vec3[] = [
      [0, 0, 0],
      [20, 5, 1],
      [40, 0, 0],
    ];
    const a = settleRod({ path, pins: [], radius_mm: 1, mode: { kind: 'cut', lengths_mm: [60] } });
    const b = settleRod({ path: path.map(turn), pins: [], radius_mm: 1, mode: { kind: 'cut', lengths_mm: [60] } });
    expect(b.points.length).toBe(a.points.length);
    let worst = 0;
    for (let i = 0; i < a.points.length; i++) worst = Math.max(worst, dist(turn(a.points[i]!), b.points[i]!));
    expect(worst).toBeLessThan(1e-6);
  });
});

// ---- 16. a cut length barely above the chord ---------------------------------------

describe('a cut length barely above the chord', () => {
  const run = (L: number) =>
    settleRod({
      path: [
        [0, 0, 0],
        [50, 0, 0],
      ],
      pins: [{ index: 0, tangent: [0, 1, 0] }, { index: 1 }],
      radius_mm: 1,
      mode: { kind: 'cut', lengths_mm: [L] },
    });
  it('more than 1e-6 relative slack: converges to the exact length', () => {
    for (const f of [1 + 2e-6, 1 + 1e-5, 1 + 1e-3]) {
      const s = run(50 * f);
      expect(s.converged).toBe(true);
      expect(Math.abs(s.length_mm - 50 * f)).toBeLessThan(1e-9);
      expect(s.min_radius_mm).toBeGreaterThan(0);
    }
  });
  it('less: the straight line, and the forced kink at the held direction reported as radius 0', () => {
    for (const f of [1 + 2e-9, 1 + 5e-7]) {
      const s = run(50 * f);
      expect(s.converged).toBe(true);
      expect(s.reaches).toBe(true);
      expect(Math.abs(s.length_mm - 50)).toBeLessThan(1e-9);
      expect(s.min_radius_mm).toBe(0);
    }
  });
});

// ---- 17. repairs are reported --------------------------------------------------------

describe('repairs to the input are listed', () => {
  it('nothing repaired for a clean input', () => {
    const s = settleRod({
      path: [
        [0, 0, 0],
        [40, 0, 0],
      ],
      pins: [],
      radius_mm: 1,
      mode: { kind: 'cut', lengths_mm: [50] },
    });
    expect(s.repaired).toEqual([]);
  });
  it('a missing cut length, a NaN point and an unusable tangent are each named', () => {
    const s = settleRod({
      path: [
        [0, 0, 0],
        [NaN, 0, 0],
        [20, 5, 0],
        [40, 0, 0],
      ],
      pins: [{ index: 2, tangent: [0, 0, 0] }],
      radius_mm: 1,
      mode: { kind: 'cut', lengths_mm: [25] },
    });
    expectFinite(s);
    expect(s.repaired.some((r) => r.startsWith('path[1]'))).toBe(true);
    expect(s.repaired.some((r) => r.includes('tangent'))).toBe(true);
    expect(s.repaired.some((r) => r.startsWith('lengths_mm[1]'))).toBe(true);
  });
});
