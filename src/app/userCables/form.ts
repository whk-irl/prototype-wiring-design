/**
 * The "Add your own cable" form as data: which fields each kind of cable
 * asks for, reading what was typed (plain decimal numbers only), turning it
 * into a `CableSpecInput`, and turning what goes wrong into plain sentences
 * naming the field. Pure.
 */
import { ZodError } from 'zod';
import {
  ASSUMED_FFC_THICKNESS_MM,
  ASSUMED_RIBBON_127_THICKNESS_MM,
  cableTypeFromSpec,
  WIRE_ESTIMATE_AWG,
  type CableSpecInput,
  type CableType,
} from '@core';

export type CableKind = 'wire' | 'round_cable' | 'ribbon' | 'ffc' | 'fpc';

export const KIND_LABEL: Record<CableKind, string> = {
  wire: 'Single wire',
  round_cable: 'Round cable (several conductors)',
  ribbon: 'Ribbon cable',
  ffc: 'Flat flex cable (FFC)',
  fpc: 'Flexible printed circuit (FPC)',
};

export interface FieldDef {
  key: string;
  label: string;
  unit?: string;
  /** Integer field. */
  int?: boolean;
  /** Optional: what happens when it is left empty. Absent: required. */
  empty?: string;
  /** Help under the field. */
  help?: string;
  /** Only shown when another field says so. */
  when?: (v: Readonly<Record<string, string>>) => boolean;
}

/** The figures each kind needs, in order. The common fields (name, maker...) are separate. */
export function fieldsFor(kind: CableKind): FieldDef[] {
  switch (kind) {
    case 'wire':
      return [
        { key: 'awg', label: 'Gauge', unit: 'AWG', int: true },
        {
          key: 'od_mm',
          label: 'Outer diameter',
          unit: 'mm',
          empty: `estimated from the gauge (for ${WIRE_ESTIMATE_AWG.finest} to ${WIRE_ESTIMATE_AWG.heaviest} AWG, or any gauge when you give the insulation wall)`,
        },
        { key: 'wall_mm', label: 'Insulation wall', unit: 'mm', empty: 'the wall of UL 1007 hook-up wire is assumed', when: (v) => !v.od_mm?.trim() },
      ];
    case 'round_cable':
      return [
        { key: 'conductors', label: 'Conductors', int: true },
        { key: 'od_mm', label: 'Outer diameter', unit: 'mm', help: 'Over the jacket. Measure it or read it from the datasheet: it is not estimated for a cable of several conductors.' },
        { key: 'awg', label: 'Gauge of each conductor', unit: 'AWG', int: true, empty: 'not recorded; the gauge check at connectors is skipped' },
      ];
    case 'ribbon':
      return [
        { key: 'ways', label: 'Ways', int: true },
        { key: 'pitch_mm', label: 'Pitch', unit: 'mm' },
        {
          key: 'thickness_mm',
          label: 'Thickness',
          unit: 'mm',
          empty: `assumed ${ASSUMED_RIBBON_127_THICKNESS_MM} mm only for 1.27 mm pitch with 28 AWG wires or no gauge given; needed otherwise`,
        },
        { key: 'awg', label: 'Gauge of each wire', unit: 'AWG', int: true, empty: 'not recorded' },
      ];
    case 'ffc':
      return [
        { key: 'ways', label: 'Ways', int: true },
        { key: 'pitch_mm', label: 'Pitch', unit: 'mm' },
        { key: 'thickness_mm', label: 'Thickness', unit: 'mm', empty: `assumed about ${ASSUMED_FFC_THICKNESS_MM} mm, the thickness flat flex connectors are made for` },
        { key: 'width_mm', label: 'Width', unit: 'mm', empty: '(ways + 1) x pitch, the width of a standard tail, is worked out' },
      ];
    case 'fpc':
      return [
        { key: 'ways', label: 'Ways', int: true },
        { key: 'pitch_mm', label: 'Pitch', unit: 'mm' },
        {
          key: 'thickness_mm',
          label: 'Thickness where it bends',
          unit: 'mm',
          help: "From the fab's stack-up, without stiffeners. Fabs commonly offer about 0.07 to 0.12 mm for one copper layer and 0.11 to 0.2 mm for two.",
        },
        { key: 'layers', label: 'Copper layers', int: true, empty: 'one layer' },
        {
          key: 'width_mm',
          label: 'Width',
          unit: 'mm',
          empty: '(ways + 1) x pitch is assumed, and the cable is marked as having an assumed size',
          help: 'An FPC is drawn to your own outline: give the width of the part that bends.',
        },
      ];
  }
}

