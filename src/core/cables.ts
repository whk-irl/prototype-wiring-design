/**
 * Cable types and the physical size of a cable built from them.
 *
 * A cable TYPE is a product: a 26 AWG silicone wire, a 3-wire servo lead, a
 * 15-way flat flex cable. It comes from the cable library (`library/cables.yaml`)
 * with its measured cross-section, minimum bend radius and source.
 *
 * A CABLE in a design is `count` of one type laid together, optionally twisted
 * and sleeved. `cableEnvelope` works out what that occupies in the prototype:
 * how thick it is, how tightly its centre line may bend, and how much wire it
 * consumes per millimetre of route. Everything here is geometry; nothing is a
 * rule of thumb unless its note says so.
 */
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { CableSpecSchema, CableTypeSchema, type Cable, type CableFamily, type CableSpecInput, type CableType, type Design } from './schema';

export const CableLibrarySchema = z.strictObject({
  version: z.literal(1),
  cables: z.array(CableTypeSchema),
});

export type CableLibrary = z.infer<typeof CableLibrarySchema>;

/**
 * Diameter of a solid conductor of a given American wire gauge, in mm. This is
 * the definition of the gauge, not an approximation: 36 AWG is 0.127 mm and
 * each step of 39 gauges is a factor of 92. A stranded conductor of the same
 * gauge is a little larger across.
 */
export function awgDiameterMm(awg: number): number {
  return 0.127 * 92 ** ((36 - awg) / 39);
}

/**
 * What is wrong with one cable type beyond its shape, one sentence each: bend
 * radii the wrong way round, a flat cable whose conductors do not fit across
 * it, a round one thinner than its own conductor.
 */
export function cableTypeProblems(type: CableType): string[] {
  const out: string[] = [];
  const bend = type.min_bend_mm;
  if (bend.dynamic !== undefined && bend.dynamic < bend.static) out.push('the dynamic bend radius cannot be smaller than the static one');
  if (type.section.shape === 'flat') {
    const { width_mm, thickness_mm } = type.section;
    if (thickness_mm > width_mm) out.push(`it is ${thickness_mm} mm thick and ${width_mm} mm wide: the width of a flat cable is its larger side`);
    if (type.pitch_mm !== undefined && (type.conductors - 1) * type.pitch_mm > width_mm + 1e-9) {
      out.push(`${type.conductors} conductors at ${type.pitch_mm} mm pitch do not fit across ${width_mm} mm`);
    }
    if (type.awg !== undefined) {
      const d = awgDiameterMm(type.awg);
      if (d >= thickness_mm) out.push(`a ${type.awg} AWG conductor is ${d.toFixed(2)} mm across, which does not fit inside a cable ${thickness_mm} mm thick`);
      else if (type.pitch_mm !== undefined && d >= type.pitch_mm) out.push(`${type.awg} AWG conductors are ${d.toFixed(2)} mm across, which does not fit a ${type.pitch_mm} mm pitch`);
    }
    // Ribbon is round insulated wires side by side: each is no thicker than the pitch.
    if (type.family === 'ribbon' && type.pitch_mm !== undefined && thickness_mm > type.pitch_mm + 1e-9) {
      out.push(`a ribbon cable of ${type.pitch_mm} mm pitch cannot be ${thickness_mm} mm thick: its wires lie side by side, each no thicker than the pitch`);
    }
  } else if (type.awg !== undefined) {
    const d = awgDiameterMm(type.awg);
    const od = type.section.od_mm;
    if (d >= od) out.push(`a ${type.awg} AWG conductor is ${d.toFixed(2)} mm across, which does not fit inside ${od} mm`);
    else if (type.conductors > 1 && bundleDiameter(d, type.conductors) >= od) {
      out.push(`${type.conductors} bare ${type.awg} AWG conductors are ${bundleDiameter(d, type.conductors).toFixed(2)} mm across when packed together, which does not fit inside ${od} mm`);
    }
  }
  return out;
}

