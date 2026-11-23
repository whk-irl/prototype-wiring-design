import { describe, expect, it } from 'vitest';
import { parseDesign, validateDesign, type Design, type Issue } from '@core';
import { fullDesign, loadLibrary, mkJoint, mkLink, sceneDesign } from './helpers';

const library = loadLibrary();

function errors(d: Design, withLibrary = false): Issue[] {
  return validateDesign(d, withLibrary ? library : undefined).filter((i) => i.severity === 'error');
}

/** Apply `mutate` to a fresh valid design and expect an error at `path` matching `message`. */
function expectError(mutate: (d: Design) => void, path: string, message: RegExp, withLibrary = false) {
  const d = fullDesign();
  mutate(d);
  const found = validateDesign(d, withLibrary ? library : undefined).filter((i) => i.severity === 'error');
  expect(
    found.some((i) => i.path === path && message.test(i.message)),
    `expected error at ${path} matching ${message}; got ${JSON.stringify(found)}`,
  ).toBe(true);
}

describe('validateDesign', () => {
  it('reports nothing for the full valid fixture, with and without the library', () => {
    expect(validateDesign(fullDesign())).toEqual([]);
    expect(validateDesign(fullDesign(), library)).toEqual([]);
  });

  it('reports nothing for an empty design', () => {
    expect(validateDesign(sceneDesign([], []))).toEqual([]);
  });

  describe('duplicate ids', () => {
    // [name, mutation, expected path]
    const cases: Array<[string, (d: Design) => void, string]> = [
      ['sources', (d) => d.scene.sources.push({ ...d.scene.sources[0]! }), 'scene.sources[1].id'],
      ['links', (d) => d.scene.links.push(mkLink('base')), 'scene.links[3].id'],
      ['joints', (d) => d.scene.joints.push({ ...d.scene.joints[0]! }), 'scene.joints[2].id'],
      ['meshes', (d) => d.scene.links[2]!.meshes.push({ ...d.scene.links[0]!.meshes[0]! }), 'scene.links[2].meshes[0].id'],
      ['zones', (d) => d.zones.push({ ...d.zones[0]! }), 'zones[2].id'],
      ['components', (d) => d.components.push({ ...d.components[0]! }), 'components[2].id'],
      ['connections', (d) => d.connections.push({ ...d.connections[0]! }), 'connections[1].id'],
      ['cables', (d) => d.cables.push({ ...d.cables[0]! }), 'cables[1].id'],
      ['routes', (d) => d.routes.push({ ...d.routes[0]! }), 'routes[1].id'],
      ['fixings', (d) => d.fixings.push({ ...d.fixings[0]! }), 'fixings[1].id'],
      ['mounts', (d) => d.mounts.push({ ...d.mounts[0]! }), 'mounts[1].id'],
    ];
    it.each(cases)('duplicate %s id', (_name, mutate, path) => {
      expectError(mutate, path, /duplicate/);
    });
  });

  describe('unknown references', () => {
    const cases: Array<[string, (d: Design) => void, string, RegExp]> = [
      ['mesh source', (d) => (d.scene.links[0]!.meshes[0]!.source = 'nope'), 'scene.links[0].meshes[0].source', /unknown source/],
      ['joint parent', (d) => (d.scene.joints[0]!.parent = 'nope'), 'scene.joints[0].parent', /unknown link/],
      ['joint child', (d) => (d.scene.joints[0]!.child = 'nope'), 'scene.joints[0].child', /unknown link/],
      ['zone link', (d) => (d.zones[0]!.link = 'nope'), 'zones[0].link', /unknown link/],
      ['zone mesh', (d) => (d.zones[0]!.mesh = 'nope'), 'zones[0].mesh', /unknown mesh/],
      ['component link', (d) => (d.components[0]!.link = 'nope'), 'components[0].link', /unknown link/],
      ['component zone', (d) => (d.components[0]!.zone = 'nope'), 'components[0].zone', /unknown zone/],
      ['connection from', (d) => (d.connections[0]!.from.component = 'nope'), 'connections[0].from.component', /unknown component/],
      ['connection to', (d) => (d.connections[0]!.to.component = 'nope'), 'connections[0].to.component', /unknown component/],
      ['cable connection', (d) => (d.cables[0]!.connections[0] = 'nope'), 'cables[0].connections[0]', /unknown connection/],
      ['route cable', (d) => (d.routes[0]!.cable = 'nope'), 'routes[0].cable', /unknown cable/],
      ['route segment link', (d) => (d.routes[0]!.segments[0]!.link = 'nope'), 'routes[0].segments[0].link', /unknown link/],
      ['route crossing joint', (d) => (d.routes[0]!.crossings[0]!.joint = 'nope'), 'routes[0].crossings[0].joint', /unknown joint/],
      ['fixing route', (d) => (d.fixings[0]!.route = 'nope'), 'fixings[0].route', /unknown route/],
      ['mount component', (d) => (d.mounts[0]!.component = 'nope'), 'mounts[0].component', /unknown component/],
    ];
    it.each(cases)('unknown %s', (_name, mutate, path, message) => {
      expectError(mutate, path, message);
    });
  });

  it('rejects a zone whose mesh belongs to another link', () => {
    expectError((d) => (d.zones[0]!.link = 'upper'), 'zones[0].mesh', /belongs to link "base"/);
  });

  describe('joints', () => {
    it('rejects a joint from a link to itself', () => {
      expectError((d) => (d.scene.joints[1]!.child = d.scene.joints[1]!.parent), 'scene.joints[1].child', /itself/);
    });

    it('rejects a link with two parent joints', () => {
      expectError(
        (d) => d.scene.joints.push(mkJoint('second', 'base', 'slider')),
        'scene.joints[2].child',
        /already the child/,
      );
    });

    it('rejects a joint cycle', () => {
      const d = sceneDesign(
        [mkLink('a'), mkLink('b'), mkLink('c')],
        [mkJoint('j1', 'a', 'b'), mkJoint('j2', 'b', 'c'), mkJoint('j3', 'c', 'a')],
      );
      const e = errors(d);
      expect(e.filter((i) => /cycle/.test(i.message)).map((i) => i.path).sort()).toEqual(['scene.links[0]', 'scene.links[1]', 'scene.links[2]']);
    });

    it('does not report a cycle for the links outside it', () => {
      const d = sceneDesign(
        [mkLink('r'), mkLink('a'), mkLink('b')],
        [mkJoint('j1', 'r', 'a'), mkJoint('j2', 'a', 'b'), mkJoint('j3', 'b', 'a')],
      );
      // a has two parents (j1, j3): an error, but r is not part of any cycle
      expect(errors(d).some((i) => i.path === 'scene.links[0]')).toBe(false);
    });

    it.each(['revolute', 'prismatic'] as const)('requires a limit on a %s joint', (type) => {
      const d = sceneDesign([mkLink('a'), mkLink('b')], [mkJoint('j', 'a', 'b', { type })]);
      expect(errors(d).some((i) => i.path === 'scene.joints[0].limit' && /needs a limit/.test(i.message))).toBe(true);
    });

    it.each(['fixed', 'continuous'] as const)('does not require a limit on a %s joint', (type) => {
      const d = sceneDesign([mkLink('a'), mkLink('b')], [mkJoint('j', 'a', 'b', { type })]);
      expect(errors(d)).toEqual([]);
    });

    it('rejects lower > upper but accepts lower == upper', () => {
      const mk = (lower: number, upper: number) =>
        sceneDesign([mkLink('a'), mkLink('b')], [mkJoint('j', 'a', 'b', { type: 'revolute', limit: { lower, upper } })]);
      expect(errors(mk(1, 0.5)).some((i) => i.path === 'scene.joints[0].limit' && /greater/.test(i.message))).toBe(true);
      expect(errors(mk(1, 1))).toEqual([]);
    });

    it.each(['revolute', 'prismatic', 'continuous'] as const)('rejects a zero axis on a %s joint', (type) => {
      const d = sceneDesign([mkLink('a'), mkLink('b')], [mkJoint('j', 'a', 'b', { type, axis: [0, 0, 0], limit: { lower: 0, upper: 1 } })]);
      expect(errors(d).some((i) => i.path === 'scene.joints[0].axis' && /zero/.test(i.message))).toBe(true);
    });

    it('ignores the axis of a fixed joint', () => {
      const d = sceneDesign([mkLink('a'), mkLink('b')], [mkJoint('j', 'a', 'b', { axis: [0, 0, 0] })]);
      expect(errors(d)).toEqual([]);
    });
  });

  describe('quaternion tolerance (1e-6)', () => {
    const withQ = (w: number) => {
      const d = fullDesign();
      d.scene.joints[0]!.origin.q = [0, 0, 0, w];
      d.components[0]!.pose.q = [0, 0, 0, w];
      return d;
    };
    it('accepts a norm just inside the tolerance', () => {
      expect(errors(withQ(1 + 0.9e-6))).toEqual([]);
      expect(errors(withQ(1 - 0.9e-6))).toEqual([]);
    });
    it('rejects a norm just outside the tolerance, on joints and components', () => {
      for (const w of [1 + 1.1e-6, 1 - 1.1e-6, 0, 2]) {
        const e = errors(withQ(w));
        expect(e.some((i) => i.path === 'scene.joints[0].origin.q' && /unit length/.test(i.message)), String(w)).toBe(true);
        expect(e.some((i) => i.path === 'components[0].pose.q' && /unit length/.test(i.message)), String(w)).toBe(true);
      }
    });
  });

  describe('zone triangles', () => {
    it.each([
      ['odd length', [0, 3, 5]],
      ['zero count', [0, 0]],
      ['overlap', [0, 5, 3, 2]],
      ['touching runs', [0, 3, 3, 2]],
      ['unordered', [10, 2, 0, 2]],
    ])('rejects malformed run list: %s', (_name, triangles) => {
      expectError((d) => (d.zones[0]!.triangles = triangles), 'zones[0].triangles', /./);
    });

    it('rejects an index outside the mesh and accepts the last valid one', () => {
      // base-mesh has 200 triangles
      expectError((d) => (d.zones[0]!.triangles = [195, 6]), 'zones[0].triangles', /outside the mesh/);
      const d = fullDesign();
      d.zones[0]!.triangles = [195, 5];
      expect(errors(d)).toEqual([]);
    });
  });

  describe('library checks', () => {
    it('is skipped without a library', () => {
      const d = fullDesign();
      d.components[0]!.part = 'no-such-part';
      d.connections[0]!.from.port = 'no-such-port';
      expect(errors(d)).toEqual([]);
    });
    it('rejects a part that is not in the library', () => {
      expectError((d) => (d.components[0]!.part = 'no-such-part'), 'components[0].part', /not in the library/, true);
    });
    it('rejects a port that is not on the part', () => {
      expectError((d) => (d.connections[0]!.from.port = 'no-such-port'), 'connections[0].from.port', /no port/, true);
      expectError((d) => (d.connections[0]!.to.port = 'no-such-port'), 'connections[0].to.port', /no port/, true);
    });
    it('rejects a connection joining a port to itself', () => {
      expectError(
        (d) => (d.connections[0]!.to = { ...d.connections[0]!.from }),
        'connections[0].to',
        /itself/,
      );
    });
    it('allows two different ports of the same component', () => {
      const d = fullDesign();
      d.connections[0]!.to = { component: 'mcu', port: 'can0' };
      expect(errors(d, true)).toEqual([]);
    });
  });

  describe('warnings', () => {
    it('warns when the saved value is outside the limit, and ok stays true', () => {
      const d = fullDesign();
      d.scene.joints[0]!.value = 3;
      const issues = validateDesign(d);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({ severity: 'warning', path: 'scene.joints[0].value' });
      const r = parseDesign(JSON.parse(JSON.stringify(d)));
      expect(r.ok).toBe(true);
      expect(r.issues).toHaveLength(1);
    });

    it('warns when a port does not list the interface, and ok stays true', () => {
      const d = fullDesign();
      d.connections[0]!.interface = 'can';
      const issues = validateDesign(d, library);
      expect(issues.every((i) => i.severity === 'warning')).toBe(true);
      expect(issues.length).toBeGreaterThan(0);
      const r = parseDesign(JSON.parse(JSON.stringify(d)), library);
      expect(r.ok).toBe(true);
    });

    it('does not warn for a continuous joint value outside its limit', () => {
      const d = sceneDesign([mkLink('a'), mkLink('b')], [mkJoint('j', 'a', 'b', { type: 'continuous', limit: { lower: 0, upper: 1 }, value: 5 })]);
      expect(validateDesign(d)).toEqual([]);
    });

    it('an error alongside a warning makes ok false', () => {
      const d = fullDesign();
      d.scene.joints[0]!.value = 3;
      d.zones[0]!.link = 'upper';
      const r = parseDesign(JSON.parse(JSON.stringify(d)));
      expect(r.ok).toBe(false);
      expect(r.issues.some((i) => i.severity === 'warning')).toBe(true);
    });
  });

  describe('parseDesign', () => {
    it('reports shape errors with a formatted path', () => {
      const r = parseDesign({ schema: 1, scene: { joints: [{ id: 'j' }] } });
      expect(r.ok).toBe(false);
      expect(r.issues.some((i) => i.path === 'scene.joints[0].name')).toBe(true);
    });
    it('rejects non-objects', () => {
      expect(parseDesign(null).ok).toBe(false);
      expect(parseDesign(42).ok).toBe(false);
      expect(parseDesign('x').ok).toBe(false);
    });
  });
});