export interface CommonFields {
  name: string;
  manufacturer: string;
  mpn: string;
  source: string;
  basis: 'datasheet' | 'measured';
  flexing: boolean;
  bend_static_mm: string;
  bend_dynamic_mm: string;
  round_family: 'multicore' | 'twisted_pair' | 'coax' | 'usb' | 'ethernet';
}

/**
 * Parameters the form does not show (current, mass, connectors, interfaces,
 * the user's own note): carried over from the cable being edited so an edit
 * never drops them.
 */
export type HiddenFields = Partial<Pick<CableSpecInput, 'max_current_a' | 'mass_g_per_m' | 'connectors' | 'interfaces' | 'note'>>;

export const COMMON_LABEL: Record<string, string> = {
  name: 'Name',
  manufacturer: 'Maker',
  mpn: 'Part number',
  source: 'Datasheet link',
  bend_static_mm: 'Bend radius, installed',
  bend_dynamic_mm: 'Bend radius, flexing in use',
  family: 'Kind of round cable',
  layers: 'Copper layers',
};

export const emptyCommon = (): CommonFields => ({
  name: '',
  manufacturer: '',
  mpn: '',
  source: '',
  basis: 'measured',
  flexing: false,
  bend_static_mm: '',
  bend_dynamic_mm: '',
  round_family: 'multicore',
});

const NUMBER = /^[+-]?(\d+([.,]\d*)?|[.,]\d+)$/;

/**
 * A typed number: digits with at most one decimal mark (a point or a comma),
 * an optional sign, nothing else. Undefined when empty; NaN for anything else
 * ("0x10", "1e3", "Infinity", and "1,000", where the comma could be a
 * thousands separator), which the problem list then names.
 */
export function parseNumber(text: string | undefined): number | undefined {
  const t = (text ?? '').trim();
  if (t === '') return undefined;
  if (!NUMBER.test(t)) return Number.NaN;
  // "1,000": a comma before exactly three digits may be a thousands separator. Refuse rather than guess.
  if (/^[+-]?\d+,\d{3}$/.test(t)) return Number.NaN;
  return Number(t.replace(',', '.'));
}

/** The spec the form describes (not yet checked). `hidden`: parameters carried over from the cable being edited. */
export function specFromForm(kind: CableKind, values: Readonly<Record<string, string>>, common: CommonFields, hidden: HiddenFields = {}): CableSpecInput {
  const opt = <K extends string>(key: K, v: number | string | undefined) => (v === undefined || v === '' ? {} : ({ [key]: v } as Record<K, number | string>));
  const base = {
    ...hidden,
    ...opt('name', common.name.trim()),
    ...opt('manufacturer', common.manufacturer.trim()),
    ...opt('mpn', common.mpn.trim()),
    ...opt('source', common.source.trim()),
    basis: common.basis,
    flexing: common.flexing,
    ...opt('bend_static_mm', parseNumber(common.bend_static_mm)),
    ...(common.flexing ? opt('bend_dynamic_mm', parseNumber(common.bend_dynamic_mm)) : {}),
  };
  const fields = Object.fromEntries(
    fieldsFor(kind)
      .filter((f) => !f.when || f.when(values))
      .flatMap((f) => {
        const v = parseNumber(values[f.key]);
        return v === undefined ? [] : [[f.key, v]];
      }),
  );
  switch (kind) {
    case 'wire':
      return { kind: 'wire', ...base, ...fields } as CableSpecInput;
    case 'round_cable':
      return { kind: 'round_cable', ...base, family: common.round_family, ...fields } as CableSpecInput;
    case 'ribbon':
      return { kind: 'ribbon', ...base, ...fields } as CableSpecInput;
    case 'ffc':
      return { kind: 'flat_flex', construction: 'ffc', ...base, ...fields } as CableSpecInput;
    case 'fpc':
      return { kind: 'flat_flex', construction: 'fpc', ...base, ...fields } as CableSpecInput;
  }
}

/** The form for a spec (editing): what was entered, and the parameters the form does not show. */
export function formFromSpec(spec: CableSpecInput): { kind: CableKind; values: Record<string, string>; common: CommonFields; hidden: HiddenFields } {
  const kind: CableKind = spec.kind === 'flat_flex' ? (spec.construction === 'fpc' ? 'fpc' : 'ffc') : spec.kind;
  const values: Record<string, string> = {};
  for (const f of fieldsFor(kind)) {
    const v = (spec as Record<string, unknown>)[f.key];
    // A one-layer FPC is the default: leave the field empty rather than show it as entered.
    if (typeof v === 'number' && !(f.key === 'layers' && v === 1)) values[f.key] = String(v);
  }
  const common: CommonFields = {
    ...emptyCommon(),
    name: spec.name ?? '',
    manufacturer: spec.manufacturer ?? '',
    mpn: spec.mpn ?? '',
    source: spec.source ?? '',
    basis: spec.basis ?? 'measured',
    flexing: spec.flexing ?? false,
    bend_static_mm: spec.bend_static_mm !== undefined ? String(spec.bend_static_mm) : '',
    bend_dynamic_mm: spec.bend_dynamic_mm !== undefined ? String(spec.bend_dynamic_mm) : '',
    round_family: spec.kind === 'round_cable' ? (spec.family ?? 'multicore') : 'multicore',
  };
  const hidden: HiddenFields = {
    ...(spec.max_current_a !== undefined ? { max_current_a: spec.max_current_a } : {}),
    ...(spec.mass_g_per_m !== undefined ? { mass_g_per_m: spec.mass_g_per_m } : {}),
    ...(spec.connectors?.length ? { connectors: spec.connectors } : {}),
    ...(spec.interfaces?.length ? { interfaces: spec.interfaces } : {}),
    ...(spec.note ? { note: spec.note } : {}),
  };
  return { kind, values, common, hidden };
}

