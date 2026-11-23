// What the connector functions mean, table by table.
import { describe, expect, it } from 'vitest';
import {
  acceptedFamilies,
  cableFit,
  CableTypeSchema,
  connectorBoxes,
  ConnectorSchema,
  contactOffsets,
  findConnector,
  parseConnectorLibrary,
  portProblem,
  portWays,
  type Accept,
  type CableType,
  type Connector,
} from '@core';

const conn = (over: Record<string, unknown> = {}): Connector =>
  ConnectorSchema.parse({ id: 'c', name: 'Test connector', pitch_mm: 2.54, ways: { min: 2, max: 10 }, confidence: 'generic', ...over });

const cable = (over: Record<string, unknown> = {}): CableType =>
  CableTypeSchema.parse({
    id: 'w',
    name: 'w',
    family: 'hookup_wire',
    section: { shape: 'round', od_mm: 1.3 },
    conductors: 1,
    awg: 26,
    min_bend_mm: { static: 5 },
    flex: 'flexible',
    confidence: 'generic',
    ...over,
  });

const perContact = (over: Partial<Accept> = {}) => ({ families: ['hookup_wire', 'jumper'], termination: 'per_contact', awg: { thickest: 22, thinnest: 28 }, od_max_mm: 1.6, ...over });
const whole = (over: Partial<Accept> = {}) => ({ families: ['ffc', 'usb'], termination: 'whole', ...over });
const flat = (conductors: number, pitch?: number) =>
  cable({ family: 'ffc', section: { shape: 'flat', width_mm: 16, thickness_mm: 0.3 }, conductors, awg: undefined, ...(pitch !== undefined ? { pitch_mm: pitch } : {}) });

describe('cableFit, per-contact termination', () => {
  const c = conn({ accepts: [perContact()] });

  it.each([
    ['more wires than contacts', 5, 4, false, /5 conductors for 4 contacts/],
    ['one wire too many', 5, 4, false, /5 conductors for 4 contacts/],
    ['equal', 4, 4, true, undefined],
    ['fewer', 3, 4, true, undefined],
  ])('%s', (_n, count, ways, fits, problem) => {
    const r = cableFit(c, ways, cable(), count);
    expect(r.fits).toBe(fits);
    if (problem) expect(r.problems.join(' ')).toMatch(problem);
    else expect(r.problems).toEqual([]);
  });

  it('says how many contacts are used when there are spare ones, and nothing when all are', () => {
    expect(cableFit(c, 4, cable(), 3).notes).toContain('3 of 4 contacts used.');
    expect(cableFit(c, 4, cable(), 4).notes).toEqual([]);
  });

  it('says so when the number of contacts is not known, and does not check the count', () => {
    const r = cableFit(c, undefined, cable(), 50);
    expect(r.fits).toBe(true);
    expect(r.notes.join(' ')).toMatch(/not recorded/);
  });

  it('uses the singular for one contact, and counts conductors times cables', () => {
    expect(cableFit(c, 1, cable({ conductors: 2, awg: 26 }), 1).problems).toEqual(['2 conductors for 1 contact.']);
    expect(cableFit(c, 5, cable({ family: 'jumper', conductors: 3 }), 2).problems).toEqual(['6 conductors for 5 contacts.']);
  });

  it.each([
    ['thicker', 20, false, /20 AWG is thicker than the contacts take \(22 to 28 AWG\)/],
    ['thinner', 30, false, /30 AWG is thinner than the contacts take \(22 to 28 AWG\)/],
    ['thickest allowed', 22, true, undefined],
    ['thinnest allowed', 28, true, undefined],
    ['inside', 26, true, undefined],
  ])('gauge %s', (_n, awg, fits, problem) => {
    const r = cableFit(c, 4, cable({ awg }), 1);
    expect(r.fits).toBe(fits);
    if (problem) expect(r.problems[0]).toMatch(problem);
  });

  it('a cable type with no gauge fits with a note, and a connector with no gauge range does not look', () => {
    const r = cableFit(c, 4, cable({ awg: undefined }), 1);
    expect(r.fits).toBe(true);
    expect(r.notes.join(' ')).toMatch(/no gauge recorded/);
    const open = conn({ accepts: [perContact({ awg: undefined })] });
    expect(cableFit(open, 1, cable({ awg: 10 }), 1)).toEqual({ fits: true, problems: [], notes: [] });
  });

  it.each([
    [2.0, false],
    [1.6, true],
    [1.6 + 1e-10, true],
    [1.61, false],
  ])('single wire of insulation %d mm against od_max 1.6', (od, fits) => {
    const r = cableFit(c, 4, cable({ section: { shape: 'round', od_mm: od } }), 1);
    expect(r.fits).toBe(fits);
    if (!fits) expect(r.problems[0]).toMatch(/wider than the housing takes \(1\.6 mm\)/);
  });

  it('od_max is for single wires only: a multi-conductor cable is not judged on it', () => {
    const r = cableFit(c, 6, cable({ family: 'jumper', conductors: 2, section: { shape: 'round', od_mm: 5 } }), 1);
    expect(r.problems).toEqual([]);
  });

  it('appends the accept note', () => {
    const n = conn({ accepts: [perContact({ note: 'Crimp contacts only.' })] });
    expect(cableFit(n, 4, cable(), 4).notes).toContain('Crimp contacts only.');
  });
});

