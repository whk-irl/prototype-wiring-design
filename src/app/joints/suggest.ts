/**
 * Suggested joint axes. Pure: arrays and matrices in, suggestions out; no DOM,
 * no renderer (three.js maths only), so it runs in a Web Worker and in Node.
 *
 * A revolute joint between two groups of bodies S (moving) and R (staying)
 * shows up as a line that a cylindrical feature of S shares with a
 * cylindrical feature of R: a shaft or servo horn in a bore or bearing seat.
 *
 * 1. Features: every good cylinder fit of a mesh (`fitAxisFromSeed`, grown
 *    from seeds), with axis, radius, extent along the axis, whether it is an
 *    outer surface (shaft) or inner (hole), and compact data for a joint
 *    refit. Only triangles that can matter are used as seeds: those inside
 *    the overlap of an S mesh's and an R mesh's bounding boxes, grown a little.
 * 2. Matching: a pair (s in S, r in R) is a candidate when the two are
 *    COAXIAL (direction and line offset within tolerance) AND TOUCH along the
 *    axis (their extents overlap or nearly touch). The second test removes
 *    screws and neighbouring fingers that are collinear but far apart.
 * 3. Candidates on one line merge into one suggestion, refitted jointly from
 *    all features on that line in both groups: direction from the summed
 *    area-weighted normal covariance, centre from per-feature circle centres
 *    in the joint plane weighted by area.
 * 4. Ranking by evidence: shaft-in-hole radial fit, number and size of
 *    features, overlap. Several parallel lines that are not concentric mean
 *    the groups are probably bolted together, not jointed.
 *
 * Everything is compared in ONE frame chosen by the caller (`toFrame` per
 * mesh: mesh-local -> frame, which includes the mesh pose and the link pose).
 */
import { Matrix3, Matrix4, Vector3 } from 'three';
import { fitAxisFromSeed, fitCircle2D, symmetricEigen3, type TriTopology, type Vec3 } from '../placement/axisFit';

// ---------------------------------------------------------------- tolerances

/** Largest angle between two features' axes to call them coaxial. Mating
 *  features on real tessellation agree within ~0.2 degrees. */
export const COAXIAL_DEG = 0.75;
/** A shaft in a hole: hole radius minus shaft radius, as a fraction of the hole radius. */
export const FIT_CLEARANCE = 0.2;
const MIN_TRIANGLES = 8;
const SAMPLE_VERTICES = 160;

/**
 * Length tolerances scale with the size of the bodies involved (`scale`, the
 * median bounding-box diagonal), so a model imported in the wrong unit, or a
 * very small or very large one, behaves the same. At the reference size of
 * 100 mm they are: line offset 0.25 mm (or 3% of the smaller radius), touch
 * gap 2 mm, seed-box growth 2 mm, radius 0.3 to 500 mm.
 */
export interface Tolerances {
  scale: number;
  coaxialDeg: number;
  /** Line offset: max(offsetFrac * scale, 3% of the smaller radius). */
  offsetFrac: number;
  touchGap: number;
  boxGrow: number;
  minRadius: number;
  maxRadius: number;
}

export function tolerancesFor(scale: number): Tolerances {
  const L = Number.isFinite(scale) && scale > 0 ? scale : 100;
  return { scale: L, coaxialDeg: COAXIAL_DEG, offsetFrac: 0.0025, touchGap: 0.02 * L, boxGrow: 0.02 * L, minRadius: 0.003 * L, maxRadius: 5 * L };
}

const DEFAULT_TOL = tolerancesFor(100);

/** Largest offset between two lines carrying features of radii ra and rb. */
export function offsetTolerance(ra: number, rb: number, tol: Tolerances = DEFAULT_TOL): number {
  return Math.max(tol.offsetFrac * tol.scale, 0.03 * Math.min(ra, rb));
}

// ---------------------------------------------------------------- features

/** A cylindrical feature in its mesh's own (imported) frame. */
export interface Feature {
  meshId: string;
  dir: Vec3;
  /** Axis point at the middle of the extent. */
  point: Vec3;
  radius: number;
  length: number;
  /** True for a hole (normals face the axis), false for a shaft. */
  inner: boolean;
  triangles: number;
  area: number;
  /** Area-weighted normal covariance (row-major 3x3), for the joint refit. */
  cov: number[];
  /** Up to SAMPLE_VERTICES surface vertices (xyz), for the joint refit. */
  samples: number[];
}

