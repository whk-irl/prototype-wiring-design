// Fit every cylindrical surface of every body in a model, then list the axis
// lines that two different bodies share. A revolute joint between two bodies
// normally shows up as such a shared line (a shaft or horn on one, a bore or
// bearing seat on the other), so this both measures how well the axis fit
// agrees with itself on real tessellation and hints at where the joints are.
//   npx tsx tools/perf/find-axes.ts path/to/model.step
import { readFileSync } from 'node:fs';
import { importModel } from '../../src/app/ingest/index';
import { fitAxisFromSeed, type Vec3 } from '../../src/app/placement/axisFit';
import { topologyOf } from '../../src/app/scene/topology';

const path = process.argv[2];
if (!path) throw new Error('usage: find-axes.ts <model file>');
const bytes = readFileSync(path);
const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
const model = await importModel([{ path: path.split(/[\/]/).pop()!, data }]);

interface Axis { mesh: string; dir: Vec3; point: Vec3; radii: number[]; length: number; tris: number; lo: number; hi: number }

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const angleDeg = (a: Vec3, b: Vec3) => (Math.acos(Math.min(1, Math.abs(dot(a, b)))) * 180) / Math.PI;
/** Distance from point p to the line through q along unit d. */
const lineDist = (p: Vec3, q: Vec3, d: Vec3) => {
  const v = sub(p, q);
  const t = dot(v, d);
  return Math.hypot(v[0] - t * d[0], v[1] - t * d[1], v[2] - t * d[2]);
};

const start = performance.now();
const all: Axis[] = [];
let fits = 0;
for (const mesh of model.meshes) {
  const topo = topologyOf(mesh.geometry);
  const triCount = topo.offsets.length - 1;
  const seen = new Uint8Array(triCount);
  const axes: Axis[] = [];
  for (let seed = 0; seed < triCount; seed++) {
    if (seen[seed]) continue;
    seen[seed] = 1;
    const fit = fitAxisFromSeed(topo, seed);
    fits++;
    if (!fit) continue;
    for (const t of fit.region ?? []) seen[t] = 1;
    if (fit.kind !== 'cylinder' || fit.quality !== 'good' || fit.position !== 'determined') continue;
    if (fit.radius < 0.8 || fit.radius > 60 || fit.triangles < 12) continue;
    // Merge with an axis of this mesh that is the same line.
    const same = axes.find((a) => angleDeg(a.dir, fit.dir) < 0.5 && lineDist(fit.point, a.point, a.dir) < 0.1);
    const along = (a: Axis | null) => dot(sub(fit.point, a ? a.point : fit.point), a ? a.dir : fit.dir);
    if (same) {
      same.radii.push(+fit.radius.toFixed(2));
      same.tris += fit.triangles;
      const c = along(same);
      same.lo = Math.min(same.lo, c - fit.length / 2);
      same.hi = Math.max(same.hi, c + fit.length / 2);
    } else {
      axes.push({ mesh: mesh.id, dir: fit.dir, point: fit.point, radii: [+fit.radius.toFixed(2)], length: fit.length, tris: fit.triangles, lo: -fit.length / 2, hi: fit.length / 2 });
    }
  }
  all.push(...axes);
  console.log(`${mesh.id.padEnd(40)} ${String(triCount).padStart(7)} tris  ${String(axes.length).padStart(4)} distinct cylinder axes`);
}
console.log(`${fits} fits in ${((performance.now() - start) / 1000).toFixed(1)} s; ${all.length} axes in total\n`);

// Axis lines shared by two different bodies.
interface Shared { a: Axis; b: Axis; angle: number; offset: number }
const shared: Shared[] = [];
for (let i = 0; i < all.length; i++) {
  for (let j = i + 1; j < all.length; j++) {
    const a = all[i]!;
    const b = all[j]!;
    if (a.mesh === b.mesh) continue;
    const angle = angleDeg(a.dir, b.dir);
    if (angle > 1) continue;
    const offset = Math.max(lineDist(b.point, a.point, a.dir), lineDist(a.point, b.point, b.dir));
    if (offset > 0.3) continue;
    // The two features must be near each other along the line, not just collinear across the model.
    const cb = dot(sub(b.point, a.point), a.dir);
    if (cb + b.hi < a.lo - 15 || cb + b.lo > a.hi + 15) continue;
    shared.push({ a, b, angle, offset });
  }
}
const byPair = new Map<string, Shared[]>();
for (const s of shared) {
  const key = [s.a.mesh, s.b.mesh].sort().join('  <->  ');
  (byPair.get(key) ?? byPair.set(key, []).get(key)!).push(s);
}
console.log(`${byPair.size} pairs of bodies share at least one axis line:`);
for (const [key, list] of [...byPair].sort()) {
  const worstAngle = Math.max(...list.map((s) => s.angle));
  const worstOffset = Math.max(...list.map((s) => s.offset));
  // Count distinct lines within the pair.
  const lines: Shared[] = [];
  for (const s of list) if (!lines.some((l) => angleDeg(l.a.dir, s.a.dir) < 1 && lineDist(s.a.point, l.a.point, l.a.dir) < 0.5)) lines.push(s);
  console.log(`  ${key}`);
  console.log(`      ${lines.length} shared line(s); worst disagreement between the two bodies' fits: ${worstAngle.toFixed(3)} deg, ${worstOffset.toFixed(3)} mm`);
  for (const l of lines.slice(0, 6)) {
    const r = (x: Axis) => [...new Set(x.radii)].sort((p, q) => p - q).slice(0, 5).join('/');
    console.log(`      line through (${l.a.point.map((v) => v.toFixed(1)).join(', ')}) along (${l.a.dir.map((v) => v.toFixed(3)).join(', ')})  radii ${r(l.a)} | ${r(l.b)}`);
  }
}
