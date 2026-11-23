import { describe, expect, it } from 'vitest';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { poseToMatrix } from '@core';
import {
  bodyBounds,
  boxesOverlap,
  partWorldMatrix,
  poseFromSurface,
  reparentPose,
  snapAngle,
  surfaceFromPose,
  withSpin,
} from '../../src/app/placement/pose';

/** Deterministic pseudo-random numbers. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function randomUnit(r: () => number): Vector3 {
  for (;;) {
    const v = new Vector3(r() * 2 - 1, r() * 2 - 1, r() * 2 - 1);
    if (v.lengthSq() > 0.01 && v.lengthSq() <= 1) return v.normalize();
  }
}

const SPECIAL_NORMALS = [
  new Vector3(0, 0, 1),
  new Vector3(0, 0, -1), // straight down
  new Vector3(1, 0, 0),
  new Vector3(-1, 0, 0),
  new Vector3(0, 1, 0),
  new Vector3(0, -1, 0),
  new Vector3(0.995, 0.0998, 0).normalize(), // near the reference switch
  new Vector3(1, 1, 1).normalize(),
];

function normals(): Vector3[] {
  const r = rng(7);
  return [...SPECIAL_NORMALS, ...Array.from({ length: 200 }, () => randomUnit(r))];
}

const partZ = (q: readonly number[]) => new Vector3(0, 0, 1).applyQuaternion(new Quaternion(...(q as [number, number, number, number])));
const partX = (q: readonly number[]) => new Vector3(1, 0, 0).applyQuaternion(new Quaternion(...(q as [number, number, number, number])));

describe('surface pose', () => {
  it('aligns part +Z with the surface normal, including straight down', () => {
    for (const n of normals()) {
      const pose = poseFromSurface(new Vector3(1, 2, 3), n, 0.3);
      expect(partZ(pose.q).distanceTo(n)).toBeLessThan(1e-9);
      expect(Math.hypot(...pose.q)).toBeCloseTo(1, 12);
      expect(pose.p_mm).toEqual([1, 2, 3]);
    }
  });

  it('round-trips point, normal and spin', () => {
    const r = rng(11);
    for (const n of normals()) {
      const point = new Vector3(r() * 400 - 200, r() * 400 - 200, r() * 400 - 200);
      const spin = r() * 2 * Math.PI - Math.PI;
      const back = surfaceFromPose(poseFromSurface(point, n, spin));
      expect(back.point.distanceTo(point)).toBeLessThan(1e-9);
      expect(back.normal.distanceTo(n)).toBeLessThan(1e-9);
      expect(Math.abs(Math.atan2(Math.sin(back.spin - spin), Math.cos(back.spin - spin)))).toBeLessThan(1e-9);
    }
  });

  it('turns the part about the normal by the spin difference', () => {
    const r = rng(5);
    for (const n of normals()) {
      const a = r() * 2 * Math.PI;
      const d = r() * Math.PI - Math.PI / 2;
      const p0 = poseFromSurface(new Vector3(), n, a);
      const p1 = withSpin(p0, a + d);
      // normal unchanged
      expect(partZ(p1.q).distanceTo(n)).toBeLessThan(1e-9);
      // +X turned by d about n (right-handed)
      const x0 = partX(p0.q);
      const expected = x0.clone().applyAxisAngle(n, d);
      expect(partX(p1.q).distanceTo(expected)).toBeLessThan(1e-9);
    }
  });

  it('snaps angles to steps and wraps them', () => {
    const step = (15 * Math.PI) / 180;
    expect(snapAngle((14 * Math.PI) / 180, step)).toBeCloseTo(step, 12);
    expect(snapAngle((181 * Math.PI) / 180, step)).toBeCloseTo(Math.PI, 12);
    expect(snapAngle((-181 * Math.PI) / 180, step)).toBeCloseTo(Math.PI, 12);
  });
});

describe('re-parenting', () => {
  it('keeps the world pose when moving a part to another link', () => {
    const r = rng(3);
    for (let i = 0; i < 100; i++) {
      const linkA = new Matrix4().compose(
        new Vector3(r() * 500, r() * 500, r() * 500),
        new Quaternion().setFromAxisAngle(randomUnit(r), r() * 6),
        new Vector3(1, 1, 1),
      );
      const linkB = new Matrix4().compose(
        new Vector3(r() * 500, r() * 500, r() * 500),
        new Quaternion().setFromAxisAngle(randomUnit(r), r() * 6),
        new Vector3(1, 1, 1),
      );
      const pose = poseFromSurface(new Vector3(r() * 100, r() * 100, r() * 100), randomUnit(r), r() * 6);
      const moved = reparentPose(pose, linkA, linkB);
      const before = partWorldMatrix(linkA, pose).elements;
      const after = new Matrix4().multiplyMatrices(linkB, poseToMatrix(moved)).elements;
      for (let k = 0; k < 16; k++) expect(after[k]!).toBeCloseTo(before[k]!, 6);
      expect(Math.hypot(...moved.q)).toBeCloseTo(1, 12);
      expect(moved.q[3]).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('box overlap', () => {
  const at = (x: number, y: number, z: number, rotZ = 0) =>
    new Matrix4().compose(new Vector3(x, y, z), new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), rotZ), new Vector3(1, 1, 1));
  const box = (m: Matrix4) => ({ matrix: m, ...bodyBounds([20, 10, 5]) });

  it('detects overlap and separation', () => {
    expect(boxesOverlap(box(at(0, 0, 0)), box(at(5, 0, 0)))).toBe(true);
    expect(boxesOverlap(box(at(0, 0, 0)), box(at(25, 0, 0)))).toBe(false);
    // rotated 90 degrees: x extent becomes 5, so 14 apart still overlaps 10 + 5
    expect(boxesOverlap(box(at(0, 0, 0)), box(at(14, 0, 0, Math.PI / 2)))).toBe(true);
    expect(boxesOverlap(box(at(0, 0, 0)), box(at(16, 0, 0, Math.PI / 2)))).toBe(false);
  });

  it('does not count face contact once inset', () => {
    const a = { matrix: at(0, 0, 0), ...bodyBounds([20, 10, 5], 0.5) };
    const b = { matrix: at(20, 0, 0), ...bodyBounds([20, 10, 5], 0.5) };
    expect(boxesOverlap(a, b)).toBe(false);
  });
});
