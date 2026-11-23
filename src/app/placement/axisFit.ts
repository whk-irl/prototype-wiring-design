/**
 * Fitting a joint axis to a clicked surface. Pure: arrays in, numbers out; no
 * DOM, no renderer, no three.js objects.
 *
 * The region is a set of triangles (usually one smooth face, flooded from the
 * clicked triangle with `SMOOTH_REGION_DEG`). Two shapes are recognised:
 *
 * - flat: every normal within `FLAT_TOLERANCE_DEG` of the mean. Axis = mean
 *   normal through the area-weighted centroid (the centre of a disc or ring).
 *   `radius` is the largest distance of a vertex from that centre.
 * - cylinder: axis direction = eigenvector of the area-weighted normal
 *   covariance with the smallest eigenvalue (the direction perpendicular to
 *   all normals); centre from a least-squares circle through the vertices
 *   projected onto the plane perpendicular to it, placed at the middle of the
 *   region's extent along the axis.
 *
 * The residuals say how far the surface is from that shape, so a cone, a
 * sphere or a freeform blend is flagged instead of returned as a good axis.
 * A flat face must also be round (boundary on one or two circles about the
 * centroid, area matching) for its centroid to count as the axis position.
 *
 * Picking (`fitAxisFromSeed`) does not trust a fixed dihedral threshold to
 * find the surface, because tangent fillets and shallow chamfers join a pin
 * smoothly to its end faces. It grows the region from the clicked triangle
 * with a model-consistency test instead: fit a cylinder, keep only connected
 * triangles whose normals are perpendicular to the provisional axis and whose
 * vertices lie at the fitted radius, refit, and repeat with tightening
 * tolerances until the region is stable. A click on a fillet, chamfer or
 * blend itself is reported as not a usable axis.
 */

/** Flood angle for collecting a cylinder: STEP tessellation puts facets up to
 *  ~30 degrees apart, and sharp (90 degree) edges must still stop the flood. */
export const SMOOTH_REGION_DEG = 40;
export const FLAT_TOLERANCE_DEG = 3;
/** Above these the fit is reported as `poor`. */
export const MAX_RELATIVE_RMS = 0.02;
export const MAX_NORMAL_DOT = Math.sin((5 * Math.PI) / 180);

export type Vec3 = [number, number, number];

export interface AxisFit {
  kind: 'cylinder' | 'flat';
  /** Unit direction. For a flat face, the outward normal. */
  dir: Vec3;
  /** A point on the axis. */
  point: Vec3;
  /** Cylinder radius, or for a flat face the largest vertex distance from the centre. */
  radius: number;
  /** RMS of (distance from axis - radius) / radius over the vertices. 0 for flat. */
  rmsRelative: number;
  /** Largest |normal . dir| over the triangles (cylinder: should be ~0); for
   *  flat, the sine of the largest normal deviation from the mean. */
  maxNormalDot: number;
  /** Extent of the region along the axis, mm. */
  length: number;
  quality: 'good' | 'poor';
  /** Whether `point` is known. A flat face that is not round gives a usable
   *  direction (its normal) but only a guessed position (its centroid). */
  position: 'determined' | 'guess';
  /** Plain-language reason when `quality` is poor or the position is a guess. */
  note?: string;
  triangles: number;
  /** The triangles the fit used. */
  region?: number[];
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const unit = (a: Vec3): Vec3 => {
  const l = len(a);
  return l > 0 ? scale(a, 1 / l) : [0, 0, 1];
};

/** Eigen-decomposition of a symmetric 3x3 matrix (Jacobi). Returns eigenvalues and column eigenvectors. */
export function symmetricEigen3(m: number[][]): { values: number[]; vectors: Vec3[] } {
  const a = m.map((r) => [...r]);
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = a[0]![1]! ** 2 + a[0]![2]! ** 2 + a[1]![2]! ** 2;
    if (off < 1e-30) break;
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ] as const) {
      const apq = a[p]![q]!;
      if (Math.abs(apq) < 1e-300) continue;
      const theta = (a[q]![q]! - a[p]![p]!) / (2 * apq);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k]![p]!;
        const akq = a[k]![q]!;
        a[k]![p] = c * akp - s * akq;
        a[k]![q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p]![k]!;
        const aqk = a[q]![k]!;
        a[p]![k] = c * apk - s * aqk;
        a[q]![k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k]![p]!;
        const vkq = v[k]![q]!;
        v[k]![p] = c * vkp - s * vkq;
        v[k]![q] = s * vkp + c * vkq;
      }
    }
  }
  const values = [a[0]![0]!, a[1]![1]!, a[2]![2]!];
  const vectors: Vec3[] = [0, 1, 2].map((j) => [v[0]![j]!, v[1]![j]!, v[2]![j]!] as Vec3);
  return { values, vectors };
}

