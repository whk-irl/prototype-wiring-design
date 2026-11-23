/**
 * Connectors: what a cable plugs into, how much room the plug needs, and
 * which cables can be terminated in it. Library file: `library/connectors.yaml`.
 *
 * A connector FAMILY is one design in all its sizes: JST SH from 2 to 20
 * ways, a single-row 2.54 mm pin header of any length. A port on a part names
 * the family and, where the family comes in several sizes, the number of ways
 * (contacts, counted over all rows).
 *
 * Boxes are given in the port frame (see `PortSchema`): the housing on the
 * part lies behind the port origin (x from -length to 0) and the mating plug
 * in front of it (x from 0 to +length), both centred on the origin in y and z.
 * Width runs along y, the row of contacts; height along z.
 */
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { CableFamilySchema, type CableFamily, type CableType } from './schema';
import { IdSchema, type Port, type Vec3 } from './schema';

/** A box whose width grows with the number of contacts in one row. */
export const BoxRuleSchema = z.strictObject({
  /** Along the direction the plug goes in. */
  length_mm: z.number().positive(),
  height_mm: z.number().positive(),
  /** Width = `per_way_mm` x (contacts in one row) + `plus_mm`. */
  width: z.strictObject({ per_way_mm: z.number().nonnegative().default(0), plus_mm: z.number().nonnegative() }),
});

/** One kind of cable a connector takes. */
export const AcceptSchema = z.strictObject({
  families: z.array(CableFamilySchema).min(1),
  /**
   * `per_contact`: every conductor goes to a contact of its own (loose wires
   * crimped into a housing, jumper wires on header pins). `whole`: one made-up
   * cable fills the connector (a USB cable, a flat flex cable).
   */
  termination: z.enum(['per_contact', 'whole']),
  /** The thickest and thinnest wire the contacts take, as AWG numbers. The
   *  thickest wire has the SMALLER number. */
  awg: z.strictObject({ thickest: z.number(), thinnest: z.number() }).optional(),
  /** `per_contact`: the widest insulation of one wire (checked for single
   *  wires only: the cores of a multi-core cable are not in the library).
   *  `whole`: the widest round cable. */
  od_max_mm: z.number().positive().optional(),
  /** A flat cable's conductor spacing, when it is not the connector's own
   *  pitch (1.27 mm ribbon in a two-row 2.54 mm connector). */
  cable_pitch_mm: z.number().positive().optional(),
  note: z.string().optional(),
});

export const ConnectorSchema = z.strictObject({
  id: IdSchema,
  name: z.string().min(1),
  /** A few words for lists and labels: `JST SH`, `USB-C`, `Pin header`. */
  short: z.string().min(1).optional(),
  /** Other names it goes by: Qwiic, STEMMA QT, Dupont. */
  aliases: z.array(z.string().min(1)).default([]),
  /** Spacing of the contacts along a row. */
  pitch_mm: z.number().positive().optional(),
  rows: z.int().positive().default(1),
  /** Sizes the family comes in, as total contacts. `min` = `max` for a
   *  connector of one size. */
  ways: z.strictObject({ min: z.int().positive(), max: z.int().positive() }),
  /** The half that sits on the part. */
  housing: BoxRuleSchema.optional(),
  /**
   * The mating half with whatever stiff length follows it (boot, strain
   * relief, crimp barrels): the space in front of the port that the cable
   * cannot start bending in.
   */
  plug: BoxRuleSchema.optional(),
  accepts: z.array(AcceptSchema).default([]),
  /** Same meaning as for cable types. */
  confidence: z.enum(['datasheet', 'measured', 'derived', 'generic']),
  source: z.url().optional(),
  note: z.string().optional(),
});

export const ConnectorLibrarySchema = z.strictObject({
  version: z.literal(1),
  connectors: z.array(ConnectorSchema),
});

export type BoxRule = z.infer<typeof BoxRuleSchema>;
export type Accept = z.infer<typeof AcceptSchema>;
export type Connector = z.infer<typeof ConnectorSchema>;
export type ConnectorLibrary = z.infer<typeof ConnectorLibrarySchema>;

/** Parse a connector library YAML file. Throws with the location on bad input. */
export function parseConnectorLibrary(yamlText: string): ConnectorLibrary {
  const lib = ConnectorLibrarySchema.parse(parseYaml(yamlText));
  const seen = new Set<string>();
  for (const c of lib.connectors) {
    if (seen.has(c.id)) throw new Error(`duplicate connector id "${c.id}"`);
    seen.add(c.id);
    if (c.ways.min > c.ways.max) throw new Error(`connector "${c.id}": ways.min is larger than ways.max`);
    if (c.ways.min % c.rows !== 0 || c.ways.max % c.rows !== 0) {
      throw new Error(`connector "${c.id}": the number of ways must divide evenly over its ${c.rows} rows`);
    }
    if ((c.confidence === 'datasheet' || c.confidence === 'derived') && !c.source) {
      throw new Error(`connector "${c.id}": confidence "${c.confidence}" needs a source`);
    }
    for (const a of c.accepts) {
      if (a.awg && a.awg.thickest > a.awg.thinnest) {
        throw new Error(`connector "${c.id}": awg.thickest must be the smaller AWG number`);
      }
    }
  }
  return lib;
}

