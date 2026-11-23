/**
 * Wire options for one route ("design selection") and the cut list. Pure apart
 * from the geometry the fit check reads.
 */
import { cableEnvelope, cableStiffness, findCableType, type Cable, type CableBuild, type CableEnvelope, type CableLibrary, type CableType, type Design, type Library, type Route } from '@core';
import { crossingGrade, crossingReports, type CrossingReport } from './crossings';
import { fitAtPort, type PortInfo } from './ports';
import { rodOfEnvelope, wirePlan, type RodCable, type SegmentSettle, type WirePlan } from './settle';
import { bendReport, detourNotesOf, fitCheck, leadOutOf, lengthReport, wireShape, type BendGrade, type BendReport, type FitResult, type LengthReport, type OtherWire } from './checks';

export type Build = CableBuild;

/** The cable's build for another type: the user's bend override belongs to the cable's own type only. */
export function buildFor(cable: Cable, typeId: string): Build {
  const b: Build = { count: cable.count, twisted: cable.twisted, sleeve_wall_mm: cable.sleeve_wall_mm };
  if (cable.lay_length_mm !== undefined) b.lay_length_mm = cable.lay_length_mm;
  if (cable.bend_override_mm !== undefined && typeId === cable.type) b.bend_override_mm = cable.bend_override_mm;
  return b;
}

export interface CompareRow {
  typeId: string;
  name: string;
  family: string;
  /** One cable of the type: "1.30 mm" round or "4.0 x 1.3 mm" flat. */
  size: string;
  /** The bundle at the current count/twist/sleeve. */
  width_mm: number;
  height_mm: number;
  bend_static_mm: number;
  bend_dynamic_mm?: number;
  /** Tightest corner of THIS route on links for this type (its lift changes the centre line). */
  tightest_bend_mm: number;
  /** Tightest bend of the free cable over any joint crossing, over the sampled poses (Infinity: none). */
  joint_bend_min_mm: number;
  /** Every crossing holds its bend limit (flexing where a joint moves it). */
  joint_bend_ok: boolean;
  /** Worst verdict over the crossings: reach, bend, loop pressing into the model, ribbon twist. */
  crossing_grade: BendGrade;
  /** Flat types: corners where the route turns sideways in the surface (the cable must be folded there). */
  folds: number;
  /** False: the cut length is a lower bound (a crossing does not reach at some pose, or has unsampled joints). */
  complete: boolean;
  /** Whether the type can be terminated in the port(s) the wire is attached to; undefined: not attached. */
  port_fit?: boolean;
  port_problems: string[];
  bend_passes: boolean;
  /** ok, warn (breaks a size-rule limit) or fail (breaks a maker's, measured or user limit). */
  bend_grade: BendGrade;
  bend_source: CableEnvelope['bend_source'];
  /** Tightest clearance on THIS route; negative = collision. */
  clearance_mm: number;
  /** Clear of everything, on a settled shape (never on one still being worked out or one that did not settle). */
  fits: boolean;
  /** Why the figures are approximate: part of the shape is still being worked out, or did not settle (the drape stands in). Empty when settled. */
  approximate: string;
  cut_mm: number;
  mass_g?: number;
  confidence: CableType['confidence'];
  source?: string;
  notes: string[];
}

export function sizeText(t: CableType): string {
  return t.section.shape === 'round' ? `${t.section.od_mm.toFixed(2)} mm` : `${t.section.width_mm.toFixed(1)} x ${t.section.thickness_mm.toFixed(2)} mm`;
}

export interface WireEvaluation {
  env: CableEnvelope;
  lengths: LengthReport;
  bend: BendReport;
  fit: FitResult | null;
  /** Joint crossings, checked (reach, bend, loop fit, ribbon twist). */
  crossings: CrossingReport[];
  /** How the shape was arrived at: segments still being worked out, segments kept on their drape (and why), and what the stiff-wire model assumed. */
  settle: { pending: number; approximate: string[]; notes: string[]; settles: Array<SegmentSettle | null>; plan: WirePlan };
}