/** Parse a cable library YAML file. Throws with the location on bad input. */
export function parseCableLibrary(yamlText: string): CableLibrary {
  const lib = CableLibrarySchema.parse(parseYaml(yamlText));
  const seen = new Set<string>();
  for (const cable of lib.cables) {
    if (seen.has(cable.id)) throw new Error(`duplicate cable id "${cable.id}"`);
    seen.add(cable.id);
    const problem = cableTypeProblems(cable)[0];
    if (problem) throw new Error(`cable "${cable.id}": ${problem}`);
    if (cable.custom || cable.spec) throw new Error(`cable "${cable.id}": a bundled library entry cannot be marked custom or carry the user's parameters`);
    if ((cable.confidence === 'datasheet' || cable.confidence === 'derived') && !cable.source) {
      throw new Error(`cable "${cable.id}": confidence "${cable.confidence}" needs a source`);
    }
    if (cable.confidence === 'derived' && !cable.note) {
      throw new Error(`cable "${cable.id}": a derived value needs a note saying how it was derived`);
    }
  }
  return lib;
}

export function findCableType(lib: CableLibrary, id: string): CableType | undefined {
  return lib.cables.find((c) => c.id === id);
}

/**
 * `base` with `types` added. A type whose id is already in `base` takes that
 * entry's place (and its position); new ones go first, so the user's own
 * cables head each group in a list.
 */
export function mergeCableLibrary(base: CableLibrary, types: readonly CableType[]): CableLibrary {
  if (types.length === 0) return base;
  const mine = new Map(types.map((t) => [t.id, t]));
  const baseIds = new Set(base.cables.map((c) => c.id));
  return {
    version: 1,
    cables: [...[...mine.values()].filter((t) => !baseIds.has(t.id)), ...base.cables.map((c) => mine.get(c.id) ?? c)],
  };
}

/** The type a cable's `type` names: the design's own first, then the library's. */
export function resolveCableType(design: Pick<Design, 'cable_types'>, lib: CableLibrary | null | undefined, id: string): CableType | undefined {
  return design.cable_types.find((c) => c.id === id) ?? (lib ? findCableType(lib, id) : undefined);
}

// ---------------------------------------------------------------- a cable from its parameters

/*
 * The user describes a cable they have (or are having made) by a few figures
 * and `cableTypeFromSpec` builds the library entry: the cross-section, the
 * bend limits and a name. Whatever the user did not enter is worked out by a
 * stated rule, and every such figure is listed in `derived` and in the type's
 * note, so nothing computed passes for a measurement.
 *
 * The rules and where they come from are in docs/CABLES.md.
 */

/** Round cable with no maker's figure: bend radius as a multiple of the outer diameter (CABLES.md rule 2). */
export const ROUND_BEND_OVER_OD = { static: 8, dynamic: 12 } as const;
/** Flat cable with no maker's figure: static bend radius as a multiple of the thickness (CABLES.md rule 3). */
export const FLAT_BEND_OVER_THICKNESS = 8;
/**
 * Flexible printed circuit: bend radius as a multiple of the thickness, by
 * number of copper layers in the part that bends (CABLES.md rule 4). `static`
 * is for a circuit bent once to install, `dynamic` for one that flexes in
 * use. Flex-circuit makers' guides disagree (6, 12, 24 or 10, 10, 20 static);
 * the larger figure of each is used. A circuit of three or more layers has no
 * dynamic figure: flexing one in use is not recommended.
 */
export const FPC_BEND_OVER_THICKNESS = {
  static: { one_layer: 10, two_layers: 12, multilayer: 24 },
  dynamic: { one_layer: 100, two_layers: 150 },
} as const;
/** Insulation wall assumed for a single wire when only its gauge is known: that of UL 1007 hook-up wire. */
export const ASSUMED_WIRE_WALL_MM = 0.41;
/** A stranded conductor is about this much larger across than a solid one of the same gauge. */
export const STRANDED_OVER_SOLID = 1.15;
/** Thickness assumed for a flat flex cable (FFC) when not entered: what FFC connectors are made for. */
export const ASSUMED_FFC_THICKNESS_MM = 0.3;
/** The thickest such an FFC may be (0.3 + 0.05 mm). The bend radius of an assumed thickness is worked out from this. */
export const ASSUMED_FFC_THICKNESS_MAX_MM = 0.35;
/** Thickness assumed for 1.27 mm pitch ribbon cable when not entered (28 AWG ribbon, as in the library). */
export const ASSUMED_RIBBON_127_THICKNESS_MM = 0.9;
/** The thickest such a ribbon may be (0.9 + 0.10 mm). The bend radius of an assumed thickness is worked out from this. */
export const ASSUMED_RIBBON_127_THICKNESS_MAX_MM = 1.0;
/** Gauges the single-wire estimate covers: the range the assumed wall is stated for. */
export const WIRE_ESTIMATE_AWG = { finest: 30, heaviest: 16 } as const;