/** Least-squares circle through 2D points: algebraic (Kasa) start, then Gauss-Newton on the geometric error. */
export function fitCircle2D(xs: readonly number[], ys: readonly number[]): { cx: number; cy: number; r: number } {
  const n = xs.length;
  // Centre the data for conditioning.
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i]!;
    my += ys[i]!;
  }
  mx /= n;
  my /= n;
  // Kasa: x^2 + y^2 + D x + E y + F = 0
  const ata = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const atb = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const x = xs[i]! - mx;
    const y = ys[i]! - my;
    const row = [x, y, 1];
    const b = -(x * x + y * y);
    for (let r = 0; r < 3; r++) {
      atb[r]! += row[r]! * b;
      for (let c = 0; c < 3; c++) ata[r]![c]! += row[r]! * row[c]!;
    }
  }
  const sol = solve3(ata, atb);
  let cx = sol ? -sol[0]! / 2 : 0;
  let cy = sol ? -sol[1]! / 2 : 0;
  let r = sol ? Math.sqrt(Math.max(cx * cx + cy * cy - sol[2]!, 0)) : 0;
  // Gauss-Newton on sum (|p - c| - r)^2
  for (let it = 0; it < 30; it++) {
    const jtj = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    const jtr = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      const dx = xs[i]! - mx - cx;
      const dy = ys[i]! - my - cy;
      const d = Math.hypot(dx, dy) || 1e-12;
      const res = d - r;
      const j = [-dx / d, -dy / d, -1];
      for (let a = 0; a < 3; a++) {
        jtr[a]! += j[a]! * res;
        for (let b = 0; b < 3; b++) jtj[a]![b]! += j[a]! * j[b]!;
      }
    }
    const step = solve3(jtj, jtr.map((x) => -x));
    if (!step) break;
    cx += step[0]!;
    cy += step[1]!;
    r += step[2]!;
    if (Math.hypot(step[0]!, step[1]!, step[2]!) < 1e-12 * Math.max(1, Math.abs(r))) break;
  }
  return { cx: cx + mx, cy: cy + my, r: Math.abs(r) };
}

function solve3(a: number[][], b: number[]): number[] | null {
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[p]![c]!)) p = r;
    if (Math.abs(m[p]![c]!) < 1e-300) return null;
    [m[c], m[p]] = [m[p]!, m[c]!];
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = m[r]![c]! / m[c]![c]!;
      for (let k = c; k < 4; k++) m[r]![k]! -= f * m[c]![k]!;
    }
  }
  return [m[0]![3]! / m[0]![0]!, m[1]![3]! / m[1]![1]!, m[2]![3]! / m[2]![2]!];
}

interface TriData {
  normals: Vec3[];
  areas: number[];
  centroids: Vec3[];
  verts: number[];
  totalArea: number;
}

function triData(positions: ArrayLike<number>, index: ArrayLike<number> | null, tris: readonly number[]): TriData {
  const vtx = (t: number, k: number) => (index ? index[3 * t + k]! : 3 * t + k);
  const P = (i: number): Vec3 => [positions[3 * i]!, positions[3 * i + 1]!, positions[3 * i + 2]!];
  const normals: Vec3[] = [];
  const areas: number[] = [];
  const centroids: Vec3[] = [];
  const verts = new Set<number>();
  let totalArea = 0;
  for (const t of tris) {
    const ia = vtx(t, 0);
    const ib = vtx(t, 1);
    const ic = vtx(t, 2);
    verts.add(ia).add(ib).add(ic);
    const a = P(ia);
    const b = P(ib);
    const c = P(ic);
    const n = cross(sub(b, a), sub(c, a));
    const l = len(n);
    if (l === 0) continue;
    normals.push(scale(n, 1 / l));
    areas.push(l / 2);
    centroids.push(scale(add(add(a, b), c), 1 / 3));
    totalArea += l / 2;
  }
  return { normals, areas, centroids, verts: [...verts], totalArea };
}