/** Everything about one wire with one type, at a pose. */
export function evaluateWire(
  design: Design,
  route: Route,
  type: CableType,
  build: Build,
  values: Readonly<Record<string, number>>,
  opts: { library?: Library | null; others?: readonly OtherWire[]; allowance_mm?: number; leadOut_mm?: number; skipFit?: boolean; skipCrossings?: boolean; solve?: boolean } = {},
): WireEvaluation {
  const env = cableEnvelope(type, build);
  const stiff = cableStiffness(type, build, env);
  const rod: RodCable = { ...rodOfEnvelope(env, stiff.sag_length_mm), lay_length_mm: stiff.lay_length_mm };
  const library = opts.library ?? null;
  const solve = opts.solve ?? false;
  const plan = wirePlan(design, library, route, rod, solve ? 'solve' : 'queue');
  const lengths = lengthReport(design, route, env, opts.allowance_mm ?? 10, plan, solve);
  const shape = wireShape(design, route, env, values, lengths.slack, { rod, library, plan, solve });
  const bend = bendReport(design, route, env, plan);
  const fit = opts.skipFit ? null : fitCheck(design, shape, env, values, { library: opts.library, others: opts.others, leadOut_mm: opts.leadOut_mm ?? leadOutOf(env) });
  const crossings = opts.skipCrossings ? [] : crossingReports(design, route, env, lengths.slack.crossings, values, { skipPress: opts.skipFit, rod, library, plan, solve });
  const settles = plan.settles;
  const approximate = settles.flatMap((st, k) => (st && !st.ok ? [settles.length > 1 ? `Stretch ${k + 1} (on ${plan.runs[k]!.link}): ${st.reason}.` : `${st.reason[0]!.toUpperCase()}${st.reason.slice(1)}.`] : []));
  const pending = settles.filter((x) => x === null).length + crossings.reduce((n, c) => n + c.pending, 0) + lengths.slack.crossings.reduce((n, c) => n + (detourNotesOf(c)?.pending ?? 0), 0);
  return { env, lengths, bend, fit, crossings, settle: { pending, approximate, notes: stiff.notes, settles, plan } };
}

export function compareRow(
  design: Design,
  route: Route,
  type: CableType,
  build: Build,
  values: Readonly<Record<string, number>>,
  opts: { library?: Library | null; others?: readonly OtherWire[]; allowance_mm?: number; leadOut_mm?: number; jointName?: (id: string) => string; ports?: readonly PortInfo[]; solve?: boolean } = {},
): CompareRow {
  const ev = evaluateWire(design, route, type, build, values, opts);
  return {
    typeId: type.id,
    name: type.name,
    family: type.family,
    size: sizeText(type),
    width_mm: ev.env.width_mm,
    height_mm: ev.env.height_mm,
    bend_static_mm: ev.env.bend_static_mm,
    ...(ev.env.bend_dynamic_mm !== undefined ? { bend_dynamic_mm: ev.env.bend_dynamic_mm } : {}),
    tightest_bend_mm: ev.bend.tightest_mm,
    folds: ev.bend.folds.length,
    joint_bend_min_mm: Math.min(Infinity, ...ev.crossings.map((c) => c.bend.radius_mm)),
    joint_bend_ok: ev.crossings.every((c) => c.bend.ok),
    crossing_grade: crossingGrade(ev.crossings),
    complete: ev.lengths.complete,
    ...portFitOf(opts.ports ?? [], type, build.count),
    bend_passes: ev.bend.grade === 'ok',
    bend_grade: ev.bend.grade,
    bend_source: ev.bend.source,
    clearance_mm: ev.fit!.tightest_mm,
    fits: ev.fit!.fits && ev.settle.pending === 0 && ev.settle.approximate.length === 0,
    approximate:
      ev.settle.pending > 0
        ? 'the shape was still being worked out'
        : ev.settle.approximate.length > 0 || ev.crossings.some((c) => c.approximate > 0)
          ? 'part of the shape did not settle, so it was judged on the drape'
          : '',
    cut_mm: ev.lengths.cut_mm,
    ...(type.mass_g_per_m !== undefined ? { mass_g: (type.mass_g_per_m * build.count * ev.lengths.cut_mm) / 1000 } : {}),
    confidence: type.confidence,
    ...(type.source ? { source: type.source } : {}),
    notes: wireNotes(ev, opts.jointName),
  };
}

/** Whether a type fits every port the wire is attached to (true when it is attached to none). */
export function fitsPorts(ports: readonly PortInfo[], type: CableType, count: number): boolean {
  return ports.every((p) => fitAtPort(p, type, count).problems.length === 0);
}

function portFitOf(ports: readonly PortInfo[], type: CableType, count: number): { port_fit?: boolean; port_problems: string[] } {
  if (ports.length === 0) return { port_problems: [] };
  const problems = ports.flatMap((p) => fitAtPort(p, type, count).problems.map((x) => `${p.port.name ?? p.port.id}: ${x}`));
  return { port_fit: problems.length === 0, port_problems: problems };
}

