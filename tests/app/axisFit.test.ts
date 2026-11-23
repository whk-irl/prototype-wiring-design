import { describe, expect, it } from 'vitest';
import { BufferGeometry, Float32BufferAttribute, Matrix4, Quaternion, Vector3 } from 'three';
import { fitAxis, SMOOTH_REGION_DEG, type AxisFit } from '../../src/app/placement/axisFit';
import { floodRegion } from '../../src/app/scene/topology';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

interface Mesh {
  positions: number[];
  index: number[];
}

/** Surface of revolution about +Z: radius r(t) for t in [0, len], `seg` facets over `arcDeg`. */
function revolve(rOf: (t: number) => number, length: number, seg: number, rings: number, arcDeg = 360): Mesh {
  const positions: number[] = [];
  const index: number[] = [];
  const full = arcDeg >= 360;
  const cols = full ? seg : seg + 1;
  for (let i = 0; i <= rings; i++) {
    const t = (i / rings) * length;
    const r = rOf(t);
    for (let j = 0; j < cols; j++) {
      const a = (j / seg) * ((arcDeg * Math.PI) / 180);
      positions.push(r * Math.cos(a), r * Math.sin(a), t);
    }
  }
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < seg; j++) {
      const a = i * cols + j;
      const b = i * cols + ((j + 1) % cols);
      const c = (i + 1) * cols + j;
      const d = (i + 1) * cols + ((j + 1) % cols);
      // outward normals
      index.push(a, b, d, a, d, c);
    }
  }
  return { positions, index };
}

/** Closed cylinder: side plus two fan caps sharing the rim vertices. Returns which triangles are side. */
function closedCylinder(r: number, length: number, seg: number): Mesh & { sideCount: number } {
  const side = revolve(() => r, length, seg, 2);
  const positions = [...side.positions];
  const index = [...side.index];
  const sideCount = index.length / 3;
  const cols = seg;
  const bottomCentre = positions.length / 3;
  positions.push(0, 0, 0);
  const topCentre = positions.length / 3;
  positions.push(0, 0, length);
  const topRow = 2 * cols;
  for (let j = 0; j < seg; j++) {
    index.push(bottomCentre, (j + 1) % cols, j);
    index.push(topCentre, topRow + j, topRow + ((j + 1) % cols));
  }
  return { positions, index, sideCount };
}

function disc(rIn: number, rOut: number, seg: number): Mesh {
  const positions: number[] = [];
  const index: number[] = [];
  if (rIn === 0) {
    positions.push(0, 0, 0);
    for (let j = 0; j < seg; j++) positions.push(rOut * Math.cos((j / seg) * 2 * Math.PI), rOut * Math.sin((j / seg) * 2 * Math.PI), 0);
    for (let j = 0; j < seg; j++) index.push(0, 1 + j, 1 + ((j + 1) % seg));
  } else {
    for (let j = 0; j < seg; j++) {
      const a = (j / seg) * 2 * Math.PI;
      positions.push(rIn * Math.cos(a), rIn * Math.sin(a), 0, rOut * Math.cos(a), rOut * Math.sin(a), 0);
    }
    for (let j = 0; j < seg; j++) {
      const i0 = 2 * j;
      const o0 = 2 * j + 1;
      const i1 = 2 * ((j + 1) % seg);
      const o1 = 2 * ((j + 1) % seg) + 1;
      index.push(i0, o0, o1, i0, o1, i1);
    }
  }
  return { positions, index };
}

function sphere(r: number, seg: number, rings: number): Mesh {
  const positions: number[] = [];
  const index: number[] = [];
  for (let i = 0; i <= rings; i++) {
    const phi = 0.15 + (i / rings) * (Math.PI - 0.3);
    for (let j = 0; j < seg; j++) {
      const a = (j / seg) * 2 * Math.PI;
      positions.push(r * Math.sin(phi) * Math.cos(a), r * Math.sin(phi) * Math.sin(a), r * Math.cos(phi));
    }
  }
  for (let i = 0; i < rings; i++)
    for (let j = 0; j < seg; j++) {
      const a = i * seg + j;
      const b = i * seg + ((j + 1) % seg);
      index.push(a, a + seg, b + seg, a, b + seg, b);
    }
  return { positions, index };
}

/** Rigid transform plus noise. Returns the transformed mesh and the true axis (+Z through origin) in that frame. */
function place(m: Mesh, seed: number, noise = 0) {
  const r = rng(seed);
  const axis = new Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize();
  const q = new Quaternion().setFromAxisAngle(axis, r() * 6);
  const t = new Vector3(r() * 400 - 200, r() * 400 - 200, r() * 400 - 200);
  const mat = new Matrix4().compose(t, q, new Vector3(1, 1, 1));
  const out: number[] = [];
  for (let i = 0; i < m.positions.length; i += 3) {
    const v = new Vector3(m.positions[i], m.positions[i + 1], m.positions[i + 2]).applyMatrix4(mat);
    out.push(v.x + (r() - 0.5) * 2 * noise, v.y + (r() - 0.5) * 2 * noise, v.z + (r() - 0.5) * 2 * noise);
  }
  return { positions: out, index: m.index, dir: new Vector3(0, 0, 1).applyQuaternion(q), point: t.clone() };
}

const all = (m: { index: number[] }) => Array.from({ length: m.index.length / 3 }, (_, i) => i);

