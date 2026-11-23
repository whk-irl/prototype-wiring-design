/** Writes the JSON Schema of the design file to schema/design.schema.json. Run with `npm run schema`. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { designJsonSchema } from '../src/core/schema';

const out = resolve(dirname(fileURLToPath(import.meta.url)), '../schema/design.schema.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(designJsonSchema(), null, 2)}\n`);
console.log(`wrote ${out}`);