describe('cableFit, whole-cable termination', () => {
  const c = conn({ pitch_mm: 1, ways: { min: 4, max: 40 }, accepts: [whole({ od_max_mm: 6 })] });

  it('takes one cable, not several', () => {
    expect(cableFit(c, 10, flat(10, 1), 1).fits).toBe(true);
    const r = cableFit(c, 10, flat(10, 1), 2);
    expect(r.fits).toBe(false);
    expect(r.problems).toContain('One cable goes into this connector, not 2.');
  });

  it('a flat cable must have as many conductors as the connector has ways', () => {
    const r = cableFit(c, 10, flat(15, 1), 1);
    expect(r.problems).toEqual(['A 15-way cable in a 10-way connector.']);
    expect(cableFit(c, 10, flat(10, 1), 1).fits).toBe(true);
    expect(cableFit(c, undefined, flat(15, 1), 1).fits).toBe(true);
  });

  it('judges the cable pitch against the connector pitch', () => {
    expect(cableFit(c, 10, flat(10, 1.0), 1).fits).toBe(true);
    expect(cableFit(c, 10, flat(10, 1.005), 1).fits).toBe(true);
    const r = cableFit(c, 10, flat(10, 1.27), 1);
    expect(r.fits).toBe(false);
    expect(r.problems[0]).toMatch(/Cable pitch 1\.27 mm; the connector takes 1 mm/);
  });

  it('a cable type with no pitch fits with a note', () => {
    const r = cableFit(c, 10, flat(10), 1);
    expect(r.fits).toBe(true);
    expect(r.notes.join(' ')).toMatch(/no pitch recorded/);
  });

  it('cable_pitch_mm overrides the connector pitch', () => {
    const two = conn({ pitch_mm: 2.54, rows: 2, ways: { min: 4, max: 40 }, accepts: [whole({ cable_pitch_mm: 1.27 })] });
    expect(cableFit(two, 10, flat(10, 1.27), 1).fits).toBe(true);
    const r = cableFit(two, 10, flat(10, 2.54), 1);
    expect(r.fits).toBe(false);
    expect(r.problems[0]).toMatch(/the connector takes 1\.27 mm/);
  });

  it('no pitch anywhere means no pitch check', () => {
    const none = conn({ pitch_mm: undefined, accepts: [whole()] });
    expect(cableFit(none, 10, flat(10, 7), 1)).toEqual({ fits: true, problems: [], notes: [] });
  });

  it('a round cable is judged on its width', () => {
    const usb = (od: number) => cable({ family: 'usb', section: { shape: 'round', od_mm: od }, conductors: 4, awg: undefined });
    expect(cableFit(c, 10, usb(7), 1).problems[0]).toMatch(/The cable is 7 mm across; the connector takes up to 6 mm/);
    expect(cableFit(c, 10, usb(6), 1).fits).toBe(true);
    expect(cableFit(c, 10, usb(6 + 1e-10), 1).fits).toBe(true);
    // the number of conductors of a round cable is not compared with the ways
    expect(cableFit(c, 10, usb(4), 1).fits).toBe(true);
  });
});

