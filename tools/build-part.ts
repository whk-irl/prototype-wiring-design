/**
 * Build a bundled part model: import a CAD or mesh file, turn it into the part
 * frame, simplify it and write `public/parts/<id>.glb`.
 *
 *   npx tsx tools/build-part.ts <file.step|.stp|.glb|.stl|.obj> --id <part-id> --up <+z|-z|+x|-x|+y|-y>
 *       [--spin <deg about the new Z>] [--max-triangles 20000] [--out public/parts] [--json] [--holes] [--pads]
 *
 * Prints the envelope, triangle counts, file size, sha256 and a table of every
 * named body of the source with its bounding box in the PART frame (after
 * turning and centring) and its triangle count, sorted by z then name. That
 * table is what a library entry's ports and mounting holes are read from.
 * `--holes` adds a best-effort search for round through-holes 1.5 to 5 mm
 * across in the lowest board-like body. `--pads` finds plated holes 0.7 to
 * 1.3 mm across in the same body and groups them into rows at 2.54 mm or
 * 2.0 mm pitch (header and connector footprints).
 *
 * Part frame: mm, origin at the centre of the bottom face of the bounding box
 * (the mounting face), +Z up, envelope x in [-sx/2, sx/2], y in [-sy/2, sy/2],
 * z in [0, sz]. STL and OBJ files are read as millimetres.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importModel } from '../src/app/ingest';
import { encodePartGlb, mergeByColour, meshBounds, sha256Hex, triangleCount, type PartMesh } from '../src/app/parts/glb';
import { flattenModel, orientMeshes, UP_AXES, type UpAxis } from '../src/app/parts/fromModel';
import { simplifyMeshes, weldMesh } from '../src/app/parts/simplify';

type V3 = [number, number, number];

export interface BuildPartOptions {
  file: string;
  id: string;
  up: UpAxis;
  spin_deg: number;
  maxTriangles: number;
  outDir: string;
  holes: boolean;
  pads?: boolean;
}

export interface BodyRow {
  name: string;
  min_mm: V3;
  max_mm: V3;
  size_mm: V3;
  triangles: number;
}

export interface DetectedHole {
  /** Body the hole was found in. */
  body: string;
  /** Hole centre, part frame, mm. */
  p_mm: [number, number];
  d_mm: number;
  /** z of the rims found: the top and bottom of the body for a through-hole. */
  z_mm: number[];
  /** A rim was found at both faces of the board. */
  through: boolean;
}

export interface BuildPartResult {
  id: string;
  source: string;
  output: string;
  up: UpAxis;
  spin_deg: number;
  envelope_mm: V3;
  triangles_before: number;
  triangles_after: number;
  bytes: number;
  sha256: string;
  bodies: BodyRow[];
  holes?: DetectedHole[];
  pads?: { holes: number } & PadRows;
  warnings: string[];
}

/** One row of pad holes at a regular pitch, part frame. */
export interface PadRow {
  pitch_mm: number;
  count: number;
  /** Centre of the first and the last hole (the first is the one with the smaller y, then x). */
  start_mm: [number, number];
  end_mm: [number, number];
  /** Direction from start to end, degrees counter-clockwise from +X seen from above. */
  angle_deg: number;
  d_mm: number;
}

export interface PadRows {
  rows: PadRow[];
  /** Pad holes in no row. */
  single: [number, number][];
}

/** Plated pad holes looked for by `--pads`, diameter range, mm. */
export const PAD_MIN_D_MM = 0.7;
export const PAD_MAX_D_MM = 1.3;
/** Pitches rows are grouped at, mm, and how far a spacing may be off. */
const PAD_PITCHES_MM = [2.54, 2.0];
const PITCH_TOLERANCE_MM = 0.08;

const r3 = (v: number): number => Math.round(v * 1000) / 1000 + 0;