/**
 * Fit an axis to triangles `tris` of an indexed (or, with `index` null,
 * non-indexed) mesh. `positions` is xyz per vertex. The region is taken as
 * given; see `fitAxisFromSeed` for picking.
 */
export function fitAxis(positions: ArrayLike<number>, index: ArrayLike<number> | null, tris: readonly number[]): AxisFit | null {
  if (tris.length === 0) return null;
  const d = triData(positions, index, tris);
  if (d.totalArea === 0) return null;
  let mean: Vec3 = [0, 0, 0];
  d.normals.forEach((n, i) => (mean = add(mean, scale(n, d.areas[i]!))));
  const meanUnit = unit(mean);
  let maxDev = 0;
  // Sine of each normal's deviation from the mean (1 for anything facing away).
  if (len(mean) > 0) for (const n of d.normals) maxDev = Math.max(maxDev, dot(n, meanUnit) <= 0 ? 1 : len(cross(n, meanUnit)));
  if (len(mean) > 0 && maxDev <= Math.sin((FLAT_TOLERANCE_DEG * Math.PI) / 180)) {
    return fitFlat(positions, index, tris, d, meanUnit, maxDev);
  }
  return fitCylinder(positions, d, tris);
}

// ---------------------------------------------------------------- flat

/** Edges used by exactly one triangle of the region, as position pairs. */
function boundaryEdges(positions: ArrayLike<number>, index: ArrayLike<number> | null, tris: readonly number[]): Array<[Vec3, Vec3]> {
  const P = (i: number): Vec3 => [positions[3 * i]!, positions[3 * i + 1]!, positions[3 * i + 2]!];
  // Key by rounded position so split vertices still pair up.
  const key = (p: Vec3) => p.map((x) => Math.round(x * 1e4)).join(',');
  const count = new Map<string, { a: Vec3; b: Vec3; n: number }>();
  for (const t of tris) {
    const ids = [0, 1, 2].map((k) => (index ? index[3 * t + k]! : 3 * t + k));
    for (let k = 0; k < 3; k++) {
      const a = P(ids[k]!);
      const b = P(ids[(k + 1) % 3]!);
      const ka = key(a);
      const kb = key(b);
      if (ka === kb) continue;
      const e = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const cur = count.get(e);
      if (cur) cur.n++;
      else count.set(e, { a, b, n: 1 });
    }
  }
  return [...count.values()].filter((e) => e.n === 1).map((e) => [e.a, e.b]);
}

/** Is a set of radii one circle (or two, for a ring) about the centre? Returns the circle radii, or null. */
function roundClusters(radii: number[]): number[] | null {
  if (radii.length < 6) return null;
  const sorted = [...radii].sort((a, b) => a - b);
  const max = sorted[sorted.length - 1]!;
  // Split at the largest gap if it is big (a ring has an inner and an outer boundary).
  let gapAt = -1;
  let gap = 0;
  for (let i = 1; i < sorted.length; i++) {
    const g = sorted[i]! - sorted[i - 1]!;
    if (g > gap) {
      gap = g;
      gapAt = i;
    }
  }
  const groups = gap > 0.1 * max ? [sorted.slice(0, gapAt), sorted.slice(gapAt)] : [sorted];
  const out: number[] = [];
  for (const g of groups) {
    if (g.length < 6) return null;
    const mean = g.reduce((a, b) => a + b, 0) / g.length;
    const rms = Math.sqrt(g.reduce((a, b) => a + (b - mean) ** 2, 0) / g.length);
    if (rms > 0.02 * mean) return null;
    out.push(mean);
  }
  return out;
}