export function findConnector(lib: ConnectorLibrary, id: string): Connector | undefined {
  return lib.connectors.find((c) => c.id === id);
}

/** Number of contacts at a port: its own figure, or the family's when the
 *  family has one size. Undefined when neither says. */
export function portWays(connector: Connector, port: Pick<Port, 'ways'>): number | undefined {
  if (port.ways !== undefined) return port.ways;
  return connector.ways.min === connector.ways.max ? connector.ways.min : undefined;
}

/** What is wrong with a port's connector entry, or undefined. */
export function portProblem(connector: Connector | undefined, port: Pick<Port, 'connector' | 'ways'>): string | undefined {
  if (!connector) return `connector "${port.connector}" is not in the connector library`;
  const ways = portWays(connector, port);
  if (ways === undefined) return `connector "${connector.id}" comes in ${connector.ways.min} to ${connector.ways.max} ways: the port must say how many`;
  if (ways < connector.ways.min || ways > connector.ways.max) {
    return connector.ways.min === connector.ways.max
      ? `connector "${connector.id}" has ${connector.ways.min} ways, not ${ways}`
      : `connector "${connector.id}" comes in ${connector.ways.min} to ${connector.ways.max} ways, not ${ways}`;
  }
  if (ways % connector.rows !== 0) return `${ways} ways do not divide evenly over the ${connector.rows} rows of connector "${connector.id}"`;
  return undefined;
}

/**
 * A connector of a given size in a few words, for lists: `USB-C`,
 * `JST SH 4-way`, `Pin header 2x20`. A family of one size is just its short
 * name; one with several rows gives rows x contacts per row; otherwise the
 * number of ways. Without `ways` (not recorded at the port) only the name.
 */
export function connectorLabel(connector: Connector, ways: number | undefined): string {
  const name = connector.short ?? connector.name;
  if (ways === undefined || connector.ways.min === connector.ways.max) return name;
  if (connector.rows > 1 && ways % connector.rows === 0) return `${name} ${connector.rows}x${ways / connector.rows}`;
  return `${name} ${ways}-way`;
}

function boxOf(rule: BoxRule | undefined, perRow: number): Vec3 | undefined {
  if (!rule) return undefined;
  return [rule.length_mm, rule.width.per_way_mm * perRow + rule.width.plus_mm, rule.height_mm];
}

/**
 * Sizes of the housing and of the mating plug for a connector of `ways`
 * contacts, each as [length along x, width along y, height along z] in the
 * port frame. The housing occupies x in [-length, 0], the plug x in
 * [0, length]; both are centred on the origin in y and z.
 */
export function connectorBoxes(connector: Connector, ways: number): { housing?: Vec3; plug?: Vec3 } {
  const perRow = ways / connector.rows;
  const housing = boxOf(connector.housing, perRow);
  const plug = boxOf(connector.plug, perRow);
  return { ...(housing ? { housing } : {}), ...(plug ? { plug } : {}) };
}

/**
 * Centres of the contacts in the port frame, at x = 0: along y within a row,
 * rows stacked along z, the whole pattern centred on the origin. Row by row,
 * each from -y to +y. Empty when the family has no pitch. `ways` is expected
 * to divide evenly over the rows (see `portProblem`); a remainder is dropped.
 */
export function contactOffsets(connector: Connector, ways: number): Vec3[] {
  if (connector.pitch_mm === undefined) return [];
  const perRow = Math.floor(ways / connector.rows);
  const out: Vec3[] = [];
  for (let r = 0; r < connector.rows; r++) {
    for (let k = 0; k < perRow; k++) {
      out.push([0, (k - (perRow - 1) / 2) * connector.pitch_mm, (r - (connector.rows - 1) / 2) * connector.pitch_mm]);
    }
  }
  return out;
}

const FAMILY_WORDS: Record<CableFamily, string> = {
  hookup_wire: 'single wires',
  jumper: 'jumper wires',
  ribbon: 'ribbon cable',
  ffc: 'flat flex cable',
  multicore: 'multi-core cable',
  twisted_pair: 'twisted-pair cable',
  coax: 'coaxial cable',
  usb: 'USB cable',
  ethernet: 'Ethernet cable',
  harness: 'ready-made harnesses',
};