function bodyRows(meshes: readonly PartMesh[]): BodyRow[] {
  return meshes
    .map((m) => {
      const { min_mm, max_mm } = meshBounds([m]);
      const empty = !(min_mm[0] <= max_mm[0]);
      const lo = (empty ? [0, 0, 0] : min_mm.map(r3)) as V3;
      const hi = (empty ? [0, 0, 0] : max_mm.map(r3)) as V3;
      return { name: m.name, min_mm: lo, max_mm: hi, size_mm: [0, 1, 2].map((k) => r3(hi[k]! - lo[k]!)) as V3, triangles: Math.floor(m.indices.length / 3) };
    })
    .sort((a, b) => a.min_mm[2] - b.min_mm[2] || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------- hole detection

/**
 * The body that looks most like the circuit board: the largest in x by y of
 * those at most 3.5 mm thick and at least 10 mm across. (The lowest such body
 * is not it: boards carry thin parts underneath, labels and shields.) Ties go
 * to the lower one.
 */
export function boardBody(meshes: readonly PartMesh[]): PartMesh | undefined {
  let best: { mesh: PartMesh; zmin: number; area: number } | undefined;
  for (const mesh of meshes) {
    const { min_mm, max_mm } = meshBounds([mesh]);
    const t = max_mm[2] - min_mm[2];
    const w = max_mm[0] - min_mm[0];
    const h = max_mm[1] - min_mm[1];
    if (!(t > 0.2 && t <= 3.5 && w >= 10 && h >= 10)) continue;
    const area = w * h;
    if (!best || area > best.area * 1.001 || (area >= best.area * 0.999 && min_mm[2] < best.zmin)) best = { mesh, zmin: min_mm[2], area };
  }
  return best?.mesh;
}

/**
 * Round holes in `mesh`: loops of feature edges (boundary edges, or edges
 * where the surface folds by more than 30 degrees) that lie in a horizontal
 * plane, form a circle `minD_mm` to `maxD_mm` across, and whose wall faces
 * the circle's centre (a hole, not a boss). Rims at the same x, y are merged
 * into one hole.
 */
export function detectHoles(source: PartMesh, minD_mm = 1.5, maxD_mm = 5): DetectedHole[] {
  const mesh = weldMesh(source);
  const p = mesh.positions;
  const tri = mesh.indices;
  const normals: V3[] = [];
  for (let t = 0; t < tri.length; t += 3) {
    const a = 3 * tri[t]!, b = 3 * tri[t + 1]!, c = 3 * tri[t + 2]!;
    const u = [p[b]! - p[a]!, p[b + 1]! - p[a + 1]!, p[b + 2]! - p[a + 2]!];
    const v = [p[c]! - p[a]!, p[c + 1]! - p[a + 1]!, p[c + 2]! - p[a + 2]!];
    const n: V3 = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
    const len = Math.hypot(...n) || 1;
    normals.push([n[0] / len, n[1] / len, n[2] / len]);
  }
  // Edge -> faces using it.
  const edgeFaces = new Map<string, number[]>();
  for (let t = 0; t < tri.length / 3; t++) {
    for (let k = 0; k < 3; k++) {
      const a = tri[3 * t + k]!;
      const b = tri[3 * t + ((k + 1) % 3)]!;
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      const list = edgeFaces.get(key);
      if (list) list.push(t);
      else edgeFaces.set(key, [t]);
    }
  }
  const cos30 = Math.cos(Math.PI / 6);
  // Horizontal feature edges, as an adjacency list.
  const adj = new Map<number, number[]>();
  const wallOf = new Map<string, number>();
  for (const [key, faces] of edgeFaces) {
    const [a, b] = key.split(',').map(Number) as [number, number];
    if (Math.abs(p[3 * a + 2]! - p[3 * b + 2]!) > 1e-3) continue;
    let feature = faces.length !== 2;
    if (!feature) {
      const n0 = normals[faces[0]!]!;
      const n1 = normals[faces[1]!]!;
      feature = n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2] < cos30;
    }
    if (!feature) continue;
    // The steepest adjacent face is the wall.
    const wall = faces.reduce((best, f) => (Math.abs(normals[f]![2]) < Math.abs(normals[best]![2]) ? f : best), faces[0]!);
    if (Math.abs(normals[wall]![2]) > 0.5) continue;
    wallOf.set(key, wall);
    for (const [x, y] of [[a, b], [b, a]] as const) {
      const list = adj.get(x);
      if (list) list.push(y);
      else adj.set(x, [y]);
    }
  }
  // Connected loops.
  const seen = new Set<number>();
  const rims: { c: [number, number]; d: number; z: number }[] = [];
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    const comp: number[] = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const v = stack.pop()!;
      comp.push(v);
      for (const w of adj.get(v) ?? []) {
        if (seen.has(w)) continue;
        seen.add(w);
        stack.push(w);
      }
    }
    if (comp.length < 5 || comp.length > 512) continue;
    if (!comp.every((v) => (adj.get(v)?.length ?? 0) === 2)) continue; // not a simple closed loop
    const cx = comp.reduce((s, v) => s + p[3 * v]!, 0) / comp.length;
    const cy = comp.reduce((s, v) => s + p[3 * v + 1]!, 0) / comp.length;
    const radii = comp.map((v) => Math.hypot(p[3 * v]! - cx, p[3 * v + 1]! - cy));
    const r = radii.reduce((s, x) => s + x, 0) / radii.length;
    if (!radii.every((x) => Math.abs(x - r) <= 0.05 * r + 0.01)) continue;
    const d = 2 * r;
    if (d < minD_mm || d > maxD_mm) continue;
    // The wall must face the centre: a hole, not a peg.
    let inward = 0;
    let outward = 0;
    for (const v of comp) {
      for (const w of adj.get(v)!) {
        if (w < v) continue;
        const wall = wallOf.get(`${v},${w}`) ?? wallOf.get(`${w},${v}`);
        if (wall === undefined) continue;
        const n = normals[wall]!;
        const mx = (p[3 * v]! + p[3 * w]!) / 2 - cx;
        const my = (p[3 * v + 1]! + p[3 * w + 1]!) / 2 - cy;
        if (n[0] * mx + n[1] * my < 0) inward++;
        else outward++;
      }
    }
    if (inward <= outward) continue;
    rims.push({ c: [cx, cy], d, z: p[3 * comp[0]! + 2]! });
  }
  // Merge rims of the same hole.
  const { min_mm, max_mm } = meshBounds([mesh]);
  const holes: DetectedHole[] = [];
  for (const rim of rims) {
    const h = holes.find((x) => Math.hypot(x.p_mm[0] - rim.c[0], x.p_mm[1] - rim.c[1]) < 0.2);
    if (h) {
      h.z_mm.push(r3(rim.z));
      h.d_mm = r3((h.d_mm + rim.d) / 2);
    } else holes.push({ body: source.name, p_mm: [r3(rim.c[0]), r3(rim.c[1])], d_mm: r3(rim.d), z_mm: [r3(rim.z)], through: false });
  }
  for (const h of holes) {
    h.z_mm.sort((a, b) => a - b);
    h.through = h.z_mm.some((z) => Math.abs(z - min_mm[2]) < 0.05) && h.z_mm.some((z) => Math.abs(z - max_mm[2]) < 0.05);
  }
  return holes.sort((a, b) => a.p_mm[1] - b.p_mm[1] || a.p_mm[0] - b.p_mm[0]);
}