export interface Box {
  min: Vec3;
  max: Vec3;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);

function triVerts(topo: TriTopology, t: number): [number, number, number] {
  const i = (k: number) => (topo.index ? topo.index[3 * t + k]! : 3 * t + k);
  return [i(0), i(1), i(2)];
}

function vtx(topo: TriTopology, i: number): Vec3 {
  return [topo.positions[3 * i]!, topo.positions[3 * i + 1]!, topo.positions[3 * i + 2]!];
}

function centroid(topo: TriTopology, t: number): Vec3 {
  const [a, b, c] = triVerts(topo, t);
  return scale(add(add(vtx(topo, a), vtx(topo, b)), vtx(topo, c)), 1 / 3);
}

function inBox(p: Vec3, b: Box): boolean {
  return p[0] >= b.min[0] && p[0] <= b.max[0] && p[1] >= b.min[1] && p[1] <= b.max[1] && p[2] >= b.min[2] && p[2] <= b.max[2];
}

/**
 * Cylindrical features of a mesh, seeded only from triangles whose centroid
 * lies in one of `boxes` (mesh-local; all triangles when omitted). Each fit
 * grows over the whole surface, so a feature crossing a box edge is whole.
 */
export function extractFeatures(
  meshId: string,
  topo: TriTopology,
  boxes?: readonly Box[],
  onProgress?: (done: number, total: number) => void,
  tol: Tolerances = DEFAULT_TOL,
): Feature[] {
  const triCount = topo.offsets.length - 1;
  const seeds: number[] = [];
  for (let t = 0; t < triCount; t++) if (!boxes || boxes.some((b) => inBox(centroid(topo, t), b))) seeds.push(t);
  const seen = new Uint8Array(triCount);
  const out: Feature[] = [];
  for (let k = 0; k < seeds.length; k++) {
    const seed = seeds[k]!;
    if (onProgress && k % 2000 === 0) onProgress(k, seeds.length);
    if (seen[seed]) continue;
    seen[seed] = 1;
    const fit = fitAxisFromSeed(topo, seed);
    if (!fit) continue;
    const region = fit.region ?? [];
    for (const t of region) seen[t] = 1;
    if (fit.kind !== 'cylinder' || fit.quality !== 'good' || fit.position !== 'determined') continue;
    if (fit.radius < tol.minRadius || fit.radius > tol.maxRadius || fit.triangles < MIN_TRIANGLES) continue;
    out.push(featureFrom(meshId, topo, fit.dir, fit.point, fit.radius, fit.length, region));
  }
  onProgress?.(seeds.length, seeds.length);
  return out;
}

function featureFrom(meshId: string, topo: TriTopology, dir: Vec3, point: Vec3, radius: number, length: number, region: readonly number[]): Feature {
  const cov = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  let area = 0;
  let outward = 0;
  const verts = new Set<number>();
  for (const t of region) {
    const [ia, ib, ic] = triVerts(topo, t);
    verts.add(ia).add(ib).add(ic);
    const a = vtx(topo, ia);
    const b = vtx(topo, ib);
    const c = vtx(topo, ic);
    const e1 = sub(b, a);
    const e2 = sub(c, a);
    const n: Vec3 = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const l = len(n);
    if (l === 0) continue;
    const w = l / 2;
    const u = scale(n, 1 / l);
    area += w;
    for (let r = 0; r < 3; r++) for (let q = 0; q < 3; q++) cov[3 * r + q]! += w * u[r]! * u[q]!;
    // Outward-facing normals (away from the axis) mean a shaft.
    const cen = scale(add(add(a, b), c), 1 / 3);
    const v = sub(cen, point);
    const radial = sub(v, scale(dir, dot(v, dir)));
    outward += w * Math.sign(dot(u, radial));
  }
  const ids = [...verts];
  const step = Math.max(1, Math.floor(ids.length / SAMPLE_VERTICES));
  const samples: number[] = [];
  for (let i = 0; i < ids.length; i += step) samples.push(...vtx(topo, ids[i]!));
  return { meshId, dir, point, radius, length, inner: outward < 0, triangles: region.length, area, cov, samples };
}

// ---------------------------------------------------------------- one frame

