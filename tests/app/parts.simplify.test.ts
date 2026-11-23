import { describe, expect, it } from 'vitest';
import { meshBounds, triangleCount, type PartMesh } from '../../src/app/parts/glb';
import { shareBudget, simplifyMeshes, weldMesh } from '../../src/app/parts/simplify';

/** A UV sphere written the way CAD exports are: every triangle with its own three vertices. */
function sphere(name: string, r_mm: number, centre: [number, number, number], segments: number): PartMesh {
  const vertex = (i: number, j: number): [number, number, number] => {
    const theta = (Math.PI * i) / segments;
    const phi = (2 * Math.PI * j) / segments;
    return [centre[0] + r_mm * Math.sin(theta) * Math.cos(phi), centre[1] + r_mm * Math.sin(theta) * Math.sin(phi), centre[2] + r_mm * Math.cos(theta)];
  };
  const pos: number[] = [];
  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < segments; j++) {
      const a = vertex(i, j), b = vertex(i + 1, j), c = vertex(i + 1, j + 1), d = vertex(i, j + 1);
      if (i > 0) pos.push(...a, ...b, ...d);
      if (i < segments - 1) pos.push(...b, ...c, ...d);
    }
  }
  return { name, positions: Float32Array.from(pos), indices: Uint32Array.from({ length: pos.length / 3 }, (_, k) => k) };
}

/** A box with its faces split into a fine grid: many triangles, flat faces. */
function gridBox(name: string, lo: [number, number, number], hi: [number, number, number], n: number): PartMesh {
  const pos: number[] = [];
  const faces: Array<(u: number, v: number) => [number, number, number]> = [
    (u, v) => [lo[0] + (hi[0] - lo[0]) * u, lo[1] + (hi[1] - lo[1]) * v, hi[2]],
    (u, v) => [lo[0] + (hi[0] - lo[0]) * v, lo[1] + (hi[1] - lo[1]) * u, lo[2]],
    (u, v) => [lo[0] + (hi[0] - lo[0]) * v, hi[1], lo[2] + (hi[2] - lo[2]) * u],
    (u, v) => [lo[0] + (hi[0] - lo[0]) * u, lo[1], lo[2] + (hi[2] - lo[2]) * v],
    (u, v) => [hi[0], lo[1] + (hi[1] - lo[1]) * u, lo[2] + (hi[2] - lo[2]) * v],
    (u, v) => [lo[0], lo[1] + (hi[1] - lo[1]) * v, lo[2] + (hi[2] - lo[2]) * u],
  ];
  for (const f of faces) {
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const a = f(i / n, j / n), b = f((i + 1) / n, j / n), c = f((i + 1) / n, (j + 1) / n), d = f(i / n, (j + 1) / n);
        pos.push(...a, ...b, ...c, ...a, ...c, ...d);
      }
    }
  }
  return { name, positions: Float32Array.from(pos), indices: Uint32Array.from({ length: pos.length / 3 }, (_, k) => k) };
}

function expectSameBox(a: PartMesh, b: PartMesh): void {
  const x = meshBounds([a]);
  const y = meshBounds([b]);
  for (let k = 0; k < 3; k++) {
    expect(Math.abs(x.min_mm[k]! - y.min_mm[k]!)).toBeLessThan(1e-3);
    expect(Math.abs(x.max_mm[k]! - y.max_mm[k]!)).toBeLessThan(1e-3);
  }
}

describe('simplifyMeshes', () => {
  it('welds duplicate vertices', () => {
    const box = gridBox('b', [0, 0, 0], [1, 1, 1], 1);
    expect(box.positions.length / 3).toBe(36);
    expect(weldMesh(box).positions.length / 3).toBe(8);
  });

  it('keeps to the budget, keeps every mesh and every bounding box', async () => {
    const meshes = [
      sphere('dome', 10, [0, 0, 5], 120), // ~28 000 triangles
      gridBox('board', [-30, -20, 0], [30, 20, 1.6], 30), // 10 800 triangles
      gridBox('housing', [25, -4, 1.6], [31, 4, 4.5], 1), // 12 triangles: a connector
      gridBox('tiny', [-1, -1, 1.6], [-0.5, -0.5, 2], 2), // 48 triangles
    ];
    const before = triangleCount(meshes);
    expect(before).toBeGreaterThan(30000);
    const out = await simplifyMeshes(meshes, 3000);
    expect(triangleCount(out)).toBeLessThanOrEqual(3000);
    expect(out.map((m) => m.name)).toEqual(meshes.map((m) => m.name));
    out.forEach((m, i) => {
      expect(m.indices.length).toBeGreaterThan(0);
      expectSameBox(m, meshes[i]!);
    });
    // Small bodies (connector housings) stay whole.
    expect(out[2]!.indices.length / 3).toBe(12);
    expect(out[3]!.indices.length / 3).toBe(48);
    // The big ones share the rest roughly by size.
    expect(out[0]!.indices.length).toBeGreaterThan(out[1]!.indices.length);
  });

  it('meets even a very small budget without dropping a mesh', async () => {
    const meshes = [sphere('a', 5, [0, 0, 0], 40), sphere('b', 2, [20, 0, 0], 40), gridBox('c', [0, 0, 0], [3, 3, 3], 4)];
    const out = await simplifyMeshes(meshes, 60);
    expect(triangleCount(out)).toBeLessThanOrEqual(60);
    out.forEach((m, i) => {
      expect(m.indices.length).toBeGreaterThan(0);
      expectSameBox(m, meshes[i]!);
    });
  });

  it('shares the budget with a floor for small meshes', () => {
    const share = shareBudget([100000, 12, 300, 50000], 10000);
    expect(share.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(10000);
    expect(share[1]).toBe(12);
    expect(share[2]).toBeGreaterThanOrEqual(256);
    expect(share[0]!).toBeGreaterThan(share[3]!);
    expect(shareBudget([5, 5], 100)).toEqual([5, 5]);
  });
});