function angleDeg(a: readonly number[], b: Vector3): number {
  const va = new Vector3(a[0], a[1], a[2]).normalize();
  return (Math.acos(Math.min(1, Math.abs(va.dot(b)))) * 180) / Math.PI;
}

/** Distance between the fitted axis line and the true one, measured at the true point. */
function lineError(fit: AxisFit, point: Vector3, dir: Vector3): number {
  const p = new Vector3(...fit.point);
  const d = new Vector3(...fit.dir).normalize();
  const w = point.clone().sub(p);
  const offAxis = w.clone().sub(d.clone().multiplyScalar(w.dot(d))).length();
  // also check the true axis point lies on the fitted line in the other direction
  const w2 = p.clone().sub(point);
  const off2 = w2.clone().sub(dir.clone().multiplyScalar(w2.dot(dir))).length();
  return Math.max(offAxis, off2);
}

describe('axis fit: cylinders', () => {
  it('fits fine cylinders at arbitrary positions and orientations', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const m = place(revolve(() => 12.5, 40, 48, 4), seed);
      const fit = fitAxis(m.positions, m.index, all(m))!;
      expect(fit.kind).toBe('cylinder');
      expect(angleDeg(fit.dir, m.dir)).toBeLessThan(0.05);
      expect(lineError(fit, m.point, m.dir)).toBeLessThan(0.01);
      expect(fit.radius).toBeCloseTo(12.5, 4);
      expect(fit.quality).toBe('good');
    }
  });

  it('fits coarse 8- and 12-facet cylinders', () => {
    for (const seg of [8, 12]) {
      const m = place(revolve(() => 5, 20, seg, 1), seg);
      const fit = fitAxis(m.positions, m.index, all(m))!;
      expect(angleDeg(fit.dir, m.dir)).toBeLessThan(0.05);
      expect(lineError(fit, m.point, m.dir)).toBeLessThan(0.01);
      expect(fit.radius).toBeCloseTo(5, 6);
      expect(fit.quality).toBe('good');
    }
  });

  it('fits a 120 degree partial arc (half-pipe, slot end)', () => {
    const m = place(revolve(() => 8, 30, 10, 3, 120), 77);
    const fit = fitAxis(m.positions, m.index, all(m))!;
    expect(angleDeg(fit.dir, m.dir)).toBeLessThan(0.05);
    expect(lineError(fit, m.point, m.dir)).toBeLessThan(0.01);
    expect(fit.radius).toBeCloseTo(8, 4);
  });

  it('tolerates small vertex noise', () => {
    const m = place(revolve(() => 10, 40, 48, 6), 9, 0.002);
    const fit = fitAxis(m.positions, m.index, all(m))!;
    expect(angleDeg(fit.dir, m.dir)).toBeLessThan(0.05);
    expect(lineError(fit, m.point, m.dir)).toBeLessThan(0.01);
    expect(Math.abs(fit.radius - 10)).toBeLessThan(0.005);
    expect(fit.quality).toBe('good');
  });
});

describe('axis fit: flat faces', () => {
  it('fits a disc and a ring: normal axis through the centre', () => {
    for (const [rIn, seed] of [
      [0, 3],
      [6, 4],
    ] as const) {
      const m = place(disc(rIn, 15, 64), seed, 0.001);
      const fit = fitAxis(m.positions, m.index, all(m))!;
      expect(fit.kind).toBe('flat');
      expect(angleDeg(fit.dir, m.dir)).toBeLessThan(0.05);
      expect(lineError(fit, m.point, m.dir)).toBeLessThan(0.01);
      expect(Math.abs(fit.radius - 15)).toBeLessThan(0.01);
    }
  });
});

describe('axis fit: rejects what is not a cylinder', () => {
  it('flags a cone', () => {
    const m = place(revolve((t) => 10 + t * 0.4, 30, 48, 6), 5);
    const fit = fitAxis(m.positions, m.index, all(m))!;
    expect(fit.quality).toBe('poor');
    expect(fit.note).toMatch(/cone|taper|round/);
  });
  it('flags a sphere', () => {
    const m = place(sphere(20, 32, 16), 6);
    const fit = fitAxis(m.positions, m.index, all(m))!;
    expect(fit.quality).toBe('poor');
  });
});

describe('smooth-region flood for axis picking', () => {
  function geometry(m: Mesh): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(m.positions, 3));
    g.setIndex(m.index);
    return g;
  }

  it('crosses a tessellated cylinder (30 degree facets) but stops at the end caps', () => {
    const c = closedCylinder(10, 30, 12);
    const region = floodRegion(geometry(c), 0, (SMOOTH_REGION_DEG * Math.PI) / 180);
    expect(new Set(region)).toEqual(new Set(Array.from({ length: c.sideCount }, (_, i) => i)));
    // The default 20 degree crease would not cross the facets.
    const narrow = floodRegion(geometry(c), 0, (20 * Math.PI) / 180);
    expect(narrow.length).toBeLessThan(c.sideCount);
    const fit = fitAxis(c.positions, c.index, region)!;
    expect(angleDeg(fit.dir, new Vector3(0, 0, 1))).toBeLessThan(0.05);
    expect(fit.radius).toBeCloseTo(10, 6);
    expect(fit.point[2]).toBeCloseTo(15, 6);
  });
});
