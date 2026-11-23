/**
 * Regression tests for problems found in review and first real use of the
 * part tooling: hostile GLBs, thin plates lost in simplification, GLB size,
 * pad-row detection, KiCad input limits.
 */
import { describe, expect, it } from 'vitest';
import { decodePartGlb, encodePartGlb, joinMeshes, MAX_TOTAL_VERTICES, mergeByColour, meshBounds, triangleCount, type PartMesh } from '../../src/app/parts/glb';
import { parseKicadPcb, parseSExpr } from '../../src/app/parts/kicadPcb';
import { simplifyMeshes } from '../../src/app/parts/simplify';
import { detectHoles, groupPadRows, type DetectedHole } from '../../tools/build-part';

// ---------------------------------------------------------------- helpers

/** A GLB from a JSON object and binary bytes, assembled by hand. */
function glbFrom(json: unknown, bin: Uint8Array): ArrayBuffer {
  const text = new TextEncoder().encode(JSON.stringify(json));
  const jl = (text.length + 3) & ~3;
  const bl = (bin.length + 3) & ~3;
  const out = new ArrayBuffer(12 + 8 + jl + 8 + bl);
  const v = new DataView(out);
  const b = new Uint8Array(out);
  v.setUint32(0, 0x46546c67, true);
  v.setUint32(4, 2, true);
  v.setUint32(8, out.byteLength, true);
  v.setUint32(12, jl, true);
  v.setUint32(16, 0x4e4f534a, true);
  b.set(text, 20);
  b.fill(0x20, 20 + text.length, 20 + jl);
  v.setUint32(20 + jl, bl, true);
  v.setUint32(24 + jl, 0x004e4942, true);
  b.set(bin, 28 + jl);
  return out;
}

/** One triangle's worth of glTF: 36 bytes of positions, 3 bytes of uint8 indices. */
function oneTriangle(): { bin: Uint8Array; accessors: object[]; bufferViews: object[] } {
  const bin = new Uint8Array(40);
  new Float32Array(bin.buffer, 0, 9).set([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  bin.set([0, 1, 2], 36);
  return {
    bin,
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5121, count: 3, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 3 },
    ],
  };
}

/** A box with every face split into an n x n grid, triangles not sharing vertices (as CAD exports are). */
function gridBox(name: string, lo: [number, number, number], hi: [number, number, number], n: number, color?: [number, number, number]): PartMesh {
  const pos: number[] = [];
  const faces: Array<(u: number, v: number) => [number, number, number]> = [
    (u, v) => [lo[0] + (hi[0] - lo[0]) * u, lo[1] + (hi[1] - lo[1]) * v, hi[2]],
    (u, v) => [lo[0] + (hi[0] - lo[0]) * v, lo[1] + (hi[1] - lo[1]) * u, lo[2]],
    (u, v) => [lo[0] + (hi[0] - lo[0]) * v, hi[1], lo[2] + (hi[2] - lo[2]) * u],
    (u, v) => [lo[0] + (hi[0] - lo[0]) * u, lo[1], lo[2] + (hi[2] - lo[2]) * v],
    (u, v) => [hi[0], lo[1] + (hi[1] - lo[1]) * u, lo[2] + (hi[2] - lo[2]) * v],
    (u, v) => [lo[0], lo[1] + (hi[1] - lo[1]) * v, lo[2] + (hi[2] - lo[2]) * u],
  ];
  for (const f of faces) {
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const a = f(i / n, j / n), b = f((i + 1) / n, j / n), c = f((i + 1) / n, (j + 1) / n), d = f(i / n, (j + 1) / n);
        pos.push(...a, ...b, ...c, ...a, ...c, ...d);
      }
    }
  }
  const mesh: PartMesh = { name, positions: Float32Array.from(pos), indices: Uint32Array.from({ length: pos.length / 3 }, (_, k) => k) };
  if (color) mesh.color = color;
  return mesh;
}