/** A feature in the common frame. */
export interface FrameFeature extends Feature {
  group: 'S' | 'R';
  /** Extent along `dir`, as absolute projections onto `dir`. */
  lo: number;
  hi: number;
}

/** Move a feature into the common frame with `m` (mesh-local -> frame, rigid). */
export function toFrame(f: Feature, m: Matrix4, group: 'S' | 'R'): FrameFeature {
  const d = new Vector3(...f.dir).transformDirection(m);
  const p = new Vector3(...f.point).applyMatrix4(m);
  const rot = new Matrix3().setFromMatrix4(m);
  const R = rot.elements; // column-major
  const at = (r: number, c: number) => R[c * 3 + r]!;
  // cov' = R cov R^T
  const cov = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      let s = 0;
      for (let k = 0; k < 3; k++) for (let l = 0; l < 3; l++) s += at(i, k) * f.cov[3 * k + l]! * at(j, l);
      cov[3 * i + j] = s;
    }
  const samples: number[] = [];
  const v = new Vector3();
  for (let i = 0; i < f.samples.length; i += 3) {
    v.set(f.samples[i]!, f.samples[i + 1]!, f.samples[i + 2]!).applyMatrix4(m);
    samples.push(v.x, v.y, v.z);
  }
  const dir: Vec3 = [d.x, d.y, d.z];
  const point: Vec3 = [p.x, p.y, p.z];
  const c = dot(point, dir);
  return { ...f, dir, point, cov, samples, group, lo: c - f.length / 2, hi: c + f.length / 2 };
}

// ---------------------------------------------------------------- matching

function lineDist(p: Vec3, q: Vec3, d: Vec3): number {
  const v = sub(p, q);
  const t = dot(v, d);
  return len(sub(v, scale(d, t)));
}

export interface PairTest {
  coaxial: boolean;
  touching: boolean;
  angleDeg: number;
  offsetMm: number;
  /** Gap along the axis (negative = overlap length). */
  gapMm: number;
}

/** Are two features on one line (coaxial) and in contact along it (touching)? */
export function coaxialTouching(a: FrameFeature, b: FrameFeature, tol: Tolerances = DEFAULT_TOL): PairTest {
  const c = Math.min(1, Math.abs(dot(a.dir, b.dir)));
  const angleDeg = (Math.acos(c) * 180) / Math.PI;
  const offsetMm = Math.max(lineDist(b.point, a.point, a.dir), lineDist(a.point, b.point, b.dir));
  const coaxial = angleDeg <= tol.coaxialDeg && offsetMm <= offsetTolerance(a.radius, b.radius, tol);
  // Extents along a's axis.
  const bc = dot(b.point, a.dir);
  const blo = bc - b.length / 2;
  const bhi = bc + b.length / 2;
  const alo = dot(a.point, a.dir) - a.length / 2;
  const ahi = alo + a.length;
  const gapMm = Math.max(alo, blo) - Math.min(ahi, bhi);
  return { coaxial, touching: gapMm <= tol.touchGap, angleDeg, offsetMm, gapMm };
}

/** Shaft of one inside a hole of the other with a running clearance. */
export function shaftInHole(a: Feature, b: Feature): boolean {
  const [shaft, hole] = !a.inner && b.inner ? [a, b] : a.inner && !b.inner ? [b, a] : [null, null];
  if (!shaft || !hole) return false;
  return shaft.radius <= hole.radius * 1.005 && hole.radius - shaft.radius <= FIT_CLEARANCE * hole.radius + 0.05;
}

export interface Suggestion {
  /** In the common frame. */
  point: Vec3;
  dir: Vec3;
  /** Plain description, e.g. "shaft 2.6 mm in hole 3.0 mm". */
  label: string;
  score: number;
  shaftInHole: boolean;
  features: number;
  overlapMm: number;
  /** Radius of the main feature pair, for display. */
  radius: number;
  /** Bodies on each side that contribute. */
  meshesS: string[];
  meshesR: string[];
  /**
   * How much the geometry supports a JOINT here. Geometry alone cannot tell a
   * pivot pin from a screw: `likely` when several concentric features from
   * three or more bodies agree, many features on both sides agree, or the
   * shared features are large relative to both bodies; otherwise `possible`
   * (could be a fastener; the trial slider is the way to check).
   */
  grade: 'likely' | 'possible';
}