describe('cableFit, which cables and which entry', () => {
  it('refuses a family it does not take and says what it does take', () => {
    const c = conn({ accepts: [perContact()] });
    const r = cableFit(c, 4, cable({ family: 'coax' }), 1);
    expect(r.fits).toBe(false);
    expect(r.notes).toEqual([]);
    expect(r.problems).toEqual(['Test connector does not take coaxial cable. It takes single wires or jumper wires.']);
  });

  it('a connector that records nothing about what it takes fits everything, with a note', () => {
    const c = conn();
    const r = cableFit(c, 4, cable({ family: 'ethernet' }), 99);
    expect(r.fits).toBe(true);
    expect(r.problems).toEqual([]);
    expect(r.notes.join(' ')).toMatch(/Test connector/);
    expect(r.notes.join(' ')).toMatch(/not checked/);
  });

  it('judges the better of two matching entries', () => {
    const c = conn({
      accepts: [perContact({ awg: { thickest: 22, thinnest: 28 } }), perContact({ awg: { thickest: 14, thinnest: 20 } })],
    });
    expect(cableFit(c, 4, cable({ awg: 26 }), 1).fits).toBe(true);
    expect(cableFit(c, 4, cable({ awg: 18 }), 1).fits).toBe(true);
    // fits neither: reported against exactly one entry
    const r = cableFit(c, 4, cable({ awg: 32 }), 1);
    expect(r.fits).toBe(false);
    expect(r.problems).toHaveLength(1);
  });

  it('prefers the entry with fewer problems', () => {
    const c = conn({
      accepts: [perContact({ awg: { thickest: 22, thinnest: 28 }, od_max_mm: 1 }), perContact({ awg: { thickest: 22, thinnest: 28 }, od_max_mm: 1.2 })],
    });
    // 1.3 mm wire: too wide for both; each entry has one problem
    expect(cableFit(c, 4, cable(), 1).problems).toHaveLength(1);
    // a wire of 20 AWG and 1.3 mm: two problems for the first entry, two for the second: still two
    const d = conn({
      accepts: [perContact({ awg: { thickest: 22, thinnest: 28 }, od_max_mm: 1 }), perContact({ awg: { thickest: 18, thinnest: 28 }, od_max_mm: 1 })],
    });
    expect(cableFit(d, 4, cable({ awg: 20 }), 1).problems).toHaveLength(1);
  });

  it('only entries listing the cable family are considered', () => {
    const c = conn({ accepts: [perContact({ families: ['jumper'] }), whole({ families: ['hookup_wire'], od_max_mm: 5 })] });
    // hookup_wire matches only the whole entry: judged as one cable
    expect(cableFit(c, 4, cable(), 2).problems).toContain('One cable goes into this connector, not 2.');
  });
});

describe('acceptedFamilies', () => {
  it('lists the families in words, once each', () => {
    expect(acceptedFamilies(conn())).toBe('');
    expect(acceptedFamilies(conn({ accepts: [perContact({ families: ['hookup_wire'] })] }))).toBe('single wires');
    expect(acceptedFamilies(conn({ accepts: [perContact()] }))).toBe('single wires or jumper wires');
    expect(acceptedFamilies(conn({ accepts: [perContact({ families: ['hookup_wire', 'jumper'] }), whole({ families: ['ffc', 'jumper'] })] }))).toBe('single wires, jumper wires or flat flex cable');
  });
});

