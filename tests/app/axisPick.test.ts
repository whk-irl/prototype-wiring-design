/**
 * Axis picking on realistic CAD shapes: the region the fit uses must be ONE
 * surface even where fillets and chamfers join it smoothly to its neighbours,
 * and a flat face only fixes the axis position when it is round.
 */
import { describe, expect, it } from 'vitest';
import { BufferGeometry, Float32BufferAttribute, Matrix4, Quaternion, Vector3 } from 'three';
import { fitAxis, fitAxisFromSeed, SMOOTH_REGION_DEG, type AxisFit } from '../../src/app/placement/axisFit';
import { floodRegion, topologyOf } from '../../src/app/scene/topology';

type P2 = [number, number];
interface Built {
  positions: number[];
  index: number[];
}

/** Revolve a closed or open profile of (r, z) points about +Z. r = 0 points become a single pole. */
function lathe(profile: P2[], seg: number, closed: boolean): Built {
  const positions: number[] = [];
  const index: number[] = [];
  const rows: number[][] = profile.map(([r, z]) => {
    if (r === 0) {
      positions.push(0, 0, z);
      const i = positions.length / 3 - 1;
      return Array.from({ length: seg }, () => i);
    }
    return Array.from({ length: seg }, (_, j) => {
      const a = (j / seg) * 2 * Math.PI;
      positions.push(r * Math.cos(a), r * Math.sin(a), z);
      return positions.length / 3 - 1;
    });
  });
  const n = profile.length;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const A = rows[i]!;
    const B = rows[(i + 1) % n]!;
    for (let j = 0; j < seg; j++) {
      const a = A[j]!;
      const b = A[(j + 1) % seg]!;
      const c = B[j]!;
      const d = B[(j + 1) % seg]!;
      if (a !== b) index.push(a, b, d);
      if (c !== d) index.push(a, d, c);
    }
  }
  return { positions, index };
}

/** Extrude a 2D polyline in XY along +Z (rings + 1 rows). */
function extrude(poly: P2[], length: number, rings: number, closed: boolean): Built {
  const positions: number[] = [];
  const index: number[] = [];
  const m = poly.length;
  for (let i = 0; i <= rings; i++) for (const [x, y] of poly) positions.push(x, y, (i / rings) * length);
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < (closed ? m : m - 1); j++) {
      const a = i * m + j;
      const b = i * m + ((j + 1) % m);
      const c = (i + 1) * m + j;
      const d = (i + 1) * m + ((j + 1) % m);
      index.push(a, b, d, a, d, c);
    }
  }
  return { positions, index };
}

function arcPoints(r: number, a0: number, a1: number, n: number): P2[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = a0 + ((a1 - a0) * i) / n;
    return [r * Math.cos(a), r * Math.sin(a)] as P2;
  });
}

const D = Math.PI / 180;

/** Fillet arc from (r0, z0) tangent along z, quarter turn, `steps` facets. */
function filletPinEnd(r: number, f: number, z0: number, steps: number, up: boolean): P2[] {
  const pts: P2[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * 90 * D;
    // centre at (r - f, z0 -/+ ...)
    const zc = up ? z0 : z0;
    pts.push([r - f + f * Math.cos(t), up ? zc + f * Math.sin(t) : zc - f * Math.sin(t)]);
  }
  return pts;
}

function filletedPin(r: number, L: number, f: number): Built {
  const bottom = filletPinEnd(r, f, f, 8, false).reverse(); // from (r - f, 0) up to (r, f)
  const top = filletPinEnd(r, f, L - f, 8, true); // from (r, L - f) to (r - f, L)
  return lathe([[0, 0], ...bottom, ...top, [0, L]], 48, false);
}

function chamferedPin(r: number, L: number, c: number, angleDeg: number): Built {
  const dr = c * Math.tan(angleDeg * D);
  return lathe(
    [
      [0, 0],
      [r - dr, 0],
      [r, c],
      [r, L - c],
      [r - dr, L],
      [0, L],
    ],
    48,
    false,
  );
}

function shaftIntoBlock(r: number, R: number, H: number, L: number, f: number): Built {
  const fil: P2[] = [];
  for (let i = 0; i <= 8; i++) {
    const t = (i / 8) * 90 * D;
    fil.push([r + f - f * Math.sin(t), H + f - f * Math.cos(t)]);
  }
  return lathe([[0, 0], [R, 0], [R, H], ...fil, [r, H + L], [0, H + L]], 48, false);
}

