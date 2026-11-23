// cableStiffness: lay length and the estimated sag length. Expected figures are worked out by hand
// from the rules in the header of src/core/stiffness.ts, not taken from the function's output.
import { describe, expect, it } from 'vitest';
import { awgDiameterMm, cableEnvelope, cableStiffness, CableTypeSchema, parseCableLibrary, type CableBuild, type CableEnvelope, type CableType } from '@core';
import { readText } from './helpers';

const wire = (over: Record<string, unknown> = {}): CableType =>
  CableTypeSchema.parse({
    id: 'w',
    name: 'w',
    family: 'hookup_wire',
    section: { shape: 'round', od_mm: 1.56 },
    conductors: 1,
    awg: 22,
    min_bend_mm: { static: 12.5 },
    flex: 'flexible',
    confidence: 'generic',
    ...over,
  });
const one: CableBuild = { count: 1, twisted: false, sleeve_wall_mm: 0 };
const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);
const stiff = (t: CableType, b: CableBuild = one) => cableStiffness(t, b, cableEnvelope(t, b));

describe('lay length', () => {
  it('is 1.6 x the envelope static bend limit', () => {
    const t = wire();
    const env = cableEnvelope(t, one);
    expect(env.bend_static_mm).toBeCloseTo(12.5, 9);
    // 1.6 x 12.5 = 20
    expect(cableStiffness(t, one, env).lay_length_mm).toBeCloseTo(20, 9);
  });

  it('uses the envelope of the bundle: 1.6 x its (larger) bend limit', () => {
    const t = wire();
    const b: CableBuild = { count: 3, twisted: false, sleeve_wall_mm: 0 };
    const env = cableEnvelope(t, b);
    expect(cableStiffness(t, b, env).lay_length_mm).toBeCloseTo(1.6 * env.bend_static_mm, 9);
    expect(env.bend_static_mm).toBeGreaterThan(12.5);
  });

  it('is 4 x height x 1.6 when there is no bend limit', () => {
    const env: CableEnvelope = { shape: 'round', width_mm: 2, height_mm: 2, bend_static_mm: 0, length_factor: 1, area_mm2: 3, bend_source: 'generic', notes: [] };
    // 4 x 2 x 1.6 = 12.8
    expect(cableStiffness(wire(), one, env).lay_length_mm).toBeCloseTo(12.8, 9);
  });

  it('always has a note about how the wire is laid', () => {
    expect(stiff(wire()).notes[0]).toMatch(/laid snug/);
  });
});

describe('no sag length', () => {
  it('for a flat cable, with a note saying why', () => {
    const t = CableTypeSchema.parse({ id: 'f', name: 'f', family: 'ffc', section: { shape: 'flat', width_mm: 5, thickness_mm: 0.3 }, conductors: 4, min_bend_mm: { static: 2.4 }, flex: 'flexible', confidence: 'generic' });
    const s = stiff(t);
    expect(s.sag_length_mm).toBeUndefined();
    expect(s.stiffness_nmm2).toBeUndefined();
    expect(s.weight_n_per_mm).toBeUndefined();
    expect(s.notes.join(' ')).toMatch(/flat cable/);
    expect(s.lay_length_mm).toBeCloseTo(1.6 * 2.4, 9);
  });

  it('for a round cable with no gauge, with a note saying why', () => {
    const s = stiff(wire({ awg: undefined }));
    expect(s.sag_length_mm).toBeUndefined();
    expect(s.notes.join(' ')).toMatch(/no gauge/);
  });
});

