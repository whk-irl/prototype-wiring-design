/**
 * Checks on the free cable where a route crosses from one link to the next
 * (a joint crossing). The length is the joint-slack model's in core
 * (`crossingSlack`): one free length per crossing. Its shape at each pose
 * sampled across the joints' range is the settled stiff wire (settle.ts:
 * cut mode from the `relaxSpan` loop, ends held along their directions,
 * gravity when the sag length is known, resting on the model and the parts
 * at that pose): what is drawn is what is checked.
 *
 *  - Reach: too short at some pose (only with a stated slack that is too
 *    small) -> fails, with the worst pose and how much it is short by.
 *  - Bend: the tightest settled loop over the sampled poses against the
 *    flexing limit (a crossing a joint moves) or the installed one; graded by
 *    where the limit comes from, as on links (derived/generic warn,
 *    datasheet/measured/user fail).
 *  - Fit: the settled loop goes round what it touches. Where it still ends
 *    pressing into the model, or did not settle, that is a WARNING ("the loop
 *    would press into ..."), not a failure.
 *  - Flat cables: a twist or a sideways shift across the joint the loop model
 *    does not cover -> warning. Thresholds below are judgement, not sourced.
 *  - Notes: approximate poses (solver stopped at its cap), unsampled joints,
 *    how far the loop stands out.
 */
import type { CableEnvelope, CrossingSlack, Design, Library, Route } from '@core';
import { loopEnds } from './settle';
import { bendGrade, crossingLoop, detourNotesOf, planOf, type BendGrade } from './checks';
import { detourBetween } from './detour';
import { pointsOfRoute } from './routeEdit';
import type { RodCable, WirePlan } from './settle';

/** Twist (degrees) a ribbon may be asked for across a joint before we warn. Judgement, not a sourced value. */
export const FLAT_TWIST_WARN_DEG = 15;
/** Sideways shift, as a fraction of the ribbon's width, before we warn. Judgement, not a sourced value. */
export const FLAT_SIDEWAYS_WARN_FRACTION = 0.5;

export interface CrossingReport {
  index: number;
  joints: string[];
  unsampled: string[];
  chord_min_mm: number;
  chord_max_mm: number;
  free_length_mm: number;
  slack_mm: number;
  basis: 'auto' | 'user';
  reaches: boolean;
  /** Worst shortfall and the pose (joint values) where it happens; only when it does not reach. `round`: short of the way round the model there (its length given), not of the straight distance. */
  short?: { by_mm: number; values: Record<string, number>; round_mm?: number };
  /**
   * The longest way round the model over the sampled poses (the drape between
   * the two holds), when something is in the way: its length, the straight
   * distance at that pose, the pose, the links it goes round, and whether it
   * set the cut length (automatic slack).
   */
  detour?: { length_mm: number; chord_mm: number; values: Record<string, number>; around: string[]; setsLength: boolean };
  /** Sampled poses where the way round could not be worked out (the length does not account for the model there), with why. */
  detourFailed: Array<{ values: Record<string, number>; why: string }>;
  /** Sampled poses whose way round is still being worked out. */
  detourPending: number;
  /** A stated slack shared by several joints this loop crosses (the first one stated on the path is used). */
  sharedSlack?: string[];
  /** Straight distance between the loop's ends at the pose shown. */
  chordHere_mm: number;
  bend: {
    radius_mm: number;
    limit_mm: number;
    /** 'flexing': the dynamic limit (a joint moves it); 'installed': the static one. */
    kind: 'flexing' | 'installed';
    /**
     * The crossing moves but the type states no flexing figure: judged against the installed
     * one, which is not meant for a cable that keeps moving. Never a clean pass (at least a warning).
     */
    noFlexFigure: boolean;
    ok: boolean;
    grade: BendGrade;
    values: Record<string, number>;
  };
  /** Joint values of the tightest pose (for "Show tightest pose"). */
  tightestValues: Record<string, number>;
  bulge_mm: number;
  /** Sampled poses where the shape solver stopped at its cap (figures approximate there). */
  approximate: number;
  /** Sampled poses whose settled loop is still being worked out (the bend and fit are not known yet). */
  pending: number;
  /** Inputs the shape solver had to repair for this loop, in its words. */
  repaired: string[];
  twist_deg?: number;
  sideways_mm?: number;
  /** Flat cables: the twist / sideways warning, in words. */
  flatWarning?: string;
  /** Joints on the path that turn without limit (a cable winds up on them). */
  continuous: string[];
  /** Warning for those, in words. */
  continuousWarning?: string;
  /** Where the loop would press into the model, worst found. */
  press?: { what: string; depth_mm: number; values: Record<string, number> };
  /** fail (reach, firm bend limit), warn (size-rule bend limit, press, flat), or ok. */
  grade: BendGrade;
}

