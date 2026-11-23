// Import a model file in Node and describe what came in: time, bodies, size,
// warnings. Useful before opening an unfamiliar CAD export in the app.
//   npx tsx tools/perf/inspect-model.ts path/to/model.step
import { readFileSync } from 'node:fs';
import { validateDesign, emptyDesign } from '../../src/core/index';
import { importModel } from '../../src/app/ingest/index';

const path = process.argv[2];
if (!path) throw new Error('usage: inspect-model.ts <model file>');
const bytes = readFileSync(path);
const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
const start = performance.now();
const model = await importModel([{ path: path.split(/[\/]/).pop()!, data }]);
const seconds = (performance.now() - start) / 1000;

const lo = [Infinity, Infinity, Infinity];
const hi = [-Infinity, -Infinity, -Infinity];
const rows: { id: string; tris: number; size: number[] }[] = [];
for (const mesh of model.meshes) {
  const p = mesh.geometry.getAttribute('position');
  const mlo = [Infinity, Infinity, Infinity];
  const mhi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.count; i++) {
    const v = [p.getX(i), p.getY(i), p.getZ(i)];
    for (let k = 0; k < 3; k++) {
      mlo[k] = Math.min(mlo[k]!, v[k]!);
      mhi[k] = Math.max(mhi[k]!, v[k]!);
      lo[k] = Math.min(lo[k]!, v[k]!);
      hi[k] = Math.max(hi[k]!, v[k]!);
    }
  }
  rows.push({ id: mesh.id, tris: (mesh.geometry.getIndex()?.count ?? 0) / 3, size: mhi.map((h, k) => +(h - mlo[k]!).toFixed(1)) });
}
const triangles = rows.reduce((n, r) => n + r.tris, 0);
const design = emptyDesign('inspect');
design.scene = { sources: model.sources, links: model.links, joints: model.joints };

console.log(`${(bytes.byteLength / 1e6).toFixed(1)} MB imported in ${seconds.toFixed(1)} s`);
console.log(`${model.links.length} link(s), ${model.joints.length} joint(s), ${model.meshes.length} meshes, ${triangles} triangles`);
console.log(`overall size mm: ${hi.map((h, k) => (h - lo[k]!).toFixed(1)).join(' x ')}`);
console.log(`validation issues: ${validateDesign(design).length}; import warnings: ${model.warnings.length}`);
for (const w of model.warnings.slice(0, 8)) console.log(`  warning: ${w}`);

// Bodies grouped by name with trailing instance numbers removed.
const groups = new Map<string, { n: number; tris: number; size: number[] }>();
for (const r of rows) {
  const key = r.id.replace(/^[^.]*\./, '').replace(/(_\d+)+$/, '');
  const g = groups.get(key);
  if (g) {
    g.n++;
    g.tris += r.tris;
  } else groups.set(key, { n: 1, tris: r.tris, size: r.size });
}
console.log(`${groups.size} distinct body names:`);
for (const [name, g] of [...groups].sort((a, b) => b[1].tris - a[1].tris).slice(0, 40)) {
  console.log(`  ${String(g.n).padStart(3)} x ${name.padEnd(44)} ${String(g.tris).padStart(8)} tris   ${g.size.join(' x ')}`);
}
