/** URDF primitive shapes as raw triangle meshes, in metres, outward-facing CCW triangles. */
import type { RawMesh } from './geometry';

export function boxMesh(sx: number, sy: number, sz: number): RawMesh {
  const h = [sx / 2, sy / 2, sz / 2] as const;
  const positions: number[] = [];
  for (let i = 0; i < 8; i++) positions.push(i & 1 ? h[0] : -h[0], i & 2 ? h[1] : -h[1], i & 4 ? h[2] : -h[2]);
  const index: number[] = [];
  const vert = (c: number[]) => (c[0]! ? 1 : 0) | (c[1]! ? 2 : 0) | (c[2]! ? 4 : 0);
  for (let axis = 0; axis < 3; axis++) {
    const u = (axis + 1) % 3;
    const w = (axis + 2) % 3;
    for (const side of [0, 1]) {
      const corner = (cu: number, cw: number) => {
        const c = [0, 0, 0];
        c[axis] = side;
        c[u] = cu;
        c[w] = cw;
        return vert(c);
      };
      // CCW in the (u, w) plane seen from +axis is outward for the + side.
      const q = [corner(0, 0), corner(1, 0), corner(1, 1), corner(0, 1)];
      if (side === 0) q.reverse();
      index.push(q[0]!, q[1]!, q[2]!, q[0]!, q[2]!, q[3]!);
    }
  }
  return { positions, index };
}

/** Axis along Z, centred on the origin. */
export function cylinderMesh(radius: number, length: number, segments = 32): RawMesh {
  const positions: number[] = [];
  const index: number[] = [];
  for (const z of [-length / 2, length / 2]) {
    for (let i = 0; i < segments; i++) {
      const a = (2 * Math.PI * i) / segments;
      positions.push(radius * Math.cos(a), radius * Math.sin(a), z);
    }
  }
  const bc = positions.length / 3;
  positions.push(0, 0, -length / 2);
  const tc = bc + 1;
  positions.push(0, 0, length / 2);
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments;
    index.push(i, j, segments + j, i, segments + j, segments + i); // side
    index.push(tc, segments + i, segments + j); // top
    index.push(bc, j, i); // bottom
  }
  return { positions, index };
}

export function sphereMesh(radius: number, segments = 24, rings = 16): RawMesh {
  const positions: number[] = [0, 0, radius];
  const index: number[] = [];
  for (let r = 1; r < rings; r++) {
    const phi = (Math.PI * r) / rings;
    for (let s = 0; s < segments; s++) {
      const th = (2 * Math.PI * s) / segments;
      positions.push(radius * Math.sin(phi) * Math.cos(th), radius * Math.sin(phi) * Math.sin(th), radius * Math.cos(phi));
    }
  }
  const south = positions.length / 3;
  positions.push(0, 0, -radius);
  const ring = (r: number, s: number) => 1 + (r - 1) * segments + (s % segments);
  for (let s = 0; s < segments; s++) index.push(0, ring(1, s), ring(1, s + 1));
  for (let r = 1; r < rings - 1; r++) {
    for (let s = 0; s < segments; s++) {
      index.push(ring(r, s), ring(r + 1, s), ring(r + 1, s + 1), ring(r, s), ring(r + 1, s + 1), ring(r, s + 1));
    }
  }
  for (let s = 0; s < segments; s++) index.push(south, ring(rings - 1, s + 1), ring(rings - 1, s));
  return { positions, index };
}
