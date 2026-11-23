// Regression tests from the importer review: id uniqueness, glTF accessors, mirroring, external .bin, unit round trip.
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { DesignSchema, IdSchema, emptyDesign, validateDesign } from '@core';
import { importModel, lengthUnitFromMmPerUnit, type ImportedModel } from '../../src/app/ingest';
import { boxStl, installDomParser, signedVolume, textFile, toArrayBuffer, boxOf } from './helpers';

installDomParser();

const sceneOf = (m: ImportedModel) => ({ sources: m.sources, links: m.links, joints: m.joints });
const dupes = (ids: string[]) => ids.filter((id, i) => ids.indexOf(id) !== i);

function expectValid(m: ImportedModel) {
  const design = emptyDesign('t');
  design.scene = sceneOf(m);
  expect(DesignSchema.safeParse(JSON.parse(JSON.stringify(design))).success).toBe(true);
  expect(validateDesign(design).filter((i) => i.severity === 'error')).toEqual([]);
  for (const id of [...m.sources, ...m.links, ...m.joints, ...m.meshes].map((x) => x.id)) expect(IdSchema.safeParse(id).success, id).toBe(true);
  expect(dupes(m.links.map((l) => l.id))).toEqual([]);
  expect(dupes(m.joints.map((j) => j.id))).toEqual([]);
  expect(dupes(m.meshes.map((x) => x.id))).toEqual([]);
}

// ------------------------------------------------------------------ 1. ids

const objTri = (names: string[]) => names.map((n, i) => `o ${n}\nv ${i} 0 0\nv ${i + 1} 0 0\nv ${i} 1 0\nf -3 -2 -1\n`).join('');

