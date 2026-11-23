/**
 * Triangle reduction for part models, with meshoptimizer (MIT, WebAssembly;
 * runs in browsers, workers and Node).
 *
 * A part model is drawn often and small, so it needs far fewer triangles than
 * a CAD export gives. Two things matter more than raw triangle share:
 * - Every body stays. A connector housing is a few dozen triangles next to a
 *   board of thousands, but it is where a cable attaches.
 * - Every body keeps its bounding box. Envelopes, port positions and
 *   collision checks are read from boxes, so a simplified body must not
 *   shrink. The six extreme vertices of each body (lowest and highest in x, y
 *   and z) are locked, which keeps the box exact.
 */
import { MeshoptSimplifier } from 'meshoptimizer';
import { joinMeshes, type PartMesh } from './glb';

/** Positions closer than this are the same vertex when welding, mm. CAD exports repeat
 *  every vertex once per face; they agree to far better than this. */
const WELD_TOLERANCE_MM = 1e-4;
/** Every body keeps at least this many triangles when the budget allows, so small
 *  housings are not reduced to slivers; a box needs 12. */
const SMALL_BODY_TRIANGLES = 256;
/** Allowed surface deviation of the first, careful pass, mm. */
const DEFAULT_MAX_ERROR_MM = 0.1;
/** Faces meeting at more than this are shaded with a hard edge, degrees. Lower values
 *  duplicate more vertices (a bigger file); 40 keeps boxes sharp and a simplified
 *  cylinder of 10 or more sides smooth. */
export const CREASE_DEG = 40;

/**
 * Merge vertices at the same position (within `WELD_TOLERANCE_MM`) and drop
 * triangles that collapse to a line or point. Unused vertices are dropped.
 */
export function weldMesh(mesh: PartMesh): PartMesh {
  const inv = 1 / WELD_TOLERANCE_MM;
  const remap = new Uint32Array(mesh.positions.length / 3);
  const seen = new Map<string, number>();
  const out: number[] = [];
  for (let i = 0; i < remap.length; i++) {
    const x = mesh.positions[3 * i]!;
    const y = mesh.positions[3 * i + 1]!;
    const z = mesh.positions[3 * i + 2]!;
    const key = `${Math.round(x * inv)},${Math.round(y * inv)},${Math.round(z * inv)}`;
    let at = seen.get(key);
    if (at === undefined) {
      at = out.length / 3;
      seen.set(key, at);
      out.push(x, y, z);
    }
    remap[i] = at;
  }
  const indices: number[] = [];
  for (let t = 0; t + 2 < mesh.indices.length; t += 3) {
    const a = remap[mesh.indices[t]!]!;
    const b = remap[mesh.indices[t + 1]!]!;
    const c = remap[mesh.indices[t + 2]!]!;
    if (a !== b && b !== c && a !== c) indices.push(a, b, c);
  }
  return compact({ ...mesh, positions: Float32Array.from(out), indices: Uint32Array.from(indices) });
}

/** Keep only the vertices some triangle uses, renumbered in first-use order. */
function compact(mesh: PartMesh): PartMesh {
  const map = new Int32Array(mesh.positions.length / 3).fill(-1);
  const positions: number[] = [];
  const indices = new Uint32Array(mesh.indices.length);
  for (let i = 0; i < mesh.indices.length; i++) {
    const v = mesh.indices[i]!;
    if (map[v] === -1) {
      map[v] = positions.length / 3;
      positions.push(mesh.positions[3 * v]!, mesh.positions[3 * v + 1]!, mesh.positions[3 * v + 2]!);
    }
    indices[i] = map[v]!;
  }
  return { ...mesh, positions: Float32Array.from(positions), indices };
}

/** Lowest and highest vertex along each axis: [x lo, x hi, y lo, y hi, z lo, z hi]. The mesh must be compact. */
function extremeVertices(mesh: PartMesh): number[] {
  const n = mesh.positions.length / 3;
  const out: number[] = [];
  for (let k = 0; k < 3; k++) {
    let lo = 0;
    let hi = 0;
    for (let i = 1; i < n; i++) {
      const v = mesh.positions[3 * i + k]!;
      if (v < mesh.positions[3 * lo + k]!) lo = i;
      if (v > mesh.positions[3 * hi + k]!) hi = i;
    }
    out.push(lo, hi);
  }
  return out;
}

