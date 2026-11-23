// Contract checks on every fixture (types.ts header comment).
import { describe, expect, it } from 'vitest';
import { DesignSchema, IdSchema, emptyDesign, validateDesign } from '@core';
import { importModel, type ImportedModel } from '../../src/app/ingest';
import { FIXTURE_SPECS, importFixture } from '../../tools/fixtures/make-designs';
import { boxStl, installDomParser, signedVolume, triCount } from './helpers';

installDomParser();

function check(model: ImportedModel, closedMeshes: boolean) {
  expect(model.meshes.length).toBeGreaterThan(0);
  const refs = new Map(model.links.flatMap((l) => l.meshes.map((m) => [m.id, { link: l.id, ref: m }] as const)));
  expect(refs.size).toBe(model.meshes.length);

  for (const mesh of model.meshes) {
    const g = mesh.geometry;
    const index = g.getIndex();
    expect(index, `${mesh.id} indexed`).not.toBeNull();
    const pos = g.getAttribute('position');
    const nrm = g.getAttribute('normal');
    expect(pos?.itemSize).toBe(3);
    expect(nrm?.itemSize).toBe(3);
    expect(nrm!.count).toBe(pos!.count);
    expect(Object.keys(g.attributes).sort()).toEqual(['normal', 'position']);
    for (const a of pos!.array) expect(Number.isFinite(a)).toBe(true);
    for (let i = 0; i < nrm!.count; i++) {
      const len = Math.hypot(nrm!.getX(i), nrm!.getY(i), nrm!.getZ(i));
      expect(Math.abs(len - 1), `${mesh.id} normal ${i}`).toBeLessThan(1e-4);
    }
    expect(index!.count % 3).toBe(0);
    for (const i of index!.array) {
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(pos!.count);
    }
    // ids and references
    expect(IdSchema.safeParse(mesh.id).success, mesh.id).toBe(true);
    const ref = refs.get(mesh.id)!;
    expect(ref.link).toBe(mesh.link);
    expect(ref.ref.tri_count).toBe(triCount(g));
    expect(model.sources.map((s) => s.id)).toContain(ref.ref.source);
    for (const c of mesh.color) {
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(1);
    }
    if (closedMeshes) expect(signedVolume(g), `${mesh.id} faces outward`).toBeGreaterThan(0);
  }
  for (const id of [...model.sources, ...model.links, ...model.joints].map((x) => x.id)) {
    expect(IdSchema.safeParse(id).success, id).toBe(true);
  }
  for (const s of model.sources) expect(s.sha256).toMatch(/^[0-9a-f]{64}$/);

  // The scene validates and parses.
  const design = emptyDesign('t');
  design.scene = { sources: model.sources, links: model.links, joints: model.joints };
  expect(DesignSchema.safeParse(JSON.parse(JSON.stringify(design))).success).toBe(true);
  const errors = validateDesign(design).filter((i) => i.severity === 'error');
  expect(errors).toEqual([]);
}

describe.each(FIXTURE_SPECS)('contract: $id', (spec) => {
  it('satisfies the geometry, id and scene rules', async () => {
    check(await importFixture(spec), true);
  });

  it('imports identically twice (ids, indices, positions, normals)', async () => {
    const a = await importFixture(spec);
    const b = await importFixture(spec);
    expect(b.meshes.map((m) => m.id)).toEqual(a.meshes.map((m) => m.id));
    expect(JSON.parse(JSON.stringify(b.joints))).toEqual(JSON.parse(JSON.stringify(a.joints)));
    expect(b.links).toEqual(a.links);
    expect(b.sources).toEqual(a.sources);
    a.meshes.forEach((m, i) => {
      const o = b.meshes[i]!.geometry;
      expect(Array.from(o.getIndex()!.array)).toEqual(Array.from(m.geometry.getIndex()!.array));
      expect(Array.from(o.getAttribute('position').array)).toEqual(Array.from(m.geometry.getAttribute('position').array));
      expect(Array.from(o.getAttribute('normal').array)).toEqual(Array.from(m.geometry.getAttribute('normal').array));
    });
  });
});

describe('contract: STL', () => {
  it('welds vertices, keeps box edges hard, and yields outward triangles', async () => {
    const model = await importModel([{ path: 'part.stl', data: boxStl(10, 20, 30) }]);
    check(model, true);
    const g = model.meshes[0]!.geometry;
    expect(triCount(g)).toBe(12);
    // 8 corners, each used by 3 faces with different normals: 24 vertices, not 36 and not 8.
    expect(g.getAttribute('position').count).toBe(24);
  });

  it('smooths a curved surface instead of splitting every vertex', async () => {
    const { CylinderGeometry } = await import('three');
    const cyl = new CylinderGeometry(5, 5, 20, 24).toNonIndexed();
    const pos = cyl.getAttribute('position').array;
    const dv = new DataView(new ArrayBuffer(84 + 50 * (pos.length / 9)));
    dv.setUint32(80, pos.length / 9, true);
    for (let t = 0; t < pos.length / 9; t++) for (let k = 0; k < 9; k++) dv.setFloat32(84 + 50 * t + 12 + 4 * k, pos[9 * t + k]!, true);
    const model = await importModel([{ path: 'cyl.stl', data: dv.buffer }]);
    const g = model.meshes[0]!.geometry;
    // 24 segments: 2 side rings (48) + 2 cap rings (48) + 2 centres = 98 once welded and split at the cap edges.
    expect(g.getAttribute('position').count).toBeLessThan(120);
    check(model, true);
  });
});