/** The label of a spec field, for problem sentences. */
function fieldLabel(kind: CableKind, key: string): string {
  return fieldsFor(kind).find((f) => f.key === key)?.label ?? COMMON_LABEL[key] ?? key;
}

const UNIT: Record<string, string> = { od_mm: ' mm', wall_mm: ' mm', pitch_mm: ' mm', thickness_mm: ' mm', width_mm: ' mm', bend_static_mm: ' mm', bend_dynamic_mm: ' mm' };

/** One zod issue in plain words, naming the field. */
function issueText(kind: CableKind, issue: ZodError['issues'][number], spec: Readonly<Record<string, unknown>>): { field?: string; message: string } {
  const key = typeof issue.path[0] === 'string' ? issue.path[0] : undefined;
  const label = key ? fieldLabel(kind, key) : 'The cable';
  const unit = key ? (UNIT[key] ?? '') : '';
  const i = issue as { code: string; minimum?: number | bigint; maximum?: number | bigint; inclusive?: boolean; expected?: string; format?: string };
  const value = key ? spec[key] : undefined;
  let what: string;
  if (typeof value === 'number' && Number.isNaN(value)) what = 'must be a plain number such as 0.5 (digits, with one decimal point or comma)';
  else if (i.code === 'invalid_type' && value === undefined) what = 'is needed';
  else if (typeof value === 'number' && !Number.isInteger(value) && (i.expected === 'int' || i.code === 'invalid_type')) what = 'must be a whole number';
  else if (i.code === 'too_small') what = Number(i.minimum) === 0 && !i.inclusive ? 'must be more than 0' : `must be at least ${String(i.minimum)}${unit}`;
  else if (i.code === 'too_big') what = `must be at most ${String(i.maximum)}${unit}`;
  else if (i.code === 'invalid_format' && i.format === 'url') what = 'must be a web address starting with https://';
  else what = issue.message.charAt(0).toLowerCase() + issue.message.slice(1);
  return { ...(key ? { field: key } : {}), message: `${label} ${what}.` };
}

export interface FormResult {
  type?: CableType;
  derived: string[];
  problems: Array<{ field?: string; message: string }>;
  /** Plausibility warnings: the cable can still be saved. */
  warnings: Array<{ field?: string; message: string }>;
}

/** Figures that are allowed but probably a slip of the keyboard. */
function warningsFor(kind: CableKind, spec: CableSpecInput): FormResult['warnings'] {
  const out: FormResult['warnings'] = [];
  if ((kind === 'ffc' || kind === 'fpc') && spec.kind === 'flat_flex' && spec.thickness_mm !== undefined && spec.thickness_mm > 1) {
    out.push({ field: 'thickness_mm', message: `${spec.thickness_mm} mm is thick for flat flex: its thickness is tenths of a millimetre. Did you enter microns?` });
  }
  return out;
}

/** Build the cable the form describes: the type and the worked-out figures, or the problems in plain words. */
export function evaluateForm(kind: CableKind, values: Readonly<Record<string, string>>, common: CommonFields, id = 'custom-preview', hidden: HiddenFields = {}): FormResult {
  let spec: CableSpecInput;
  try {
    spec = specFromForm(kind, values, common, hidden);
  } catch (e) {
    return { derived: [], problems: [{ message: e instanceof Error ? e.message : String(e) }], warnings: [] };
  }
  const warnings = warningsFor(kind, spec);
  try {
    const { type, derived } = cableTypeFromSpec(spec, id);
    return { type, derived, problems: [], warnings };
  } catch (e) {
    if (e instanceof ZodError) return { derived: [], problems: e.issues.map((x) => issueText(kind, x, spec as Record<string, unknown>)), warnings };
    return { derived: [], problems: [{ message: e instanceof Error ? e.message : String(e) }], warnings };
  }
}