describe('connectorBoxes', () => {
  const housing = { length_mm: 6, height_mm: 4.5, width: { per_way_mm: 1, plus_mm: 3 } };
  const plug = { length_mm: 10, height_mm: 5, width: { per_way_mm: 1.25, plus_mm: 2 } };

  it('one row: width grows with the number of ways', () => {
    const b = connectorBoxes(conn({ housing, plug }), 4);
    expect(b.housing).toEqual([6, 7, 4.5]);
    expect(b.plug).toEqual([10, 7, 5]);
  });

  it('two rows: the width follows the contacts in one row', () => {
    const b = connectorBoxes(conn({ rows: 2, housing, plug, ways: { min: 4, max: 40 } }), 10);
    expect(b.housing).toEqual([6, 5 + 3, 4.5]);
    expect(b.plug![1]).toBeCloseTo(5 * 1.25 + 2, 12);
  });

  it('a box that is not described is absent, and per_way_mm defaults to 0', () => {
    expect(connectorBoxes(conn(), 4)).toEqual({});
    const only = connectorBoxes(conn({ housing: { length_mm: 5, height_mm: 3, width: { plus_mm: 9 } } }), 8);
    expect(only).toEqual({ housing: [5, 9, 3] });
    expect('plug' in only).toBe(false);
  });
});

describe('contactOffsets', () => {
  it('one row: centred on the origin, along y, at the pitch', () => {
    const o = contactOffsets(conn({ ways: { min: 4, max: 4 } }), 4);
    expect(o).toHaveLength(4);
    [-3.81, -1.27, 1.27, 3.81].forEach((y, i) => {
      expect(o[i]![0]).toBe(0);
      expect(o[i]![1]).toBeCloseTo(y, 12);
      expect(o[i]![2]).toBeCloseTo(0, 12);
    });
  });

  it('two rows: row by row, each from -y to +y, rows stacked along z', () => {
    const o = contactOffsets(conn({ rows: 2, ways: { min: 2, max: 40 } }), 6);
    expect(o).toHaveLength(6);
    const expectedY = [-2.54, 0, 2.54, -2.54, 0, 2.54];
    const expectedZ = [-1.27, -1.27, -1.27, 1.27, 1.27, 1.27];
    o.forEach((p, i) => {
      expect(p[0]).toBe(0);
      expect(p[1]).toBeCloseTo(expectedY[i]!, 12);
      expect(p[2]).toBeCloseTo(expectedZ[i]!, 12);
    });
  });

  it('a single contact is at the origin', () => {
    const o = contactOffsets(conn({ ways: { min: 1, max: 1 } }), 1);
    expect(o).toHaveLength(1);
    expect(o[0]!.map((v) => Math.abs(v))).toEqual([0, 0, 0]);
  });

  it('is empty when the family has no pitch', () => {
    expect(contactOffsets(conn({ pitch_mm: undefined }), 4)).toEqual([]);
  });
});

describe('portWays and portProblem', () => {
  const single = conn({ id: 'usb-c', name: 'USB-C', ways: { min: 24, max: 24 }, pitch_mm: undefined });
  const ranged = conn({ id: 'jst-sh', name: 'JST SH', ways: { min: 2, max: 20 } });
  const dual = conn({ id: 'hdr', name: 'Header', rows: 2, ways: { min: 4, max: 40 } });

  it('portWays: the port figure, else the family one when it has only one size', () => {
    expect(portWays(single, {})).toBe(24);
    expect(portWays(ranged, {})).toBeUndefined();
    expect(portWays(ranged, { ways: 4 })).toBe(4);
    expect(portWays(single, { ways: 12 })).toBe(12);
  });

  it.each([
    ['unknown connector', undefined, { connector: 'nope' }, /connector "nope" is not in the connector library/],
    ['ranged family without ways', ranged, { connector: 'jst-sh' }, /comes in 2 to 20 ways: the port must say how many/],
    ['ranged family, too few', ranged, { connector: 'jst-sh', ways: 1 }, /comes in 2 to 20 ways, not 1/],
    ['ranged family, too many', ranged, { connector: 'jst-sh', ways: 25 }, /comes in 2 to 20 ways, not 25/],
    ['single size, wrong figure', single, { connector: 'usb-c', ways: 12 }, /has 24 ways, not 12/],
    ['ways not divisible by rows', dual, { connector: 'hdr', ways: 7 }, /7 ways do not divide evenly over the 2 rows of connector "hdr"/],
  ])('portProblem: %s', (_n, connector, port, message) => {
    expect(portProblem(connector, port)).toMatch(message);
  });

  it.each([
    [ranged, { connector: 'jst-sh', ways: 2 }],
    [ranged, { connector: 'jst-sh', ways: 20 }],
    [ranged, { connector: 'jst-sh', ways: 8 }],
    [single, { connector: 'usb-c' }],
    [single, { connector: 'usb-c', ways: 24 }],
    [dual, { connector: 'hdr', ways: 10 }],
  ])('portProblem: a valid port gives undefined', (connector, port) => {
    expect(portProblem(connector, port)).toBeUndefined();
  });

  it('findConnector finds by id', () => {
    const lib = parseConnectorLibrary('version: 1\nconnectors:\n  - { id: a, name: A, ways: { min: 2, max: 2 }, confidence: generic }\n');
    expect(findConnector(lib, 'a')?.name).toBe('A');
    expect(findConnector(lib, 'b')).toBeUndefined();
  });
});

