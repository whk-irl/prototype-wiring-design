// validateDesign on the design's own parts, component and connection references, and route ends.
import { describe, expect, it } from 'vitest';
import { CableTypeSchema, DesignSchema, parseDesign, PartSchema, PortSchema, validateDesign, type Design, type Part } from '@core';
import { fullDesign, loadLibrary } from './helpers';

const library = loadLibrary();

const own = (over: Record<string, unknown> = {}): Part =>
  PartSchema.parse({
    id: 'my-board',
    name: 'My board',
    category: 'sensor',
    body: { size_mm: [30, 20, 6] },
    ports: [{ id: 'bus', connector: 'jst-sh', ways: 4, pose: { p_mm: [0, 0, 1], q: [0, 0, 0, 1] }, interfaces: ['i2c'] }],
    confidence: 'generic',
    custom: true,
    ...over,
  });

const errors = (d: Design, withLib = false) => validateDesign(d, withLib ? library : undefined).filter((i) => i.severity === 'error');
const warnings = (d: Design, withLib = false) => validateDesign(d, withLib ? library : undefined).filter((i) => i.severity === 'warning');

describe('the design own parts', () => {
  it('reports each problem of a part at parts[i]', () => {
    const d = fullDesign();
    d.parts.push(own({ body: { size_mm: [0, 20, 6] }, ports: [own().ports[0]!, own().ports[0]!] }));
    const found = errors(d).filter((i) => i.path === 'parts[0]');
    expect(found.map((i) => i.message).sort()).toEqual(['duplicate port id "bus"', 'the body size must be positive in all three directions']);
  });

  it('reports duplicate ids among them', () => {
    const d = fullDesign();
    d.parts.push(own(), own());
    expect(errors(d).some((i) => i.path === 'parts[1].id' && /duplicate/.test(i.message))).toBe(true);
  });

  it('a part with the id of a library part gives a warning, only when there is a library', () => {
    const d = fullDesign();
    d.parts.push(own({ id: 'generic-controller-70x50' }));
    d.connections[0]!.from.port = 'bus';
    const w = warnings(d, true).filter((i) => i.path === 'parts[0].id');
    expect(w).toHaveLength(1);
    expect(w[0]!.message).toMatch(/is used in its place/);
    expect(errors(d, true)).toEqual([]);
    expect(warnings(d).filter((i) => i.path === 'parts[0].id')).toEqual([]);
  });

  it('a sound own part gives no issue', () => {
    const d = fullDesign();
    d.parts.push(own());
    expect(validateDesign(d)).toEqual([]);
    expect(validateDesign(d, library)).toEqual([]);
  });
});

describe('components that use the design own parts', () => {
  it('may refer to one with a library', () => {
    const d = fullDesign();
    d.parts.push(own());
    d.components[1]!.part = 'my-board';
    d.connections[0]!.to.port = 'bus';
    expect(errors(d, true)).toEqual([]);
  });

  it('an unknown part is reported with a library, naming both places, and not without one', () => {
    const d = fullDesign();
    d.components[1]!.part = 'my-board';
    const e = errors(d, true).filter((i) => i.path === 'components[1].part');
    expect(e).toHaveLength(1);
    expect(e[0]!.message).toMatch(/not in the library or in this design/);
    expect(errors(d).filter((i) => i.path === 'components[1].part')).toEqual([]);
  });

  it('an own part with a library id is used in place of the library one', () => {
    const d = fullDesign();
    // The library breakout has ports i2c-in and i2c-out; this replacement has only "bus".
    d.parts.push(own({ id: 'generic-breakout-25x18' }));
    expect(errors(d, true).some((i) => i.path === 'connections[0].to.port' && /has no port "i2c-in"/.test(i.message))).toBe(true);
    d.connections[0]!.to.port = 'bus';
    expect(errors(d, true)).toEqual([]);
  });
});

describe('connection ports resolve through the design own parts, with or without a library', () => {
  const withOwn = () => {
    const d = fullDesign();
    d.parts.push(own());
    d.components[1]!.part = 'my-board';
    d.connections[0]!.to.port = 'bus';
    return d;
  };

  it('a port that exists is fine', () => {
    expect(errors(withOwn())).toEqual([]);
    expect(errors(withOwn(), true)).toEqual([]);
  });

  it('a port that does not exist is an error even without a library', () => {
    const d = withOwn();
    d.connections[0]!.to.port = 'missing';
    for (const lib of [false, true]) expect(errors(d, lib).some((i) => i.path === 'connections[0].to.port' && /has no port "missing"/.test(i.message))).toBe(true);
  });

  it('warns when the port does not list the interface', () => {
    const d = withOwn();
    d.connections[0]!.interface = 'can';
    expect(warnings(d).some((i) => i.path === 'connections[0].to.port' && /does not list interface "can"/.test(i.message))).toBe(true);
  });

  it('a part that cannot be resolved is not checked', () => {
    const d = fullDesign();
    d.connections[0]!.to.port = 'whatever';
    expect(errors(d)).toEqual([]);
  });
});