/** Lock the extreme vertices, so edge collapse cannot move them. */
function extremeLocks(mesh: PartMesh): Uint8Array {
  const lock = new Uint8Array(mesh.positions.length / 3);
  if (lock.length > 0) for (const v of extremeVertices(mesh)) lock[v] = 1;
  return lock;
}

/** Two triangles through the six extreme vertices: the whole bounding box for two triangles. */
function extremeStandIn(mesh: PartMesh): Uint32Array {
  return Uint32Array.from(extremeVertices(mesh));
}

/** Bounds of the vertices the triangles use, mm. */
function boundsOf(positions: Float32Array, indices: Uint32Array): { lo: number[]; hi: number[] } {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const v of indices) {
    for (let k = 0; k < 3; k++) {
      const c = positions[3 * v + k]!;
      if (c < lo[k]!) lo[k] = c;
      if (c > hi[k]!) hi[k] = c;
    }
  }
  return { lo, hi };
}

/** Two boxes are the same when every face agrees to this, mm. */
const BOX_TOLERANCE_MM = 0.01;
function sameBox(a: { lo: number[]; hi: number[] }, b: { lo: number[]; hi: number[] }): boolean {
  for (let k = 0; k < 3; k++) {
    if (Math.abs(a.lo[k]! - b.lo[k]!) > BOX_TOLERANCE_MM || Math.abs(a.hi[k]! - b.hi[k]!) > BOX_TOLERANCE_MM) return false;
  }
  return true;
}

/** A closed box over the mesh's bounding box: 8 vertices, 12 triangles facing out. */
function boundingBoxMesh(mesh: PartMesh): PartMesh {
  const { lo, hi } = boundsOf(mesh.positions, mesh.indices);
  const positions = new Float32Array(24);
  for (let i = 0; i < 8; i++) {
    positions[3 * i] = i & 1 ? hi[0]! : lo[0]!;
    positions[3 * i + 1] = i & 2 ? hi[1]! : lo[1]!;
    positions[3 * i + 2] = i & 4 ? hi[2]! : lo[2]!;
  }
  // prettier-ignore
  const indices = Uint32Array.from([
    0, 2, 1, 1, 2, 3, // -z
    4, 5, 6, 5, 7, 6, // +z
    0, 1, 4, 1, 5, 4, // -y
    2, 6, 3, 3, 6, 7, // +y
    0, 4, 2, 2, 4, 6, // -x
    1, 3, 5, 3, 7, 5, // +x
  ]);
  return { ...mesh, positions, indices };
}

/**
 * Reduce one welded, compact mesh to at most `target` triangles, keeping its
 * bounding box (to 0.01 mm) whenever `target` is 2 or more:
 * - 12 or more: edge collapse with the extreme vertices locked, then the
 *   sloppy method if topology stops it. Locks keep vertices in place but a
 *   collapse can still remove every triangle around one (a thin shell going
 *   away); then two triangles through the extreme vertices are added, for
 *   which room is kept, so the box survives.
 * - 2 to 11: two triangles through the six extreme vertices.
 * - 1: one triangle; the box is lost (only with more meshes than budget/2).
 */
function reduceMesh(mesh: PartMesh, target: number, maxError_mm: number): PartMesh {
  const triangles = mesh.indices.length / 3;
  if (triangles <= target) return mesh;
  if (target < 2) return compact({ ...mesh, indices: mesh.indices.slice(0, 3) });
  if (target < 12) return compact({ ...mesh, indices: extremeStandIn(mesh) });
  const goal = target - 2; // room for the stand-in should the box move
  const lock = extremeLocks(mesh);
  const none = new Float32Array(0);
  // 1. Careful: stay within the error bound.
  let [indices] = MeshoptSimplifier.simplifyWithAttributes(mesh.indices, mesh.positions, 3, none, 0, [], lock, goal * 3, maxError_mm, ['ErrorAbsolute']);
  // 2. Any error: the budget wins over the error bound.
  if (indices.length / 3 > goal) {
    [indices] = MeshoptSimplifier.simplifyWithAttributes(indices, mesh.positions, 3, none, 0, [], lock, goal * 3, 1e9, ['ErrorAbsolute']);
  }
  // 3. Topology may stop edge collapse (many separate shells); the sloppy method ignores it.
  if (indices.length / 3 > goal) {
    [indices] = MeshoptSimplifier.simplifySloppy(indices, mesh.positions, 3, lock, goal * 3, 1);
  }
  // 4. Last resort: the box, which keeps where the mesh is and how big.
  if (indices.length / 3 > goal || indices.length === 0) return boundingBoxMesh(mesh);
  if (!sameBox(boundsOf(mesh.positions, indices), boundsOf(mesh.positions, mesh.indices))) {
    const joined = new Uint32Array(indices.length + 6);
    joined.set(indices);
    joined.set(extremeStandIn(mesh), indices.length);
    indices = joined;
  }
  return compact({ ...mesh, indices });
}

