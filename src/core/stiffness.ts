/**
 * How stiff and how heavy a cable is, for working out the shape it takes
 * (`rod.ts`): how snugly it can be laid, and whether a free stretch of it
 * sags.
 *
 * Two lengths describe it.
 *
 * Lay length. A wire laid on a prototype is pulled snug, but a careful builder
 * does not pull it tighter than its bend limit. A stiff rod under tension T
 * pulled round a sharp edge through a total turn of theta bends there to a
 * radius of lambda / (2 sin(theta / 4)), with lambda = sqrt(B / T) (B the
 * bending stiffness). That is with the wire running on a long way either
 * side; ties nearer the edge tighten the bend a little (by 6% for a half turn
 * with ties 10 lambda away). The lay length is taken as 1.6 x the cable's
 * static bend limit, so that a half turn (theta = 180 degrees, the wire
 * doubling back over an edge) bends to 1.13 x the limit with the ties far
 * away and stays above the limit with ties down to about 10 lambda. A gentler
 * turn bends more gently (a right angle: about 2 x the limit), and only a
 * route that forces the wire (ties too close for the turn between them) goes
 * below the limit. This is a statement about how the wire is laid, not a
 * measured property of the wire.
 * A cable with no bend limit to go by (a type the library does not know) is
 * laid as if its limit were four times its own height, and its note says so.
 *
 * Sag length. A free stretch droops under its own weight when it is longer
 * than about (B / w)^(1/3), w its weight per length. Neither figure is on a
 * datasheet for hook-up wire, so both are ESTIMATED from the construction:
 *
 *  - B of a conductor: that of its strands bending separately, each about
 *    its own axis, which is the solid conductor's stiffness divided by the
 *    number of strands (E_cu pi d^4 / 64 / n). Friction between strands makes
 *    the real figure higher; this is the floppy end.
 *  - strands: 7 for wire built for a static installation, 19 for wire built to
 *    flex. The usual constructions; the real count is not in the library.
 *  - insulation and jacket: a tube of soft polymer between the bare
 *    conductors and the outside, E = 10 MPa (flexible PVC is 5 to 25 MPa,
 *    silicone lower).
 *  - weight: the maker's mass where the library has it, else copper at
 *    8.96 g/cm3 for the conductors and 1.3 g/cm3 for the rest of the section.
 *
 * The cube root is forgiving: stiffness wrong by a factor of 3 moves the sag
 * length by 44%. Read a sag as "this stretch droops about this much", not as
 * a dimension. Flat cables get no sag length: they bend one way only and the
 * rod model has no such direction.
 */
import { awgDiameterMm, bundleDiameter, type CableBuild, type CableEnvelope } from './cables';
import type { CableType } from './schema';

/** Lay length over the static bend limit (see the file comment). */
export const LAY_OVER_BEND_LIMIT = 1.6;
/** Young's modulus of annealed copper, MPa (N/mm2). */
export const COPPER_MODULUS_MPA = 110_000;
/** Young's modulus taken for insulation and jacket, MPa. An assumption. */
export const POLYMER_MODULUS_MPA = 10;
/** Densities, g/cm3. */
export const COPPER_DENSITY = 8.96;
export const POLYMER_DENSITY = 1.3;
/** Strands assumed in a conductor, by what the cable is built to survive. An assumption. */
export const ASSUMED_STRANDS = { static: 7, flexing: 19 } as const;
const G_MM_S2 = 9806.65;

export interface CableStiffness {
  /** Natural bend length of the cable laid snug, for `rod.ts` laid mode. */
  lay_length_mm: number;
  /** (B / w)^(1/3). Absent when it cannot be estimated (flat cable, no gauge). */
  sag_length_mm?: number;
  /** Bending stiffness, N mm2. Absent with `sag_length_mm`. An estimate. */
  stiffness_nmm2?: number;
  /** Weight per length, N/mm. Absent with `sag_length_mm`. */
  weight_n_per_mm?: number;
  /** What was assumed, in plain words. */
  notes: string[];
}

const circleI = (d: number): number => (Math.PI * d ** 4) / 64;

/**
 * Stiffness figures for `build.count` cables of `type` run together, whose
 * envelope is `env` (from `cableEnvelope`).
 */
export function cableStiffness(type: CableType, build: CableBuild, env: CableEnvelope): CableStiffness {
  const notes: string[] = [];
  // A cable with no bend limit to go by (an unknown type) is laid at four times its own height.
  const known = env.bend_static_mm > 0;
  const limit = known ? env.bend_static_mm : 4 * env.height_mm;
  const lay = LAY_OVER_BEND_LIMIT * limit;
  notes.push(
    known
      ? `Drawn as a stiff wire laid snug: pulled no tighter than lets it double back over an edge without going below its ${round1(limit)} mm bend limit.`
      : `Drawn as a stiff wire laid snug. No bend limit is known for this cable, so it is drawn as if its limit were ${round1(limit)} mm, four times its own height: an assumption, not the cable's figure.`,
  );

  if (type.section.shape !== 'round') {
    notes.push('No sag is worked out for a flat cable: it bends one way only.');
    return { lay_length_mm: lay, notes };
  }
  if (type.awg === undefined) {
    notes.push('No sag is worked out: the library gives no gauge for this cable, so its stiffness cannot be estimated.');
    return { lay_length_mm: lay, notes };
  }

  const od = type.section.od_mm;
  const d = awgDiameterMm(type.awg);
  const strands = type.flex === 'static' ? ASSUMED_STRANDS.static : ASSUMED_STRANDS.flexing;
  const conductors = type.conductors;
  // One cable: conductors bending separately, inside a soft tube from the bare bundle out to the surface.
  const copperB = (conductors * COPPER_MODULUS_MPA * circleI(d)) / strands;
  const core = Math.min(bundleDiameter(d, conductors), 0.95 * od);
  const polymerB = POLYMER_MODULUS_MPA * (circleI(od) - circleI(core));
  const copperArea = (conductors * Math.PI * d * d) / 4;
  const section = (Math.PI * od * od) / 4;
  // g/m: mm2 x g/cm3 is g/m exactly.
  const massPerM = type.mass_g_per_m ?? copperArea * COPPER_DENSITY + Math.max(0, section - copperArea) * POLYMER_DENSITY;
  // Several run together bend and weigh as that many separate cables.
  const B = build.count * (copperB + polymerB);
  // g/m is 1e-6 kg/mm; times g in mm/s2 gives millinewtons per mm; divide by 1000 for N/mm.
  const weight = (build.count * massPerM * 1e-6 * G_MM_S2) / 1000;
  const sag = Math.cbrt(B / weight);
  notes.push(
    `Sag is an estimate: stiffness from ${strands}-strand ${type.awg} AWG conductors bending separately, weight ${type.mass_g_per_m !== undefined ? "from the maker's figure" : 'from copper and insulation densities'}. A free stretch longer than about ${Math.round(sag)} mm droops visibly.`,
  );
  return { lay_length_mm: lay, sag_length_mm: sag, stiffness_nmm2: B, weight_n_per_mm: weight, notes };
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}