/** Why the cut length is only a lower bound, in words; empty when it is complete. */
export function incompleteReason(lengths: LengthReport, jointName: (id: string) => string = (id) => id): string {
  const parts: string[] = [];
  for (const c of lengths.slack.crossings) {
    const over = c.joints.map(jointName).join(', ') || 'a fixed joint';
    if (!c.reaches) parts.push(`the crossing over ${over} does not reach at some pose`);
    if (c.unsampled.length) parts.push(`the crossing over ${over} was not swept over ${c.unsampled.map(jointName).join(', ')}`);
    if (c.continuous.length) parts.push(`${c.continuous.map(jointName).join(', ')} turns without limit (figures cover half a turn each way; beyond that a slip ring is needed)`);
  }
  return parts.join('; ');
}

/** Slack over all crossings (free length beyond the longest straight distance). */
export function totalSlack(lengths: LengthReport): number {
  return lengths.slack.crossings.reduce((t, c) => t + c.slack_mm, 0);
}

/**
 * Everything uncertain about a wire's numbers, in plain words: the envelope's
 * notes (assumed lay length, user bend radius...), a cut length that is only a
 * lower bound and why, crossing notes (approximate poses, unsampled joints, how
 * far a loop stands out), flat-cable folds, and meshes whose inside could not
 * be told for sure.
 */
export function wireNotes(ev: WireEvaluation, jointName: (id: string) => string = (id) => id): string[] {
  const notes = [...ev.env.notes];
  if (!ev.lengths.complete) notes.push(`The cut length is a LOWER BOUND: ${incompleteReason(ev.lengths, jointName)}.`);
  for (const c of ev.lengths.slack.crossings) {
    const over = c.joints.map(jointName).join(', ') || 'a fixed joint';
    if (c.unsampled.length > 0) notes.push(`The crossing over ${over} was swept over only three joints; ${c.unsampled.map(jointName).join(', ')} stayed at the saved value, so its range may be too narrow.`);
    if (c.joints.length > 0 && c.bulge_mm > 0.5) notes.push(`Crossing over ${over}: the loop stands out up to ${c.bulge_mm.toFixed(1)} mm from the straight line between its ends.`);
  }
  const repaired = new Set([...ev.settle.settles.flatMap((st) => st?.line?.repaired ?? []), ...ev.crossings.flatMap((c) => c.repaired)]);
  if (repaired.size > 0) notes.push(`The shape solver had to repair its input: ${[...repaired].join('; ')}.`);
  if (ev.bend.folds.length > 0) {
    notes.push(`${ev.bend.folds.length} corner${ev.bend.folds.length === 1 ? '' : 's'} turn sideways in the surface: a flat cable must be folded there, or the route changed.`);
  }
  if (ev.fit && ev.fit.uncertainMeshes.length > 0) {
    notes.push(`Not watertight near the wire: ${ev.fit.uncertainMeshes.join(', ')}. Inside or outside there was decided by a majority of five rays and may be wrong.`);
  }
  return notes;
}

export type SortKey = keyof Pick<CompareRow, 'name' | 'family' | 'width_mm' | 'bend_static_mm' | 'tightest_bend_mm' | 'joint_bend_min_mm' | 'clearance_mm' | 'cut_mm' | 'mass_g'>;

const GRADE_RANK: Record<BendGrade, number> = { ok: 0, warn: 1, fail: 2 };

/** Sort; by the bend here, rows order by verdict first (ok, warns, fails), then by radius. */
export function sortRows(rows: readonly CompareRow[], key: SortKey, asc: boolean): CompareRow[] {
  const v = (r: CompareRow) => r[key] ?? (asc ? Infinity : -Infinity);
  return [...rows].sort((a, b) => {
    if (key === 'tightest_bend_mm' && a.bend_grade !== b.bend_grade) {
      const g = GRADE_RANK[a.bend_grade] - GRADE_RANK[b.bend_grade];
      return asc ? g : -g;
    }
    const x = v(a);
    const y = v(b);
    const c = typeof x === 'string' && typeof y === 'string' ? x.localeCompare(y) : (x as number) - (y as number);
    return asc ? c : -c;
  });
}

// ---------------------------------------------------------------- cut list