/** Split a welded mesh into its connected pieces (shells), each compact. A single piece returns the mesh itself. */
export function splitComponents(mesh: PartMesh): PartMesh[] {
  const n = mesh.positions.length / 3;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (v: number): number => {
    while (parent[v] !== v) {
      parent[v] = parent[parent[v]!]!;
      v = parent[v]!;
    }
    return v;
  };
  const idx = mesh.indices;
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const a = find(idx[t]!);
    parent[find(idx[t + 1]!)] = a;
    parent[find(idx[t + 2]!)] = a;
  }
  const groups = new Map<number, number[]>();
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const root = find(idx[t]!);
    let list = groups.get(root);
    if (!list) groups.set(root, (list = []));
    list.push(idx[t]!, idx[t + 1]!, idx[t + 2]!);
  }
  if (groups.size <= 1) return [mesh];
  return [...groups.values()].map((list) => compact({ ...mesh, indices: Uint32Array.from(list) }));
}

/**
 * Reduce one body to `target` triangles. When the budget gives every connected
 * piece room for at least its box (12 triangles), the pieces are reduced as
 * units of their own, so a thin plate merged into a bigger body keeps its
 * box; otherwise the body is reduced as a whole (its own box still holds).
 */
function reduceBody(mesh: PartMesh, target: number, maxError_mm: number): PartMesh {
  if (mesh.indices.length / 3 <= target) return mesh;
  const pieces = splitComponents(mesh);
  if (pieces.length > 1 && pieces.length * 12 <= target) {
    const share = shareBudget(
      pieces.map((p) => p.indices.length / 3),
      target,
    );
    return joinMeshes(
      mesh,
      pieces.map((p, i) => reduceMesh(p, share[i]!, maxError_mm)),
    );
  }
  return reduceMesh(mesh, target, maxError_mm);
}

/**
 * Triangle budget per mesh: every mesh first gets a floor (all of a small
 * mesh, so housings stay whole), then the rest is shared in proportion to how
 * many triangles each mesh has beyond its floor. The floor is at least 12
 * (room for a box) when the budget allows that for every mesh, else at least
 * 2 (two triangles that still span the box), else 1.
 */
export function shareBudget(triangles: readonly number[], maxTriangles: number): number[] {
  const n = triangles.length;
  const total = triangles.reduce((a, b) => a + b, 0);
  if (total <= maxTriangles) return [...triangles];
  const minFloor = 12 * n <= maxTriangles ? 12 : 2 * n <= maxTriangles ? 2 : 1;
  const floorEach = Math.max(minFloor, Math.min(SMALL_BODY_TRIANGLES, Math.floor(maxTriangles / (4 * n))));
  const floors = triangles.map((t) => Math.min(t, floorEach));
  const floorSum = floors.reduce((a, b) => a + b, 0);
  const rest = Math.max(0, maxTriangles - floorSum);
  const extra = triangles.map((t, i) => t - floors[i]!);
  const extraSum = extra.reduce((a, b) => a + b, 0);
  return floors.map((f, i) => (extraSum > 0 ? f + Math.floor((rest * extra[i]!) / extraSum) : f));
}

/**
 * Give each sharp edge its own vertices again. A GLB written here carries no
 * normals and the viewer computes smooth ones from shared vertices, so a welded
 * box would look like a blob. Corners of faces whose normals differ by more
 * than `creaseDeg` get separate copies of the vertex; the triangles and the
 * shape are unchanged.
 */
