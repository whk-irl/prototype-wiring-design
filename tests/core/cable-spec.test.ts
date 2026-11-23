// User-defined cable types: awgDiameterMm, cableTypeProblems, merge/resolve, and cableTypeFromSpec.
// Expected bend radii are worked out by hand and written as literals; the constants are checked
// against the documented figures separately.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ASSUMED_FFC_THICKNESS_MAX_MM,
  ASSUMED_FFC_THICKNESS_MM,
  ASSUMED_RIBBON_127_THICKNESS_MAX_MM,
  ASSUMED_RIBBON_127_THICKNESS_MM,
  ASSUMED_WIRE_WALL_MM,
  awgDiameterMm,
  cableEnvelope,
  cableFit,
  CableTypeSchema,
  cableTypeFromSpec,
  cableTypeProblems,
  DesignSchema,
  findCableType,
  findConnector,
  FLAT_BEND_OVER_THICKNESS,
  FPC_BEND_OVER_THICKNESS,
  mergeCableLibrary,
  parseCableLibrary,
  parseConnectorLibrary,
  parseDesign,
  resolveCableType,
  ROUND_BEND_OVER_OD,
  STRANDED_OVER_SOLID,
  validateDesign,
  WIRE_ESTIMATE_AWG,
  type CableLibrary,
  type CableSpecInput,
  type CableType,
} from '@core';
import { fullDesign, readText } from './helpers';

fc.configureGlobal({ seed: 20261121 });

const library = parseCableLibrary(readText('library/cables.yaml'));
const connectors = parseConnectorLibrary(readText('library/connectors.yaml'));
const r2 = (x: number) => Math.round(x * 100) / 100; // only for the documented 2-decimal wire estimate

const type = (over: Record<string, unknown> = {}): CableType =>
  CableTypeSchema.parse({
    id: 't',
    name: 't',
    family: 'hookup_wire',
    section: { shape: 'round', od_mm: 2 },
    conductors: 1,
    min_bend_mm: { static: 10 },
    flex: 'flexible',
    confidence: 'generic',
    ...over,
  });

const build = (spec: CableSpecInput, id = 'mine') => cableTypeFromSpec(spec, id);
const flatSection = (t: CableType) => t.section as { width_mm: number; thickness_mm: number };
const roundOd = (t: CableType) => (t.section as { od_mm: number }).od_mm;

describe('the documented multiples', () => {
  it('are the figures in docs/CABLES.md', () => {
    expect(ROUND_BEND_OVER_OD).toEqual({ static: 8, dynamic: 12 });
    expect(FLAT_BEND_OVER_THICKNESS).toBe(8);
    expect(FPC_BEND_OVER_THICKNESS).toEqual({ static: { one_layer: 10, two_layers: 12, multilayer: 24 }, dynamic: { one_layer: 100, two_layers: 150 } });
    expect([ASSUMED_FFC_THICKNESS_MM, ASSUMED_FFC_THICKNESS_MAX_MM]).toEqual([0.3, 0.35]);
    expect([ASSUMED_RIBBON_127_THICKNESS_MM, ASSUMED_RIBBON_127_THICKNESS_MAX_MM]).toEqual([0.9, 1.0]);
    expect(WIRE_ESTIMATE_AWG).toEqual({ finest: 30, heaviest: 16 });
  });
});

describe('awgDiameterMm', () => {
  it('matches the definition of the gauge', () => {
    expect(awgDiameterMm(36)).toBeCloseTo(0.127, 12);
    expect(awgDiameterMm(0)).toBeCloseTo(8.251, 3);
    expect(awgDiameterMm(24)).toBeCloseTo(0.511, 3);
    expect(awgDiameterMm(26)).toBeCloseTo(0.405, 3);
  });
  it('is strictly decreasing in gauge, and 39 gauges are a factor of 92', () => {
    for (let g = 0; g < 46; g++) expect(awgDiameterMm(g + 1)).toBeLessThan(awgDiameterMm(g));
    expect(awgDiameterMm(0) / awgDiameterMm(39)).toBeCloseTo(92, 9);
  });
});

describe('cableTypeProblems', () => {
  const flatBase = { family: 'ffc', conductors: 2 };
  const cases: Array<[string, Record<string, unknown>, Record<string, unknown>, RegExp]> = [
    ['dynamic below static', { min_bend_mm: { static: 10, dynamic: 9 } }, { min_bend_mm: { static: 10, dynamic: 10 } }, /dynamic bend radius cannot be smaller/],
    [
      'flat cable thicker than wide',
      { section: { shape: 'flat', width_mm: 1, thickness_mm: 2 } },
      { section: { shape: 'flat', width_mm: 2, thickness_mm: 2 } },
      /the width of a flat cable is its larger side/,
    ],
    [
      'conductors do not fit across a flat cable',
      { section: { shape: 'flat', width_mm: 4, thickness_mm: 0.3 }, conductors: 6, pitch_mm: 1 },
      { section: { shape: 'flat', width_mm: 5, thickness_mm: 0.3 }, conductors: 6, pitch_mm: 1 },
      /6 conductors at 1 mm pitch do not fit across 4 mm/,
    ],
    ['round cable thinner than its conductor', { awg: 10, section: { shape: 'round', od_mm: 2 } }, { awg: 10, section: { shape: 'round', od_mm: 3 } }, /10 AWG conductor is 2\.59 mm across/],
    [
      'a flat cable thinner than its conductor (28 AWG is 0.321 mm)',
      { ...flatBase, awg: 28, pitch_mm: 1, section: { shape: 'flat', width_mm: 5, thickness_mm: 0.3 } },
      { ...flatBase, awg: 36, pitch_mm: 1, section: { shape: 'flat', width_mm: 5, thickness_mm: 0.3 } },
      /28 AWG conductor is 0\.32 mm across, which does not fit inside a cable 0\.3 mm thick/,
    ],
    [
      'a flat cable whose conductor is wider than its pitch (26 AWG is 0.405 mm)',
      { ...flatBase, awg: 26, pitch_mm: 0.3, section: { shape: 'flat', width_mm: 2, thickness_mm: 1 } },
      { ...flatBase, awg: 26, pitch_mm: 0.5, section: { shape: 'flat', width_mm: 2, thickness_mm: 1 } },
      /26 AWG conductors are 0\.40 mm across, which does not fit a 0\.3 mm pitch/,
    ],
    [
      'a ribbon thicker than its pitch',
      { family: 'ribbon', conductors: 2, pitch_mm: 0.5, section: { shape: 'flat', width_mm: 1, thickness_mm: 1 } },
      { family: 'ribbon', conductors: 2, pitch_mm: 0.5, section: { shape: 'flat', width_mm: 1, thickness_mm: 0.5 } },
      /ribbon cable of 0\.5 mm pitch cannot be 1 mm thick/,
    ],
    [
      'bare conductors that do not fit together inside a round cable (20 x 20 AWG in 1.0 mm)',
      { conductors: 20, awg: 20, family: 'multicore', section: { shape: 'round', od_mm: 1 } },
      { conductors: 20, awg: 20, family: 'multicore', section: { shape: 'round', od_mm: 6 } },
      /20 bare 20 AWG conductors are \d+\.\d\d mm across when packed together, which does not fit inside 1 mm/,
    ],
  ];
  it.each(cases)('%s', (_n, bad, good, message) => {
    expect(cableTypeProblems(type(bad)).join(' ')).toMatch(message);
    expect(cableTypeProblems(type(good))).toEqual([]);
  });

  it('a conductor exactly as wide as the cable is a problem, and a pitch that just fits is not', () => {
    expect(cableTypeProblems(type({ awg: 10, section: { shape: 'round', od_mm: awgDiameterMm(10) } }))).toHaveLength(1);
    expect(cableTypeProblems(type({ section: { shape: 'flat', width_mm: 5, thickness_mm: 0.3 }, conductors: 6, pitch_mm: 1 }))).toEqual([]);
  });

  it('no type in library/cables.yaml has a problem', () => {
    for (const c of library.cables) expect(cableTypeProblems(c), c.id).toEqual([]);
  });

  it('CableTypeSchema takes a gauge from 0 to 50', () => {
    expect(CableTypeSchema.safeParse({ ...type(), awg: 50 }).success).toBe(true);
    expect(CableTypeSchema.safeParse({ ...type(), awg: 0 }).success).toBe(true);
    expect(CableTypeSchema.safeParse({ ...type(), awg: 51 }).success).toBe(false);
    expect(CableTypeSchema.safeParse({ ...type(), awg: -1 }).success).toBe(false);
  });
});