const RANK: Record<BendGrade, number> = { ok: 0, warn: 1, fail: 2 };
const worse = (a: BendGrade, b: BendGrade): BendGrade => (RANK[a] >= RANK[b] ? a : b);

/**
 * Every loop of a route (`crossings`: the slack model of the plan's derived
 * route), checked. `values` is the pose shown; the loop's fit is also checked
 * at the sampled poses that matter. `skipPress` leaves the (slower) fit part
 * out.
 */
export function crossingReports(
  design: Design,
  route: Route,
  env: CableEnvelope,
  crossings: readonly CrossingSlack[],
  values: Readonly<Record<string, number>>,
  opts: { skipPress?: boolean; rod?: RodCable; library?: Library | null; plan?: WirePlan; solve?: boolean } = {},
): CrossingReport[] {
  const plan = planOf(design, route, env, opts);
  const library = opts.library ?? null;
  const solve = opts.solve ?? false;
  const r = env.shape === 'flat' ? env.height_mm / 2 : env.width_mm / 2;
  const tol = Math.max(0.05, 0.03 * r);
  return crossings.map((c, index) => {
    // The loop at every sampled pose is the settled stiff wire (cut length, gravity, resting on what it touches).
    let tightIdx = c.tightest;
    let tightR = Infinity;
    let unconverged = 0;
    let pending = 0;
    const repaired = new Set<string>();
    let settledPress: { depth_mm: number; values: Record<string, number> } | null = null;
    // The settled loop costs up to a tenth of a second where it struggles: work it out at the poses that matter
    // (the range's ends, the tightest and the largest bulge of the quick loop), not at every sampled pose.
    const bulgiest = c.poses.reduce((w, p, i) => (p.bulge_mm > c.poses[w]!.bulge_mm ? i : w), 0);
    const picks = new Set([0, c.poses.length - 1, c.tightest, bulgiest].filter((i) => i >= 0 && i < c.poses.length));
    c.poses.forEach((pose, i) => {
      if (!picks.has(i)) return;
      const v = { ...values, ...pose.values };
      const loop = crossingLoop(design, plan, library, c.after_segment, c.free_length_mm, v, solve);
      if (loop.pending) pending++;
      if (!loop.settled) return;
      for (const r of loop.settled.repaired) repaired.add(r);
      if (!loop.settled.converged) unconverged++;
      if (loop.settled.min_radius_mm < tightR) {
        tightR = loop.settled.min_radius_mm;
        tightIdx = i;
      }
      const depth = loop.settled.worst_penetration_mm;
      if ((depth > tol || !loop.settled.converged) && (!settledPress || depth > settledPress.depth_mm)) settledPress = { depth_mm: depth, values: pose.values };
    });
    const tight = c.poses[tightIdx];
    const moves = c.joints.length > 0;
    const kind: 'flexing' | 'installed' = moves && env.bend_dynamic_mm !== undefined ? 'flexing' : 'installed';
    // Until the settled loops are known, the quick loop's figure (relaxSpan, no contact) stands in.
    if (tightR === Infinity && pending > 0 && c.poses[c.tightest]) tightR = c.poses[c.tightest]!.min_radius_mm;
    const bendOk = !c.reaches || tightR >= c.bend_limit_mm;
    const bend = {
      radius_mm: c.reaches ? tightR : Infinity,
      limit_mm: c.bend_limit_mm,
      kind,
      noFlexFigure: moves && env.bend_dynamic_mm === undefined,
      ok: bendOk,
      grade: bendGrade(bendOk, env.bend_source),
      values: tight?.values ?? {},
    };
    let grade: BendGrade = bend.grade;
    // Holding the installed limit is no evidence a cable survives flexing: never a clean pass.
    if (bend.noFlexFigure && bend.ok) grade = worse(grade, 'warn');
    let continuousWarning: string | undefined;
    if (c.continuous.length > 0) {
      continuousWarning =
        'This joint can turn without limit: a cable winds up on it. The figures cover half a turn each way only; beyond that the crossing needs a slip ring.';
      grade = worse(grade, 'warn');
    }
    let short: CrossingReport['short'];
    if (!c.reaches) {
      const worstShort = c.poses.reduce((w, p) => (p.short_by_mm > w.short_by_mm ? p : w), c.poses[0]!);
      const round = worstShort.detour_mm !== undefined && worstShort.detour_mm > c.free_length_mm;
      short = { by_mm: worstShort.short_by_mm, values: worstShort.values, ...(round ? { round_mm: worstShort.detour_mm } : {}) };
      grade = 'fail';
    }
    let detour: CrossingReport['detour'];
    if (c.detour_max_mm !== undefined) {
      const at = c.poses.find((p) => p.detour_mm === c.detour_max_mm) ?? c.poses[0]!;
      const pts = pointsOfRoute(plan.route);
      const a = pts[plan.runs[c.after_segment]?.holds.at(-1) ?? -1];
      const b = pts[plan.runs[c.after_segment + 1]?.holds[0] ?? -1];
      const d = a && b ? detourBetween(design, a, b, plan.rod.radius_mm, at.values, solve) : null;
      detour = {
        length_mm: c.detour_max_mm,
        chord_mm: at.chord_mm,
        values: at.values,
        around: d?.kind === 'round' ? d.around : [],
        setsLength: c.basis === 'auto' && c.detour_max_mm * 1.02 >= c.free_length_mm - 1e-6,
      };
    }
    const notes = detourNotesOf(c);
    const here = loopEnds(design, plan, c.after_segment, values);
    const chordHere = Math.hypot(here.b[0] - here.a[0], here.b[1] - here.a[1], here.b[2] - here.a[2]);
    let flatWarning: string | undefined;
    if (env.shape === 'flat' && c.twist_deg !== undefined && c.sideways_mm !== undefined) {
      const parts: string[] = [];
      if (c.twist_deg > FLAT_TWIST_WARN_DEG) parts.push(`twist ${c.twist_deg.toFixed(0)} degrees`);
      if (c.sideways_mm > FLAT_SIDEWAYS_WARN_FRACTION * env.width_mm) parts.push(`shift ${c.sideways_mm.toFixed(1)} mm sideways`);
      if (parts.length) {
        flatWarning = `The ribbon would have to ${parts.join(' and ')} across this joint, which the loop model does not cover: fold it or use round wire.`;
        grade = worse(grade, 'warn');
      }
    }
    let press: CrossingReport['press'];
    if (!opts.skipPress && c.reaches) {
      // The settled loop rests on what it touches; one that still presses in, or did not settle, is reported.
      const sp = settledPress as { depth_mm: number; values: Record<string, number> } | null;
      if (sp) press = { what: 'the model', depth_mm: sp.depth_mm, values: Object.fromEntries(c.joints.map((j) => [j, sp.values[j] ?? values[j] ?? 0])) };
      else {
        // The pose shown, which the sampled poses may not include.
        const loop = crossingLoop(design, plan, library, c.after_segment, c.free_length_mm, values, solve);
        if (loop.pending) pending++;
        const hit = loop.settled && (loop.settled.worst_penetration_mm > tol || !loop.settled.converged) ? loop.settled.worst_penetration_mm : null;
        if (hit !== null) press = { what: 'the model', depth_mm: hit, values: Object.fromEntries(c.joints.map((j) => [j, values[j] ?? 0])) };
      }
      if (press) grade = worse(grade, 'warn');
    }
    return {
      index,
      joints: c.joints,
      unsampled: c.unsampled,
      chord_min_mm: c.chord_min_mm,
      chord_max_mm: c.chord_max_mm,
      free_length_mm: c.free_length_mm,
      slack_mm: c.slack_mm,
      basis: c.basis,
      reaches: c.reaches,
      ...(short ? { short } : {}),
      ...(detour ? { detour } : {}),
      detourFailed: notes?.failed ?? [],
      chordHere_mm: chordHere,
      detourPending: notes?.pending ?? 0,
      ...(c.basis === 'user' && c.joints.length > 1 ? { sharedSlack: c.joints } : {}),
      bend,
      tightestValues: tight?.values ?? {},
      bulge_mm: c.bulge_mm,
      approximate: unconverged,
      pending,
      repaired: [...repaired],
      ...(c.twist_deg !== undefined ? { twist_deg: c.twist_deg } : {}),
      ...(c.sideways_mm !== undefined ? { sideways_mm: c.sideways_mm } : {}),
      ...(flatWarning ? { flatWarning } : {}),
      continuous: c.continuous,
      ...(continuousWarning ? { continuousWarning } : {}),
      ...(press ? { press } : {}),
      grade,
    };
  });
}