function fitFlat(positions: ArrayLike<number>, index: ArrayLike<number> | null, tris: readonly number[], d: TriData, n: Vec3, maxDev: number): AxisFit {
  let centre: Vec3 = [0, 0, 0];
  d.centroids.forEach((c, i) => (centre = add(centre, scale(c, d.areas[i]!))));
  centre = scale(centre, 1 / d.totalArea);
  const inPlane = (p: Vec3) => {
    const v = sub(p, centre);
    return len(sub(v, scale(n, dot(v, n))));
  };
  // Roundness: boundary vertices AND edge midpoints must sit on circles about
  // the centroid (the corners of a rectangle are equidistant from its centre;
  // its edge midpoints are not), and the area must match the circle or annulus.
  const edges = boundaryEdges(positions, index, tris);
  const radii = edges.map(([a]) => inPlane(a));
  const circles = roundClusters(radii);
  let round = false;
  let radius = 0;
  if (circles) {
    const mids = edges.map(([a, b]) => inPlane(scale(add(a, b), 0.5)));
    // A regular N-gon's edge midpoints sit at R cos(pi/N); this allows down to ~12 sides.
    const midsOk = mids.every((m) => circles.some((r) => m >= r * 0.96 && m <= r * 1.01));
    const outer = Math.max(...circles);
    const inner = circles.length > 1 ? Math.min(...circles) : 0;
    const areaRatio = d.totalArea / (Math.PI * (outer * outer - inner * inner));
    round = midsOk && areaRatio > 0.9 && areaRatio < 1.02;
    radius = outer;
  } else {
    for (const v of d.verts) radius = Math.max(radius, inPlane([positions[3 * v]!, positions[3 * v + 1]!, positions[3 * v + 2]!]));
  }
  return {
    kind: 'flat',
    dir: n,
    point: centre,
    radius,
    rmsRelative: 0,
    maxNormalDot: maxDev,
    length: 0,
    quality: round ? 'good' : 'poor',
    position: round ? 'determined' : 'guess',
    note: round ? undefined : 'This flat face is not round, so only its direction is known: the point shown is just its centre. Pick a pin or hole, or type the point.',
    triangles: tris.length,
    region: [...tris],
  };
}

// ---------------------------------------------------------------- cylinder

interface CylinderModel {
  dir: Vec3;
  point: Vec3;
  radius: number;
  u: Vec3;
  v: Vec3;
  cx: number;
  cy: number;
  tMin: number;
  tMax: number;
  rms: number;
  /** Angle around the axis covered by the vertices, radians. */
  coverage: number;
}

function cylinderModel(positions: ArrayLike<number>, d: TriData): CylinderModel {
  const cov = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  d.normals.forEach((n, i) => {
    const w = d.areas[i]!;
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) cov[r]![c]! += w * n[r]! * n[c]!;
  });
  const eig = symmetricEigen3(cov);
  let k = 0;
  for (let i = 1; i < 3; i++) if (eig.values[i]! < eig.values[k]!) k = i;
  let dir = unit(eig.vectors[k]!);
  const big = [0, 1, 2].reduce((m, i) => (Math.abs(dir[i]!) > Math.abs(dir[m]!) ? i : m), 0);
  if (dir[big]! < 0) dir = scale(dir, -1);
  const helper: Vec3 = Math.abs(dir[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = unit(cross(dir, helper));
  const v = cross(dir, u);
  const xs: number[] = [];
  const ys: number[] = [];
  let tMin = Infinity;
  let tMax = -Infinity;
  for (const i of d.verts) {
    const p: Vec3 = [positions[3 * i]!, positions[3 * i + 1]!, positions[3 * i + 2]!];
    xs.push(dot(p, u));
    ys.push(dot(p, v));
    const t = dot(p, dir);
    if (t < tMin) tMin = t;
    if (t > tMax) tMax = t;
  }
  const c = fitCircle2D(xs, ys);
  let sq = 0;
  const angles: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i]! - c.cx;
    const dy = ys[i]! - c.cy;
    sq += (Math.hypot(dx, dy) - c.r) ** 2;
    angles.push(Math.atan2(dy, dx));
  }
  angles.sort((a, b) => a - b);
  let maxGap = angles.length ? 2 * Math.PI - (angles[angles.length - 1]! - angles[0]!) : 2 * Math.PI;
  for (let i = 1; i < angles.length; i++) maxGap = Math.max(maxGap, angles[i]! - angles[i - 1]!);
  const point = add(add(scale(u, c.cx), scale(v, c.cy)), scale(dir, (tMin + tMax) / 2));
  return { dir, point, radius: c.r, u, v, cx: c.cx, cy: c.cy, tMin, tMax, rms: Math.sqrt(sq / Math.max(1, xs.length)), coverage: 2 * Math.PI - maxGap };
}

