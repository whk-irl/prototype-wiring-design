import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { cableFit, CableTypeSchema, connectorBoxes, ConnectorSchema, contactOffsets, portProblem, portWays } from '@core';

fc.configureGlobal({ seed: 20261121 });

const num = (lo: number, hi: number) => fc.double({ min: lo, max: hi, noNaN: true, noDefaultInfinity: true });
const opt = <T>(a: fc.Arbitrary<T>) => fc.option(a, { nil: undefined });
const families = ['hookup_wire', 'jumper', 'ribbon', 'ffc', 'multicore', 'twisted_pair', 'coax', 'usb', 'ethernet', 'harness'] as const;

const acceptArb = fc
  .record({
    families: fc.uniqueArray(fc.constantFrom(...families), { minLength: 1, maxLength: 4 }),
    termination: fc.constantFrom('per_contact', 'whole'),
    awg: opt(fc.tuple(fc.integer({ min: 10, max: 30 }), fc.integer({ min: 0, max: 14 })).map(([a, d]) => ({ thickest: a, thinnest: a + d }))),
    od_max_mm: opt(num(0.3, 12)),
    cable_pitch_mm: opt(num(0.3, 3)),
  })
  .map((a) => ({ ...a, ...(a.awg ? {} : { awg: undefined }) }));

const connectorArb = fc
  .record({
    rows: fc.integer({ min: 1, max: 3 }),
    per: fc.tuple(fc.integer({ min: 1, max: 10 }), fc.integer({ min: 0, max: 20 })),
    pitch_mm: opt(num(0.5, 5)),
    accepts: fc.array(acceptArb, { maxLength: 3 }),
  })
  .map((r) =>
    ConnectorSchema.parse({
      id: 'c',
      name: 'Connector',
      rows: r.rows,
      ways: { min: r.per[0]! * r.rows, max: (r.per[0]! + r.per[1]!) * r.rows },
      ...(r.pitch_mm !== undefined ? { pitch_mm: r.pitch_mm } : {}),
      accepts: r.accepts.map((a) => Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined))),
      confidence: 'generic',
    }),
  );

const cableArb = fc
  .record({
    family: fc.constantFrom(...families),
    flatShape: fc.boolean(),
    od: num(0.2, 10),
    conductors: fc.integer({ min: 1, max: 20 }),
    awg: opt(fc.integer({ min: 8, max: 36 })),
    pitch: opt(num(0.3, 3)),
  })
  .map((r) =>
    CableTypeSchema.parse({
      id: 't',
      name: 't',
      family: r.family,
      section: r.flatShape ? { shape: 'flat', width_mm: r.od * 3, thickness_mm: r.od / 5 } : { shape: 'round', od_mm: r.od },
      conductors: r.conductors,
      ...(r.awg !== undefined ? { awg: r.awg } : {}),
      ...(r.pitch !== undefined ? { pitch_mm: r.pitch } : {}),
      min_bend_mm: { static: 5 },
      flex: 'flexible',
      confidence: 'generic',
    }),
  );

describe('contactOffsets', () => {
  it('is centred on the origin and has one entry per way when the ways divide over the rows', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 4 }), fc.integer({ min: 1, max: 12 }), num(0.3, 6), (rows, perRow, pitch) => {
        const c = ConnectorSchema.parse({ id: 'c', name: 'c', rows, pitch_mm: pitch, ways: { min: rows, max: rows * 40 }, confidence: 'generic' });
        const ways = rows * perRow;
        const o = contactOffsets(c, ways);
        expect(o).toHaveLength(ways);
        const sum = o.reduce((s, p) => [s[0] + p[0], s[1] + p[1], s[2] + p[2]], [0, 0, 0]);
        for (const v of sum) expect(Math.abs(v)).toBeLessThan(1e-9 * (1 + ways * pitch));
        for (const p of o) expect(p[0]).toBe(0);
        // row spacing and in-row spacing are the pitch
        if (perRow > 1) expect(o[1]![1] - o[0]![1]).toBeCloseTo(pitch, 9);
        if (rows > 1) expect(o[perRow]![2] - o[0]![2]).toBeCloseTo(pitch, 9);
      }),
    );
  });
});