function expectEnvelope(actual: readonly PartMesh[], expected: readonly PartMesh[], tol_mm: number): void {
  const a = meshBounds(actual);
  const e = meshBounds(expected);
  for (let k = 0; k < 3; k++) {
    expect(Math.abs(a.min_mm[k]! - e.min_mm[k]!)).toBeLessThanOrEqual(tol_mm);
    expect(Math.abs(a.max_mm[k]! - e.max_mm[k]!)).toBeLessThanOrEqual(tol_mm);
  }
}

// ---------------------------------------------------------------- 1. hostile GLBs

describe('decodePartGlb on hostile or broken files', () => {
  const scene = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }], buffers: [{ byteLength: 40 }] };

  it('refuses a huge accessor count with a clear Error before allocating', () => {
    const t = oneTriangle();
    const accessors = [{ ...t.accessors[0], count: 2e9 }, t.accessors[1]];
    expect(() => decodePartGlb(glbFrom({ ...scene, accessors, bufferViews: t.bufferViews }, t.bin))).toThrow(/more than this reader accepts/);
    // Without a buffer view (all zeros by the spec) the count is capped too.
    const noView = [{ componentType: 5126, count: 2e9, type: 'VEC3' }, t.accessors[1]];
    expect(() => decodePartGlb(glbFrom({ ...scene, accessors: noView, bufferViews: t.bufferViews }, t.bin))).toThrow(/more than this reader accepts/);
  });

  it('refuses accessors and buffer views that run past the data', () => {
    const t = oneTriangle();
    const longCount = [{ ...t.accessors[0], count: 4 }, t.accessors[1]];
    expect(() => decodePartGlb(glbFrom({ ...scene, accessors: longCount, bufferViews: t.bufferViews }, t.bin))).toThrow(/past the end of its buffer view/);
    const longView = [{ buffer: 0, byteOffset: 0, byteLength: 4000 }, t.bufferViews[1]];
    expect(() => decodePartGlb(glbFrom({ ...scene, accessors: t.accessors, bufferViews: longView }, t.bin))).toThrow(/past the end of its buffer/);
    const badStride = [{ buffer: 0, byteOffset: 0, byteLength: 36, byteStride: 4 }, t.bufferViews[1]];
    expect(() => decodePartGlb(glbFrom({ ...scene, accessors: t.accessors, bufferViews: badStride }, t.bin))).toThrow(/stride/);
    const negative = [{ buffer: 0, byteOffset: -8, byteLength: 36 }, t.bufferViews[1]];
    expect(() => decodePartGlb(glbFrom({ ...scene, accessors: t.accessors, bufferViews: negative }, t.bin))).toThrow(/negative or fractional/);
  });

  it('caps the total vertex count over reused meshes', () => {
    // One mesh, instanced by many nodes, each 3 vertices... a reused 4 000 000-vertex accessor three times.
    const count = 4_000_000;
    expect(3 * count).toBeGreaterThan(MAX_TOTAL_VERTICES);
    const json = {
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0, 1, 2] }],
      nodes: [{ mesh: 0 }, { mesh: 0 }, { mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 0 }, { attributes: { POSITION: 0 } }] }],
      // No buffer view: zeros by the spec, so the file stays tiny while asking for a lot.
      accessors: [{ componentType: 5126, count, type: 'VEC3' }],
    };
    expect(() => decodePartGlb(glbFrom(json, new Uint8Array(4)))).toThrow(/more than 10000000 vertices/);
  });

  it('walks a 5000-deep node chain without overflowing the stack, transforms accumulated', () => {
    const t = oneTriangle();
    const depth = 5000;
    const nodes = Array.from({ length: depth }, (_, i) => (i < depth - 1 ? { translation: [0.001, 0, 0], children: [i + 1] } : { translation: [0.001, 0, 0], mesh: 0 }));
    const json = { ...scene, nodes, accessors: t.accessors, bufferViews: t.bufferViews };
    const { meshes } = decodePartGlb(glbFrom(json, t.bin));
    expect(meshes).toHaveLength(1);
    // 5000 steps of 1 mm along x.
    expect(meshes[0]!.positions[0]).toBeCloseTo(5000, 1);
  });
});

