import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { decodePartGlb, meshBounds, sha256Hex, type PartMesh } from '../../src/app/parts/glb';
import { buildPart, detectHoles, formatResult, parseArgs, type BuildPartResult } from '../../tools/build-part';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const STEP = resolve(ROOT, 'public/fixtures/enclosure/enclosure.step');
const out = mkdtempSync(join(tmpdir(), 'wd-build-part-'));
afterAll(() => rmSync(out, { recursive: true, force: true }));

const bufferOf = (path: string): ArrayBuffer => {
  const b = readFileSync(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

describe('tools/build-part', () => {
  let result: BuildPartResult;

  it('builds the enclosure fixture into a part-frame GLB', async () => {
    result = await buildPart({ ...parseArgs([STEP, '--id', 'enclosure', '--up', '+z', '--out', out, '--max-triangles', '300']), holes: true });
    expect(result.output).toBe(join(out, 'enclosure.glb'));
    expect(existsSync(result.output)).toBe(true);
    expect(result.envelope_mm).toEqual([160, 100, 60]);
    expect(result.triangles_before).toBeGreaterThan(300);
    expect(result.triangles_after).toBeLessThanOrEqual(300);
    const data = bufferOf(result.output);
    expect(result.bytes).toBe(data.byteLength);
    expect(result.sha256).toBe(await sha256Hex(data));
    const { meshes } = decodePartGlb(data);
    const b = meshBounds(meshes);
    for (let k = 0; k < 2; k++) {
      expect(b.min_mm[k]).toBeCloseTo(-result.envelope_mm[k]! / 2, 2);
      expect(b.max_mm[k]).toBeCloseTo(result.envelope_mm[k]! / 2, 2);
    }
    expect(b.min_mm[2]).toBeCloseTo(0, 2);
    // Every body, part frame, sorted by z then name.
    expect(result.bodies.map((x) => x.name)).toEqual([
      'enclosure/shell',
      'enclosure/divider',
      'enclosure/standoff_1',
      'enclosure/standoff_2',
      'enclosure/standoff_3',
      'enclosure/standoff_4',
    ]);
    const shell = result.bodies[0]!;
    expect(shell.min_mm).toEqual([-80, -50, 0]);
    expect(shell.max_mm).toEqual([80, 50, 60]);
    // No board-like body in an enclosure: no holes, and a warning saying why.
    expect(result.holes).toEqual([]);
    expect(result.warnings.some((w) => /board-like/.test(w))).toBe(true);
    const text = formatResult(result);
    expect(text).toMatch(/Envelope\s+160\.00 x 100\.00 x 60\.00 mm/);
    expect(text).toMatch(/enclosure\/standoff_1\s+-63\.00 \.\.\s+-57\.00/);
  });

  it('turns the model with --up and --spin', async () => {
    const r = await buildPart(parseArgs([STEP, '--id', 'enc-turned', '--up', '+y', '--spin', '90', '--out', out]));
    // +y up: (160, 100, 60) -> (160, 60, 100); a quarter turn swaps x and y.
    expect(r.envelope_mm).toEqual([60, 160, 100]);
  });

  it('rejects bad arguments', () => {
    expect(() => parseArgs([STEP, '--id', 'x'])).toThrow(/Usage/);
    expect(() => parseArgs([STEP, '--id', 'x', '--up', 'z'])).toThrow(/--up must be one of/);
    expect(() => parseArgs([STEP, '--id', 'bad id', '--up', '+z'])).toThrow(/--id/);
  });

  it('runs from the command line and prints JSON', () => {
    const stdout = execFileSync(process.execPath, ['--import', 'tsx', resolve(ROOT, 'tools/build-part.ts'), STEP, '--id', 'enc-cli', '--up', '+z', '--out', out, '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    const json = JSON.parse(stdout) as BuildPartResult;
    expect(json.id).toBe('enc-cli');
    expect(json.envelope_mm).toEqual([160, 100, 60]);
    expect(json.bodies).toHaveLength(6);
    expect(existsSync(join(out, 'enc-cli.glb'))).toBe(true);
  }, 60_000);

  it('detects round through-holes in a board', () => {
    // A 20 x 20 x 1.6 mm plate with one 3 mm hole at (5, -4): rim loops of 24 segments at top and bottom.
    const segs = 24;
    const r = 1.5;
    const pos: number[] = [];
    const idx: number[] = [];
    const add = (x: number, y: number, z: number) => (pos.push(x, y, z), pos.length / 3 - 1);
    for (const z of [0, 1.6]) {
      // Annulus between the hole and a square ring, as a fan of quads.
      const inner = Array.from({ length: segs }, (_, k) => add(5 + r * Math.cos((2 * Math.PI * k) / segs), -4 + r * Math.sin((2 * Math.PI * k) / segs), z));
      const outer = Array.from({ length: segs }, (_, k) => {
        const t = (2 * Math.PI * k) / segs;
        const s = 10 / Math.max(Math.abs(Math.cos(t)), Math.abs(Math.sin(t)));
        return add(5 + Math.max(-15, Math.min(5, s * Math.cos(t))), -4 + Math.max(-6, Math.min(14, s * Math.sin(t))), z);
      });
      for (let k = 0; k < segs; k++) {
        const a = inner[k]!, b = inner[(k + 1) % segs]!, c = outer[(k + 1) % segs]!, d = outer[k]!;
        if (z > 0) idx.push(a, b, c, a, c, d);
        else idx.push(a, c, b, a, d, c);
      }
    }
    // Hole wall, facing the hole's axis.
    for (let k = 0; k < segs; k++) {
      const a = k, b = (k + 1) % segs, a2 = 2 * segs + k, b2 = 2 * segs + ((k + 1) % segs);
      idx.push(a, a2, b2, a, b2, b);
    }
    const plate: PartMesh = { name: 'pcb', positions: Float32Array.from(pos), indices: Uint32Array.from(idx) };
    const holes = detectHoles(plate);
    expect(holes).toHaveLength(1);
    expect(holes[0]!.p_mm[0]).toBeCloseTo(5, 1);
    expect(holes[0]!.p_mm[1]).toBeCloseTo(-4, 1);
    expect(holes[0]!.d_mm).toBeGreaterThan(2.9);
    expect(holes[0]!.d_mm).toBeLessThan(3.05);
    expect(holes[0]!.through).toBe(true);
  });
});
