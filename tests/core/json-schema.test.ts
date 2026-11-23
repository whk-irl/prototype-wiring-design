import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { it } from 'vitest';
import { designJsonSchema } from '@core';
import { ROOT } from './helpers';

it('schema/design.schema.json is up to date with the code', () => {
  const expected = `${JSON.stringify(designJsonSchema(), null, 2)}\n`;
  let actual: string;
  try {
    actual = readFileSync(resolve(ROOT, 'schema/design.schema.json'), 'utf8').replace(/\r\n/g, '\n');
  } catch {
    throw new Error('schema/design.schema.json is missing. Run `npm run schema` and commit the result.');
  }
  if (actual !== expected) {
    throw new Error('schema/design.schema.json differs from the schema in src/core/schema.ts. Run `npm run schema` and commit the result.');
  }
});