export interface SuggestResult {
  suggestions: Suggestion[];
  /** Set when the groups share other parallel lines besides the top one (fasteners would lock the joint). */
  bolted: boolean;
  /** How many other parallel lines the groups share. */
  otherParallel: number;
  note?: string;
}

/** Joint refit from all features on a line. */
export function refitLine(features: readonly FrameFeature[]): { point: Vec3; dir: Vec3 } {
  const cov = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (const f of features) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i]![j]! += f.cov[3 * i + j]!;
  const eig = symmetricEigen3(cov);
  let k = 0;
  for (let i = 1; i < 3; i++) if (eig.values[i]! < eig.values[k]!) k = i;
  let dir = eig.vectors[k]!;
  const l = len(dir);
  dir = scale(dir, 1 / (l || 1));
  if (dot(dir, features[0]!.dir) < 0) dir = scale(dir, -1);
  const helper: Vec3 = Math.abs(dir[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u0 = new Vector3(...dir).cross(new Vector3(...helper)).normalize();
  const u: Vec3 = [u0.x, u0.y, u0.z];
  const v0 = new Vector3(...dir).cross(u0);
  const v: Vec3 = [v0.x, v0.y, v0.z];
  let cx = 0;
  let cy = 0;
  let wsum = 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (const f of features) {
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < f.samples.length; i += 3) {
      const p: Vec3 = [f.samples[i]!, f.samples[i + 1]!, f.samples[i + 2]!];
      xs.push(dot(p, u));
      ys.push(dot(p, v));
      const t = dot(p, dir);
      lo = Math.min(lo, t);
      hi = Math.max(hi, t);
    }
    if (xs.length < 3) continue;
    const c = fitCircle2D(xs, ys);
    cx += f.area * c.cx;
    cy += f.area * c.cy;
    wsum += f.area;
  }
  cx /= wsum || 1;
  cy /= wsum || 1;
  const point = add(add(scale(u, cx), scale(v, cy)), scale(dir, (lo + hi) / 2));
  return { point, dir };
}

const fmtR = (r: number) => r.toFixed(r < 100 ? 1 : 0);

