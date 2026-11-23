// Regression tests for gaps an independent review found in validateDesign.
import { describe, expect, it } from 'vitest';
import { validateDesign, type Design, type Zone } from '@core';
import { IDQ, mkJoint, mkLink, sceneDesign } from './helpers';

function designWithZones(): Design {
  const a = mkLink('a');
  const b = mkLink('b');
  const design = sceneDesign([a, b], [mkJoint('j', 'a', 'b')]);
  design.scene.sources.push({ id: 's', kind: 'stl', uri: 's.stl', mm_per_unit: 1 });
  a.meshes.push({ id: 'ma', source: 's', node: 'ma', tri_count: 10 });
  b.meshes.push({ id: 'mb', source: 's', node: 'mb', tri_count: 10 });
  const zone = (id: string, link: string, mesh: string, kind: Zone['kind']): Zone => ({ id, name: id, kind, link, mesh, triangles: [0, 2] });
  design.zones.push(zone('za', 'a', 'ma', 'mount_allowed'), zone('zb', 'b', 'mb', 'mount_allowed'), zone('keep', 'a', 'ma', 'keep_out'));
  return design;
}

const component = (zone: string | undefined, link = 'a') => ({
  id: 'c1',
  name: 'c1',
  part: 'generic-breakout-25x18',
  link,
  pose: { p_mm: [0, 0, 0] as [number, number, number], q: IDQ },
  ...(zone === undefined ? {} : { zone }),
});

describe('component zone consistency', () => {
  it('accepts a component in a mount-allowed zone on its own link', () => {
    const d = designWithZones();
    d.components.push(component('za'));
    expect(validateDesign(d)).toEqual([]);
  });

  it('reports an error when the zone is on another link', () => {
    const d = designWithZones();
    d.components.push(component('zb'));
    const issues = validateDesign(d);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: 'error', path: 'components[0].zone' });
  });

  it('warns, without failing, when the zone is a keep-out zone', () => {
    const d = designWithZones();
    d.components.push(component('keep'));
    const issues = validateDesign(d);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: 'warning', path: 'components[0].zone' });
  });
});

describe('non-finite numbers in an in-memory design', () => {
  // JSON cannot carry NaN, so the schema never sees these; an edit in the app can.
  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('rejects %s in a component quaternion', (_label, bad) => {
    const d = designWithZones();
    d.components.push({ ...component(undefined), pose: { p_mm: [0, 0, 0], q: [0, 0, bad, 1] } });
    expect(validateDesign(d).some((i) => i.severity === 'error' && i.path === 'components[0].pose.q')).toBe(true);
  });

  it('rejects NaN in a component position', () => {
    const d = designWithZones();
    d.components.push({ ...component(undefined), pose: { p_mm: [0, Number.NaN, 0], q: IDQ } });
    expect(validateDesign(d).some((i) => i.severity === 'error' && i.path === 'components[0].pose.p_mm')).toBe(true);
  });

  it('rejects NaN in a joint origin, axis and value', () => {
    const d = designWithZones();
    const joint = d.scene.joints[0]!;
    joint.origin = { p_mm: [Number.NaN, 0, 0], q: [0, 0, Number.NaN, 1] };
    joint.axis = [0, Number.NaN, 1];
    joint.value = Number.NaN;
    const paths = validateDesign(d)
      .filter((i) => i.severity === 'error')
      .map((i) => i.path);
    expect(paths).toEqual(expect.arrayContaining(['scene.joints[0].origin.q', 'scene.joints[0].origin.p_mm', 'scene.joints[0].axis', 'scene.joints[0].value']));
  });
});

describe('defaults', () => {
  it('gives every new design its own arrays', async () => {
    const { emptyDesign, DesignSchema } = await import('@core');
    const a = emptyDesign();
    const b = emptyDesign();
    const c = DesignSchema.parse({ schema: 1 });
    for (const other of [b, c]) {
      expect(a.scene).not.toBe(other.scene);
      expect(a.scene.sources).not.toBe(other.scene.sources);
      expect(a.scene.links).not.toBe(other.scene.links);
      expect(a.scene.joints).not.toBe(other.scene.joints);
      expect(a.meta).not.toBe(other.meta);
      for (const key of ['zones', 'components', 'connections', 'cables', 'routes', 'fixings', 'mounts', 'checks'] as const) {
        expect(a[key]).not.toBe(other[key]);
      }
    }
    a.scene.links.push({ id: 'x', name: 'x', meshes: [] });
    expect(emptyDesign().scene.links).toEqual([]);
  });
});
