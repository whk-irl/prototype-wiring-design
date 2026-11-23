// Golden: importing each committed fixture reproduces its expected.json and design.json.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FIXTURE_SPECS, expectedOf, importFixture, sceneOf } from '../../tools/fixtures/make-designs';
import { FIXTURE_DIR, expectClose } from './helpers';

const json = (path: string) => JSON.parse(readFileSync(`${FIXTURE_DIR}${path}`, 'utf8')) as Record<string, unknown>;

describe.each(FIXTURE_SPECS)('golden: $id', (spec) => {
  it('matches expected.json (counts exact, bounding box within 0.01 mm)', async () => {
    const model = await importFixture(spec);
    const actual = JSON.parse(JSON.stringify(expectedOf(model))) as Record<string, unknown>;
    const expected = json(`${spec.id}/expected.json`);
    const { bbox_mm: actualBox, ...actualRest } = actual;
    const { bbox_mm: expectedBox, ...expectedRest } = expected;
    expectClose(actualRest, expectedRest, 1e-12); // counts, triangle counts, joint names, types, limits
    expectClose(actualBox, expectedBox, 0.01);
  });

  it('reproduces the scene of design.json', async () => {
    const model = await importFixture(spec);
    const actual = JSON.parse(JSON.stringify(sceneOf(model)));
    const design = json(`${spec.id}/design.json`);
    // Strict equality, except that numbers may differ in the last bits (trig functions differ between engines).
    expectClose(actual, design['scene'], 1e-9);
  });

  it('is listed in index.json', () => {
    const index = JSON.parse(readFileSync(`${FIXTURE_DIR}index.json`, 'utf8')) as { id: string; files: string[]; design: string }[];
    const entry = index.find((e) => e.id === spec.id);
    expect(entry?.files).toEqual(spec.files);
    expect(entry?.design).toBe('design.json');
  });
});