export function splitSharpEdges(mesh: PartMesh, creaseDeg = CREASE_DEG): PartMesh {
  const triCount = mesh.indices.length / 3;
  const p = mesh.positions;
  const normals = new Float64Array(triCount * 3);
  for (let t = 0; t < triCount; t++) {
    const a = 3 * mesh.indices[3 * t]!;
    const b = 3 * mesh.indices[3 * t + 1]!;
    const c = 3 * mesh.indices[3 * t + 2]!;
    const ux = p[b]! - p[a]!, uy = p[b + 1]! - p[a + 1]!, uz = p[b + 2]! - p[a + 2]!;
    const vx = p[c]! - p[a]!, vy = p[c + 1]! - p[a + 1]!, vz = p[c + 2]! - p[a + 2]!;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    normals[3 * t] = nx / len;
    normals[3 * t + 1] = ny / len;
    normals[3 * t + 2] = nz / len;
  }
  // Corners grouped by vertex.
  const vertexCount = p.length / 3;
  const start = new Uint32Array(vertexCount + 1);
  for (const v of mesh.indices) start[v + 1]!++;
  for (let v = 0; v < vertexCount; v++) start[v + 1]! += start[v]!;
  const fill = start.slice(0, vertexCount);
  const corners = new Uint32Array(mesh.indices.length);
  mesh.indices.forEach((v, corner) => {
    corners[fill[v]!++] = corner;
  });

  const cosLimit = Math.cos((creaseDeg * Math.PI) / 180);
  const positions: number[] = [];
  const indices = new Uint32Array(mesh.indices.length);
  for (let v = 0; v < vertexCount; v++) {
    // Clusters of corners at this vertex whose faces agree with the cluster's first face.
    const seeds: { tri: number; vertex: number }[] = [];
    for (let k = start[v]!; k < start[v + 1]!; k++) {
      const corner = corners[k]!;
      const tri = Math.floor(corner / 3);
      let cluster = seeds.find(
        (s) => normals[3 * s.tri]! * normals[3 * tri]! + normals[3 * s.tri + 1]! * normals[3 * tri + 1]! + normals[3 * s.tri + 2]! * normals[3 * tri + 2]! >= cosLimit,
      );
      if (!cluster) {
        cluster = { tri, vertex: positions.length / 3 };
        positions.push(p[3 * v]!, p[3 * v + 1]!, p[3 * v + 2]!);
        seeds.push(cluster);
      }
      indices[corner] = cluster.vertex;
    }
  }
  return { ...mesh, positions: Float32Array.from(positions), indices };
}

/**
 * Weld every mesh and reduce the total to at most `maxTriangles`.
 *
 * The budget is shared between meshes by `shareBudget`, and within a mesh
 * between its connected pieces when the budget gives each room for a box. No
 * mesh is dropped: when there are more meshes than `maxTriangles`, each keeps
 * one triangle and the total exceeds the budget. Each mesh keeps its bounding
 * box (to 0.01 mm) as long as the budget gives it 2 triangles or more, so the
 * part's overall envelope survives whatever the body structure; the surface
 * elsewhere moves by at most `maxError_mm` when the budget allows, and further
 * when it does not. Edges sharper than `CREASE_DEG` are split again at the end
 * (`splitSharpEdges`) so the result shades like the original.
 */
export async function simplifyMeshes(meshes: PartMesh[], maxTriangles: number, maxError_mm: number = DEFAULT_MAX_ERROR_MM): Promise<PartMesh[]> {
  if (!(maxTriangles >= 1)) throw new Error('maxTriangles must be at least 1.');
  const welded = meshes.map(weldMesh);
  const counts = welded.map((m) => m.indices.length / 3);
  let reduced = welded;
  if (counts.reduce((a, b) => a + b, 0) > maxTriangles) {
    await MeshoptSimplifier.ready;
    const budget = shareBudget(counts, Math.floor(maxTriangles));
    reduced = welded.map((m, i) => (counts[i]! === 0 ? m : reduceBody(m, budget[i]!, maxError_mm)));
  }
  return reduced.map((m) => splitSharpEdges(m, CREASE_DEG));
}