const round2 = (x: number): number => Math.round(x * 100) / 100;
const round3 = (x: number): number => Math.round(x * 1000) / 1000;
/**
 * A bend radius worked out by a rule, rounded UP to 0.1 mm: a minimum that is
 * rounded down would allow a tighter bend than the rule does.
 */
const ceil1 = (x: number): number => Math.ceil(x * 10 - 1e-9) / 10;
/** `how`, with the exact product when rounding up changed it. */
const withExact = (how: string, exact: number, rounded: number): string =>
  Math.abs(exact - rounded) < 1e-9 ? how : `${how} (${round3(exact)} mm, rounded up)`;

const ROUND_FAMILY_NAME: Record<'multicore' | 'twisted_pair' | 'coax' | 'usb' | 'ethernet', string> = {
  multicore: 'Multi-core cable',
  twisted_pair: 'Twisted-pair cable',
  coax: 'Coaxial cable',
  usb: 'USB cable',
  ethernet: 'Ethernet cable',
};

/**
 * Build a cable type from the user's parameters. `derived` says, one sentence
 * each, which figures were worked out and by what rule; the same sentences go
 * into the type's note.
 *
 * The type carries the parameters it was built from (`spec`), so building
 * again from `type.spec` gives the same type, and a form can be reopened
 * with exactly what was entered.
 *
 * Confidence of the result: `generic` when a size was assumed (a typical wall
 * or thickness, the width of a flexible circuit), else `derived` when a bend
 * radius or the width of a ribbon or FFC came from a rule, else the user's
 * `basis` (every figure is theirs).
 *
 * Throws a `RangeError` in plain words when the parameters cannot describe a
 * cable (an FPC without a thickness, bend radii the wrong way round).
 */