/** Smallest angular coverage of a round surface that fixes the axis position well. */
const MIN_COVERAGE = (25 * Math.PI) / 180;

function fitCylinder(positions: ArrayLike<number>, d: TriData, tris: readonly number[]): AxisFit {
  const m = cylinderModel(positions, d);
  const rmsRelative = m.radius > 0 ? m.rms / m.radius : Infinity;
  let maxNormalDot = 0;
  for (const n of d.normals) maxNormalDot = Math.max(maxNormalDot, Math.abs(dot(n, m.dir)));
  let quality: AxisFit['quality'] = 'good';
  let note: string | undefined;
  if (!Number.isFinite(rmsRelative) || rmsRelative > MAX_RELATIVE_RMS) {
    quality = 'poor';
    note = 'The surface is not round about a single axis (it may be a sphere, a fillet or a freeform blend).';
  } else if (maxNormalDot > MAX_NORMAL_DOT) {
    quality = 'poor';
    note = 'The surface narrows along the axis (a cone or a taper), so it is not a cylinder.';
  } else if (m.coverage < MIN_COVERAGE) {
    quality = 'poor';
    note = 'Too little of the round surface to place the axis reliably. Click a larger part of the pin or hole.';
  }
  return {
    kind: 'cylinder',
    dir: m.dir,
    point: m.point,
    radius: m.radius,
    rmsRelative,
    maxNormalDot,
    length: m.tMax - m.tMin,
    quality,
    position: quality === 'good' ? 'determined' : 'guess',
    note,
    triangles: tris.length,
    region: [...tris],
  };
}

// ---------------------------------------------------------------- picking

/** Triangle mesh with adjacency, as the picker needs it. */
export interface TriTopology {
  positions: ArrayLike<number>;
  index: ArrayLike<number> | null;
  /** Unit face normal per triangle, xyz. */
  normals: ArrayLike<number>;
  /** CSR adjacency: neighbours of t are adj[offsets[t] .. offsets[t+1]). */
  offsets: ArrayLike<number>;
  adj: ArrayLike<number>;
}

const deg = (a: number) => (a * Math.PI) / 180;
/** Initial neighbourhood: neighbours across edges up to this dihedral angle. */
const SEED_DIHEDRAL = deg(50);
/** Normal tolerance (|n . axis|) per refinement round, loose to tight. */
const NORMAL_TOL = [Math.sin(deg(15)), Math.sin(deg(8)), Math.sin(deg(4)), Math.sin(deg(2.5))];
/** Radius tolerance (fraction of the radius) per round. */
const RADIUS_TOL = [0.15, 0.06, 0.02, 0.01];

function triNormal(topo: TriTopology, t: number): Vec3 {
  return [topo.normals[3 * t]!, topo.normals[3 * t + 1]!, topo.normals[3 * t + 2]!];
}

function vertexIds(topo: TriTopology, t: number): number[] {
  return [0, 1, 2].map((k) => (topo.index ? topo.index[3 * t + k]! : 3 * t + k));
}

/** Connected triangles from `seed` (breadth first) for which `accept` holds. */
function grow(topo: TriTopology, seed: number, accept: (t: number) => boolean): number[] {
  if (!accept(seed)) return [];
  const seen = new Set([seed]);
  const out = [seed];
  for (let h = 0; h < out.length; h++) {
    const t = out[h]!;
    for (let k = topo.offsets[t]!; k < topo.offsets[t + 1]!; k++) {
      const u = topo.adj[k]!;
      if (seen.has(u)) continue;
      seen.add(u);
      if (accept(u)) out.push(u);
    }
  }
  return out;
}