export interface CutListEntry {
  cable: Cable;
  type?: CableType;
  /** The length to cut: the user's when set, else the computed one. */
  cut_mm?: number;
  /** The computed requirement (route length with each crossing's free length, x factor, + allowances). */
  required_mm?: number;
  status: string;
  /** Joint crossings on the route. */
  crossings?: number;
  /** Slack over all crossings. */
  slack_mm?: number;
  /** Tightest bend over the crossings (Infinity or undefined: none). */
  joint_bend_min_mm?: number;
  /** Empty: the length is complete. Otherwise why it is only a lower bound. */
  incomplete?: string;
  /** Why the length is not final (the shape is still being worked out, or did not settle); empty when it is. */
  approximate?: string;
  /** The ports the two ends are attached to, in words ("Controller / I2C: JST SH 4-way"). */
  from_port?: string;
  to_port?: string;
  /** Lay length assumed because none was given. */
  lay_assumed_mm?: number;
  notes?: string[];
}

const csvCell = (v: string | number | undefined) => {
  const s = v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** How far to trust a cut length, in words. */
export function lengthBasis(e: Pick<CutListEntry, 'cable' | 'cut_mm' | 'required_mm' | 'crossings' | 'slack_mm' | 'incomplete' | 'approximate'>): string {
  const parts: string[] = [];
  if (e.cable.length_mm !== undefined) {
    parts.push(e.required_mm !== undefined && e.cable.length_mm < e.required_mm ? 'set by user, SHORTER than required' : 'set by user');
  }
  const n = e.crossings ?? 0;
  if (e.approximate) parts.push(e.approximate);
  if (e.incomplete) parts.push(`lower bound: ${e.incomplete}`);
  else if (n > 0) parts.push(`with ${n} joint crossing${n === 1 ? '' : 's'} at their free length (slack ${(e.slack_mm ?? 0).toFixed(1)} mm)`);
  else if (e.required_mm !== undefined) parts.push('on links only');
  return parts.join('; ');
}

/** Cut list as CSV: one line per wire, then totals per cable type (wire length = cut x count). */
export function cutListCsv(entries: readonly CutListEntry[]): string {
  const lines = [
    ['wire', 'name', 'type', 'type_name', 'count', 'twisted', 'cut_length_mm', 'total_wire_mm', 'required_mm', 'length_basis', 'crossings', 'slack_mm', 'joint_bend_min_mm', 'lay_assumed_mm', 'from_port', 'to_port', 'status', 'notes'].join(','),
  ];
  const totals = new Map<string, { name: string; wire_mm: number; wires: number }>();
  for (const e of entries) {
    const total = e.cut_mm !== undefined ? e.cut_mm * e.cable.count : undefined;
    lines.push(
      [
        e.cable.id,
        e.cable.name ?? '',
        e.cable.type,
        e.type?.name ?? '(not in library)',
        e.cable.count,
        e.cable.twisted ? 'yes' : 'no',
        e.cut_mm !== undefined ? e.cut_mm.toFixed(1) : '',
        total !== undefined ? total.toFixed(1) : '',
        e.required_mm !== undefined ? e.required_mm.toFixed(1) : '',
        lengthBasis(e),
        e.crossings ?? '',
        e.slack_mm !== undefined ? e.slack_mm.toFixed(1) : '',
        e.joint_bend_min_mm !== undefined && Number.isFinite(e.joint_bend_min_mm) ? e.joint_bend_min_mm.toFixed(1) : '',
        e.lay_assumed_mm !== undefined ? e.lay_assumed_mm.toFixed(1) : '',
        e.from_port ?? '',
        e.to_port ?? '',
        e.status,
        (e.notes ?? []).join(' | '),
      ]
        .map(csvCell)
        .join(','),
    );
    if (total !== undefined) {
      const t = totals.get(e.cable.type) ?? { name: e.type?.name ?? e.cable.type, wire_mm: 0, wires: 0 };
      t.wire_mm += total;
      t.wires += 1;
      totals.set(e.cable.type, t);
    }
  }
  lines.push('');
  lines.push(['total_for_type', 'type_name', 'wires', 'total_wire_mm'].join(','));
  for (const [id, t] of totals) lines.push([id, t.name, t.wires, t.wire_mm.toFixed(1)].map(csvCell).join(','));
  return `${lines.join('\n')}\n`;
}

/** The library type of a cable, if present. */
export function typeOf(lib: CableLibrary | null, cable: Cable): CableType | undefined {
  return lib ? findCableType(lib, cable.type) : undefined;
}
