import { describe, expect, it } from 'vitest';
import { PartSchema, type Part } from '@core';
import { decodePartGlb, encodePartGlb, meshBounds, sha256Hex, type PartMesh } from '../../src/app/parts/glb';

/** A small closed box in the part frame, mm. */
function box(name: string, lo: [number, number, number], hi: [number, number, number], color?: [number, number, number]): PartMesh {
  const positions = new Float32Array(24);
  for (let i = 0; i < 8; i++) {
    positions[3 * i] = i & 1 ? hi[0] : lo[0];
    positions[3 * i + 1] = i & 2 ? hi[1] : lo[1];
    positions[3 * i + 2] = i & 4 ? hi[2] : lo[2];
  }
  const indices = Uint32Array.from([0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6, 0, 1, 4, 1, 5, 4, 2, 6, 3, 3, 6, 7, 0, 4, 2, 2, 4, 6, 1, 3, 5, 3, 7, 5]);
  return color ? { name, positions, indices, color } : { name, positions, indices };
}

/** The JSON chunk of a GLB. */
function jsonOf(glb: ArrayBuffer): Record<string, unknown> {
  const view = new DataView(glb);
  const length = view.getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, length))) as Record<string, unknown>;
}

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

const PART: Part = PartSchema.parse({
  id: 'custom-test-01234567',
  name: 'Test',
  category: 'sensor',
  body: { size_mm: [20, 10, 5] },
  confidence: 'measured',
  custom: true,
});