// ---------------------------------------------------------------- 2. thin plates and the envelope

describe('simplification keeps the overall envelope', () => {
  // A connector-like body (dense box) with a 0.3 mm plate on top, as on a barrel jack.
  const body = gridBox('jack', [-5, -4.5, 0], [5, 4.5, 11], 40);
  const plate = gridBox('plate', [-4, -4, 14.2], [4, 4, 14.5], 6);
  const board = gridBox('board', [-35, -26, 0], [35, 26, 1.6], 60);

  for (const budget of [8000, 2000, 200, 40]) {
    it(`separate bodies, budget ${budget}`, async () => {
      const src = [board, body, plate];
      const out = await simplifyMeshes(src, budget);
      expect(triangleCount(out)).toBeLessThanOrEqual(budget);
      expectEnvelope(out, src, 0.05);
      expectEnvelope([out[2]!], [plate], 0.05);
    });

    it(`plate merged into its body, budget ${budget}`, async () => {
      const merged = joinMeshes(body, [body, plate]);
      const src = [board, merged];
      const out = await simplifyMeshes(src, budget);
      expect(triangleCount(out)).toBeLessThanOrEqual(budget);
      expectEnvelope(out, src, 0.05);
      expectEnvelope([out[1]!], [merged], 0.05);
    });
  }

  it('a body of many small pieces plus a plate, more pieces than the budget can box', async () => {
    const pins = Array.from({ length: 150 }, (_, i) => gridBox('pin', [-30 + (i % 50) * 1.2, -20 + Math.floor(i / 50) * 2, 1.6], [-29.4 + (i % 50) * 1.2, -19.4 + Math.floor(i / 50) * 2, 9], 3));
    const header = joinMeshes(pins[0]!, [...pins, gridBox('top', [-30, -21, 15], [30, -20, 15.2], 4)]);
    const src = [board, header];
    const out = await simplifyMeshes(src, 600);
    expect(triangleCount(out)).toBeLessThanOrEqual(600);
    expectEnvelope(out, src, 0.05);
    expectEnvelope([out[1]!], [header], 0.05);
  });
});

// ---------------------------------------------------------------- 3. file size

describe('GLB size', () => {
  it('merges bodies of one colour, cutting the per-body JSON', () => {
    const red: [number, number, number] = [1, 0, 0];
    const grey: [number, number, number] = [0.5, 0.5, 0.5];
    const bodies = Array.from({ length: 300 }, (_, i) => gridBox(`b${i}`, [i, 0, 0], [i + 0.5, 0.5, 0.5], 1, i % 3 === 0 ? red : grey));
    const separate = encodePartGlb(bodies);
    const merged = mergeByColour(bodies);
    expect(merged.map((m) => m.name)).toEqual(['colour 1', 'colour 2']);
    const glb = encodePartGlb(merged);
    const tris = triangleCount(bodies);
    // About 250 bytes of JSON per body are gone; the geometry is the same.
    expect(glb.byteLength / tris).toBeLessThan(0.6 * (separate.byteLength / tris));
    const back = decodePartGlb(glb).meshes;
    expect(triangleCount(back)).toBe(tris);
    expectEnvelope(back, bodies, 1e-3);
  });

  it('splits a merged colour group before 16-bit indices overflow', () => {
    const big = Array.from({ length: 30 }, (_, i) => gridBox(`b${i}`, [i, 0, 0], [i + 0.5, 0.5, 0.5], 12)); // 5184 vertices each
    const merged = mergeByColour(big);
    expect(merged.length).toBeGreaterThan(1);
    for (const m of merged) expect(m.positions.length / 3).toBeLessThan(0xffff);
    expect(triangleCount(merged)).toBe(triangleCount(big));
  });

  it('simplified output stays near 30 bytes per triangle once merged', async () => {
    const bodies = Array.from({ length: 200 }, (_, i) => gridBox(`b${i}`, [i % 20, Math.floor(i / 20), 0], [(i % 20) + 0.8, Math.floor(i / 20) + 0.8, 1 + (i % 7)], 6, [0.2, 0.2, 0.2]));
    const out = await simplifyMeshes(bodies, 8000);
    const glb = encodePartGlb(mergeByColour(out));
    expect(glb.byteLength / triangleCount(out)).toBeLessThan(40);
  });
});

