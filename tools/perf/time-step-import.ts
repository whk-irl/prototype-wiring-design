// Time a STEP import in Node, outside the browser:
//   npx tsx tools/perf/time-step-import.ts tools/out/big.step
import { readFileSync } from 'node:fs';
import { importModel } from '../../src/app/ingest/index';

const path = process.argv[2];
if (!path) throw new Error('usage: time-step-import.ts <file.step>');
const bytes = readFileSync(path);
const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
const start = performance.now();
const model = await importModel([{ path: path.split(/[\/]/).pop()!, data }]);
const seconds = (performance.now() - start) / 1000;
const triangles = model.links.flatMap((l) => l.meshes).reduce((n, m) => n + m.tri_count, 0);
console.log(`${(bytes.byteLength / 1e6).toFixed(1)} MB, ${model.meshes.length} meshes, ${triangles} triangles, ${seconds.toFixed(1)} s`);