describe('parseConnectorLibrary', () => {
  const entry = (extra = '', id = 'a') => `  - id: ${id}\n    name: A\n    ways: { min: 2, max: 8 }\n    confidence: generic\n${extra}`;
  const lib = (...entries: string[]) => `version: 1\nconnectors:\n${entries.join('')}`;

  it('accepts a minimal library and fills defaults', () => {
    const l = parseConnectorLibrary(lib(entry()));
    expect(l.connectors[0]).toMatchObject({ rows: 1, aliases: [], accepts: [] });
    expect(parseConnectorLibrary('version: 1\nconnectors: []\n').connectors).toEqual([]);
  });

  const bad: Array<[string, string, RegExp]> = [
    ['duplicate id', lib(entry('', 'a'), entry('', 'a')), /duplicate connector id "a"/],
    ['min above max', lib(entry().replace('min: 2, max: 8', 'min: 9, max: 8')), /ways.min is larger than ways.max/],
    ['min not divisible by rows', lib(entry('    rows: 2\n').replace('min: 2, max: 8', 'min: 3, max: 8')), /divide evenly over its 2 rows/],
    ['max not divisible by rows', lib(entry('    rows: 2\n').replace('min: 2, max: 8', 'min: 2, max: 9')), /divide evenly over its 2 rows/],
    ['datasheet without source', lib(entry().replace('generic', 'datasheet')), /needs a source/],
    ['derived without source', lib(entry().replace('generic', 'derived')), /needs a source/],
    ['thickest above thinnest', lib(entry('    accepts:\n      - { families: [hookup_wire], termination: per_contact, awg: { thickest: 30, thinnest: 22 } }\n')), /thickest must be the smaller AWG number/],
    ['unknown key', lib(entry('    colour: red\n')), /./],
    ['bad version', lib(entry()).replace('version: 1', 'version: 2'), /./],
    ['zero pitch', lib(entry('    pitch_mm: 0\n')), /./],
    ['zero ways', lib(entry().replace('min: 2', 'min: 0')), /./],
    ['empty family list', lib(entry('    accepts:\n      - { families: [], termination: whole }\n')), /./],
    ['unknown termination', lib(entry('    accepts:\n      - { families: [ffc], termination: glued }\n')), /./],
    ['unknown family', lib(entry('    accepts:\n      - { families: [rope], termination: whole }\n')), /./],
    ['zero od_max', lib(entry('    accepts:\n      - { families: [ffc], termination: whole, od_max_mm: 0 }\n')), /./],
  ];
  it.each(bad)('throws for %s', (_n, yaml, message) => {
    expect(() => parseConnectorLibrary(yaml)).toThrow(message);
  });

  it('accepts a datasheet entry with a source, and thickest equal to thinnest', () => {
    expect(() => parseConnectorLibrary(lib(entry('    source: https://example.com\n').replace('generic', 'datasheet')))).not.toThrow();
    expect(() => parseConnectorLibrary(lib(entry('    accepts:\n      - { families: [hookup_wire], termination: per_contact, awg: { thickest: 26, thinnest: 26 } }\n')))).not.toThrow();
  });
});