export function cableTypeFromSpec(input: CableSpecInput, id: string): { type: CableType; derived: string[] } {
  const spec = CableSpecSchema.parse(input);
  const derived: string[] = [];
  let assumed = false;
  let ruled = false;

  let family: CableFamily;
  let section: CableType['section'];
  let conductors: number;
  let pitch: number | undefined;
  let awg: number | undefined;
  let name: string;
  /** The rules' figures before rounding up. */
  let ruleStatic: number;
  let ruleDynamic: number | undefined;
  let staticHow: string;
  let dynamicHow = '';
  /** Why a cable said to flex in use gets no flexing bend radius from a rule. */
  let noDynamicRule: string | undefined;
  // A flexing bend radius the user entered says the cable is made to flex.
  let flex: CableType['flex'] = spec.flexing || spec.bend_dynamic_mm !== undefined ? 'flexible' : 'static';

  if (spec.kind === 'wire' || spec.kind === 'round_cable') {
    let od: number;
    if (spec.kind === 'wire') {
      family = 'hookup_wire';
      conductors = 1;
      awg = spec.awg;
      if (spec.od_mm !== undefined) {
        od = spec.od_mm;
      } else {
        if (spec.wall_mm === undefined && (spec.awg > WIRE_ESTIMATE_AWG.finest || spec.awg < WIRE_ESTIMATE_AWG.heaviest)) {
          throw new RangeError(
            `Give the outer diameter of the wire: it is only estimated from the gauge for ${WIRE_ESTIMATE_AWG.finest} to ${WIRE_ESTIMATE_AWG.heaviest} AWG hook-up wire, where the typical insulation is known.`,
          );
        }
        const wall = spec.wall_mm ?? ASSUMED_WIRE_WALL_MM;
        od = round2(STRANDED_OVER_SOLID * awgDiameterMm(spec.awg) + 2 * wall);
        assumed = true;
        derived.push(
          `Outer diameter ${od} mm estimated from the gauge: a stranded ${spec.awg} AWG conductor (${STRANDED_OVER_SOLID} x ${round2(awgDiameterMm(spec.awg))} mm) plus a ${wall} mm wall each side${
            spec.wall_mm === undefined ? ', the wall of UL 1007 hook-up wire' : ''
          }. Measure the wire to replace this estimate.`,
        );
      }
      name = `Wire, ${spec.awg} AWG, ${od} mm`;
    } else {
      family = spec.family;
      conductors = spec.conductors;
      awg = spec.awg;
      od = spec.od_mm;
      name = `${ROUND_FAMILY_NAME[spec.family]}, ${spec.conductors} ${spec.awg !== undefined ? `x ${spec.awg} AWG` : `conductor${spec.conductors === 1 ? '' : 's'}`}, ${od} mm`;
    }
    section = { shape: 'round', od_mm: od };
    ruleStatic = ROUND_BEND_OVER_OD.static * od;
    staticHow = `${ROUND_BEND_OVER_OD.static} x the ${od} mm outer diameter (the library's rule for round cable with no maker's figure)`;
    if (spec.flexing) {
      ruleDynamic = ROUND_BEND_OVER_OD.dynamic * od;
      dynamicHow = `${ROUND_BEND_OVER_OD.dynamic} x the outer diameter`;
    }
  } else {
    conductors = spec.ways;
    pitch = spec.pitch_mm;
    let thickness: number;
    let width: number;
    if (spec.kind === 'ribbon') {
      family = 'ribbon';
      awg = spec.awg;
      width = round2(spec.ways * spec.pitch_mm);
      ruled = true;
      derived.push(`Width ${width} mm = ${spec.ways} ways x ${spec.pitch_mm} mm pitch.`);
      // The thickness the bend radius is worked out from.
      let bendThickness: number;
      if (spec.thickness_mm !== undefined) {
        thickness = spec.thickness_mm;
        bendThickness = thickness;
        staticHow = `${FLAT_BEND_OVER_THICKNESS} x the ${thickness} mm thickness (the library's rule for flat cable with no maker's figure)`;
      } else if (Math.abs(spec.pitch_mm - 1.27) < 1e-6 && (spec.awg === undefined || spec.awg === 28)) {
        thickness = ASSUMED_RIBBON_127_THICKNESS_MM;
        bendThickness = ASSUMED_RIBBON_127_THICKNESS_MAX_MM;
        assumed = true;
        derived.push(`Thickness ${thickness} mm assumed: that of 28 AWG ribbon at 1.27 mm pitch. Measure the cable to replace it.`);
        staticHow = `${FLAT_BEND_OVER_THICKNESS} x ${bendThickness} mm, the thickest such a ribbon may be (the library's rule for flat cable with no maker's figure)`;
      } else if (Math.abs(spec.pitch_mm - 1.27) < 1e-6) {
        throw new RangeError(`Give the thickness of the ribbon cable: the typical figure is for 28 AWG ribbon, not ${spec.awg} AWG.`);
      } else throw new RangeError('Give the thickness of the ribbon cable: there is no typical figure for this pitch.');
      name = `Flat ribbon cable, ${spec.ways} way, ${spec.pitch_mm} mm pitch`;
      ruleStatic = FLAT_BEND_OVER_THICKNESS * bendThickness;
      noDynamicRule = 'there is no rule for a ribbon cable that flexes in use';
    } else {
      family = 'ffc';
      // Flat flex is flexible by construction; a circuit of three or more
      // layers is the exception (below).
      flex = 'flexible';
      if (spec.width_mm !== undefined) width = spec.width_mm;
      else {
        width = round2((spec.ways + 1) * spec.pitch_mm);
        if (spec.construction === 'ffc') {
          ruled = true;
          derived.push(`Width ${width} mm = (${spec.ways} ways + 1) x ${spec.pitch_mm} mm pitch, the width of a standard flat flex cable.`);
        } else {
          // A flexible circuit is made to the user's own outline: the width of
          // a standard tail is a guess at it, not a rule it follows.
          assumed = true;
          derived.push(
            `Width ${width} mm assumed = (${spec.ways} ways + 1) x ${spec.pitch_mm} mm pitch, the width of a standard flat flex tail. Enter the width of your own circuit to replace it.`,
          );
        }
      }
      if (spec.construction === 'ffc') {
        let bendThickness: number;
        if (spec.thickness_mm !== undefined) {
          thickness = spec.thickness_mm;
          bendThickness = thickness;
          staticHow = `${FLAT_BEND_OVER_THICKNESS} x the ${thickness} mm thickness (the library's rule for flat cable with no maker's figure)`;
        } else {
          thickness = ASSUMED_FFC_THICKNESS_MM;
          bendThickness = ASSUMED_FFC_THICKNESS_MAX_MM;
          assumed = true;
          derived.push(`Thickness ${thickness} mm assumed: the thickness flat flex connectors are made for, at the stiffened end. The cable between its ends is thinner.`);
          staticHow = `${FLAT_BEND_OVER_THICKNESS} x ${bendThickness} mm, the thickest such a cable may be (the library's rule for flat cable with no maker's figure)`;
        }
        name = `Flat flex cable (FFC), ${spec.ways} way, ${spec.pitch_mm} mm pitch`;
        ruleStatic = FLAT_BEND_OVER_THICKNESS * bendThickness;
        noDynamicRule = 'there is no rule for a flat flex cable that flexes in use';
      } else {
        if (spec.thickness_mm === undefined) {
          throw new RangeError("Give the thickness of the flexible circuit where it bends: it is in the fab's stack-up, and the bend radius is worked out from it.");
        }
        thickness = spec.thickness_mm;
        const k = spec.layers === 1 ? FPC_BEND_OVER_THICKNESS.static.one_layer : spec.layers === 2 ? FPC_BEND_OVER_THICKNESS.static.two_layers : FPC_BEND_OVER_THICKNESS.static.multilayer;
        name = `Flexible printed circuit (FPC), ${spec.ways} way, ${spec.pitch_mm} mm pitch, ${spec.layers} layer${spec.layers === 1 ? '' : 's'}`;
        ruleStatic = k * thickness;
        staticHow = `${k} x the ${thickness} mm thickness, the figure for a ${spec.layers === 1 ? 'single-layer' : spec.layers === 2 ? 'two-layer' : 'multilayer'} flexible circuit bent once to install`;
        if (spec.layers <= 2) {
          if (spec.flexing) {
            const kd = spec.layers === 1 ? FPC_BEND_OVER_THICKNESS.dynamic.one_layer : FPC_BEND_OVER_THICKNESS.dynamic.two_layers;
            ruleDynamic = kd * thickness;
            dynamicHow = `${kd} x the thickness, the figure for a ${spec.layers === 1 ? 'single-layer' : 'two-layer'} flexible circuit that flexes in use`;
          }
        } else {
          // Not built to flex in use, unless the fab says so with a figure.
          if (spec.bend_dynamic_mm === undefined) flex = 'static';
          noDynamicRule = `a flexible circuit of ${spec.layers} layers is not recommended for flexing in use, so there is no figure to apply`;
        }
      }
    }
    section = { shape: 'flat', width_mm: width, thickness_mm: thickness };
  }

  const bendStatic = spec.bend_static_mm ?? ceil1(ruleStatic);
  if (spec.bend_static_mm === undefined) {
    ruled = true;
    derived.push(`Bend radius ${bendStatic} mm = ${withExact(staticHow, ruleStatic, bendStatic)}.`);
  }
  let bendDynamic = spec.bend_dynamic_mm;
  if (bendDynamic === undefined && ruleDynamic !== undefined) {
    const rule = ceil1(ruleDynamic);
    ruled = true;
    if (rule >= bendStatic) {
      bendDynamic = rule;
      derived.push(`Flexing bend radius ${rule} mm = ${withExact(dynamicHow, ruleDynamic, rule)}.`);
    } else {
      // A rule's flexing figure never undercuts an installed radius the user entered.
      bendDynamic = bendStatic;
      derived.push(`Flexing bend radius ${bendStatic} mm: the rule (${dynamicHow}) gives ${rule} mm, less than the installed radius entered, so the installed radius is used.`);
    }
  }
  if (spec.flexing && bendDynamic === undefined && noDynamicRule !== undefined) {
    derived.push(`No flexing bend radius: ${noDynamicRule}. Enter the maker's own figure if it gives one.`);
  }
  if (bendDynamic !== undefined && bendDynamic < bendStatic) {
    throw new RangeError(`The flexing bend radius (${bendDynamic} mm) cannot be smaller than the installed one (${bendStatic} mm).`);
  }

  const note = [spec.note, ...derived].filter((x): x is string => !!x).join(' ');
  const type: CableType = {
    id,
    name: spec.name ?? name,
    family,
    ...(spec.manufacturer ? { manufacturer: spec.manufacturer } : {}),
    ...(spec.mpn ? { mpn: spec.mpn } : {}),
    section,
    conductors,
    ...(pitch !== undefined ? { pitch_mm: pitch } : {}),
    ...(awg !== undefined ? { awg } : {}),
    min_bend_mm: { static: bendStatic, ...(bendDynamic !== undefined ? { dynamic: bendDynamic } : {}) },
    flex,
    ...(spec.max_current_a !== undefined ? { max_current_a: spec.max_current_a } : {}),
    ...(spec.mass_g_per_m !== undefined ? { mass_g_per_m: spec.mass_g_per_m } : {}),
    connectors: spec.connectors,
    interfaces: spec.interfaces,
    confidence: assumed ? 'generic' : ruled ? 'derived' : spec.basis,
    ...(spec.source ? { source: spec.source } : {}),
    ...(note ? { note } : {}),
    custom: true,
    spec,
  };
  const problem = cableTypeProblems(type)[0];
  if (problem) throw new RangeError(`This does not describe a cable: ${problem}.`);
  return { type: CableTypeSchema.parse(type), derived };
}