/** Suggestions from features already in the common frame. */
export function suggestFromFeatures(
  S: readonly FrameFeature[],
  R: readonly FrameFeature[],
  opts: { tol?: Tolerances; bodySize?: ReadonlyMap<string, number> } = {},
): SuggestResult {
  const tol = opts.tol ?? DEFAULT_TOL;
  // 1. Candidate pairs.
  const all = [...S, ...R];
  const parent = all.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const pairInfo: Array<{ i: number; j: number; fit: boolean; overlap: number }> = [];
  for (let i = 0; i < S.length; i++) {
    for (let j = 0; j < R.length; j++) {
      const t = coaxialTouching(S[i]!, R[j]!, tol);
      if (!t.coaxial || !t.touching) continue;
      const a = i;
      const b = S.length + j;
      parent[find(a)] = find(b);
      pairInfo.push({ i: a, j: b, fit: shaftInHole(S[i]!, R[j]!), overlap: Math.max(0, -t.gapMm) });
    }
  }
  if (pairInfo.length === 0) return { suggestions: [], bolted: false, otherParallel: 0 };
  // 2. Clusters (lines), then pull in other features on the same line that touch it.
  const clusters = new Map<number, number[]>();
  for (const p of pairInfo) for (const idx of [p.i, p.j]) {
    const root = find(idx);
    const list = clusters.get(root) ?? [];
    if (!list.includes(idx)) list.push(idx);
    clusters.set(root, list);
  }
  // Grow each cluster with other features on its line that touch it, then
  // merge clusters that lie on one line (contact at two places along one
  // axis, e.g. a servo horn on one side and a bearing on the other).
  const groups: Array<{ members: number[]; roots: number[] }> = [];
  for (const [root, members] of clusters) {
    for (let k = 0; k < all.length; k++) {
      if (members.includes(k)) continue;
      if (
        members.some((m) => {
          const t = coaxialTouching(all[m]!, all[k]!, tol);
          return t.coaxial && t.touching;
        })
      )
        members.push(k);
    }
    groups.push({ members, roots: [root] });
  }
  const lineOf = (g: { members: number[] }) => refitLine(g.members.map((m) => all[m]!));
  for (let a = 0; a < groups.length; a++) {
    for (let b = a + 1; b < groups.length; b++) {
      const la = lineOf(groups[a]!);
      const lb = lineOf(groups[b]!);
      const angle = (Math.acos(Math.min(1, Math.abs(dot(la.dir, lb.dir)))) * 180) / Math.PI;
      const off = Math.max(lineDist(lb.point, la.point, la.dir), lineDist(la.point, lb.point, lb.dir));
      const ra = Math.min(...groups[a]!.members.map((m) => all[m]!.radius));
      const rb = Math.min(...groups[b]!.members.map((m) => all[m]!.radius));
      if (angle <= tol.coaxialDeg && off <= offsetTolerance(ra, rb, tol)) {
        const ga = groups[a]!;
        for (const m of groups[b]!.members) if (!ga.members.includes(m)) ga.members.push(m);
        ga.roots.push(...groups[b]!.roots);
        groups.splice(b, 1);
        b = a;
      }
    }
  }
  const suggestions: Suggestion[] = [];
  for (const { members, roots } of groups) {
    const feats = members.map((m) => all[m]!);
    const line = refitLine(feats);
    const pairs = pairInfo.filter((p) => roots.includes(find(p.i)));
    const fitPair = pairs.find((p) => p.fit);
    const overlap = Math.max(...pairs.map((p) => p.overlap));
    const sFeats = feats.filter((f) => f.group === 'S');
    const rFeats = feats.filter((f) => f.group === 'R');
    const areaS = sFeats.reduce((a, f) => a + f.area, 0);
    const areaR = rFeats.reduce((a, f) => a + f.area, 0);
    let label: string;
    let radius: number;
    if (fitPair) {
      const a = all[fitPair.i]!;
      const b = all[fitPair.j]!;
      const shaft = a.inner ? b : a;
      const hole = a.inner ? a : b;
      label = `shaft ${fmtR(shaft.radius)} mm in hole ${fmtR(hole.radius)} mm`;
      radius = shaft.radius;
    } else {
      const a = all[pairs[0]!.i]!;
      const b = all[pairs[0]!.j]!;
      label = `${a.inner ? 'hole' : 'shaft'} ${fmtR(a.radius)} mm and ${b.inner ? 'hole' : 'shaft'} ${fmtR(b.radius)} mm on one line`;
      radius = Math.min(a.radius, b.radius);
    }
    const meshesS = [...new Set(sFeats.map((f) => f.meshId))];
    const meshesR = [...new Set(rFeats.map((f) => f.meshId))];
    // Size of the shared features relative to the bodies that carry them.
    const rel = (fs: FrameFeature[]) => Math.max(0, ...fs.map((f) => f.radius / (opts.bodySize?.get(f.meshId) ?? Infinity)));
    const large = Math.min(rel(sFeats), rel(rFeats)) >= 0.05;
    const grade: Suggestion['grade'] =
      meshesS.length + meshesR.length >= 3 || (feats.length >= 6 && sFeats.length >= 2 && rFeats.length >= 2) || large ? 'likely' : 'possible';
    const score =
      (grade === 'likely' ? 4 : 1) *
      (fitPair ? 3 : 1) *
      Math.sqrt(Math.min(areaS, areaR)) *
      (1 + Math.min(feats.length, 12) / 6) *
      (1 + Math.min(overlap / tol.scale, 0.1) * 10);
    suggestions.push({
      point: line.point,
      dir: line.dir,
      label,
      score,
      shaftInHole: !!fitPair,
      features: feats.length,
      overlapMm: overlap,
      radius,
      meshesS,
      meshesR,
      grade,
    });
  }
  suggestions.sort((a, b) => b.score - a.score);
  // 3. Other parallel lines besides the top one: if they are fasteners, the
  // parts cannot turn. Geometry cannot tell, so say only what is known.
  let otherParallel = 0;
  if (suggestions.length >= 2) {
    const top = suggestions[0]!;
    const parallel = suggestions.filter((x) => Math.acos(Math.min(1, Math.abs(dot(x.dir, top.dir)))) * (180 / Math.PI) <= 2);
    const distinct = parallel.filter((x, i) => parallel.slice(0, i).every((o) => lineDist(x.point, o.point, o.dir) > offsetTolerance(x.radius, o.radius, tol) * 4));
    otherParallel = distinct.length - 1;
  }
  return {
    suggestions,
    bolted: otherParallel > 0,
    otherParallel,
    note:
      otherParallel > 0
        ? `These parts also share ${otherParallel} other parallel line${otherParallel === 1 ? '' : 's'}; if those are fasteners, the parts cannot turn about this axis.`
        : undefined,
  };
}