/** Small neighbourhood of the seed across smooth-ish edges, by rings, until its normals span a few degrees. */
function seedPatch(topo: TriTopology, seed: number): { tris: number[]; curved: boolean } {
  const ns = triNormal(topo, seed);
  const cosEdge = Math.cos(SEED_DIHEDRAL);
  let ring = [seed];
  const seen = new Set([seed]);
  const tris = [seed];
  const spanSin = Math.sin(deg(4));
  for (let depth = 0; depth < 8; depth++) {
    const next: number[] = [];
    for (const t of ring) {
      const nt = triNormal(topo, t);
      for (let k = topo.offsets[t]!; k < topo.offsets[t + 1]!; k++) {
        const u = topo.adj[k]!;
        if (seen.has(u)) continue;
        seen.add(u);
        if (dot(nt, triNormal(topo, u)) >= cosEdge) next.push(u);
      }
    }
    tris.push(...next);
    ring = next;
    if (tris.length >= 3 && next.some((t) => len(cross(triNormal(topo, t), ns)) > spanSin)) return { tris, curved: true };
    if (next.length === 0) break;
  }
  return { tris, curved: false };
}

/** The flat face under the click (normals within the flat tolerance of the clicked one). */
function flatRegionFit(topo: TriTopology, seed: number, ns: Vec3): AxisFit | null {
  const cosFlat = Math.cos(deg(FLAT_TOLERANCE_DEG));
  const region = grow(topo, seed, (t) => dot(triNormal(topo, t), ns) >= cosFlat);
  return fitAxis(topo.positions, topo.index, region);
}

/**
 * Fit the axis of the surface under a clicked triangle. Grows a region that
 * is consistent with ONE cylinder (or one flat face) from the click, so
 * fillets, chamfers, end faces and keyways next to a pin or hole are left out.
 * A click on a fillet, chamfer or blend itself is reported as poor with a
 * note asking for the cylindrical part.
 */
export function fitAxisFromSeed(topo: TriTopology, seed: number): AxisFit | null {
  const ns = triNormal(topo, seed);
  // A round flat face (a pin's end face, a washer face) answers directly,
  // even when a tangent fillet makes its neighbourhood look curved.
  const flat = flatRegionFit(topo, seed, ns);
  if (flat && flat.quality === 'good') return flat;
  const patch = seedPatch(topo, seed);
  if (!patch.curved) return flat;

  let region = patch.tris;
  let seedOk = true;
  for (let round = 0; round < 16; round++) {
    const level = Math.min(round, NORMAL_TOL.length - 1);
    const d = triData(topo.positions, topo.index, region);
    if (d.totalArea === 0) break;
    const m = cylinderModel(topo.positions, d);
    const tolN = NORMAL_TOL[level]!;
    const tolR = Math.max(RADIUS_TOL[level]! * m.radius, 1e-6);
    const vertexOk = (i: number) => {
      const p: Vec3 = [topo.positions[3 * i]!, topo.positions[3 * i + 1]!, topo.positions[3 * i + 2]!];
      return Math.abs(Math.hypot(dot(p, m.u) - m.cx, dot(p, m.v) - m.cy) - m.radius) <= tolR;
    };
    const consistent = (t: number) => Math.abs(dot(triNormal(topo, t), m.dir)) <= tolN && vertexIds(topo, t).every(vertexOk);
    const next = grow(topo, seed, consistent);
    if (next.length === 0) {
      // The clicked triangle is not on the cylinder its neighbourhood fits.
      seedOk = false;
      break;
    }
    const stable = level === NORMAL_TOL.length - 1 && next.length === region.length && next.every((t, i) => t === region[i]);
    region = next;
    if (stable) break;
  }
  if (seedOk && region.length >= 2) {
    const fit = fitAxis(topo.positions, topo.index, region);
    if (fit && fit.kind === 'cylinder' && fit.quality === 'good') return fit;
  }
  // Not a cylinder under the click. A larger flat face gives its direction
  // (position flagged as a guess); otherwise it is a fillet, chamfer or blend.
  if (flat && flat.triangles > 2) return flat;
  const blend = fitAxis(topo.positions, topo.index, patch.tris);
  if (!blend) return null;
  return {
    ...blend,
    quality: 'poor',
    position: 'guess',
    note: 'This looks like a fillet, chamfer or blend, not the round surface of a pin or hole. Click the cylindrical part of the pin or hole.',
  };
}