// ---------------------------------------------------------------- bundles

/**
 * Diameter of the smallest circle that encloses n equal circles, in units of
 * their diameter (the optimal circle-packing values, n = 0..19).
 */
const ENCLOSING = [
  0, 1, 2, 2.1547, 2.4142, 2.7013, 3, 3, 3.3048, 3.6131, 3.813, 3.9238, 4.0296, 4.2361, 4.3284, 4.5214, 4.6154, 4.792, 4.8637,
  4.8637,
];

/** Outer diameter of `count` round wires of diameter `d_mm` bundled as tightly as they go. */
export function bundleDiameter(d_mm: number, count: number): number {
  if (!Number.isInteger(count) || count < 1) throw new RangeError(`count must be a positive integer, got ${count}`);
  // Beyond the table, the density of a large hexagonal bundle (about 0.75 of
  // the enclosing circle is filled) gives D = d * sqrt(n / 0.75).
  const k = count < ENCLOSING.length ? ENCLOSING[count]! : Math.sqrt(count / 0.75);
  return k * d_mm;
}

/** Default lay length, as a multiple of the bundle diameter, when none is given. */
export const DEFAULT_LAY_OVER_DIAMETER = 12;

/** What a design cable occupies and requires. */
export interface CableEnvelope {
  shape: 'round' | 'flat';
  /** Size across the route, parallel to the surface it lies on. */
  width_mm: number;
  /** Size away from the surface it lies on. Round: the same as the width. */
  height_mm: number;
  /** Smallest allowed radius of the centre line, installed and left. */
  bend_static_mm: number;
  /** Smallest allowed radius of the centre line where it flexes in use, if the type states one. */
  bend_dynamic_mm?: number;
  /** Millimetres of each wire consumed per millimetre of route: 1, or more when twisted. */
  length_factor: number;
  /** The lay length used, when twisted. */
  lay_length_mm?: number;
  /** Cross-section area of the bounding shape, for fill calculations. */
  area_mm2: number;
  /**
   * Where the bend radii come from: the library type's `confidence`, or `user`
   * when the cable carries a `bend_override_mm`. A limit that is `derived` or
   * `generic` is a rule applied to the cable's size, not a maker's figure, and
   * a route that breaks it deserves a warning, not a verdict.
   */
  bend_source: CableType['confidence'] | 'user';
  /** Assumptions made and things that do not apply, in plain words. */
  notes: string[];
}

