/**
 * Turns raw triangle soup into the geometry the contract asks for: indexed,
 * `position` + `normal`, millimetres, no degenerate triangles, deterministic
 * vertex and triangle order.
 */
import { BufferAttribute, BufferGeometry, Matrix3, Matrix4, Vector3 } from 'three';

export interface RawMesh {
  /** xyz triples. */
  positions: ArrayLike<number>;
  /** Triangle vertex indices; absent means the vertices are already a triangle list. */
  index?: ArrayLike<number> | null;
  /** xyz triples, one per vertex. Used as given when `keepNormals` is set. */
  normals?: ArrayLike<number> | null;
}

export interface BuildOptions {
  /** Baked into the vertices (and normals). A mirroring matrix flips the winding. */
  matrix?: Matrix4;
  /** Keep the source's per-vertex normals instead of welding and recomputing. */
  keepNormals?: boolean;
  /** Faces meeting at more than this angle keep a hard edge. Default 30. */
  creaseDeg?: number;
}

export interface BuildResult {
  /** Null when no usable triangle is left. */
  geometry: BufferGeometry | null;
  /** Triangles removed because they were degenerate or had non-finite coordinates. */
  dropped: number;
}

/** Smallest triangle kept: twice the area, in mm^2. */
const MIN_AREA2 = 1e-10;
/** Positions are welded at 1e-4 mm. */
const WELD = 1e4;

export function buildGeometry(raw: RawMesh, opts: BuildOptions = {}): BuildResult {
  const matrix = opts.matrix ?? new Matrix4();
  const nVert = Math.floor(raw.positions.length / 3);
  const flip = matrix.determinant() < 0;

  const pos = new Float64Array(nVert * 3);
  const v = new Vector3();
  for (let i = 0; i < nVert; i++) {
    v.set(raw.positions[3 * i]!, raw.positions[3 * i + 1]!, raw.positions[3 * i + 2]!).applyMatrix4(matrix);
    pos[3 * i] = v.x;
    pos[3 * i + 1] = v.y;
    pos[3 * i + 2] = v.z;
  }

  const src: number[] = [];
  if (raw.index) {
    for (let i = 0; i + 2 < raw.index.length; i += 3) src.push(raw.index[i]!, raw.index[i + 1]!, raw.index[i + 2]!);
  } else {
    for (let i = 0; i + 2 < nVert; i += 3) src.push(i, i + 1, i + 2);
  }
  if (flip) {
    for (let i = 0; i < src.length; i += 3) {
      const t = src[i + 1]!;
      src[i + 1] = src[i + 2]!;
      src[i + 2] = t;
    }
  }

  let normals: Float64Array | null = null;
  if (opts.keepNormals && raw.normals && raw.normals.length === raw.positions.length) {
    normals = new Float64Array(nVert * 3);
    const nm = new Matrix3().getNormalMatrix(matrix);
    let ok = true;
    for (let i = 0; i < nVert && ok; i++) {
      v.set(raw.normals[3 * i]!, raw.normals[3 * i + 1]!, raw.normals[3 * i + 2]!).applyMatrix3(nm);
      const len = v.length();
      if (!(len > 1e-12) || !Number.isFinite(len)) ok = false;
      else {
        normals[3 * i] = v.x / len;
        normals[3 * i + 1] = v.y / len;
        normals[3 * i + 2] = v.z / len;
      }
    }
    if (!ok) normals = null;
  }

  return normals ? keepPath(pos, normals, src, nVert) : shadePath(pos, src, nVert, opts.creaseDeg ?? 30);
}

function triArea2(pos: ArrayLike<number>, a: number, b: number, c: number): number {
  const ux = pos[3 * b]! - pos[3 * a]!;
  const uy = pos[3 * b + 1]! - pos[3 * a + 1]!;
  const uz = pos[3 * b + 2]! - pos[3 * a + 2]!;
  const wx = pos[3 * c]! - pos[3 * a]!;
  const wy = pos[3 * c + 1]! - pos[3 * a + 1]!;
  const wz = pos[3 * c + 2]! - pos[3 * a + 2]!;
  return Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx);
}

function finish(position: number[], normal: number[], index: number[], dropped: number): BuildResult {
  if (index.length === 0) return { geometry: null, dropped };
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(Float32Array.from(position), 3));
  g.setAttribute('normal', new BufferAttribute(Float32Array.from(normal), 3));
  g.setIndex(new BufferAttribute(Uint32Array.from(index), 1));
  return { geometry: g, dropped };
}

/** Source normals are kept; only unused vertices and bad triangles go. */
function keepPath(pos: Float64Array, nrm: Float64Array, src: number[], nVert: number): BuildResult {
  const remap = new Int32Array(nVert).fill(-1);
  const position: number[] = [];
  const normal: number[] = [];
  const index: number[] = [];
  let dropped = 0;
  for (let t = 0; t < src.length; t += 3) {
    const a = src[t]!;
    const b = src[t + 1]!;
    const c = src[t + 2]!;
    const inRange = a >= 0 && b >= 0 && c >= 0 && a < nVert && b < nVert && c < nVert;
    const area2 = inRange && a !== b && b !== c && a !== c ? triArea2(pos, a, b, c) : 0;
    if (!(area2 > MIN_AREA2)) {
      dropped++;
      continue;
    }
    for (const i of [a, b, c]) {
      if (remap[i]! < 0) {
        remap[i] = position.length / 3;
        position.push(pos[3 * i]!, pos[3 * i + 1]!, pos[3 * i + 2]!);
        normal.push(nrm[3 * i]!, nrm[3 * i + 1]!, nrm[3 * i + 2]!);
      }
      index.push(remap[i]!);
    }
  }
  return finish(position, normal, index, dropped);
}