function chamferedHole(r: number, R: number, t: number, c: number): Built {
  return lathe(
    [
      [R, 0],
      [r, 0],
      [r, t - c],
      [r + c, t],
      [R, t],
    ],
    48,
    true,
  );
}

function keyedHole(r: number, t: number, w: number, depth: number): Built {
  const a = Math.asin(w / r);
  const poly: P2[] = [...arcPoints(r, a, 2 * Math.PI - a, 46), [r + depth, -w], [r + depth, w]];
  return extrude(poly, t, 4, true);
}

/** Seed: the triangle whose centroid is nearest `p`. */
function seedNear(b: Built, p: [number, number, number]): number {
  let best = -1;
  let bd = Infinity;
  for (let t = 0; t < b.index.length / 3; t++) {
    const c = [0, 1, 2].map((k) => {
      let s = 0;
      for (let v = 0; v < 3; v++) s += b.positions[3 * b.index[3 * t + v]! + k]!;
      return s / 3;
    });
    // ignore degenerate triangles
    const d = Math.hypot(c[0]! - p[0], c[1]! - p[1], c[2]! - p[2]);
    if (d < bd) {
      bd = d;
      best = t;
    }
  }
  return best;
}

/** Place a mesh with a seeded random rigid transform; return transformed copy and the transform. */
function place(b: Built, seed: number): Built & { m: Matrix4 } {
  let s = seed >>> 0;
  const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const q = new Quaternion().setFromAxisAngle(new Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize(), r() * 6);
  const m = new Matrix4().compose(new Vector3(r() * 300 - 150, r() * 300 - 150, r() * 300 - 150), q, new Vector3(1, 1, 1));
  const out: number[] = [];
  for (let i = 0; i < b.positions.length; i += 3) {
    const v = new Vector3(b.positions[i], b.positions[i + 1], b.positions[i + 2]).applyMatrix4(m);
    out.push(v.x, v.y, v.z);
  }
  return { positions: out, index: b.index, m };
}

function geometry(b: Built): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(b.positions, 3));
  g.setIndex(b.index);
  return g;
}

/** Fit from a seed near `local` (in the unplaced frame) on the placed mesh. */
function pick(b: Built, local: [number, number, number], seed = 7): { fit: AxisFit; m: Matrix4 } {
  const placed = place(b, seed);
  const tri = seedNear(b, local);
  const fit = fitAxisFromSeed(topologyOf(geometry(placed)), tri)!;
  return { fit, m: placed.m };
}

/** Check against the true axis (+Z through the origin, in the unplaced frame). */
function expectAxis(fit: AxisFit, m: Matrix4, radius: number): void {
  const dir = new Vector3(0, 0, 1).transformDirection(m);
  const p0 = new Vector3(0, 0, 0).applyMatrix4(m);
  const d = new Vector3(...fit.dir).normalize();
  const angle = Math.acos(Math.min(1, Math.abs(d.dot(dir)))) / D;
  const w = new Vector3(...fit.point).sub(p0);
  const line = w.clone().sub(dir.clone().multiplyScalar(w.dot(dir))).length();
  expect(fit.quality, fit.note).toBe('good');
  expect(fit.position).toBe('determined');
  expect(angle).toBeLessThan(0.1);
  expect(line).toBeLessThan(0.05);
  expect(Math.abs(fit.radius - radius) / radius).toBeLessThan(0.01);
}