/**
 * Group hole centres into straight rows at 2.54 mm or 2.0 mm pitch. Rows are
 * found as chains of neighbours one pitch apart in one direction; the longest
 * chains are taken first, and a chain is kept only while at least two of its
 * holes are in no longer row (so a 2 x 20 header gives two rows of 20, not
 * twenty rows of 2).
 */
export function groupPadRows(holes: readonly DetectedHole[]): PadRows {
  const pts = holes.map((h) => h.p_mm);
  const chains: { pitch: number; members: number[] }[] = [];
  for (const pitch of PAD_PITCHES_MM) {
    // Neighbour steps, keyed by direction (rounded, one sign per line).
    const steps = new Map<string, Map<number, number>>();
    for (let i = 0; i < pts.length; i++) {
      for (let j = 0; j < pts.length; j++) {
        if (i === j) continue;
        const dx = pts[j]![0] - pts[i]![0];
        const dy = pts[j]![1] - pts[i]![1];
        if (Math.abs(Math.hypot(dx, dy) - pitch) > PITCH_TOLERANCE_MM) continue;
        // Forward means +x, or +y when the step is vertical: each line is walked one way.
        if (dx < -1e-6 || (Math.abs(dx) <= 1e-6 && dy < 0)) continue;
        const key = `${Math.round((Math.atan2(dy, dx) * 180) / Math.PI / 2) * 2}`;
        let next = steps.get(key);
        if (!next) steps.set(key, (next = new Map()));
        next.set(i, j);
      }
    }
    for (const next of steps.values()) {
      const hasPrev = new Set(next.values());
      for (const start of next.keys()) {
        if (hasPrev.has(start)) continue;
        const members = [start];
        for (let at = next.get(start); at !== undefined && !members.includes(at); at = next.get(at)) members.push(at);
        if (members.length >= 2) chains.push({ pitch, members });
      }
    }
  }
  chains.sort((a, b) => b.members.length - a.members.length || b.pitch - a.pitch);
  const used = new Set<number>();
  const rows: PadRow[] = [];
  for (const c of chains) {
    if (c.members.filter((m) => !used.has(m)).length < 2) continue;
    for (const m of c.members) used.add(m);
    let first = pts[c.members[0]!]!;
    let last = pts[c.members[c.members.length - 1]!]!;
    if (last[1] < first[1] - 1e-6 || (Math.abs(last[1] - first[1]) <= 1e-6 && last[0] < first[0])) [first, last] = [last, first];
    const d = c.members.reduce((s, m) => s + holes[m]!.d_mm, 0) / c.members.length;
    rows.push({
      pitch_mm: c.pitch,
      count: c.members.length,
      start_mm: [r3(first[0]), r3(first[1])],
      end_mm: [r3(last[0]), r3(last[1])],
      angle_deg: r3((Math.atan2(last[1] - first[1], last[0] - first[0]) * 180) / Math.PI),
      d_mm: r3(d),
    });
  }
  rows.sort((a, b) => a.start_mm[1] - b.start_mm[1] || a.start_mm[0] - b.start_mm[0]);
  const single = pts.filter((_, i) => !used.has(i)).map((p) => [r3(p[0]), r3(p[1])] as [number, number]);
  return { rows, single };
}