describe('unique ids after sanitising', () => {
  it('OBJ objects with non-Latin names', async () => {
    const m = await importModel([textFile('part.obj', objTri(['螺丝', '螺母']))]);
    expect(m.meshes).toHaveLength(2);
    expectValid(m);
  });

  it('OBJ objects "a b" and "a_b"', async () => {
    const m = await importModel([textFile('part.obj', objTri(['a b', 'a_b']))]);
    expect(m.meshes.map((x) => x.id)).toEqual(['part.a_b', 'part.a_b_2']);
    expectValid(m);
  });

  it('URDF links "arm 1" and "arm_1" and the joint between them', async () => {
    const urdf = `<robot name="r"><link name="arm 1"/><link name="arm_1"/>
      <joint name="j" type="fixed"><parent link="arm 1"/><child link="arm_1"/></joint></robot>`;
    const m = await importModel([textFile('r.urdf', urdf)]);
    expect(m.links.map((l) => l.id)).toEqual(['r.arm_1', 'r.arm_1_2']);
    expect(m.joints[0]).toMatchObject({ parent: 'r.arm_1', child: 'r.arm_1_2' });
    expectValid(m);
  });

  it('random names from a small alphabet: unique, valid, stable', async () => {
    let seed = 12345;
    const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    const alphabet = ['a', 'b', ' ', '_', '.', '螺', '丝', '-', 'a', '_'];
    const name = (min: number) => {
      const len = min + Math.floor(rnd() * 3);
      return Array.from({ length: len }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join('');
    };
    for (let round = 0; round < 40; round++) {
      // OBJ: empty names allowed
      const objNames = Array.from({ length: 2 + Math.floor(rnd() * 5) }, () => name(0));
      const obj = [textFile('p.obj', objTri(objNames))];
      const a = await importModel(obj);
      const b = await importModel(obj);
      expectValid(a);
      expect(b.meshes.map((x) => x.id)).toEqual(a.meshes.map((x) => x.id));
      // URDF: distinct raw non-empty link names (that may collide once sanitised), arbitrary joint names
      const raw = [...new Set(Array.from({ length: 2 + Math.floor(rnd() * 5) }, () => name(1).trim() || 'z'))];
      const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
      const urdf = `<robot name="r">${raw.map((n) => `<link name="${esc(n)}"><visual><geometry><box size="1 1 1"/></geometry></visual></link>`).join('')}
        ${raw.slice(1).map((n, i) => `<joint name="${esc(name(1))}" type="fixed"><parent link="${esc(raw[i]!)}"/><child link="${esc(n)}"/></joint>`).join('')}</robot>`;
      const u1 = await importModel([textFile('r.urdf', urdf)]);
      const u2 = await importModel([textFile('r.urdf', urdf)]);
      expect(u1.links).toHaveLength(raw.length);
      expectValid(u1);
      expect(u2.links.map((l) => l.id)).toEqual(u1.links.map((l) => l.id));
      expect(u2.joints.map((j) => j.id)).toEqual(u1.joints.map((j) => j.id));
      expect(u2.meshes.map((x) => x.id)).toEqual(u1.meshes.map((x) => x.id));
    }
  });
});

// ------------------------------------------------------------------ glTF builders (hand-assembled)

interface Chunk {
  data: ArrayBuffer;
  view: Record<string, unknown>;
}
function glb(json: object, bin: Uint8Array): ArrayBuffer {
  const j = new TextEncoder().encode(JSON.stringify(json));
  const jp = new Uint8Array(Math.ceil(j.length / 4) * 4).fill(0x20);
  jp.set(j);
  const bp = new Uint8Array(Math.ceil(bin.length / 4) * 4);
  bp.set(bin);
  const out = new Uint8Array(12 + 8 + jp.length + 8 + bp.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, out.length, true);
  dv.setUint32(12, jp.length, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(jp, 20);
  dv.setUint32(20 + jp.length, bp.length, true);
  dv.setUint32(24 + jp.length, 0x004e4942, true);
  out.set(bp, 28 + jp.length);
  return out.buffer;
}
void (null as unknown as Chunk);

const vertexSet = (m: ImportedModel) => {
  const p = m.meshes[0]!.geometry.getAttribute('position');
  return Array.from({ length: p.count }, (_, i) => [p.getX(i), p.getY(i), p.getZ(i)].map((x) => Math.round(x * 1e4) / 1e4)).sort();
};

describe('glTF accessors', () => {
  it('interleaved vertex buffer (byte stride 24) gives the written positions in mm, Z-up', async () => {
    // glTF (Y-up, metres): (0,0,0) (0.1,0,0) (0,0.1,0), normal +Z. Expected app frame, mm: (0,0,0) (100,0,0) (0,0,100), normal -Y.
    const bin = new ArrayBuffer(3 * 24 + 8);
    const f = new DataView(bin);
    const verts = [[0, 0, 0], [0.1, 0, 0], [0, 0.1, 0]];
    verts.forEach((v, i) => {
      v.forEach((x, k) => f.setFloat32(i * 24 + 4 * k, x, true));
      [0, 0, 1].forEach((x, k) => f.setFloat32(i * 24 + 12 + 4 * k, x, true));
    });
    [0, 1, 2].forEach((x, i) => f.setUint16(72 + 2 * i, x, true));
    const json = {
      asset: { version: '2.0' },
      scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2 }] }],
      buffers: [{ byteLength: bin.byteLength }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 72, byteStride: 24 }, { buffer: 0, byteOffset: 72, byteLength: 6 }],
      accessors: [
        { bufferView: 0, byteOffset: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [0.1, 0.1, 0] },
        { bufferView: 0, byteOffset: 12, componentType: 5126, count: 3, type: 'VEC3' },
        { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
      ],
    };
    const m = await importModel([{ path: 'tri.glb', data: glb(json, new Uint8Array(bin)) }]);
    expect(vertexSet(m)).toEqual([[0, 0, 0], [0, 0, 100], [100, 0, 0]]);
    const n = m.meshes[0]!.geometry.getAttribute('normal');
    expect([n.getX(0), n.getY(0), n.getZ(0)].map((x) => Math.round(x * 1e6) / 1e6)).toEqual([0, -1, 0]);
    expectValid(m);
  });

  it.each([
    ['uint8 indices', 5121],
    ['uint16 indices', 5123],
    ['uint32 indices', 5125],
  ])('KHR_mesh_quantization (normalised int16 positions) with %s', async (_n, indexType) => {
    // int16 normalised (+-32767 -> +-1) with node scale 0.1: positions (0,0,0) (0.1,0,0) (0,0.1,0) m.
    const size = indexType === 5121 ? 1 : indexType === 5123 ? 2 : 4;
    const bin = new ArrayBuffer(24 + 12);
    const dv = new DataView(bin);
    [0, 0, 0, 32767, 0, 0, 0, 32767, 0].forEach((x, i) => dv.setInt16(2 * i, x, true)); // 3 x (x,y,z) = 18 bytes
    // pad vertex data to 24 with a fourth component per vertex is not allowed; use stride 8 (x,y,z,pad)
    const quant = new ArrayBuffer(24 + 12);
    const q = new DataView(quant);
    [[0, 0, 0], [32767, 0, 0], [0, 32767, 0]].forEach((v, i) => v.forEach((x, k) => q.setInt16(i * 8 + 2 * k, x, true)));
    [0, 1, 2].forEach((x, i) => (size === 1 ? q.setUint8(24 + i, x) : size === 2 ? q.setUint16(24 + 2 * i, x, true) : q.setUint32(24 + 4 * i, x, true)));
    const json = {
      asset: { version: '2.0' },
      extensionsUsed: ['KHR_mesh_quantization'], extensionsRequired: ['KHR_mesh_quantization'],
      scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, scale: [0.1, 0.1, 0.1] }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
      buffers: [{ byteLength: 36 }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 24, byteStride: 8 }, { buffer: 0, byteOffset: 24, byteLength: 3 * size }],
      accessors: [
        { bufferView: 0, componentType: 5122, normalized: true, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
        { bufferView: 1, componentType: indexType, count: 3, type: 'SCALAR' },
      ],
    };
    const m = await importModel([{ path: 'q.glb', data: glb(json, new Uint8Array(quant)) }]);
    void bin;
    expect(vertexSet(m)).toEqual([[0, 0, 0], [0, 0, 100], [100, 0, 0]]);
  });
});