export type CableBuild = Pick<Cable, 'count' | 'twisted' | 'lay_length_mm' | 'sleeve_wall_mm'> & Partial<Pick<Cable, 'bend_override_mm'>>;

/**
 * Size, bend limits and wire consumption of `build.count` cables of `type`
 * laid together.
 *
 * Round bundle. The diameter is the smallest circle around `count` equal
 * circles, plus the sleeve. The centre line may not bend tighter than the
 * type's own minimum plus the distance from the bundle's centre to its
 * innermost wire's centre, because that wire takes the tightest path. When
 * twisted, each outer wire is a helix about the bundle axis and is longer than
 * the route by sqrt(1 + (2 pi r / lay)^2), r being the helix radius.
 *
 * Flat cables stack: the height multiplies, the width does not, and they
 * cannot be twisted.
 */
export function cableEnvelope(type: CableType, build: CableBuild): CableEnvelope {
  const notes: string[] = [];
  const sleeve = build.sleeve_wall_mm;
  const override = build.bend_override_mm;
  const wireStatic = override ?? type.min_bend_mm.static;
  const wireDynamic = override ?? type.min_bend_mm.dynamic;
  const bendSource = override !== undefined ? ('user' as const) : type.confidence;
  if (override !== undefined) {
    notes.push(`Bend radius of ${override} mm set by the user, in place of the library's ${type.min_bend_mm.static} mm.`);
  }

  if (type.section.shape === 'flat') {
    const height = type.section.thickness_mm * build.count + 2 * sleeve;
    const width = type.section.width_mm + 2 * sleeve;
    if (build.twisted) notes.push('A flat cable cannot be twisted; the twist setting is ignored.');
    if (build.count > 1) notes.push(`${build.count} flat cables are taken as stacked on top of each other.`);
    // Stacked flats bend together; the innermost one takes the tightest path.
    const inner = (height - type.section.thickness_mm - 2 * sleeve) / 2;
    return {
      shape: 'flat',
      width_mm: width,
      height_mm: height,
      bend_static_mm: wireStatic + inner,
      ...(wireDynamic !== undefined ? { bend_dynamic_mm: wireDynamic + inner } : {}),
      length_factor: 1,
      area_mm2: width * height,
      bend_source: bendSource,
      notes,
    };
  }

  const d = type.section.od_mm;
  const bare = bundleDiameter(d, build.count);
  const od = bare + 2 * sleeve;
  // Centre of the bundle to the centre of an outermost wire.
  const offset = (bare - d) / 2;

  let lengthFactor = 1;
  let lay: number | undefined;
  if (build.twisted) {
    if (build.count < 2) {
      notes.push('A single cable cannot be twisted with itself; the twist setting is ignored.');
    } else {
      lay = build.lay_length_mm;
      if (lay === undefined) {
        lay = DEFAULT_LAY_OVER_DIAMETER * bare;
        notes.push(`No lay length given: assumed ${DEFAULT_LAY_OVER_DIAMETER} times the bundle diameter (${lay.toFixed(1)} mm). This is an assumption, not a sourced value.`);
      }
      lengthFactor = Math.hypot(1, (2 * Math.PI * offset) / lay);
    }
  }

  return {
    shape: 'round',
    width_mm: od,
    height_mm: od,
    bend_static_mm: wireStatic + offset,
    ...(wireDynamic !== undefined ? { bend_dynamic_mm: wireDynamic + offset } : {}),
    length_factor: lengthFactor,
    ...(lay !== undefined ? { lay_length_mm: lay } : {}),
    area_mm2: (Math.PI * od * od) / 4,
    bend_source: bendSource,
    notes,
  };
}
