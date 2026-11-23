import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DesignSchema, emptyDesign, parseDesign, SCHEMA_VERSION } from '@core';
import { fullDesign, readText, ROOT } from './helpers';

describe('schema', () => {
  it('parses a minimal design and fills defaults', () => {
    const d = DesignSchema.parse({ schema: 1 });
    expect(d.meta).toEqual({ name: 'Untitled' });
    expect(d.scene).toEqual({ sources: [], links: [], joints: [] });
    for (const k of ['zones', 'components', 'connections', 'cables', 'routes', 'fixings', 'mounts', 'checks'] as const) {
      expect(d[k]).toEqual([]);
    }
  });

  it('applies joint and link defaults', () => {
    const d = DesignSchema.parse({
      schema: 1,
      scene: {
        links: [
          { id: 'a', name: 'a' },
          { id: 'b', name: 'b' },
        ],
        joints: [{ id: 'j', name: 'j', type: 'fixed', parent: 'a', child: 'b', origin: { p_mm: [0, 0, 0], q: [0, 0, 0, 1] } }],
      },
    });
    expect(d.scene.joints[0]!.axis).toEqual([0, 0, 1]);
    expect(d.scene.joints[0]!.value).toBe(0);
    expect(d.scene.links[0]!.meshes).toEqual([]);
  });

  it('emptyDesign round-trips through JSON and parseDesign', () => {
    const d = emptyDesign('My robot');
    expect(d.meta.name).toBe('My robot');
    expect(d.schema).toBe(SCHEMA_VERSION);
    const r = parseDesign(JSON.parse(JSON.stringify(d)));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.design).toEqual(d);
  });

  it('round-trips the full fixture through JSON', () => {
    const d = fullDesign();
    expect(DesignSchema.parse(JSON.parse(JSON.stringify(d)))).toEqual(d);
  });

  it('rejects unknown keys at every level', () => {
    expect(DesignSchema.safeParse({ schema: 1, extra: 1 }).success).toBe(false);
    expect(DesignSchema.safeParse({ schema: 1, meta: { name: 'x', extra: 1 } }).success).toBe(false);
    expect(DesignSchema.safeParse({ schema: 1, scene: { extra: [] } }).success).toBe(false);
    const d = JSON.parse(readText('tests/core/fixtures/valid/full.json'));
    d.scene.joints[0].limit.extra = 1;
    expect(DesignSchema.safeParse(d).success).toBe(false);
    const e = JSON.parse(readText('tests/core/fixtures/valid/full.json'));
    e.components[0].pose.extra = 1;
    expect(DesignSchema.safeParse(e).success).toBe(false);
  });

  const link = (id: unknown) => ({ schema: 1, scene: { links: [{ id, name: 'x' }] } });
  it.each(['', ' a', 'a b', '_a', '-a', '.a', 'a/b', 'é', 'a'.repeat(129)])('rejects bad id %j', (id) => {
    expect(DesignSchema.safeParse(link(id)).success).toBe(false);
  });
  it.each(['a', '0', 'a_b', 'a.b', 'a:b', 'a-b', 'A1', 'a'.repeat(128)])('accepts id %j', (id) => {
    expect(DesignSchema.safeParse(link(id)).success).toBe(true);
  });

  const pose = (p: unknown, q: unknown) => ({
    schema: 1,
    components: [{ id: 'c', name: 'c', part: 'p', link: 'l', pose: { p_mm: p, q } }],
  });
  it.each([
    ['short position', [0, 0], [0, 0, 0, 1]],
    ['long position', [0, 0, 0, 0], [0, 0, 0, 1]],
    ['short quaternion', [0, 0, 0], [0, 0, 1]],
    ['long quaternion', [0, 0, 0], [0, 0, 0, 1, 0]],
    ['string number', [0, '1', 0], [0, 0, 0, 1]],
  ])('rejects %s', (_name, p, q) => {
    expect(DesignSchema.safeParse(pose(p, q)).success).toBe(false);
  });

  it('rejects non-finite numbers', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(DesignSchema.safeParse(pose([bad, 0, 0], [0, 0, 0, 1])).success, String(bad)).toBe(false);
      expect(DesignSchema.safeParse(pose([0, 0, 0], [0, 0, 0, bad])).success, String(bad)).toBe(false);
    }
  });

  it('rejects wrong enum values', () => {
    const j = (type: string) => ({
      schema: 1,
      scene: {
        links: [
          { id: 'a', name: 'a' },
          { id: 'b', name: 'b' },
        ],
        joints: [{ id: 'j', name: 'j', type, parent: 'a', child: 'b', origin: { p_mm: [0, 0, 0], q: [0, 0, 0, 1] } }],
      },
    });
    expect(DesignSchema.safeParse(j('hinge')).success).toBe(false);
    expect(DesignSchema.safeParse(j('revolute')).success).toBe(true);
    expect(DesignSchema.safeParse({ schema: 1, scene: { sources: [{ id: 's', kind: 'fbx', uri: 'x', mm_per_unit: 1 }] } }).success).toBe(false);
    const conn = { id: 'c', from: { component: 'a', port: 'p' }, to: { component: 'b', port: 'p' }, interface: 'wifi' };
    expect(DesignSchema.safeParse({ schema: 1, connections: [conn] }).success).toBe(false);
  });

  it('rejects bad scalar values', () => {
    const src = (extra: object) => ({ schema: 1, scene: { sources: [{ id: 's', kind: 'stl', uri: 'x', mm_per_unit: 1, ...extra }] } });
    expect(DesignSchema.safeParse(src({})).success).toBe(true);
    expect(DesignSchema.safeParse(src({ mm_per_unit: 0 })).success).toBe(false);
    expect(DesignSchema.safeParse(src({ mm_per_unit: -1 })).success).toBe(false);
    expect(DesignSchema.safeParse(src({ uri: '' })).success).toBe(false);
    expect(DesignSchema.safeParse(src({ sha256: 'abc' })).success).toBe(false);
  });

  it('rejects a wrong or missing schema version', () => {
    expect(DesignSchema.safeParse({}).success).toBe(false);
    expect(DesignSchema.safeParse({ schema: 0 }).success).toBe(false);
    expect(DesignSchema.safeParse({ schema: '1' }).success).toBe(false);
  });

  it('rejects a schema 2 file with a message that mentions the version', () => {
    const r = parseDesign({ schema: 2 });
    expect(r.ok).toBe(false);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]!.path).toBe('schema');
    expect(r.issues[0]!.message).toMatch(/version/i);
    expect(r.issues[0]!.message).toContain('2');
  });
});