// ------------------------------------------------------------------ closed box glTF (24 vertices with normals)

function boxGltfParts(nodeScale: number[]) {
  const h = 0.05; // 100 mm cube centred on the node origin
  const faces = [
    { n: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] },
    { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
    { n: [0, 1, 0], u: [0, 0, 1], v: [1, 0, 0] },
    { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
    { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
    { n: [0, 0, -1], u: [0, 1, 0], v: [1, 0, 0] },
  ];
  const pos: number[] = [];
  const nrm: number[] = [];
  const idx: number[] = [];
  faces.forEach((f, fi) => {
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      for (let k = 0; k < 3; k++) pos.push(h * (f.n[k]! + a * f.u[k]! + b * f.v[k]!));
      nrm.push(...f.n);
    }
    idx.push(4 * fi, 4 * fi + 1, 4 * fi + 2, 4 * fi, 4 * fi + 2, 4 * fi + 3);
  });
  const bin = new ArrayBuffer(24 * 12 * 2 + 36 * 2);
  const dv = new DataView(bin);
  pos.forEach((x, i) => dv.setFloat32(4 * i, x, true));
  nrm.forEach((x, i) => dv.setFloat32(288 + 4 * i, x, true));
  idx.forEach((x, i) => dv.setUint16(576 + 2 * i, x, true));
  const json = (uri?: string) => ({
    asset: { version: '2.0' },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, scale: nodeScale }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2 }] }],
    buffers: [{ byteLength: bin.byteLength, ...(uri ? { uri } : {}) }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 288 },
      { buffer: 0, byteOffset: 288, byteLength: 288 },
      { buffer: 0, byteOffset: 576, byteLength: 72 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 24, type: 'VEC3', min: [-h, -h, -h], max: [h, h, h] },
      { bufferView: 1, componentType: 5126, count: 24, type: 'VEC3' },
      { bufferView: 2, componentType: 5123, count: 36, type: 'SCALAR' },
    ],
  });
  return { json, bin: new Uint8Array(bin) };
}

function expectOutwardClosedBox(m: ImportedModel) {
  const g = m.meshes[0]!.geometry;
  expect(signedVolume(g)).toBeGreaterThan(0);
  const c = boxOf(g).getCenter(new Vector3());
  const p = g.getAttribute('position');
  const n = g.getAttribute('normal');
  for (let i = 0; i < p.count; i++) {
    const out = new Vector3(p.getX(i), p.getY(i), p.getZ(i)).sub(c);
    expect(out.dot(new Vector3(n.getX(i), n.getY(i), n.getZ(i)))).toBeGreaterThan(0);
  }
}