describe('mergeCableLibrary and resolveCableType', () => {
  const base: CableLibrary = { version: 1, cables: ['a', 'b', 'c'].map((id) => type({ id, name: id })) };

  it('returns the same object for an empty list', () => {
    expect(mergeCableLibrary(base, [])).toBe(base);
  });

  it('puts new types first and replaces an existing id in its place', () => {
    const merged = mergeCableLibrary(base, [type({ id: 'x', name: 'x' }), type({ id: 'b', name: 'mine' }), type({ id: 'y', name: 'y' })]);
    expect(merged.cables.map((c) => c.id)).toEqual(['x', 'y', 'a', 'b', 'c']);
    expect(findCableType(merged, 'b')!.name).toBe('mine');
    expect(base.cables.map((c) => c.name)).toEqual(['a', 'b', 'c']);
  });

  it('never duplicates an id (property)', () => {
    const ids = fc.array(fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f'), { maxLength: 8 });
    fc.assert(
      fc.property(ids, (list) => {
        const merged = mergeCableLibrary(base, list.map((id, i) => type({ id, name: `n${i}` })));
        const out = merged.cables.map((c) => c.id);
        expect(new Set(out).size).toBe(out.length);
        for (const id of ['a', 'b', 'c', ...list]) expect(out).toContain(id);
      }),
    );
  });

  it('resolveCableType: the design own type wins, then the library, else undefined', () => {
    const design = { cable_types: [type({ id: 'b', name: 'own b' }), type({ id: 'z', name: 'own z' })] };
    expect(resolveCableType(design, base, 'b')!.name).toBe('own b');
    expect(resolveCableType(design, base, 'a')!.name).toBe('a');
    expect(resolveCableType(design, base, 'z')!.name).toBe('own z');
    expect(resolveCableType(design, base, 'nope')).toBeUndefined();
    expect(resolveCableType(design, null, 'a')).toBeUndefined();
    expect(resolveCableType(design, undefined, 'z')!.name).toBe('own z');
    expect(resolveCableType({ cable_types: [] }, base, 'c')!.name).toBe('c');
  });
});

// ---------------------------------------------------------------- sizes against the library

describe('cableTypeFromSpec, widths and sizes against the library', () => {
  it('ribbon: width = ways x pitch (ribbon-10way-1.27mm is 12.7 mm)', () => {
    const lib = findCableType(library, 'ribbon-10way-1.27mm')!;
    const { type: t } = build({ kind: 'ribbon', ways: 10, pitch_mm: 1.27 });
    expect(t.section).toMatchObject({ shape: 'flat', width_mm: 12.7 });
    expect(flatSection(lib).width_mm).toBeCloseTo(12.7, 9);
    expect(t.family).toBe('ribbon');
    expect(t.conductors).toBe(10);
    expect(t.pitch_mm).toBe(1.27);
  });

  it('every ribbon entry of the library has the width ways x pitch', () => {
    const ribbons = library.cables.filter((c) => c.family === 'ribbon' && c.id.startsWith('ribbon-'));
    expect(ribbons).toHaveLength(3);
    for (const c of ribbons) {
      expect(flatSection(build({ kind: 'ribbon', ways: c.conductors, pitch_mm: c.pitch_mm! }).type).width_mm, c.id).toBeCloseTo(flatSection(c).width_mm, 9);
    }
  });

  it('every ffc entry of the library has the width (ways + 1) x pitch, and the generator reproduces it', () => {
    const ffcs = library.cables.filter((c) => c.family === 'ffc');
    expect(ffcs).toHaveLength(6);
    for (const c of ffcs) {
      expect(flatSection(c).width_mm, c.id).toBeCloseTo((c.conductors + 1) * c.pitch_mm!, 9);
      const { type: t } = build({ kind: 'flat_flex', construction: 'ffc', ways: c.conductors, pitch_mm: c.pitch_mm! });
      expect(flatSection(t).width_mm, c.id).toBeCloseTo(flatSection(c).width_mm, 9);
      expect(t.family).toBe('ffc');
    }
  });

  it('flat flex: a given width replaces the standard one, and says nothing about it', () => {
    const { type: t, derived } = build({ kind: 'flat_flex', construction: 'fpc', ways: 6, pitch_mm: 0.5, thickness_mm: 0.1, width_mm: 9 });
    expect(flatSection(t).width_mm).toBe(9);
    expect(derived.join(' ')).not.toMatch(/Width/);
  });

  it('the wire estimate from the gauge reproduces every ul1007-* library entry within 0.05 mm', () => {
    const entries = library.cables.filter((c) => c.id.startsWith('ul1007-'));
    expect(entries).toHaveLength(6);
    for (const entry of entries) {
      expect(Math.abs(roundOd(build({ kind: 'wire', awg: entry.awg! }).type) - roundOd(entry)), entry.id).toBeLessThanOrEqual(0.05);
    }
  });

  it('the wire estimate is stranded diameter plus the wall each side', () => {
    expect(roundOd(build({ kind: 'wire', awg: 24 }).type)).toBe(r2(STRANDED_OVER_SOLID * awgDiameterMm(24) + 2 * ASSUMED_WIRE_WALL_MM));
    expect(roundOd(build({ kind: 'wire', awg: 24 }).type)).toBeCloseTo(1.41, 2);
    const w = build({ kind: 'wire', awg: 24, wall_mm: 0.2 });
    expect(roundOd(w.type)).toBe(r2(STRANDED_OVER_SOLID * awgDiameterMm(24) + 0.4));
    expect(w.derived[0]).not.toMatch(/UL 1007/);
    expect(build({ kind: 'wire', awg: 24 }).derived[0]).toMatch(/UL 1007/);
  });

  it('a measured outer diameter is used as given and nothing is estimated', () => {
    const { type: t, derived } = build({ kind: 'wire', awg: 24, od_mm: 1.4 });
    expect(roundOd(t)).toBe(1.4);
    expect(derived.join(' ')).not.toMatch(/estimated/);
  });
});

describe('cableTypeFromSpec, the wire estimate range', () => {
  it.each([30, 16, 24])('%d AWG is estimated', (awg) => {
    expect(() => build({ kind: 'wire', awg })).not.toThrow();
  });
  it.each([32, 31, 15, 12, 0])('%d AWG without an outer diameter asks for one', (awg) => {
    expect(() => build({ kind: 'wire', awg })).toThrow(RangeError);
    expect(() => build({ kind: 'wire', awg })).toThrow(/outer diameter/);
  });
  it('outside the range, a wall or an outer diameter lets it through', () => {
    expect(() => build({ kind: 'wire', awg: 32, wall_mm: 0.2 })).not.toThrow();
    expect(() => build({ kind: 'wire', awg: 12, od_mm: 5 })).not.toThrow();
  });
  it.each([0, 46, 47, 50])('a gauge of %d is accepted (0 to 50)', (awg) => {
    expect(() => build({ kind: 'wire', awg, od_mm: 12 })).not.toThrow();
  });
  it.each([24.5, -1, 51, 100])('a gauge of %d is refused by the spec schema', (awg) => {
    expect(() => build({ kind: 'wire', awg, od_mm: 5 })).toThrow();
  });
});

describe('cableTypeFromSpec, bounds of the spec', () => {
  const refused: Array<[string, CableSpecInput]> = [
    ['od_mm above 100', { kind: 'wire', awg: 24, od_mm: 100.01 }],
    ['round cable od above 100', { kind: 'round_cable', conductors: 2, od_mm: 101 }],
    ['conductors above 200', { kind: 'round_cable', conductors: 201, od_mm: 50 }],
    ['ways above 200', { kind: 'ribbon', ways: 201, pitch_mm: 1.27 }],
    ['flat flex ways above 200', { kind: 'flat_flex', construction: 'ffc', ways: 201, pitch_mm: 0.5 }],
    ['pitch below 0.1', { kind: 'ribbon', ways: 4, pitch_mm: 0.05, thickness_mm: 0.05 }],
    ['pitch above 25', { kind: 'ribbon', ways: 4, pitch_mm: 25.1, thickness_mm: 1 }],
    ['flat flex pitch above 25', { kind: 'flat_flex', construction: 'ffc', ways: 4, pitch_mm: 26 }],
    ['thickness above 10', { kind: 'ribbon', ways: 4, pitch_mm: 25, thickness_mm: 10.5 }],
    ['width above 500', { kind: 'flat_flex', construction: 'ffc', ways: 4, pitch_mm: 1, width_mm: 501 }],
    ['wall above 10', { kind: 'wire', awg: 24, wall_mm: 11 }],
    ['static bend above 5000', { kind: 'wire', awg: 24, od_mm: 1, bend_static_mm: 5001 }],
    ['dynamic bend above 5000', { kind: 'wire', awg: 24, od_mm: 1, bend_static_mm: 10, bend_dynamic_mm: 5001 }],
    ['an unknown key', { kind: 'wire', awg: 24, od_mm: 1, colour: 'red' } as unknown as CableSpecInput],
  ];
  it.each(refused)('refuses %s', (_n, spec) => {
    expect(() => build(spec)).toThrow();
  });

  it('accepts the bounds themselves', () => {
    expect(() => build({ kind: 'wire', awg: 24, od_mm: 100 })).not.toThrow();
    expect(() => build({ kind: 'ribbon', ways: 200, pitch_mm: 25, thickness_mm: 10 })).not.toThrow();
    expect(() => build({ kind: 'flat_flex', construction: 'ffc', ways: 2, pitch_mm: 0.1, width_mm: 500 })).not.toThrow();
    expect(() => build({ kind: 'wire', awg: 24, od_mm: 1, bend_static_mm: 5000, bend_dynamic_mm: 5000 })).not.toThrow();
  });
});

// ---------------------------------------------------------------- bend radii, by hand

describe('cableTypeFromSpec, bend radii (worked out by hand)', () => {
  it('round wire and cable: 8 x and 12 x the outer diameter', () => {
    // 8 x 2.2 = 17.6, 12 x 2.2 = 26.4
    const w = build({ kind: 'wire', awg: 22, od_mm: 2.2, flexing: true }).type;
    expect(w.min_bend_mm).toEqual({ static: 17.6, dynamic: 26.4 });
    expect(w.flex).toBe('flexible');
    // 8 x 5 = 40
    const c = build({ kind: 'round_cable', conductors: 4, od_mm: 5 }).type;
    expect(c.min_bend_mm).toEqual({ static: 40 });
    expect(c.flex).toBe('static');
  });

  it('rounds up to 0.1 mm, and says what it rounded from', () => {
    // 8 x 1.23 = 9.84 -> 9.9
    const { type: t, derived } = build({ kind: 'wire', awg: 24, od_mm: 1.23 });
    expect(t.min_bend_mm.static).toBe(9.9);
    expect(derived.join(' ')).toContain('(9.84 mm, rounded up)');
  });

  it('a product that is already a multiple of 0.1 has no "rounded up" text', () => {
    // 10 x 0.12 = 1.2 ; 8 x 2.2 = 17.6
    const f = build({ kind: 'flat_flex', construction: 'fpc', ways: 8, pitch_mm: 0.5, thickness_mm: 0.12, width_mm: 5 });
    expect(f.type.min_bend_mm.static).toBe(1.2);
    expect(f.derived.join(' ')).not.toMatch(/rounded up/);
    expect(build({ kind: 'wire', awg: 22, od_mm: 2.2 }).derived.join(' ')).not.toMatch(/rounded up/);
  });

  it('ribbon and FFC: 8 x the thickness, no dynamic figure', () => {
    // FFC 0.34 mm: 8 x 0.34 = 2.72 -> 2.8 ; FFC 0.2 mm: 1.6 ; ribbon 0.5 mm: 4
    expect(build({ kind: 'flat_flex', construction: 'ffc', ways: 6, pitch_mm: 0.5, thickness_mm: 0.34 }).type.min_bend_mm).toEqual({ static: 2.8 });
    expect(build({ kind: 'flat_flex', construction: 'ffc', ways: 6, pitch_mm: 0.5, thickness_mm: 0.2 }).type.min_bend_mm).toEqual({ static: 1.6 });
    expect(build({ kind: 'ribbon', ways: 10, pitch_mm: 2.54, thickness_mm: 0.5, flexing: true }).type.min_bend_mm).toEqual({ static: 4 });
  });

  it('an assumed thickness: sized at 0.3 / 0.9 mm, but bent by the thickest such a cable may be', () => {
    const ffc = build({ kind: 'flat_flex', construction: 'ffc', ways: 6, pitch_mm: 0.5 }).type;
    expect(flatSection(ffc).thickness_mm).toBe(0.3);
    expect(ffc.min_bend_mm.static).toBe(2.8); // 8 x 0.35
    const ribbon = build({ kind: 'ribbon', ways: 10, pitch_mm: 1.27 }).type;
    expect(flatSection(ribbon).thickness_mm).toBe(0.9);
    expect(ribbon.min_bend_mm.static).toBe(8); // 8 x 1.0
    // an entered thickness is used as it is
    expect(build({ kind: 'ribbon', ways: 10, pitch_mm: 1.27, thickness_mm: 0.9 }).type.min_bend_mm.static).toBe(7.2);
  });

  it('an FFC without a thickness says it assumed one', () => {
    const { derived } = build({ kind: 'flat_flex', construction: 'ffc', ways: 6, pitch_mm: 0.5 });
    expect(derived.join(' ')).toMatch(/Thickness 0\.3 mm assumed/);
  });

  describe('FPC', () => {
    const fpc = (extra: Record<string, unknown>) => build({ kind: 'flat_flex', construction: 'fpc', ways: 8, pitch_mm: 0.5, width_mm: 5, ...extra } as CableSpecInput);

    it('2 layers, 0.11 mm: 12 x 0.11 = 1.32 -> 1.4, with the exact product shown', () => {
      const r = fpc({ thickness_mm: 0.11, layers: 2 });
      expect(r.type.min_bend_mm.static).toBe(1.4);
      expect(r.derived.join(' ')).toContain('(1.32 mm, rounded up)');
    });

    it('2 layers, 0.12 mm: 12 x 0.12 = 1.44 -> 1.5', () => {
      expect(fpc({ thickness_mm: 0.12, layers: 2 }).type.min_bend_mm.static).toBe(1.5);
    });

    it('a 0.004 mm circuit no longer crashes: 10 x 0.004 = 0.04 -> 0.1', () => {
      expect(fpc({ thickness_mm: 0.004 }).type.min_bend_mm.static).toBe(0.1);
    });

    it('static radius by layers at 0.12 mm: 1.2, 1.5, 2.9 (24 x 0.12 = 2.88), 2.9', () => {
      expect([1, 2, 3, 6].map((layers) => fpc({ thickness_mm: 0.12, layers }).type.min_bend_mm.static)).toEqual([1.2, 1.5, 2.9, 2.9]);
      for (const layers of [1, 2, 3, 6]) expect(fpc({ thickness_mm: 0.12, layers }).type.min_bend_mm.dynamic).toBeUndefined();
    });

    it('a circuit that flexes: 100 x (1 layer) and 150 x (2 layers) the thickness', () => {
      expect(fpc({ thickness_mm: 0.12, layers: 1, flexing: true }).type.min_bend_mm).toEqual({ static: 1.2, dynamic: 12 });
      expect(fpc({ thickness_mm: 0.12, layers: 2, flexing: true }).type.min_bend_mm).toEqual({ static: 1.5, dynamic: 18 });
    });

    it.each([3, 4, 8])('%d layers that flex get no dynamic figure, a sentence saying why, and flex "static"', (layers) => {
      const { type: t, derived } = fpc({ thickness_mm: 0.12, layers, flexing: true });
      expect(t.min_bend_mm.dynamic).toBeUndefined();
      expect(derived.join(' ')).toMatch(/not recommended for flexing in use/);
      expect(t.note).toMatch(/not recommended for flexing in use/);
      expect(t.flex).toBe('static');
      expect(fpc({ thickness_mm: 0.12, layers }).type.flex).toBe('static');
    });

    it('3 or more layers with the fab figure entered: used, flexible, nothing to say', () => {
      const own = fpc({ thickness_mm: 0.12, layers: 3, flexing: true, bend_dynamic_mm: 99 });
      expect(own.type.min_bend_mm.dynamic).toBe(99);
      expect(own.type.flex).toBe('flexible');
      expect(own.derived.join(' ')).not.toMatch(/not recommended/);
    });
  });

  describe('the installed radius entered is above the rule flexing radius', () => {
    it('the flexing radius equals the installed one and the sentence says so', () => {
      // rule: 12 x 2 = 24 mm; installed radius entered: 100 mm
      const { type: t, derived } = build({ kind: 'wire', awg: 22, od_mm: 2, flexing: true, bend_static_mm: 100 });
      expect(t.min_bend_mm).toEqual({ static: 100, dynamic: 100 });
      const text = derived.join(' ');
      expect(text).toContain('the rule (12 x the outer diameter) gives 24 mm, less than the installed radius entered, so the installed radius is used');
      expect(text).not.toContain('100 mm = 12 x the outer diameter');
      expect(text).toMatch(/Flexing bend radius 100 mm:/);
    });

    it('when the rule figure is larger it is used as it is', () => {
      const { type: t, derived } = build({ kind: 'wire', awg: 22, od_mm: 2, flexing: true, bend_static_mm: 10 });
      expect(t.min_bend_mm).toEqual({ static: 10, dynamic: 24 });
      expect(derived.join(' ')).toContain('Flexing bend radius 24 mm = 12 x the outer diameter.');
    });
  });

  it('the user figures win, and then nothing about bend appears in derived', () => {
    const { type: t, derived } = build({ kind: 'wire', awg: 22, od_mm: 2.2, flexing: true, bend_static_mm: 7, bend_dynamic_mm: 15 });
    expect(t.min_bend_mm).toEqual({ static: 7, dynamic: 15 });
    expect(derived.join(' ')).not.toMatch(/bend radius/i);
    expect(t.note ?? '').not.toMatch(/bend radius/i);
    const s = build({ kind: 'round_cable', conductors: 2, od_mm: 3, bend_static_mm: 11 });
    expect(s.type.min_bend_mm).toEqual({ static: 11 });
    expect(s.derived).toEqual([]);
  });

  it('throws RangeError for a flexing radius below the static one', () => {
    expect(() => build({ kind: 'wire', awg: 22, od_mm: 2, bend_static_mm: 10, bend_dynamic_mm: 9 })).toThrow(RangeError);
    expect(() => build({ kind: 'wire', awg: 22, od_mm: 2, bend_dynamic_mm: 3 })).toThrow(RangeError); // static from the rule is 16
    expect(() => build({ kind: 'wire', awg: 22, od_mm: 2, bend_static_mm: 10, bend_dynamic_mm: 10 })).not.toThrow();
  });

  it('throws RangeError for an FPC without a thickness', () => {
    expect(() => build({ kind: 'flat_flex', construction: 'fpc', ways: 8, pitch_mm: 0.5 })).toThrow(RangeError);
  });

  describe('ribbon thickness', () => {
    it('is assumed only for 28 AWG or no gauge at 1.27 mm pitch', () => {
      expect(() => build({ kind: 'ribbon', ways: 10, pitch_mm: 1.27 })).not.toThrow();
      expect(() => build({ kind: 'ribbon', ways: 10, pitch_mm: 1.27, awg: 28 })).not.toThrow();
    });
    it('another gauge without a thickness throws, naming the gauge', () => {
      expect(() => build({ kind: 'ribbon', ways: 10, pitch_mm: 1.27, awg: 26 })).toThrow(RangeError);
      expect(() => build({ kind: 'ribbon', ways: 10, pitch_mm: 1.27, awg: 26 })).toThrow(/26 AWG/);
      expect(() => build({ kind: 'ribbon', ways: 10, pitch_mm: 1.27, awg: 26, thickness_mm: 0.9 })).not.toThrow();
    });
    it('another pitch without a thickness throws', () => {
      expect(() => build({ kind: 'ribbon', ways: 10, pitch_mm: 2.54 })).toThrow(RangeError);
      expect(() => build({ kind: 'ribbon', ways: 10, pitch_mm: 2.54, thickness_mm: 1.2 })).not.toThrow();
    });
  });

  it('throws RangeError when the parameters do not describe a cable', () => {
    expect(() => build({ kind: 'flat_flex', construction: 'ffc', ways: 6, pitch_mm: 0.5, thickness_mm: 5 })).toThrow(RangeError);
    expect(() => build({ kind: 'round_cable', conductors: 2, od_mm: 0.5, awg: 10 })).toThrow(RangeError);
    expect(() => build({ kind: 'ribbon', ways: 4, pitch_mm: 0.5, thickness_mm: 1 })).toThrow(RangeError); // thicker than its pitch
    expect(() => build({ kind: 'flat_flex', construction: 'ffc', ways: 4, pitch_mm: 1, thickness_mm: 0.3, width_mm: 2 })).toThrow(RangeError); // 3 mm of conductors across 2 mm
  });

  it('refuses a round cable whose bare conductors cannot fit (20 x 20 AWG in 1.0 mm)', () => {
    expect(() => build({ kind: 'round_cable', conductors: 20, awg: 20, od_mm: 1 })).toThrow(RangeError);
    expect(() => build({ kind: 'round_cable', conductors: 20, awg: 20, od_mm: 6 })).not.toThrow();
  });
});

describe('cableTypeFromSpec, flex', () => {
  it('a flexing radius entered, without `flexing`, makes it flexible', () => {
    expect(build({ kind: 'wire', awg: 22, od_mm: 2, bend_static_mm: 10, bend_dynamic_mm: 20 }).type.flex).toBe('flexible');
    expect(build({ kind: 'wire', awg: 22, od_mm: 2 }).type.flex).toBe('static');
    expect(build({ kind: 'wire', awg: 22, od_mm: 2, flexing: true }).type.flex).toBe('flexible');
  });

  it('ribbon and FFC that flex with no flexing radius entered get a sentence, in derived and in the note', () => {
    for (const spec of [
      { kind: 'ribbon', ways: 10, pitch_mm: 1.27, flexing: true },
      { kind: 'flat_flex', construction: 'ffc', ways: 6, pitch_mm: 0.5, flexing: true },
    ] as CableSpecInput[]) {
      const { type: t, derived } = build(spec);
      expect(derived.join(' ')).toMatch(/No flexing bend radius: /);
      expect(t.note).toMatch(/No flexing bend radius: /);
      expect(t.min_bend_mm.dynamic).toBeUndefined();
    }
    const own = build({ kind: 'ribbon', ways: 10, pitch_mm: 1.27, flexing: true, bend_static_mm: 8, bend_dynamic_mm: 30 });
    expect(own.derived.join(' ')).not.toMatch(/No flexing bend radius/);
  });

  it('flat flex is flexible by construction, except circuits of three or more layers', () => {
    expect(build({ kind: 'flat_flex', construction: 'ffc', ways: 6, pitch_mm: 0.5 }).type.flex).toBe('flexible');
    expect(build({ kind: 'flat_flex', construction: 'fpc', ways: 6, pitch_mm: 0.5, thickness_mm: 0.1, width_mm: 5 }).type.flex).toBe('flexible');
    expect(build({ kind: 'flat_flex', construction: 'fpc', ways: 6, pitch_mm: 0.5, thickness_mm: 0.1, width_mm: 5, layers: 3 }).type.flex).toBe('static');
  });
});

describe('cableTypeFromSpec, confidence', () => {
  it('generic when a size was assumed', () => {
    expect(build({ kind: 'wire', awg: 24 }).type.confidence).toBe('generic');
    expect(build({ kind: 'ribbon', ways: 10, pitch_mm: 1.27 }).type.confidence).toBe('generic');
    expect(build({ kind: 'flat_flex', construction: 'ffc', ways: 6, pitch_mm: 0.5 }).type.confidence).toBe('generic');
    expect(build({ kind: 'wire', awg: 24, bend_static_mm: 5, basis: 'datasheet' }).type.confidence).toBe('generic');
  });

  it('an FPC whose width was not entered is generic, and the sentence says "assumed"', () => {
    const { type: t, derived } = build({ kind: 'flat_flex', construction: 'fpc', ways: 8, pitch_mm: 0.5, thickness_mm: 0.12, bend_static_mm: 1.5, basis: 'datasheet' });
    expect(t.confidence).toBe('generic');
    expect(derived.find((s) => /^Width/.test(s))).toMatch(/^Width 4\.5 mm assumed/);
  });

  it('derived when only a bend radius came from a rule', () => {
    expect(build({ kind: 'wire', awg: 24, od_mm: 1.2 }).type.confidence).toBe('derived');
    expect(build({ kind: 'round_cable', conductors: 3, od_mm: 4, basis: 'datasheet', bend_static_mm: 20, flexing: true }).type.confidence).toBe('derived');
    expect(build({ kind: 'flat_flex', construction: 'fpc', ways: 6, pitch_mm: 0.5, thickness_mm: 0.1, width_mm: 4 }).type.confidence).toBe('derived');
  });

  it('a ribbon or FFC whose width was worked out is at most derived, even with both bend radii entered', () => {
    const ribbon = build({ kind: 'ribbon', ways: 4, pitch_mm: 2.54, thickness_mm: 1, bend_static_mm: 9, bend_dynamic_mm: 12, flexing: true, basis: 'datasheet' });
    expect(ribbon.type.confidence).toBe('derived');
    const ffc = build({ kind: 'flat_flex', construction: 'ffc', ways: 6, pitch_mm: 0.5, thickness_mm: 0.3, bend_static_mm: 3, basis: 'datasheet' });
    expect(ffc.type.confidence).toBe('derived');
  });

  it("the user's basis when they entered the sizes and bend radii", () => {
    expect(build({ kind: 'wire', awg: 24, od_mm: 1.2, bend_static_mm: 8 }).type.confidence).toBe('measured');
    expect(build({ kind: 'wire', awg: 24, od_mm: 1.2, bend_static_mm: 8, basis: 'datasheet' }).type.confidence).toBe('datasheet');
    for (const construction of ['ffc', 'fpc'] as const) {
      const t = build({ kind: 'flat_flex', construction, ways: 6, pitch_mm: 0.5, thickness_mm: 0.2, width_mm: 4, bend_static_mm: 3, basis: 'datasheet' }).type;
      expect(t.confidence, construction).toBe('datasheet');
    }
  });
});

describe('a generated type carries its parameters', () => {
  const specs: Array<[string, CableSpecInput]> = [
    ['wire', { kind: 'wire', awg: 24, flexing: true }],
    ['wire with od and bends', { kind: 'wire', awg: 22, od_mm: 2, bend_static_mm: 12, bend_dynamic_mm: 20, basis: 'datasheet', note: 'mine' }],
    ['round cable', { kind: 'round_cable', family: 'usb', conductors: 4, od_mm: 5, awg: 28 }],
    ['ribbon', { kind: 'ribbon', ways: 10, pitch_mm: 1.27 }],
    ['ffc', { kind: 'flat_flex', construction: 'ffc', ways: 6, pitch_mm: 0.5 }],
    ['fpc', { kind: 'flat_flex', construction: 'fpc', ways: 8, pitch_mm: 0.5, thickness_mm: 0.12, layers: 2, flexing: true }],
  ];

  it.each(specs)('%s: rebuilding from type.spec gives the same type', (_n, input) => {
    const { type: t } = build(input, 'again');
    expect(t.spec).toBeDefined();
    expect(t.spec!.kind).toBe(input.kind);
    const again = build(t.spec!, 'again').type;
    expect(JSON.parse(JSON.stringify(again))).toEqual(JSON.parse(JSON.stringify(t)));
  });

  it('the parsed spec has the defaults filled in, and keeps what was entered', () => {
    const { type: t } = build({ kind: 'wire', awg: 24, od_mm: 1.4 });
    expect(t.spec).toMatchObject({ kind: 'wire', awg: 24, od_mm: 1.4, basis: 'measured', flexing: false, connectors: [], interfaces: [] });
    const f = build({ kind: 'flat_flex', construction: 'ffc', ways: 6, pitch_mm: 0.5 }).type;
    expect(f.spec).toMatchObject({ kind: 'flat_flex', layers: 1 });
  });

  it('a type with its spec passes CableTypeSchema and survives a design JSON round trip through parseDesign', () => {
    for (const [name, input] of specs) {
      const t = build(input, 'custom-rt').type;
      expect(CableTypeSchema.safeParse(t).success, name).toBe(true);
      const d = fullDesign();
      d.cable_types.push(t);
      d.cables[0]!.type = 'custom-rt';
      const r = parseDesign(JSON.parse(JSON.stringify(d)));
      expect(r.ok, name).toBe(true);
      if (r.ok) {
        expect(r.design.cable_types[0]).toEqual(t);
        expect(build(r.design.cable_types[0]!.spec!, 'custom-rt').type).toEqual(t);
      }
    }
  });

  it('parseCableLibrary refuses a bundled entry that has a spec', () => {
    const t = build({ kind: 'wire', awg: 24 }, 'x').type;
    const bundled = { ...t, custom: undefined };
    const yaml = JSON.stringify({ version: 1, cables: [bundled] });
    expect(() => parseCableLibrary(yaml)).toThrow(/cannot be marked custom or carry the user's parameters/);
  });
});

// ---------------------------------------------------------------- properties

describe('cableTypeFromSpec, always a sound type (property)', () => {
  const num = (lo: number, hi: number) => fc.double({ min: lo, max: hi, noNaN: true, noDefaultInfinity: true });
  const common = fc.record({
    flexing: fc.boolean(),
    basis: fc.constantFrom('datasheet', 'measured'),
    note: fc.option(fc.constantFrom('my note', 'from the maker'), { nil: undefined }),
    bendStatic: fc.option(num(1, 80), { nil: undefined }),
    bendExtra: fc.option(num(0, 80), { nil: undefined }),
  });
  const withBend = (c: { bendStatic?: number; bendExtra?: number }) => ({
    ...(c.bendStatic !== undefined ? { bend_static_mm: c.bendStatic } : {}),
    // a flexing radius is only entered with a static one, and never below it
    ...(c.bendStatic !== undefined && c.bendExtra !== undefined ? { bend_dynamic_mm: c.bendStatic + c.bendExtra } : {}),
  });
  // Every spec below is physically consistent: conductors fit inside the cable, thickness is under the pitch,
  // gauges are in the estimate range, and everything is inside the schema bounds.
  const specArb: fc.Arbitrary<CableSpecInput> = fc.oneof(
    fc.record({ c: common, awg: fc.integer({ min: 16, max: 30 }), od: fc.option(num(0, 1), { nil: undefined }), wall: fc.option(num(0.1, 0.8), { nil: undefined }) }).map(
      ({ c, awg, od, wall }) => ({
        kind: 'wire' as const,
        awg,
        flexing: c.flexing,
        basis: c.basis as 'datasheet',
        ...(c.note ? { note: c.note } : {}),
        ...(od !== undefined ? { od_mm: awgDiameterMm(awg) * 1.2 + 0.1 + od } : wall !== undefined ? { wall_mm: wall } : {}),
        ...withBend(c),
      }),
    ),
    fc.record({ c: common, family: fc.constantFrom('multicore', 'twisted_pair', 'coax', 'usb', 'ethernet'), n: fc.integer({ min: 1, max: 20 }), od: num(2.5, 12), awg: fc.option(fc.integer({ min: 26, max: 32 }), { nil: undefined }) }).map(
      ({ c, family, n, od, awg }) => ({
        kind: 'round_cable' as const,
        family: family as 'multicore',
        conductors: n,
        od_mm: od,
        flexing: c.flexing,
        basis: c.basis as 'datasheet',
        ...(awg !== undefined ? { awg } : {}),
        ...(c.note ? { note: c.note } : {}),
        ...withBend(c),
      }),
    ),
    fc.record({ c: common, ways: fc.integer({ min: 2, max: 60 }), pitch: fc.constantFrom(1.27, 2.54, 1.0), thick: fc.option(num(0.1, 0.9), { nil: undefined }) }).map(({ c, ways, pitch, thick }) => ({
      kind: 'ribbon' as const,
      ways,
      pitch_mm: pitch,
      // 1.27 mm ribbon may assume its thickness; the others must give it (and no more than the pitch)
      ...(thick !== undefined || pitch !== 1.27 ? { thickness_mm: Math.min(thick ?? 0.5, pitch) } : {}),
      flexing: c.flexing,
      basis: c.basis as 'datasheet',
      ...(c.note ? { note: c.note } : {}),
      ...withBend(c),
    })),
    fc
      .record({
        c: common,
        construction: fc.constantFrom('ffc', 'fpc'),
        ways: fc.integer({ min: 2, max: 60 }),
        pitch: fc.constantFrom(0.3, 0.5, 0.8, 1.0, 1.25),
        thick: fc.option(num(0.05, 0.4), { nil: undefined }),
        layers: fc.integer({ min: 1, max: 6 }),
        wide: fc.boolean(),
      })
      .map(({ c, construction, ways, pitch, thick, layers, wide }) => ({
        kind: 'flat_flex' as const,
        construction: construction as 'ffc' | 'fpc',
        ways,
        pitch_mm: pitch,
        ...(thick !== undefined || construction === 'fpc' ? { thickness_mm: thick ?? 0.12 } : {}),
        ...(wide ? { width_mm: ways * pitch * 1.1 + 1 } : {}),
        layers,
        flexing: c.flexing,
        basis: c.basis as 'datasheet',
        ...(c.note ? { note: c.note } : {}),
        ...withBend(c),
      })),
  );

  it('parses with CableTypeSchema, is custom, has no problems, and its note holds every derived sentence', () => {
    fc.assert(
      fc.property(specArb, (spec) => {
        const { type: t, derived } = build(spec, 'gen');
        expect(CableTypeSchema.safeParse(t).success).toBe(true);
        expect(t.custom).toBe(true);
        expect(t.id).toBe('gen');
        expect(cableTypeProblems(t)).toEqual([]);
        // the type carries its parameters, and building from them again gives the same type
        expect(t.spec).toBeDefined();
        expect(JSON.parse(JSON.stringify(build(t.spec!, 'gen').type))).toEqual(JSON.parse(JSON.stringify(t)));
        for (const sentence of derived) expect(t.note ?? '', sentence).toContain(sentence);
        if (t.min_bend_mm.dynamic !== undefined) expect(t.min_bend_mm.dynamic).toBeGreaterThanOrEqual(t.min_bend_mm.static);
        const s = spec as { bend_static_mm?: number; bend_dynamic_mm?: number };
        if (s.bend_static_mm !== undefined) expect(t.min_bend_mm.static).toBe(s.bend_static_mm);
        if (s.bend_dynamic_mm !== undefined) expect(t.min_bend_mm.dynamic).toBe(s.bend_dynamic_mm);
        if (s.bend_static_mm !== undefined && (s.bend_dynamic_mm !== undefined || !('flexing' in spec && spec.flexing))) {
          expect(derived.join(' ')).not.toMatch(/bend radius/i);
        }
        // derived sentences about a rule bend radius appear exactly when the user did not enter that figure
        expect(derived.some((x) => /^Bend radius /.test(x))).toBe(s.bend_static_mm === undefined);
      }),
      { numRuns: 400 },
    );
  });

  it('a rule flexing figure is never below the static one', () => {
    fc.assert(
      fc.property(specArb, (spec) => {
        const t = build({ ...spec, bend_dynamic_mm: undefined } as CableSpecInput).type;
        if (t.min_bend_mm.dynamic !== undefined) expect(t.min_bend_mm.dynamic).toBeGreaterThanOrEqual(t.min_bend_mm.static);
      }),
      { numRuns: 300 },
    );
  });

  it('a rule bend radius is never below the exact rule product, and less than 0.1 mm above it', () => {
    fc.assert(
      fc.property(specArb, (spec) => {
        const noUser = { ...spec, bend_static_mm: undefined, bend_dynamic_mm: undefined } as CableSpecInput;
        const { type: t } = build(noUser);
        // the exact product, worked out here from the constants and the inputs
        let exact: number;
        let exactDynamic: number | undefined;
        if (t.section.shape === 'round') {
          exact = ROUND_BEND_OVER_OD.static * t.section.od_mm;
          exactDynamic = ROUND_BEND_OVER_OD.dynamic * t.section.od_mm;
        } else if (spec.kind === 'flat_flex' && spec.construction === 'fpc') {
          const th = spec.thickness_mm!;
          const k = spec.layers === 1 ? FPC_BEND_OVER_THICKNESS.static.one_layer : spec.layers === 2 ? FPC_BEND_OVER_THICKNESS.static.two_layers : FPC_BEND_OVER_THICKNESS.static.multilayer;
          exact = k * th;
          exactDynamic = spec.layers === 1 ? FPC_BEND_OVER_THICKNESS.dynamic.one_layer * th : spec.layers === 2 ? FPC_BEND_OVER_THICKNESS.dynamic.two_layers * th : undefined;
        } else {
          const thicker = spec.kind === 'ribbon' ? ASSUMED_RIBBON_127_THICKNESS_MAX_MM : ASSUMED_FFC_THICKNESS_MAX_MM;
          exact = FLAT_BEND_OVER_THICKNESS * ((spec as { thickness_mm?: number }).thickness_mm ?? thicker);
        }
        expect(t.min_bend_mm.static).toBeGreaterThanOrEqual(exact - 1e-9);
        expect(t.min_bend_mm.static).toBeLessThan(exact + 0.1 + 1e-9);
        if (exactDynamic !== undefined && spec.flexing) {
          expect(t.min_bend_mm.dynamic!).toBeGreaterThanOrEqual(exactDynamic - 1e-9);
          expect(t.min_bend_mm.dynamic!).toBeLessThan(Math.max(exactDynamic, t.min_bend_mm.static) + 0.1 + 1e-9);
        }
      }),
      { numRuns: 500 },
    );
  });
});

// ---------------------------------------------------------------- the design file

describe('cable_types in a design', () => {
  const custom = (id = 'custom-fpc-8') => build({ kind: 'flat_flex', construction: 'fpc', ways: 8, pitch_mm: 0.5, thickness_mm: 0.12, width_mm: 5 }, id).type;
  const issues = (d: ReturnType<typeof fullDesign>) => validateDesign(d);
  const errors = (d: ReturnType<typeof fullDesign>) => issues(d).filter((i) => i.severity === 'error');
  const warnings = (d: ReturnType<typeof fullDesign>) => issues(d).filter((i) => i.severity === 'warning');

  it('defaults to empty', () => {
    expect(DesignSchema.parse({ schema: 1 }).cable_types).toEqual([]);
  });

  it('duplicate ids are an error at the second one', () => {
    const d = fullDesign();
    d.cable_types.push(custom(), custom());
    expect(errors(d).some((i) => i.path === 'cable_types[1].id' && /duplicate/.test(i.message))).toBe(true);
  });

  it('a type with a problem is an error at cable_types[i]', () => {
    const d = fullDesign();
    d.cable_types.push(custom(), { ...custom('custom-bad'), min_bend_mm: { static: 10, dynamic: 5 } });
    const e = errors(d);
    expect(e.map((i) => i.path)).toEqual(['cable_types[1]']);
    expect(e[0]!.message).toMatch(/dynamic bend radius/);
  });

  it('a derived type with no note is an error at cable_types[i].note', () => {
    const d = fullDesign();
    const t = custom();
    delete t.note;
    d.cable_types.push({ ...t, confidence: 'derived' });
    expect(errors(d).map((i) => i.path)).toEqual(['cable_types[0].note']);
    d.cable_types[0] = { ...t, confidence: 'derived', note: 'worked out by rule' };
    expect(errors(d)).toEqual([]);
    d.cable_types[0] = { ...t, confidence: 'generic' };
    expect(errors(d)).toEqual([]);
  });

  it('a type not marked custom gives a warning at cable_types[i].id', () => {
    const d = fullDesign();
    const t = { ...custom() };
    delete t.custom;
    d.cable_types.push(t);
    const w = warnings(d).filter((i) => i.path === 'cable_types[0].id');
    expect(w).toHaveLength(1);
    expect(w[0]!.message).toMatch(/used in place of any library cable with the same id/);
    expect(errors(d)).toEqual([]);
    d.cable_types[0] = custom();
    expect(warnings(d).filter((i) => i.path === 'cable_types[0].id')).toEqual([]);
  });

  it('a cable whose type starts with custom- must find it in cable_types', () => {
    const d = fullDesign();
    d.cables[0]!.type = 'custom-fpc-8';
    const e = errors(d);
    expect(e).toHaveLength(1);
    expect(e[0]!.path).toBe('cables[0].type');
    expect(e[0]!.message).toMatch(/custom-fpc-8/);
    d.cable_types.push(custom('custom-fpc-8'));
    expect(errors(d)).toEqual([]);
    d.cables[0]!.type = 'lib:not-custom';
    expect(errors(d)).toEqual([]);
  });

  it('a design that uses a custom type round-trips through JSON and parseDesign', () => {
    const d = fullDesign();
    d.cable_types.push(custom());
    d.cables[0]!.type = 'custom-fpc-8';
    const raw = JSON.parse(JSON.stringify(d));
    const r = parseDesign(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.design.cable_types[0]).toEqual(d.cable_types[0]);
      expect(r.design.cable_types[0]!.custom).toBe(true);
      expect(resolveCableType(r.design, library, 'custom-fpc-8')!.id).toBe('custom-fpc-8');
    }
  });

  it('a bundled library cannot mark an entry custom', () => {
    const yaml = readText('library/cables.yaml');
    const text = yaml.replace('confidence: generic', 'confidence: generic\n    custom: true');
    expect(() => parseCableLibrary(text)).toThrow(/cannot be marked custom/);
  });
});

// ---------------------------------------------------------------- ties to the existing size and fit code

describe('generated types in cableEnvelope and cableFit', () => {
  const one = { count: 1, twisted: false, sleeve_wall_mm: 0 };

  it('a generated FPC with its width entered: width, thickness and bend as asked, bend_source derived', () => {
    const { type: t } = build({ kind: 'flat_flex', construction: 'fpc', ways: 8, pitch_mm: 0.5, thickness_mm: 0.12, width_mm: 4.5, layers: 1 });
    const e = cableEnvelope(t, one);
    expect(e.shape).toBe('flat');
    expect(e.width_mm).toBeCloseTo(4.5, 9);
    expect(e.height_mm).toBeCloseTo(0.12, 9);
    expect(e.bend_static_mm).toBeCloseTo(1.2, 9); // 10 x 0.12
    expect(e.bend_source).toBe('derived');
    expect(e.length_factor).toBe(1);
  });

  it('a generated FPC without a width has the standard tail width and bend_source generic', () => {
    const { type: t } = build({ kind: 'flat_flex', construction: 'fpc', ways: 8, pitch_mm: 0.5, thickness_mm: 0.12 });
    const e = cableEnvelope(t, one);
    expect(e.width_mm).toBeCloseTo(4.5, 9); // (8 + 1) x 0.5
    expect(e.bend_static_mm).toBeCloseTo(1.2, 9);
    expect(e.bend_source).toBe('generic');
  });

  it('a generated wire has its diameter as width and height and the rule bend radius', () => {
    const { type: t } = build({ kind: 'wire', awg: 22, od_mm: 1.8, flexing: true });
    const e = cableEnvelope(t, one);
    expect(e.width_mm).toBeCloseTo(1.8, 9);
    expect(e.height_mm).toBeCloseTo(1.8, 9);
    expect(e.bend_static_mm).toBeCloseTo(14.4, 9); // 8 x 1.8
    expect(e.bend_dynamic_mm).toBeCloseTo(21.6, 9); // 12 x 1.8
  });

  describe('a generated 0.5 mm pitch FPC and the flat flex connectors', () => {
    const ways = 12;
    const { type: t } = build({ kind: 'flat_flex', construction: 'fpc', ways, pitch_mm: 0.5, thickness_mm: 0.12 });
    const c = (id: string) => findConnector(connectors, id)!;

    it('fits an ffc-0.5 port of the same ways', () => {
      const r = cableFit(c('ffc-0.5'), ways, t, 1);
      expect(r.problems).toEqual([]);
      expect(r.fits).toBe(true);
    });

    it('is refused at a different number of ways', () => {
      const r = cableFit(c('ffc-0.5'), ways + 2, t, 1);
      expect(r.fits).toBe(false);
      expect(r.problems.join(' ')).toMatch(/12-way cable in a 14-way connector/);
    });

    it('is refused at ffc-1.0 (different pitch)', () => {
      const r = cableFit(c('ffc-1.0'), ways, t, 1);
      expect(r.fits).toBe(false);
      expect(r.problems.join(' ')).toMatch(/pitch/i);
    });
  });
});