/**
 * Weld coincident vertices, then compute normals per triangle corner from the
 * neighbouring faces that lie within the crease angle, splitting vertices where
 * the normals differ. Flat faces stay flat, curved surfaces shade smoothly.
 */
function shadePath(pos: Float64Array, src: number[], nVert: number, creaseDeg: number): BuildResult {
  // 1. weld
  const weldMap = new Map<string, number>();
  const wpos: number[] = [];
  const remap = new Int32Array(nVert);
  for (let i = 0; i < nVert; i++) {
    const x = pos[3 * i]!;
    const y = pos[3 * i + 1]!;
    const z = pos[3 * i + 2]!;
    if (!Number.isFinite(x + y + z)) {
      remap[i] = -1;
      continue;
    }
    const key = `${Math.round(x * WELD)},${Math.round(y * WELD)},${Math.round(z * WELD)}`;
    let id = weldMap.get(key);
    if (id === undefined) {
      id = wpos.length / 3;
      weldMap.set(key, id);
      wpos.push(x, y, z);
    }
    remap[i] = id;
  }

  // 2. keep good triangles
  const tris: number[] = [];
  let dropped = 0;
  const mapped = (i: number) => (i >= 0 && i < nVert ? remap[i]! : -1);
  for (let t = 0; t < src.length; t += 3) {
    const a = mapped(src[t]!);
    const b = mapped(src[t + 1]!);
    const c = mapped(src[t + 2]!);
    const ok = a >= 0 && b >= 0 && c >= 0 && a !== b && b !== c && a !== c && triArea2(wpos, a, b, c) > MIN_AREA2;
    if (ok) tris.push(a, b, c);
    else dropped++;
  }
  const nTri = tris.length / 3;
  if (nTri === 0) return { geometry: null, dropped };

  // 3. face normals and corner angles
  const fn = new Float64Array(nTri * 3);
  const ang = new Float64Array(nTri * 3);
  const p = [new Vector3(), new Vector3(), new Vector3()] as const;
  const e1 = new Vector3();
  const e2 = new Vector3();
  for (let t = 0; t < nTri; t++) {
    for (let k = 0; k < 3; k++) {
      const i = tris[3 * t + k]!;
      p[k]!.set(wpos[3 * i]!, wpos[3 * i + 1]!, wpos[3 * i + 2]!);
    }
    e1.subVectors(p[1], p[0]);
    e2.subVectors(p[2], p[0]);
    e1.cross(e2).normalize();
    fn[3 * t] = e1.x;
    fn[3 * t + 1] = e1.y;
    fn[3 * t + 2] = e1.z;
    for (let k = 0; k < 3; k++) {
      e1.subVectors(p[(k + 1) % 3]!, p[k]!).normalize();
      e2.subVectors(p[(k + 2) % 3]!, p[k]!).normalize();
      ang[3 * t + k] = Math.acos(Math.min(1, Math.max(-1, e1.dot(e2))));
    }
  }

  // 4. vertex -> corners (CSR)
  const nW = wpos.length / 3;
  const start = new Int32Array(nW + 1);
  for (const i of tris) start[i + 1]!++;
  for (let i = 0; i < nW; i++) start[i + 1]! += start[i]!;
  const fill = start.slice(0, nW);
  const corners = new Int32Array(tris.length); // corner id = 3 * tri + k
  for (let c = 0; c < tris.length; c++) corners[fill[tris[c]!]!++] = c;

  // 5. per-corner smoothed normal, vertices split where it differs
  const cosCrease = Math.cos((creaseDeg * Math.PI) / 180);
  const outMap = new Map<string, number>();
  const position: number[] = [];
  const normal: number[] = [];
  const index: number[] = [];
  for (let c = 0; c < tris.length; c++) {
    const t = Math.floor(c / 3);
    const w = tris[c]!;
    let nx = 0;
    let ny = 0;
    let nz = 0;
    for (let j = start[w]!; j < start[w + 1]!; j++) {
      const oc = corners[j]!;
      const ot = Math.floor(oc / 3);
      const d = fn[3 * ot]! * fn[3 * t]! + fn[3 * ot + 1]! * fn[3 * t + 1]! + fn[3 * ot + 2]! * fn[3 * t + 2]!;
      if (d >= cosCrease - 1e-9) {
        const a = ang[oc]!;
        nx += a * fn[3 * ot]!;
        ny += a * fn[3 * ot + 1]!;
        nz += a * fn[3 * ot + 2]!;
      }
    }
    let len = Math.hypot(nx, ny, nz);
    if (!(len > 1e-12)) {
      nx = fn[3 * t]!;
      ny = fn[3 * t + 1]!;
      nz = fn[3 * t + 2]!;
      len = 1;
    }
    nx /= len;
    ny /= len;
    nz /= len;
    const key = `${w}|${Math.round(nx * 1000)},${Math.round(ny * 1000)},${Math.round(nz * 1000)}`;
    let id = outMap.get(key);
    if (id === undefined) {
      id = position.length / 3;
      outMap.set(key, id);
      position.push(wpos[3 * w]!, wpos[3 * w + 1]!, wpos[3 * w + 2]!);
      normal.push(nx, ny, nz);
    }
    index.push(id);
  }
  return finish(position, normal, index, dropped);
}