describe('mirroring transforms', () => {
  it('glTF node with scale (-1, 1, 1) keeps outward winding and normals', async () => {
    const { json, bin } = boxGltfParts([-1, 1, 1]);
    const m = await importModel([{ path: 'box.glb', data: glb(json(), bin) }]);
    expect(boxOf(m.meshes[0]!.geometry).getSize(new Vector3()).toArray().map(Math.round)).toEqual([100, 100, 100]);
    expectOutwardClosedBox(m);
    const { json: j2, bin: b2 } = boxGltfParts([1, 1, 1]); // control: not mirrored
    expectOutwardClosedBox(await importModel([{ path: 'box.glb', data: glb(j2(), b2) }]));
  });

  it('URDF visual with a negative mesh scale keeps outward winding', async () => {
    const urdf = `<robot name="r"><link name="l"><visual><origin xyz="0.3 0 0"/><geometry><mesh filename="b.stl" scale="-1 1 1"/></geometry></visual></link></robot>`;
    const m = await importModel([textFile('r.urdf', urdf), { path: 'b.stl', data: boxStl(0.1, 0.1, 0.1) }]);
    expect(m.warnings).toEqual([]);
    const box = boxOf(m.meshes[0]!.geometry);
    expect(box.min.x).toBeCloseTo(200, 3); // 300 - 100 (mirrored about the visual origin)
    expect(box.max.x).toBeCloseTo(300, 3);
    expectOutwardClosedBox(m);
  });
});

describe('.gltf with an external .bin', () => {
  it('imports when the .bin is supplied (matched by path suffix)', async () => {
    const { json, bin } = boxGltfParts([1, 1, 1]);
    const m = await importModel([
      textFile('models/box.gltf', JSON.stringify(json('box.bin'))),
      { path: 'models/box.bin', data: toArrayBuffer(bin) },
    ]);
    expect(m.sources[0]!.kind).toBe('gltf');
    expect(m.meshes[0]!.geometry.getIndex()!.count).toBe(36);
    expectOutwardClosedBox(m);
  });

  it('names the missing file when the .bin is absent', async () => {
    const { json } = boxGltfParts([1, 1, 1]);
    await expect(importModel([textFile('models/box.gltf', JSON.stringify(json('box.bin')))])).rejects.toThrow(/box\.bin/);
  });
});

// ------------------------------------------------------------------ units round trip

describe('reopening with the stored unit', () => {
  it('maps mm_per_unit back to a unit', () => {
    expect([1, 10, 1000, 25.4].map(lengthUnitFromMmPerUnit)).toEqual(['mm', 'cm', 'm', 'inch']);
    expect(lengthUnitFromMmPerUnit(2)).toBeUndefined();
    expect(lengthUnitFromMmPerUnit(NaN)).toBeUndefined();
  });

  it.each([
    ['stl', () => ({ path: 'p.stl', data: boxStl(1, 2, 3) }), undefined],
    ['stl', () => ({ path: 'p.stl', data: boxStl(1, 2, 3) }), 'inch'],
    ['stl', () => ({ path: 'p.stl', data: boxStl(1, 2, 3) }), 'm'],
    ['obj', () => textFile('p.obj', objTri(['a', 'b'])), 'cm'],
  ] as const)('%s imported with %s is reproduced from Source.mm_per_unit', async (_k, file, unit) => {
    const first = await importModel([file()], { unitlessAs: unit });
    const again = await importModel([file()], { unitlessAs: lengthUnitFromMmPerUnit(first.sources[0]!.mm_per_unit) });
    expect(again.sources).toEqual(first.sources);
    expect(again.links).toEqual(first.links);
    expect(again.meshes.map((m) => m.id)).toEqual(first.meshes.map((m) => m.id));
    first.meshes.forEach((m, i) => {
      expect(Array.from(again.meshes[i]!.geometry.getAttribute('position').array)).toEqual(Array.from(m.geometry.getAttribute('position').array));
      expect(Array.from(again.meshes[i]!.geometry.getIndex()!.array)).toEqual(Array.from(m.geometry.getIndex()!.array));
    });
  });
});
