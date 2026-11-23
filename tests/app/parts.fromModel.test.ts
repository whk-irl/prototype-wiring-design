import { BufferAttribute, BufferGeometry } from 'three';
import { describe, expect, it } from 'vitest';
import { PartSchema, partProblems } from '@core';
import type { ImportedModel } from '../../src/app/ingest/types';
import { decodePartGlb, meshBounds, sha256Hex, triangleCount } from '../../src/app/parts/glb';
import { flattenModel, partFromModel, slugify, UP_AXES, type UpAxis } from '../../src/app/parts/fromModel';

/** Indexed box geometry over [lo, hi], mm. */
function boxGeometry(lo: [number, number, number], hi: [number, number, number]): BufferGeometry {
  const positions = new Float32Array(24);
  for (let i = 0; i < 8; i++) {
    positions[3 * i] = i & 1 ? hi[0] : lo[0];
    positions[3 * i + 1] = i & 2 ? hi[1] : lo[1];
    positions[3 * i + 2] = i & 4 ? hi[2] : lo[2];
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(positions, 3));
  g.setIndex([0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6, 0, 1, 4, 1, 5, 4, 2, 6, 3, 3, 6, 7, 0, 4, 2, 2, 4, 6, 1, 3, 5, 3, 7, 5]);
  return g;
}

/**
 * A model of two links joined by a revolute joint at a non-zero saved value:
 * a body 20 x 4 x 6 mm at x 10..30, y 0..4, z -5..1, and a marker cube 1 mm
 * across on the child link, 100 mm along x, on the high-x side.
 */
function model(): ImportedModel {
  return {
    sources: [{ id: 's', kind: 'step', uri: 'm.step', mm_per_unit: 1 }],
    links: [
      { id: 'base', name: 'base', meshes: [{ id: 's.body', source: 's', node: 'body', tri_count: 12 }] },
      { id: 'arm', name: 'arm', meshes: [{ id: 's.mark', source: 's', node: 'marker', tri_count: 12 }] },
    ],
    joints: [{ id: 'j', name: 'j', type: 'revolute', parent: 'base', child: 'arm', origin: { p_mm: [100, 0, 0], q: [0, 0, 0, 1] }, axis: [0, 0, 1], limit: { lower: -2, upper: 2 }, value: 1.2 }],
    meshes: [
      { id: 's.body', link: 'base', geometry: boxGeometry([10, 0, -5], [30, 4, 1]), color: [0.1, 0.5, 0.1] },
      // In the arm frame: x -71..-70, so 29..30 at the zero pose.
      { id: 's.mark', link: 'arm', geometry: boxGeometry([-71, 1, -1], [-70, 2, 0]), color: [1, 0, 0] },
    ],
    warnings: [],
  };
}

/** Where model axis `up` should end up, and the expected envelope. Model box: 20 (x) x 4 (y) x 6 (z). */
const EXPECT: Record<UpAxis, { size: [number, number, number] }> = {
  '+z': { size: [20, 4, 6] },
  '-z': { size: [20, 4, 6] },
  '+y': { size: [20, 6, 4] },
  '-y': { size: [20, 6, 4] },
  '+x': { size: [6, 4, 20] },
  '-x': { size: [6, 4, 20] },
};

describe('partFromModel', () => {
  it('flattens at the zero pose, ignoring the saved joint value', () => {
    const flat = flattenModel(model());
    expect(flat.map((m) => m.name)).toEqual(['body', 'marker']);
    const b = meshBounds([flat[1]!]);
    expect(b.min_mm[0]).toBeCloseTo(29, 6);
    expect(b.max_mm[1]).toBeCloseTo(2, 6);
  });

  for (const up of UP_AXES) {
    it(`puts model ${up} along part +Z and the envelope in the part frame`, async () => {
      const { part, glb, meshes } = await partFromModel(model(), { name: 'Test Thing!', category: 'sensor', up });
      expect(PartSchema.parse(part)).toEqual(part);
      expect(partProblems(part)).toEqual([]);
      const size = part.body.size_mm;
      EXPECT[up].size.forEach((v, k) => expect(size[k]).toBeCloseTo(v, 3));
      const b = meshBounds(meshes);
      for (let k = 0; k < 2; k++) {
        expect(b.min_mm[k]).toBeCloseTo(-size[k]! / 2, 3);
        expect(b.max_mm[k]).toBeCloseTo(size[k]! / 2, 3);
      }
      expect(b.min_mm[2]).toBeCloseTo(0, 3);
      expect(b.max_mm[2]).toBeCloseTo(size[2], 3);
      // The marker sits at the model's high x end (x 29..30). Turning +x up puts it on top,
      // -x up puts it at the bottom; otherwise it stays at mid-height ends.
      const mark = meshBounds([meshes[1]!]);
      if (up === '+x') expect(mark.max_mm[2]).toBeCloseTo(size[2], 3);
      if (up === '-x') expect(mark.min_mm[2]).toBeCloseTo(0, 3);
      // The model's +z face (z = 1) goes to the top for +z and to the bottom for -z.
      const body = meshBounds([meshes[0]!]);
      expect(body.max_mm[2]).toBeCloseTo(size[2], 3);
      expect(part.id).toBe(`custom-test-thing-${part.model!.sha256!.slice(0, 8)}`);
      expect(part.model).toEqual({ uri: `custom:${part.model!.sha256}`, sha256: await sha256Hex(glb), triangles: triangleCount(meshes) });
      expect(part.custom).toBe(true);
      expect(part.confidence).toBe('measured');
      expect(part.ports).toEqual([]);
      expect(decodePartGlb(glb).meshes).toHaveLength(2);
    });
  }

  it('turns +z up so the marker on the +z side ends on top, -z so it ends at the bottom', async () => {
    const m = model();
    // Move the marker to sit on the body's top face (model z 1..2).
    m.meshes[1]!.geometry = boxGeometry([-80, 1, 1], [-79, 2, 2]);
    const top = await partFromModel(m, { name: 't', category: 'other', up: '+z' });
    expect(meshBounds([top.meshes[1]!]).max_mm[2]).toBeCloseTo(top.part.body.size_mm[2], 3);
    const bottom = await partFromModel(m, { name: 't', category: 'other', up: '-z' });
    expect(meshBounds([bottom.meshes[1]!]).min_mm[2]).toBeCloseTo(0, 3);
  });

  it('simplifies above the triangle budget', async () => {
    const { part } = await partFromModel(model(), { name: 'x', category: 'other', up: '+z', maxTriangles: 12 });
    expect(part.model!.triangles).toBeLessThanOrEqual(12);
    expect(part.model!.triangles).toBeGreaterThan(0);
  });

  it('makes slugs from names', () => {
    expect(slugify('  Raspberry Pi 5 (8 GB) ')).toBe('raspberry-pi-5-8-gb');
    expect(slugify('***')).toBe('part');
  });
});