describe('part GLB', () => {
  it('round-trips positions, indices, colours and the embedded part', () => {
    const meshes = [box('board', [-10, -5, 0], [10, 5, 1.6], [0, 0.3, 0.1]), box('usb', [8, -2, 1.6], [10.5, 2, 4.8], [0.8, 0.8, 0.8]), box('header', [-9, -1, 1.6], [-1, 1, 10], [0, 0.3, 0.1])];
    const glb = encodePartGlb(meshes, PART);
    const back = decodePartGlb(glb);
    expect(back.meshes.map((m) => m.name)).toEqual(['board', 'usb', 'header']);
    back.meshes.forEach((m, i) => {
      const src = meshes[i]!;
      expect(m.positions.length).toBe(src.positions.length);
      for (let k = 0; k < src.positions.length; k++) expect(Math.abs(m.positions[k]! - src.positions[k]!)).toBeLessThan(1e-3);
      expect(Array.from(m.indices)).toEqual(Array.from(src.indices));
      for (let k = 0; k < 3; k++) expect(m.color![k]).toBeCloseTo(src.color![k]!, 6);
    });
    expect(PartSchema.parse(back.part)).toEqual(PART);
    // Two distinct colours, so two materials; small meshes use 16-bit indices; min/max are set.
    const json = jsonOf(glb) as { materials: unknown[]; accessors: { componentType: number; min?: number[]; max?: number[]; type: string }[] };
    expect(json.materials).toHaveLength(2);
    expect(json.accessors.filter((a) => a.type === 'SCALAR').every((a) => a.componentType === 5123)).toBe(true);
    expect(json.accessors.filter((a) => a.type === 'VEC3').every((a) => a.min && a.max)).toBe(true);
  });

  it('uses 32-bit indices when a mesh has 65535 vertices or more', () => {
    const n = 70000;
    const positions = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) positions[3 * i] = i * 0.001;
    positions[3 * (n - 1) + 1] = 1;
    const mesh: PartMesh = { name: 'big', positions, indices: Uint32Array.from([0, 1, n - 1]) };
    const glb = encodePartGlb([mesh]);
    const json = jsonOf(glb) as { accessors: { componentType: number; type: string }[] };
    expect(json.accessors.find((a) => a.type === 'SCALAR')!.componentType).toBe(5125);
    expect(Array.from(decodePartGlb(glb).meshes[0]!.indices)).toEqual([0, 1, n - 1]);
  });

  it('writes part +Z as glTF +Y and part +Y as glTF -Z, in metres', () => {
    const mesh: PartMesh = { name: 'p', positions: Float32Array.from([0, 0, 0, 0, 0, 50, 0, 20, 0]), indices: Uint32Array.from([0, 1, 2]) };
    const glb = encodePartGlb([mesh]);
    const json = jsonOf(glb) as { accessors: { min: number[]; max: number[] }[] };
    const pos = json.accessors[0]!;
    // Part (0,0,50) mm -> glTF (0, 0.05, 0); part (0,20,0) mm -> glTF (0, 0, -0.02).
    expect(pos.max[1]).toBeCloseTo(0.05, 7);
    expect(pos.min[2]).toBeCloseTo(-0.02, 7);
    expect(pos.max[2]).toBeCloseTo(0, 7);
    const back = decodePartGlb(glb).meshes[0]!;
    expect(Array.from(back.positions.subarray(3, 6))).toEqual([0, 0, 50]);
    expect(back.positions[7]).toBeCloseTo(20, 4);
    const b = meshBounds([back]);
    expect(b.max_mm[2]).toBeCloseTo(50, 4);
  });

  it('applies node transforms, reads several primitives and any index type, and flips mirrored triangles', () => {
    // One triangle, glTF metres: (0,0,0), (1,0,0), (0,1,0). Float32 positions then uint8 indices.
    const bin = new Uint8Array(36 + 4);
    new Float32Array(bin.buffer, 0, 9).set([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    bin.set([0, 1, 2], 36);
    const json = {
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0, 2] }],
      nodes: [
        // Parent: moved 1 m along glTF +X; child: quarter turn about glTF +Y and scaled by 0.01.
        { name: 'parent', translation: [1, 0, 0], children: [1] },
        { name: 'child', rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2], scale: [0.01, 0.01, 0.01], mesh: 0 },
        // A mirror (column-major matrix with x negated): triangle winding must be swapped back.
        { name: 'mirror', matrix: [-0.01, 0, 0, 0, 0, 0.01, 0, 0, 0, 0, 0.01, 0, 0, 0, 0, 1], mesh: 1 },
      ],
      meshes: [
        {
          name: 'two',
          primitives: [
            { attributes: { POSITION: 0 }, indices: 1, material: 0 },
            { attributes: { POSITION: 0 } }, // not indexed
          ],
        },
        { primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] },
      ],
      materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] } }],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
        { bufferView: 1, componentType: 5121, count: 3, type: 'SCALAR' },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 36 },
        { buffer: 0, byteOffset: 36, byteLength: 3 },
      ],
      buffers: [{ byteLength: 40 }],
    };
    const { meshes } = decodePartGlb(glbFrom(json, bin));
    expect(meshes.map((m) => m.name)).toEqual(['child#1', 'child#2', 'mirror']);
    expect(meshes[0]!.color).toEqual([1, 0, 0]);
    expect(meshes[1]!.color).toBeUndefined();
    expect(Array.from(meshes[1]!.indices)).toEqual([0, 1, 2]);
    // glTF vertex (1,0,0) in the child: scaled to 0.01, turned about +Y to (0,0,-0.01), moved to (1,0,-0.01).
    // In the part frame: (x, -z, y) * 1000 = (1000, 10, 0).
    const p = meshes[0]!.positions;
    expect(p[3]).toBeCloseTo(1000, 3);
    expect(p[4]).toBeCloseTo(10, 3);
    expect(p[5]).toBeCloseTo(0, 3);
    // glTF (0,1,0) -> (0, 0.01, 0) -> part (0, 0, 10).
    expect(p[8]).toBeCloseTo(10, 3);
    // Mirrored node: x negated, winding swapped.
    expect(meshes[2]!.positions[3]).toBeCloseTo(-10, 3);
    expect(Array.from(meshes[2]!.indices)).toEqual([0, 2, 1]);
  });

  it('refuses Draco- and meshopt-compressed files with a clear message', () => {
    const base = { asset: { version: '2.0' }, scenes: [{ nodes: [] }] };
    expect(() => decodePartGlb(glbFrom({ ...base, extensionsUsed: ['KHR_draco_mesh_compression'], extensionsRequired: ['KHR_draco_mesh_compression'] }, new Uint8Array(4)))).toThrow(
      /Draco-compressed.*without compression/,
    );
    expect(() => decodePartGlb(glbFrom({ ...base, extensionsUsed: ['EXT_meshopt_compression'] }, new Uint8Array(4)))).toThrow(/meshopt-compressed/);
    expect(() => decodePartGlb(new TextEncoder().encode('solid stl file, not a glb').buffer as ArrayBuffer)).toThrow(/Not a GLB/);
  });

  it('hashes with SHA-256', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc').buffer as ArrayBuffer)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