describe('axis picking on CAD shapes (good axes)', () => {
  it('pin with filleted ends: click on the cylinder', () => {
    const { fit, m } = pick(filletedPin(10, 40, 2), [10, 0, 20]);
    expectAxis(fit, m, 10);
    expect(fit.kind).toBe('cylinder');
  });

  it('the old 40 degree flood leaks over a tangent fillet (why picking grows by model)', () => {
    const b = filletedPin(10, 40, 2);
    const g = geometry(b);
    const region = floodRegion(g, seedNear(b, [10, 0, 20]), SMOOTH_REGION_DEG * D);
    const old = fitAxis(b.positions, b.index, region)!;
    expect(Math.abs(old.radius - 10) / 10 > 0.01 || old.quality !== 'good').toBe(true);
  });

  for (const angle of [30, 45]) {
    it(`pin with ${angle} degree chamfers`, () => {
      const { fit, m } = pick(chamferedPin(6, 30, 1.2, angle), [6, 0, 15]);
      expectAxis(fit, m, 6);
    });
  }

  it('shaft filleted into a larger body', () => {
    const { fit, m } = pick(shaftIntoBlock(8, 25, 10, 30, 3), [8, 0, 30]);
    expectAxis(fit, m, 8);
  });

  it('hole with a chamfered mouth', () => {
    const { fit, m } = pick(chamferedHole(6, 30, 8, 1), [-6, 0, 3]);
    expectAxis(fit, m, 6);
  });

  it('hole interrupted by a keyway', () => {
    const { fit, m } = pick(keyedHole(6, 8, 1.5, 2.5), [-6, 0, 4]);
    expectAxis(fit, m, 6);
  });

  it('hole through a thin plate', () => {
    const { fit, m } = pick(
      lathe(
        [
          [20, 0],
          [5, 0],
          [5, 1.5],
          [20, 1.5],
        ],
        32,
        true,
      ),
      [-5, 0, 0.75],
    );
    expectAxis(fit, m, 5);
  });

  it('washer-like short cylinder', () => {
    const { fit, m } = pick(
      lathe(
        [
          [4, 0],
          [8, 0],
          [8, 1.5],
          [4, 1.5],
        ],
        40,
        true,
      ),
      [8, 0, 0.75],
    );
    expectAxis(fit, m, 8);
  });

  it('coarse 8-facet cylinder', () => {
    const { fit, m } = pick(
      lathe(
        [
          [0, 0],
          [5, 0],
          [5, 20],
          [0, 20],
        ],
        8,
        false,
      ),
      [4.6, 1.9, 10],
    );
    expectAxis(fit, m, 5);
  });

  it('60 degree partial arc', () => {
    const { fit, m } = pick(extrude(arcPoints(8, 0, 60 * D, 6), 20, 3, false), [8 * Math.cos(30 * D), 8 * Math.sin(30 * D), 10]);
    expectAxis(fit, m, 8);
  });
});

describe('axis picking: not an axis', () => {
  it('a click on a fillet is not a usable axis', () => {
    // fillet centre line at 45 degrees on the bottom fillet
    const r = 10;
    const f = 2;
    const { fit } = pick(filletedPin(r, 40, f), [r - f + f * Math.cos(45 * D), 0, f - f * Math.sin(45 * D)]);
    expect(fit.quality).toBe('poor');
  });

  it('a click on a chamfer is not a usable axis', () => {
    const c = 1.2;
    const dr = c * Math.tan(45 * D);
    const { fit } = pick(chamferedPin(6, 30, c, 45), [6 - dr / 2, 0, c / 2]);
    expect(fit.quality).toBe('poor');
  });
});

describe('flat faces', () => {
  function grid(w: number, h: number, nx: number, ny: number): Built {
    const positions: number[] = [];
    const index: number[] = [];
    for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) positions.push(-w / 2 + (w * i) / nx, -h / 2 + (h * j) / ny, 0);
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const a = j * (nx + 1) + i;
        index.push(a, a + 1, a + nx + 2, a, a + nx + 2, a + nx + 1);
      }
    return { positions, index };
  }
  const all = (b: Built) => Array.from({ length: b.index.length / 3 }, (_, i) => i);

  it('an 80 x 10 rectangle gives a direction but no position', () => {
    const b = grid(80, 10, 8, 2);
    const fit = fitAxis(b.positions, b.index, all(b))!;
    expect(fit.kind).toBe('flat');
    expect(fit.quality).toBe('poor');
    expect(fit.position).toBe('guess');
    const picked = fitAxisFromSeed(topologyOf(geometry(b)), 3)!;
    expect(picked.position).toBe('guess');
  });

  it('a single narrow strip of a cylinder is not a round face', () => {
    const b = lathe(
      [
        [10, 0],
        [10, 40],
      ],
      48,
      false,
    );
    const fit = fitAxis(b.positions, b.index, [0, 1])!;
    expect(fit.position).toBe('guess');
    expect(fit.quality).toBe('poor');
  });

  it('a disc and a ring are round: axis through the centre', () => {
    const disc = lathe(
      [
        [0, 0],
        [15, 0],
      ],
      64,
      false,
    );
    const ring = lathe(
      [
        [6, 0],
        [15, 0],
      ],
      64,
      false,
    );
    for (const b of [disc, ring]) {
      const placed = place(b, 3);
      const fit = fitAxis(placed.positions, placed.index, all(placed))!;
      expect(fit.kind).toBe('flat');
      expectAxis(fit, placed.m, 15);
    }
  });
});