// ---------------------------------------------------------------- 4. pads

describe('pad holes', () => {
  const hole = (x: number, y: number, d = 1): DetectedHole => ({ body: 'pcb', p_mm: [x, y], d_mm: d, z_mm: [0, 1.6], through: true });

  it('groups a 2 x 5 header, a 1 x 4 row at 2.0 mm and leaves a stray hole single', () => {
    const holes: DetectedHole[] = [];
    for (let k = 0; k < 5; k++) holes.push(hole(-10 + 2.54 * k, 5), hole(-10 + 2.54 * k, 7.54));
    for (let k = 0; k < 4; k++) holes.push(hole(20, -10 + 2 * k, 0.8));
    holes.push(hole(0, -20));
    const { rows, single } = groupPadRows(holes);
    expect(rows).toHaveLength(3);
    const two = rows.filter((r) => r.pitch_mm === 2.54);
    expect(two.map((r) => r.count)).toEqual([5, 5]);
    expect(two[0]).toMatchObject({ start_mm: [-10, 5], end_mm: [0.16, 5], angle_deg: 0 });
    const vertical = rows.find((r) => r.pitch_mm === 2)!;
    expect(vertical).toMatchObject({ count: 4, start_mm: [20, -10], end_mm: [20, -4], angle_deg: 90, d_mm: 0.8 });
    expect(single).toEqual([[0, -20]]);
  });

  it('finds 1.0 mm plated holes with the pad diameter range', () => {
    // A 10 x 10 x 1.6 mm plate with one 1 mm hole at (2, 3), 8 segments.
    const segs = 8;
    const r = 0.5;
    const pos: number[] = [];
    const idx: number[] = [];
    const add = (x: number, y: number, z: number) => (pos.push(x, y, z), pos.length / 3 - 1);
    for (const z of [0, 1.6]) {
      const inner = Array.from({ length: segs }, (_, k) => add(2 + r * Math.cos((2 * Math.PI * k) / segs), 3 + r * Math.sin((2 * Math.PI * k) / segs), z));
      const outer = Array.from({ length: segs }, (_, k) => add(2 + 4 * Math.cos((2 * Math.PI * k) / segs), 3 + 4 * Math.sin((2 * Math.PI * k) / segs), z));
      for (let k = 0; k < segs; k++) {
        const a = inner[k]!, b = inner[(k + 1) % segs]!, c = outer[(k + 1) % segs]!, d = outer[k]!;
        if (z > 0) idx.push(a, b, c, a, c, d);
        else idx.push(a, c, b, a, d, c);
      }
    }
    for (let k = 0; k < segs; k++) {
      const a = k, b = (k + 1) % segs, a2 = 2 * segs + k, b2 = 2 * segs + ((k + 1) % segs);
      idx.push(a, a2, b2, a, b2, b);
    }
    const plate: PartMesh = { name: 'pcb', positions: Float32Array.from(pos), indices: Uint32Array.from(idx) };
    expect(detectHoles(plate)).toHaveLength(0); // default range 1.5 to 5 mm
    const pads = detectHoles(plate, 0.7, 1.3);
    expect(pads).toHaveLength(1);
    expect(pads[0]!.p_mm).toEqual([2, 3]);
    expect(pads[0]!.d_mm).toBeCloseTo(1, 2);
  });
});

// ---------------------------------------------------------------- KiCad input limits

describe('KiCad input limits', () => {
  it('refuses absurd nesting and over-long text with clear Errors', () => {
    expect(() => parseSExpr('('.repeat(100_000))).toThrow(/nests more than/);
    expect(() => parseKicadPcb(' '.repeat(64 * 1024 * 1024 + 1))).toThrow(/more than this reader accepts/);
  });
});