// ---------------------------------------------------------------- seed boxes

/** World/frame bounding box of a mesh's local box under `m`. */
export function boxToFrame(b: Box, m: Matrix4): Box {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  const v = new Vector3();
  for (let i = 0; i < 8; i++) {
    v.set(i & 1 ? b.max[0] : b.min[0], i & 2 ? b.max[1] : b.min[1], i & 4 ? b.max[2] : b.min[2]).applyMatrix4(m);
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, v.getComponent(k));
      max[k] = Math.max(max[k]!, v.getComponent(k));
    }
  }
  return { min, max };
}

function intersect(a: Box, b: Box, grow: number): Box | null {
  const min: Vec3 = [0, 0, 0];
  const max: Vec3 = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    min[k] = Math.max(a.min[k]!, b.min[k]!) - grow;
    max[k] = Math.min(a.max[k]!, b.max[k]!) + grow;
    if (min[k]! > max[k]!) return null;
  }
  return { min, max };
}

export interface MeshInput {
  id: string;
  /** Mesh-local bounding box. */
  bounds: Box;
  /** Mesh-local -> common frame (rigid). */
  toFrame: Matrix4;
}

/**
 * Where each mesh needs fitting: for every S mesh and R mesh whose frame
 * boxes overlap (grown by BOX_GROW_MM), the overlap box, expressed back in
 * each mesh's local frame. Meshes with no overlap need no fitting at all.
 */
export function seedBoxes(S: readonly MeshInput[], R: readonly MeshInput[], grow = DEFAULT_TOL.boxGrow): Map<string, Box[]> {
  const out = new Map<string, Box[]>();
  const frameBox = new Map<string, Box>();
  for (const m of [...S, ...R]) frameBox.set(m.id, boxToFrame(m.bounds, m.toFrame));
  for (const s of S) {
    for (const r of R) {
      const o = intersect(frameBox.get(s.id)!, frameBox.get(r.id)!, grow);
      if (!o) continue;
      for (const m of [s, r]) {
        const local = boxToFrame(o, new Matrix4().copy(m.toFrame).invert());
        const list = out.get(m.id) ?? [];
        list.push(local);
        out.set(m.id, list);
      }
    }
  }
  return out;
}

/**
 * Synchronous pipeline (tests, Node, worker-free use): seed boxes, features,
 * common frame, matching. `topo(id)` gives a mesh's topology.
 */
/** Bounding-box diagonal of each mesh (rigid transforms keep it). */
export function bodySizes(inputs: readonly MeshInput[]): Map<string, number> {
  return new Map(inputs.map((m) => [m.id, Math.hypot(m.bounds.max[0] - m.bounds.min[0], m.bounds.max[1] - m.bounds.min[1], m.bounds.max[2] - m.bounds.min[2])]));
}

/** Characteristic size of the bodies involved: the median bounding-box diagonal. */
export function scaleOf(inputs: readonly MeshInput[]): number {
  const d = [...bodySizes(inputs).values()].sort((a, b) => a - b);
  return d.length ? d[Math.floor(d.length / 2)]! : 100;
}

export function suggestAxes(S: readonly MeshInput[], R: readonly MeshInput[], topo: (id: string) => TriTopology): SuggestResult {
  const tol = tolerancesFor(scaleOf([...S, ...R]));
  const boxes = seedBoxes(S, R, tol.boxGrow);
  const fs: FrameFeature[] = [];
  const fr: FrameFeature[] = [];
  for (const [list, group, out] of [
    [S, 'S', fs],
    [R, 'R', fr],
  ] as const) {
    for (const m of list) {
      const b = boxes.get(m.id);
      if (!b) continue;
      for (const f of extractFeatures(m.id, topo(m.id), b, undefined, tol)) out.push(toFrame(f, m.toFrame, group));
    }
  }
  return suggestFromFeatures(fs, fr, { tol, bodySize: bodySizes([...S, ...R]) });
}