describe('fixtures', () => {
  const dir = (name: string) => resolve(ROOT, 'tests/core/fixtures', name);
  const files = (name: string) => readdirSync(dir(name)).filter((f) => f.endsWith('.json'));

  it('has at least one valid and five invalid fixtures', () => {
    expect(files('valid').length).toBeGreaterThanOrEqual(1);
    expect(files('invalid').length).toBeGreaterThanOrEqual(5);
  });

  it.each(files('valid'))('valid/%s is accepted without errors', (f) => {
    const r = parseDesign(JSON.parse(readText(`tests/core/fixtures/valid/${f}`)));
    expect(r.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('the full fixture has every section non-empty', () => {
    const d = fullDesign();
    expect(d.scene.sources.length).toBeGreaterThan(0);
    expect(d.scene.links.length).toBeGreaterThan(0);
    expect(d.scene.joints.length).toBeGreaterThan(0);
    for (const k of ['zones', 'components', 'connections', 'cables', 'routes', 'fixings', 'mounts', 'checks'] as const) {
      expect(d[k].length, k).toBeGreaterThan(0);
    }
    expect(d.scene.links.some((l) => l.meshes.length > 0)).toBe(true);
  });

  it.each(files('invalid'))('invalid/%s is rejected at its documented path', (f) => {
    const fx = JSON.parse(readText(`tests/core/fixtures/invalid/${f}`)) as { path: string; design: unknown };
    const r = parseDesign(fx.design);
    expect(r.ok).toBe(false);
    expect(
      r.issues.some((i) => i.severity === 'error' && i.path === fx.path),
      JSON.stringify(r.issues),
    ).toBe(true);
  });
});
