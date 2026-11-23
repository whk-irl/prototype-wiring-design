/**
 * Per-mesh triangle data for painting: face normals, areas, adjacency (with
 * vertices welded by position, since CAD exports split vertices at every
 * face), flood fill and brush queries. Everything is cached per geometry and
 * indexed by the ORIGINAL triangle order, the order zones use.
 */
import { Box3, BufferGeometry, Triangle, Vector3 } from 'three';
import type { MeshBVH } from 'three-mesh-bvh';
import { triangleCountOf } from './registry';

interface Topology {
  normals: Float32Array;
  areas: Float32Array;
  /** CSR adjacency: neighbours of t are adj[offsets[t] .. offsets[t+1]). */
  offsets?: Uint32Array;
  adj?: Uint32Array;
}

const cache = new WeakMap<BufferGeometry, Topology>();

function vertexIndex(geometry: BufferGeometry, t: number, k: number): number {
  const index = geometry.getIndex();
  return index ? index.getX(3 * t + k) : 3 * t + k;
}

function base(geometry: BufferGeometry): Topology {
  let topo = cache.get(geometry);
  if (topo) return topo;
  const tris = triangleCountOf(geometry);
  const pos = geometry.getAttribute('position');
  const normals = new Float32Array(tris * 3);
  const areas = new Float32Array(tris);
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  for (let t = 0; t < tris; t++) {
    a.fromBufferAttribute(pos, vertexIndex(geometry, t, 0));
    b.fromBufferAttribute(pos, vertexIndex(geometry, t, 1));
    c.fromBufferAttribute(pos, vertexIndex(geometry, t, 2));
    c.sub(b);
    b.sub(a);
    b.cross(c); // (b - a) x (c - b): same direction as (b - a) x (c - a)
    const len = b.length();
    areas[t] = len / 2;
    if (len > 0) b.divideScalar(len);
    normals[3 * t] = b.x;
    normals[3 * t + 1] = b.y;
    normals[3 * t + 2] = b.z;
  }
  topo = { normals, areas };
  cache.set(geometry, topo);
  return topo;
}

export function faceNormals(geometry: BufferGeometry): Float32Array {
  return base(geometry).normals;
}

/** Total area in mm^2 of the given triangles. */
export function areaOf(geometry: BufferGeometry, triangles: Iterable<number>): number {
  const areas = base(geometry).areas;
  let sum = 0;
  for (const t of triangles) sum += areas[t] ?? 0;
  return sum;
}

/** Build (once) the triangle adjacency of a mesh. Returns build time in ms. */
export function ensureAdjacency(geometry: BufferGeometry): number {
  const topo = base(geometry);
  if (topo.offsets) return 0;
  const t0 = performance.now();
  const tris = triangleCountOf(geometry);
  const pos = geometry.getAttribute('position');
  geometry.computeBoundingBox();
  const box = geometry.boundingBox ?? new Box3();
  const diag = box.isEmpty() ? 1 : box.max.distanceTo(box.min);
  const tol = Math.max(diag * 1e-6, 1e-6);

  // Weld vertices by quantised position.
  const weld = new Map<string, number>();
  const canon = new Uint32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const key = `${Math.round(pos.getX(i) / tol)},${Math.round(pos.getY(i) / tol)},${Math.round(pos.getZ(i) / tol)}`;
    let id = weld.get(key);
    if (id === undefined) {
      id = weld.size;
      weld.set(key, id);
    }
    canon[i] = id;
  }
  const V = weld.size;

  // Pair triangles that share an edge.
  const firstTri = new Map<number, number>();
  const pairs: number[] = [];
  const degree = new Uint32Array(tris);
  for (let t = 0; t < tris; t++) {
    const v = [canon[vertexIndex(geometry, t, 0)]!, canon[vertexIndex(geometry, t, 1)]!, canon[vertexIndex(geometry, t, 2)]!];
    for (let k = 0; k < 3; k++) {
      const p = v[k]!;
      const q = v[(k + 1) % 3]!;
      if (p === q) continue;
      const key = p < q ? p * V + q : q * V + p;
      const other = firstTri.get(key);
      if (other === undefined) firstTri.set(key, t);
      else if (other !== t) {
        pairs.push(other, t);
        degree[other]!++;
        degree[t]!++;
      }
    }
  }
  const offsets = new Uint32Array(tris + 1);
  for (let t = 0; t < tris; t++) offsets[t + 1] = offsets[t]! + degree[t]!;
  const adj = new Uint32Array(offsets[tris]!);
  const fill = offsets.slice(0, tris);
  for (let k = 0; k < pairs.length; k += 2) {
    const a = pairs[k]!;
    const b = pairs[k + 1]!;
    adj[fill[a]!++] = b;
    adj[fill[b]!++] = a;
  }
  topo.offsets = offsets;
  topo.adj = adj;
  return performance.now() - t0;
}