describe('sag length of a 22 AWG wire, 1.56 mm outside, worked out by hand', () => {
  // d = 0.127 x 92^(14/39) = 0.127 x exp(14/39 x ln 92) = 0.127 x exp(1.6232) = 0.127 x 5.0673 = 0.6435 mm
  // I(d) = pi d^4 / 64 = pi x 0.17147 / 64 = 0.0084172 mm^4 ; I(1.56) = pi x 5.9224 / 64 = 0.29072 mm^4
  // Polymer tube: 10 MPa x (0.29072 - 0.0084172) = 2.823 N mm^2
  // Section: copper pi d^2 / 4 = 0.32523 mm^2 ; whole pi 1.56^2 / 4 = 1.91134 mm^2 ; polymer 1.58611 mm^2
  // Mass: 0.32523 x 8.96 + 1.58611 x 1.3 = 2.9141 + 2.0619 = 4.9760 g/m
  // Weight: 4.976e-6 kg/mm x 9.80665 m/s^2 = 4.8798e-5 N/mm
  it('flexing wire (19 strands): B = 110000 x 0.0084172 / 19 + 2.823 = 51.55, sag = (B / w)^(1/3) = 101.9 mm', () => {
    expect(awgDiameterMm(22)).toBeCloseTo(0.644, 3);
    const s = stiff(wire());
    expect(rel(s.stiffness_nmm2!, 51.55)).toBeLessThan(0.01);
    expect(rel(s.weight_n_per_mm!, 4.8798e-5)).toBeLessThan(0.01);
    expect(rel(s.sag_length_mm!, 101.9)).toBeLessThan(0.01);
    expect(s.notes.join(' ')).toMatch(/19-strand 22 AWG/);
  });

  it('static-rated wire (7 strands): B = 110000 x 0.0084172 / 7 + 2.823 = 135.1, sag = 140.4 mm', () => {
    const s = stiff(wire({ flex: 'static' }));
    expect(rel(s.stiffness_nmm2!, 135.1)).toBeLessThan(0.01);
    expect(rel(s.weight_n_per_mm!, 4.8798e-5)).toBeLessThan(0.01);
    expect(rel(s.sag_length_mm!, 140.4)).toBeLessThan(0.01);
    expect(s.notes.join(' ')).toMatch(/7-strand/);
  });

  it("the maker's mass is used when present: 10 g/m -> 9.80665e-5 N/mm, sag = (51.55 / 9.80665e-5)^(1/3) = 80.7 mm", () => {
    const s = stiff(wire({ mass_g_per_m: 10 }));
    expect(rel(s.weight_n_per_mm!, 9.80665e-5)).toBeLessThan(1e-9);
    expect(rel(s.sag_length_mm!, 80.7)).toBeLessThan(0.01);
    expect(s.notes.join(' ')).toMatch(/maker/);
  });

  it('count wires together: stiffness and weight multiply, the sag length does not change', () => {
    const base = stiff(wire());
    for (const count of [2, 3, 7]) {
      const s = stiff(wire(), { count, twisted: false, sleeve_wall_mm: 0 });
      expect(rel(s.stiffness_nmm2!, count * base.stiffness_nmm2!)).toBeLessThan(1e-9);
      expect(rel(s.weight_n_per_mm!, count * base.weight_n_per_mm!)).toBeLessThan(1e-9);
      expect(rel(s.sag_length_mm!, base.sag_length_mm!)).toBeLessThan(1e-9);
    }
  });

  it('the sag length is (B / w)^(1/3) of the figures it reports', () => {
    const s = stiff(wire());
    expect(s.sag_length_mm!).toBeCloseTo(Math.cbrt(s.stiffness_nmm2! / s.weight_n_per_mm!), 9);
  });
});

describe('the library', () => {
  const lib = parseCableLibrary(readText('library/cables.yaml'));

  it('every cable gives finite positive figures', () => {
    for (const c of lib.cables) {
      const s = stiff(c);
      expect(Number.isFinite(s.lay_length_mm) && s.lay_length_mm > 0, c.id).toBe(true);
      if (s.sag_length_mm !== undefined) {
        for (const v of [s.sag_length_mm, s.stiffness_nmm2!, s.weight_n_per_mm!]) expect(Number.isFinite(v) && v > 0, c.id).toBe(true);
      } else {
        expect(c.section.shape === 'flat' || c.awg === undefined, c.id).toBe(true);
      }
    }
  });

  it('within a family of the same construction the sag length rises with the conductor size', () => {
    for (const prefix of ['ul1007-', 'silicone-']) {
      const family = lib.cables.filter((c) => c.id.startsWith(prefix)).sort((a, b) => b.awg! - a.awg!); // thin to thick
      expect(family.length).toBeGreaterThanOrEqual(6);
      const sags = family.map((c) => stiff(c).sag_length_mm!);
      for (let i = 1; i < sags.length; i++) expect(sags[i]!, `${family[i]!.id} vs ${family[i - 1]!.id}`).toBeGreaterThan(sags[i - 1]!);
    }
  });
});