/** The worst grade over a route's crossings. */
export function crossingGrade(reports: readonly CrossingReport[]): BendGrade {
  return reports.reduce<BendGrade>((g, r) => worse(g, r.grade), 'ok');
}

/** A pose in words: "joint 2 = 35 deg, base = -10 deg" (revolute in degrees, prismatic in mm). */
export function poseText(design: Design, values: Readonly<Record<string, number>>): string {
  const parts = Object.entries(values).map(([id, v]) => {
    const j = design.scene.joints.find((x) => x.id === id);
    const name = j?.name || id;
    return j?.type === 'prismatic' ? `${name} = ${v.toFixed(1)} mm` : `${name} = ${((v * 180) / Math.PI).toFixed(0)} deg`;
  });
  return parts.length ? parts.join(', ') : 'any pose';
}

/** "1 pose", "3 poses". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

const mmText = (v: number, d = 1) => `${v.toFixed(d)} mm`;

/**
 * A loop's check in one line, worst news first: still being worked out, does
 * not reach, presses into the model, did not settle, way round not known,
 * then the bend. One short clause each; the bend always last.
 */
export function crossingHeadline(c: CrossingReport, checking = false): { verdict: 'checking' | 'fail' | 'warn' | 'ok'; text: string } {
  if (checking || c.pending > 0 || c.detourPending > 0) return { verdict: 'checking', text: 'working out the loop' };
  const clauses: string[] = [];
  let verdict: 'fail' | 'warn' | 'ok' = c.grade === 'fail' ? 'fail' : c.grade === 'warn' ? 'warn' : 'ok';
  if (!c.reaches && c.short) clauses.push(`${mmText(c.short.by_mm)} too short${c.short.round_mm !== undefined ? ' to get round the model' : ''}`);
  if (c.press) clauses.push(`presses ${mmText(c.press.depth_mm)} into ${c.press.what}`);
  if (c.approximate > 0) {
    clauses.push(`did not settle at ${plural(c.approximate, 'pose')}`);
    if (verdict === 'ok') verdict = 'warn';
  }
  if (c.detourFailed.length > 0) {
    clauses.push(`way round unknown at ${plural(c.detourFailed.length, 'pose')}`);
    if (verdict === 'ok') verdict = 'warn';
  }
  if (c.reaches) {
    const bend = `tightest ${Number.isFinite(c.bend.radius_mm) ? mmText(c.bend.radius_mm) : 'straight'}, limit ${mmText(c.bend.limit_mm)}`;
    clauses.push(c.bend.ok && c.bend.noFlexFigure ? `${bend}; no flexing limit known for this cable` : bend);
  }
  return { verdict, text: clauses.join('; ') };
}

/**
 * Why the loop is as long as it is, in plain words: "322 mm of cable so Base
 * yaw can turn from -170 to 170 degrees; at this pose 172 mm of it is spare".
 */
export function lengthWhy(design: Design, c: CrossingReport, jointName: (id: string) => string): string {
  const ranges = c.joints.map((id) => {
    const j = design.scene.joints.find((x) => x.id === id);
    const r = j && j.type !== 'continuous' && j.limit ? [j.limit.lower, j.limit.upper] : [-Math.PI, Math.PI];
    return j?.type === 'prismatic' ? `${jointName(id)} can move from ${r[0]!.toFixed(0)} to ${r[1]!.toFixed(0)} mm` : `${jointName(id)} can turn from ${((r[0]! * 180) / Math.PI).toFixed(0)} to ${((r[1]! * 180) / Math.PI).toFixed(0)} degrees`;
  });
  const spare = Math.max(0, c.free_length_mm - c.chordHere_mm);
  const why = ranges.length ? ` so ${ranges.join(' and ')}` : '';
  return `${mmText(c.free_length_mm, 0)} of cable${why}; at this pose ${mmText(spare, 0)} of it is spare`;
}