describe('route ends (from and to)', () => {
  const routed = () => {
    const d = fullDesign();
    d.parts.push(own());
    d.components[1]!.part = 'my-board';
    d.connections[0]!.to.port = 'bus';
    d.routes[0]!.from = { component: 'mcu', port: 'i2c0' };
    d.routes[0]!.to = { component: 'imu', port: 'bus' };
    return d;
  };

  it('valid ends give no issue', () => {
    expect(errors(routed())).toEqual([]);
    expect(errors(routed(), true)).toEqual([]);
  });

  it('are optional, each on its own', () => {
    const d = routed();
    delete d.routes[0]!.from;
    expect(errors(d)).toEqual([]);
    delete d.routes[0]!.to;
    expect(errors(d)).toEqual([]);
  });

  it('an unknown component is an error', () => {
    for (const end of ['from', 'to'] as const) {
      const d = routed();
      d.routes[0]![end] = { component: 'nobody', port: 'bus' };
      expect(errors(d).some((i) => i.path === `routes[0].${end}.component` && /unknown component "nobody"/.test(i.message))).toBe(true);
    }
  });

  it('an unknown port is an error when the part can be resolved', () => {
    const d = routed();
    d.routes[0]!.to = { component: 'imu', port: 'nope' };
    expect(errors(d).some((i) => i.path === 'routes[0].to.port' && /has no port "nope"/.test(i.message))).toBe(true);
    const e = routed();
    e.routes[0]!.from = { component: 'mcu', port: 'nope' };
    expect(errors(e).filter((i) => i.path === 'routes[0].from.port')).toEqual([]); // mcu is a library part: not resolvable without a library
    expect(errors(e, true).some((i) => i.path === 'routes[0].from.port')).toBe(true);
  });

  it('survives parseDesign and a JSON round trip', () => {
    const d = routed();
    const r = parseDesign(JSON.parse(JSON.stringify(d)));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.design.routes[0]!.to).toEqual({ component: 'imu', port: 'bus' });
  });
});

describe('schema of the new fields', () => {
  it('parts and tags default to empty', () => {
    expect(DesignSchema.parse({ schema: 1 }).parts).toEqual([]);
    expect(own().tags).toEqual([]);
    expect(PartSchema.parse({ id: 'p', name: 'p', category: 'other', body: { size_mm: [1, 1, 1] }, confidence: 'generic' }).tags).toEqual([]);
  });

  it('accepts the new part fields', () => {
    const p = own({
      description: 'A board',
      tags: ['imu', 'qwiic'],
      body: { size_mm: [30, 20, 6], board: { z_mm: 2, thickness_mm: 1.6 } },
      model: { uri: 'b.glb', license: 'CC0-1.0', attribution: 'me', source: 'https://example.com/b.glb', triangles: 100, sha256: 'a'.repeat(64), changes: 'none' },
      category: 'actuator',
    });
    expect(p.tags).toEqual(['imu', 'qwiic']);
    expect(p.body.board).toEqual({ z_mm: 2, thickness_mm: 1.6 });
    expect(p.category).toBe('actuator');
  });

  it.each([
    ['part', { colour: 'red' }],
    ['body', { body: { size_mm: [1, 1, 1], extra: 1 } }],
    ['board', { body: { size_mm: [1, 1, 1], board: { z_mm: 0, thickness_mm: 1, extra: 1 } } }],
    ['model', { model: { uri: 'a.glb', extra: 1 } }],
    ['empty tag', { tags: [''] }],
    ['custom false', { custom: false }],
    ['bad category', { category: 'toy' }],
    ['zero board thickness', { body: { size_mm: [1, 1, 1], board: { z_mm: 0, thickness_mm: 0 } } }],
    ['bad model hash', { model: { uri: 'a.glb', sha256: 'zz' } }],
  ])('rejects %s', (_n, extra) => {
    const raw = { id: 'p', name: 'p', category: 'other', body: { size_mm: [1, 1, 1] }, confidence: 'generic', ...extra };
    expect(PartSchema.safeParse(raw).success).toBe(false);
  });

  it('ports: ways is an optional positive integer, unknown keys are rejected', () => {
    const base = { id: 'a', connector: 'x', pose: { p_mm: [0, 0, 0], q: [0, 0, 0, 1] }, interfaces: ['i2c'] };
    expect(PortSchema.parse(base).ways).toBeUndefined();
    expect(PortSchema.parse({ ...base, ways: 4 }).ways).toBe(4);
    for (const bad of [0, -1, 1.5]) expect(PortSchema.safeParse({ ...base, ways: bad }).success).toBe(false);
    expect(PortSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(PortSchema.safeParse({ ...base, interfaces: [] }).success).toBe(false);
  });

  it('a design with its own parts round-trips through JSON', () => {
    const d = fullDesign();
    d.parts.push(own({ tags: ['x'] }));
    expect(DesignSchema.parse(JSON.parse(JSON.stringify(d)))).toEqual(d);
  });

  it('a cable type has an optional positive pitch', () => {
    const t = (extra: object) =>
      CableTypeSchema.safeParse({ id: 'a', name: 'a', family: 'ffc', section: { shape: 'flat', width_mm: 5, thickness_mm: 0.3 }, conductors: 4, min_bend_mm: { static: 2 }, flex: 'flexible', confidence: 'generic', ...extra });
    expect(t({}).success).toBe(true);
    expect(t({ pitch_mm: 1 }).success).toBe(true);
    expect(t({ pitch_mm: 0 }).success).toBe(false);
  });

  it('route from and to are port references and reject unknown keys', () => {
    const d = fullDesign();
    const raw = JSON.parse(JSON.stringify(d)) as { routes: Array<Record<string, unknown>> };
    raw.routes[0]!.from = { component: 'mcu', port: 'i2c0', extra: 1 };
    expect(DesignSchema.safeParse(raw).success).toBe(false);
    raw.routes[0]!.from = { component: 'mcu' };
    expect(DesignSchema.safeParse(raw).success).toBe(false);
  });
});