/** The cable families a connector takes, in words: "single wires or jumper wires". */
export function acceptedFamilies(connector: Connector): string {
  const words = [...new Set(connector.accepts.flatMap((a) => a.families))].map((f) => FAMILY_WORDS[f]);
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} or ${words[words.length - 1]}`;
}

export interface CableFit {
  /** False when the cable cannot be terminated in this connector as it is. */
  fits: boolean;
  /** Why not: one sentence each. Empty when it fits. */
  problems: string[];
  /** Things worth knowing that do not stop it fitting. */
  notes: string[];
}

const fmt = (v: number): string => String(Math.round(v * 100) / 100);

function judge(connector: Connector, ways: number | undefined, accept: Accept, type: CableType, count: number): CableFit {
  const problems: string[] = [];
  const notes: string[] = [];
  if (accept.termination === 'per_contact') {
    const needed = type.conductors * count;
    if (ways === undefined) notes.push('The number of contacts at this port is not recorded, so the wire count is not checked.');
    else if (needed > ways) problems.push(`${needed} conductors for ${ways} contact${ways === 1 ? '' : 's'}.`);
    else if (needed < ways) notes.push(`${needed} of ${ways} contacts used.`);
    if (accept.awg) {
      const range = `${accept.awg.thickest} to ${accept.awg.thinnest} AWG`;
      if (type.awg === undefined) notes.push(`The contacts take ${range}; this cable type has no gauge recorded.`);
      else if (type.awg < accept.awg.thickest) problems.push(`${type.awg} AWG is thicker than the contacts take (${range}).`);
      else if (type.awg > accept.awg.thinnest) problems.push(`${type.awg} AWG is thinner than the contacts take (${range}).`);
    }
    if (accept.od_max_mm !== undefined && type.conductors === 1 && type.section.shape === 'round' && type.section.od_mm > accept.od_max_mm + 1e-9) {
      problems.push(`Insulation of ${fmt(type.section.od_mm)} mm is wider than the housing takes (${fmt(accept.od_max_mm)} mm).`);
    }
  } else {
    if (count !== 1) problems.push(`One cable goes into this connector, not ${count}.`);
    if (type.section.shape === 'flat') {
      if (ways !== undefined && type.conductors !== ways) problems.push(`A ${type.conductors}-way cable in a ${ways}-way connector.`);
      const pitch = accept.cable_pitch_mm ?? connector.pitch_mm;
      if (pitch !== undefined) {
        if (type.pitch_mm === undefined) notes.push(`The connector takes ${fmt(pitch)} mm pitch; this cable type has no pitch recorded.`);
        else if (Math.abs(type.pitch_mm - pitch) > 0.01) problems.push(`Cable pitch ${fmt(type.pitch_mm)} mm; the connector takes ${fmt(pitch)} mm.`);
      }
    } else if (accept.od_max_mm !== undefined && type.section.od_mm > accept.od_max_mm + 1e-9) {
      problems.push(`The cable is ${fmt(type.section.od_mm)} mm across; the connector takes up to ${fmt(accept.od_max_mm)} mm.`);
    }
  }
  if (accept.note) notes.push(accept.note);
  return { fits: problems.length === 0, problems, notes };
}

/**
 * Can `count` cables of `type`, laid together, be terminated in `connector`
 * with `ways` contacts?
 *
 * A ready-made lead (family `harness` or `jumper`) already has its plugs on:
 * it fits only the connector families its type lists in `connectors`, however
 * well its wires would suit another. This is checked first.
 *
 * Otherwise a connector may take several kinds of cable; the kind that suits
 * this cable best (fewest problems, the first listed on a tie) is the one
 * judged. A connector with nothing recorded about what it takes fits
 * everything, with a note saying it was not checked.
 */
export function cableFit(connector: Connector, ways: number | undefined, type: CableType, count: number): CableFit {
  if ((type.family === 'harness' || type.family === 'jumper') && type.connectors.length > 0 && !type.connectors.includes(connector.id)) {
    return { fits: false, problems: [`This lead comes with plugs for ${type.connectors.join(', ')}, not for ${connector.name}.`], notes: [] };
  }
  if (connector.accepts.length === 0) {
    return { fits: true, problems: [], notes: [`The library does not record which cables ${connector.name} takes, so this was not checked.`] };
  }
  const candidates = connector.accepts.filter((a) => a.families.includes(type.family));
  if (candidates.length === 0) {
    return { fits: false, problems: [`${connector.name} does not take ${FAMILY_WORDS[type.family]}. It takes ${acceptedFamilies(connector)}.`], notes: [] };
  }
  let best: CableFit | undefined;
  for (const accept of candidates) {
    const fit = judge(connector, ways, accept, type, count);
    if (!best || fit.problems.length < best.problems.length) best = fit;
  }
  return best!;
}