// ---------------------------------------------------------------- the build

export async function buildPart(opts: BuildPartOptions): Promise<BuildPartResult> {
  const buf = readFileSync(opts.file);
  const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  const model = await importModel([{ path: basename(opts.file), data }], { unitlessAs: 'mm' });
  const { meshes: oriented } = orientMeshes(flattenModel(model), opts.up, opts.spin_deg);
  const bodies = bodyRows(oriented);
  const simplified = await simplifyMeshes(oriented, opts.maxTriangles);
  const { min_mm, max_mm } = meshBounds(simplified);
  const glb = encodePartGlb(mergeByColour(simplified));
  const sha256 = await sha256Hex(glb);
  mkdirSync(opts.outDir, { recursive: true });
  const output = join(opts.outDir, `${opts.id}.glb`);
  writeFileSync(output, new Uint8Array(glb));
  const result: BuildPartResult = {
    id: opts.id,
    source: opts.file,
    output,
    up: opts.up,
    spin_deg: opts.spin_deg,
    envelope_mm: [0, 1, 2].map((k) => r3(max_mm[k]! - min_mm[k]!)) as V3,
    triangles_before: triangleCount(oriented),
    triangles_after: triangleCount(simplified),
    bytes: glb.byteLength,
    sha256,
    bodies,
    warnings: model.warnings,
  };
  // The simplified model must fill the same envelope as the source.
  const source = meshBounds(oriented);
  for (let k = 0; k < 3; k++) {
    if (Math.abs(source.min_mm[k]! - min_mm[k]!) > 0.05 || Math.abs(source.max_mm[k]! - max_mm[k]!) > 0.05) {
      result.warnings.push(`Simplification changed the envelope along ${'xyz'[k]}: source ${r3(source.min_mm[k]!)} .. ${r3(source.max_mm[k]!)}, model ${r3(min_mm[k]!)} .. ${r3(max_mm[k]!)} mm.`);
    }
  }
  const board = opts.holes || opts.pads ? boardBody(oriented) : undefined;
  if ((opts.holes || opts.pads) && !board) result.warnings.push('No board-like body (at most 3.5 mm thick, at least 10 mm across) was found for --holes / --pads.');
  if (opts.holes) result.holes = board ? detectHoles(board) : [];
  if (opts.pads) {
    const holes = board ? detectHoles(board, PAD_MIN_D_MM, PAD_MAX_D_MM) : [];
    result.pads = { holes: holes.length, ...groupPadRows(holes) };
  }
  return result;
}

// ---------------------------------------------------------------- command line

const USAGE = `Usage: npx tsx tools/build-part.ts <file.step|.stp|.glb|.stl|.obj> --id <part-id> --up <+z|-z|+x|-x|+y|-y>
         [--spin <deg>] [--max-triangles 20000] [--out public/parts] [--json] [--holes] [--pads]`;