/**
 * Connected region around `seed` where every step between neighbouring
 * triangles turns by at most `creaseRad`: one CAD face, or a smooth patch.
 */
export function floodRegion(geometry: BufferGeometry, seed: number, creaseRad: number): number[] {
  ensureAdjacency(geometry);
  const { normals, offsets, adj } = base(geometry);
  const cosMax = Math.cos(creaseRad);
  const tris = triangleCountOf(geometry);
  if (seed < 0 || seed >= tris) return [];
  const seen = new Uint8Array(tris);
  const out = [seed];
  seen[seed] = 1;
  for (let head = 0; head < out.length; head++) {
    const t = out[head]!;
    const nx = normals[3 * t]!;
    const ny = normals[3 * t + 1]!;
    const nz = normals[3 * t + 2]!;
    for (let k = offsets![t]!; k < offsets![t + 1]!; k++) {
      const u = adj![k]!;
      if (seen[u]) continue;
      const dot = nx * normals[3 * u]! + ny * normals[3 * u + 1]! + nz * normals[3 * u + 2]!;
      if (dot >= cosMax) {
        seen[u] = 1;
        out.push(u);
      }
    }
  }
  return out;
}

const tmpTri = new Vector3();

/**
 * Triangles within `radius` of `centre` (link frame) that face the viewer
 * (`viewDir`, from the eye towards the surface, link frame) and roughly the
 * same way as the surface under the cursor (`surfaceNormal`), so the brush
 * does not paint through a part onto its far side.
 */
export function brushTriangles(
  geometry: BufferGeometry,
  centre: Vector3,
  radius: number,
  viewDir: Vector3,
  surfaceNormal: Vector3,
  out: number[] = [],
): number[] {
  const bvh = geometry.boundsTree as unknown as MeshBVH | undefined;
  if (!bvh) return out;
  const normals = faceNormals(geometry);
  const r2 = radius * radius;
  bvh.shapecast({
    intersectsBounds: (box: Box3) => box.distanceToPoint(centre) <= radius,
    intersectsTriangle: (tri: Triangle, t: number) => {
      const nx = normals[3 * t]!;
      const ny = normals[3 * t + 1]!;
      const nz = normals[3 * t + 2]!;
      if (nx * viewDir.x + ny * viewDir.y + nz * viewDir.z >= 0) return false;
      if (nx * surfaceNormal.x + ny * surfaceNormal.y + nz * surfaceNormal.z <= 0.1) return false;
      tri.closestPointToPoint(centre, tmpTri);
      if (tmpTri.distanceToSquared(centre) <= r2) out.push(t);
      return false;
    },
  });
  return out;
}

/** Arrays the axis picker needs (`TriTopology` in `placement/axisFit.ts`). */
export function topologyOf(geometry: BufferGeometry): {
  positions: ArrayLike<number>;
  index: ArrayLike<number> | null;
  normals: Float32Array;
  offsets: Uint32Array;
  adj: Uint32Array;
} {
  ensureAdjacency(geometry);
  const topo = base(geometry);
  const index = geometry.getIndex();
  return {
    positions: geometry.getAttribute('position').array,
    index: index ? index.array : null,
    normals: topo.normals,
    offsets: topo.offsets!,
    adj: topo.adj!,
  };
}
