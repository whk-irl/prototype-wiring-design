/** A wire's checks in one word, for rows, chips and the status bar. Pure. */
import type { AppState } from '../state/store';

export type WireVerdict = 'checking' | 'unknown' | 'fail' | 'warn' | 'ok';
type WireStatus = AppState['wireChecks'][string];

export function wireVerdict(st: WireStatus | undefined): WireVerdict {
  if (!st) return 'checking';
  if (!st.known) return 'unknown';
  // Anything it depends on changed and it has not been checked again, or its shape is still being worked out: nothing reads as passing.
  if (st.stale || st.shapePending) return 'checking';
  const cr = st.crossings ?? [];
  const fail =
    !st.fits ||
    st.bendGrade === 'fail' ||
    st.crossingGrade === 'fail' ||
    (st.ends ?? []).some((e) => e.problems.length > 0) ||
    cr.some((c) => !c.reaches) ||
    !!st.cutTooShort;
  if (fail) return 'fail';
  const warn =
    !!st.shapeApproximate ||
    st.bendGrade === 'warn' ||
    st.crossingGrade === 'warn' ||
    (st.keepClear ?? []).length > 0 ||
    (st.folds ?? []).length > 0 ||
    (st.ends ?? []).some((e) => e.detached) ||
    cr.some((c) => c.press || c.continuousWarning || c.flatWarning || c.bend.noFlexFigure || (c.reaches && !c.bend.ok));
  return warn ? 'warn' : 'ok';
}

export const VERDICT_WORD: Record<WireVerdict, string> = {
  checking: 'Checking',
  unknown: 'Unknown type',
  fail: 'Fails',
  warn: 'Warning',
  ok: 'OK',
};