export function parseArgs(argv: string[]): BuildPartOptions & { json: boolean } {
  let file: string | undefined;
  let id: string | undefined;
  let up: string | undefined;
  let spin_deg = 0;
  let maxTriangles = 20000;
  let outDir = 'public/parts';
  let json = false;
  let holes = false;
  let pads = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value.\n${USAGE}`);
      return v;
    };
    if (a === '--id') id = next();
    else if (a === '--up') up = next();
    else if (a === '--spin') spin_deg = Number(next());
    else if (a === '--max-triangles') maxTriangles = Number(next());
    else if (a === '--out') outDir = next();
    else if (a === '--json') json = true;
    else if (a === '--holes') holes = true;
    else if (a === '--pads') pads = true;
    else if (a.startsWith('--')) throw new Error(`Unknown option ${a}.\n${USAGE}`);
    else if (file === undefined) file = a;
    else throw new Error(`Only one input file, please (got "${file}" and "${a}").\n${USAGE}`);
  }
  if (!file || !id || !up) throw new Error(USAGE);
  if (!(UP_AXES as readonly string[]).includes(up)) throw new Error(`--up must be one of ${UP_AXES.join(', ')}, not "${up}".`);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(id)) throw new Error(`--id "${id}" must be letters, digits, _ . - and start with a letter or digit.`);
  if (!Number.isFinite(spin_deg)) throw new Error('--spin must be a number of degrees.');
  if (!(maxTriangles >= 12)) throw new Error('--max-triangles must be at least 12.');
  return { file: resolve(file), id, up: up as UpAxis, spin_deg, maxTriangles: Math.floor(maxTriangles), outDir: resolve(outDir), json, holes, pads };
}

const f = (v: number): string => v.toFixed(2);

/** The human-readable report. */
export function formatResult(r: BuildPartResult): string {
  const lines: string[] = [];
  lines.push(`Part model   ${r.id}  ->  ${r.output}`);
  lines.push(`Source       ${r.source}  (up ${r.up}${r.spin_deg ? `, spin ${r.spin_deg} deg` : ''})`);
  lines.push(`Envelope     ${f(r.envelope_mm[0])} x ${f(r.envelope_mm[1])} x ${f(r.envelope_mm[2])} mm  (x, y, z)`);
  lines.push(`Triangles    ${r.triangles_before} -> ${r.triangles_after}`);
  lines.push(`File size    ${r.bytes} bytes (${(r.bytes / 1024).toFixed(1)} KiB)`);
  lines.push(`sha256       ${r.sha256}`);
  lines.push('');
  lines.push(`Bodies (${r.bodies.length}), PART frame mm: origin at the centre of the bottom face, +Z up. Sorted by z min, then name.`);
  const nameWidth = Math.max(4, ...r.bodies.map((b) => b.name.length));
  const range = (lo: number, hi: number) => `${f(lo).padStart(8)} .. ${f(hi).padStart(8)}`;
  lines.push(`  ${'name'.padEnd(nameWidth)}  ${'x min .. max'.padStart(20)}  ${'y min .. max'.padStart(20)}  ${'z min .. max'.padStart(20)}  ${'size x y z'.padStart(26)}  triangles`);
  for (const b of r.bodies) {
    const size = `${f(b.size_mm[0]).padStart(8)} ${f(b.size_mm[1]).padStart(8)} ${f(b.size_mm[2]).padStart(8)}`;
    lines.push(`  ${b.name.padEnd(nameWidth)}  ${range(b.min_mm[0], b.max_mm[0])}  ${range(b.min_mm[1], b.max_mm[1])}  ${range(b.min_mm[2], b.max_mm[2])}  ${size}  ${String(b.triangles).padStart(9)}`);
  }
  if (r.holes) {
    lines.push('');
    lines.push(`Holes DETECTED (best effort, check against the drawing): ${r.holes.length}`);
    for (const h of r.holes) {
      lines.push(`  x ${f(h.p_mm[0]).padStart(8)}  y ${f(h.p_mm[1]).padStart(8)}  d ${f(h.d_mm)} mm  ${h.through ? 'through' : 'rim only'} (z ${h.z_mm.map(f).join(', ')})  in ${h.body}`);
    }
  }
  if (r.pads) {
    lines.push('');
    lines.push(`Pad holes DETECTED (${PAD_MIN_D_MM} to ${PAD_MAX_D_MM} mm, best effort): ${r.pads.holes}, in ${r.pads.rows.length} rows`);
    for (const row of r.pads.rows) {
      lines.push(
        `  row of ${String(row.count).padStart(2)} at ${row.pitch_mm.toFixed(2)} mm  from (${f(row.start_mm[0])}, ${f(row.start_mm[1])}) to (${f(row.end_mm[0])}, ${f(row.end_mm[1])})  angle ${f(row.angle_deg)} deg  d ${f(row.d_mm)} mm`,
      );
    }
    if (r.pads.single.length > 0) lines.push(`  single: ${r.pads.single.map((p) => `(${f(p[0])}, ${f(p[1])})`).join(' ')}`);
  }
  if (r.warnings.length > 0) {
    lines.push('');
    for (const w of r.warnings) lines.push(`Warning: ${w}`);
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  let opts: ReturnType<typeof parseArgs>;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 2;
    return;
  }
  const result = await buildPart(opts);
  console.log(opts.json ? JSON.stringify(result, null, 2) : formatResult(result));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}