describe('cableFit', () => {
  const waysArb = opt(fc.integer({ min: 1, max: 60 }));

  it('never throws, and fits exactly when there are no problems', () => {
    fc.assert(
      fc.property(connectorArb, cableArb, waysArb, fc.integer({ min: 1, max: 12 }), (c, t, ways, count) => {
        const r = cableFit(c, ways, t, count);
        expect(r.fits).toBe(r.problems.length === 0);
        for (const s of [...r.problems, ...r.notes]) expect(typeof s).toBe('string');
        for (const p of r.problems) expect(p).not.toMatch(/NaN|undefined/);
      }),
      { numRuns: 1000 },
    );
  });

  it('a connector with no recorded accepts fits everything', () => {
    fc.assert(
      fc.property(connectorArb, cableArb, waysArb, fc.integer({ min: 1, max: 12 }), (c, t, ways, count) => {
        const bare = ConnectorSchema.parse({ ...c, accepts: [] });
        expect(cableFit(bare, ways, t, count).fits).toBe(true);
      }),
    );
  });

  it('adding wires never turns a misfit into a fit', () => {
    fc.assert(
      fc.property(connectorArb, cableArb, waysArb, fc.integer({ min: 1, max: 12 }), fc.integer({ min: 1, max: 6 }), (c, t, ways, count, more) => {
        if (!cableFit(c, ways, t, count).fits) expect(cableFit(c, ways, t, count + more).fits).toBe(false);
      }),
      { numRuns: 1000 },
    );
  });

  it('with per-contact termination, one wire more than the contacts is always a misfit', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 30 }), fc.integer({ min: 1, max: 5 }), (ways, conductors) => {
        const c = ConnectorSchema.parse({
          id: 'c',
          name: 'c',
          ways: { min: 1, max: 60 },
          accepts: [{ families: ['multicore'], termination: 'per_contact' }],
          confidence: 'generic',
        });
        const t = CableTypeSchema.parse({ id: 't', name: 't', family: 'multicore', section: { shape: 'round', od_mm: 3 }, conductors, min_bend_mm: { static: 5 }, flex: 'flexible', confidence: 'generic' });
        const count = Math.floor(ways / conductors) + 1;
        fc.pre(conductors * count > ways);
        expect(cableFit(c, ways, t, count).fits).toBe(false);
        expect(cableFit(c, ways, t, Math.floor(ways / conductors) || 1).fits).toBe(conductors <= ways);
      }),
    );
  });
});

describe('boxes, ways and port problems', () => {
  it('portProblem is undefined exactly for ways inside the range that divide over the rows', () => {
    fc.assert(
      fc.property(connectorArb, fc.integer({ min: 0, max: 100 }), (c, ways) => {
        const problem = portProblem(c, { connector: c.id, ways });
        const ok = ways >= c.ways.min && ways <= c.ways.max && ways % c.rows === 0;
        expect(problem === undefined).toBe(ok);
        if (ok) expect(portWays(c, { ways })).toBe(ways);
      }),
      { numRuns: 500 },
    );
  });

  it('box widths never decrease as ways are added', () => {
    fc.assert(
      fc.property(num(0, 2), num(0, 10), fc.integer({ min: 1, max: 30 }), (per, plus, n) => {
        const c = ConnectorSchema.parse({ id: 'c', name: 'c', ways: { min: 1, max: 100 }, housing: { length_mm: 5, height_mm: 4, width: { per_way_mm: per, plus_mm: plus } }, confidence: 'generic' });
        const a = connectorBoxes(c, n).housing![1];
        const b = connectorBoxes(c, n + 1).housing![1];
        expect(b).toBeGreaterThanOrEqual(a);
      }),
    );
  });
});
