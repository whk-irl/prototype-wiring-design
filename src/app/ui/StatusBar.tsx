/** The status bar: what is under the pointer on the left; the model's size, units, up axis and a summary of the wire checks on the right. */
import { useMemo } from 'react';
import { useApp } from '../state/store';
import { fmtMm } from '../units';
import { StatusIcon } from './StatusIcon';
import { wireVerdict } from './wireStatus';

function HoverReadout() {
  const hover = useApp((s) => s.hover);
  const linkName = useApp((s) => (s.hover ? s.design.scene.links.find((l) => l.id === s.hover!.linkId)?.name : undefined));
  const ph = useApp((s) => s.portHover);
  const compName = useApp((s) => (s.portHover ? s.design.components.find((c) => c.id === s.portHover!.componentId)?.name : undefined));
  if (ph)
    return (
      <span className="status-item ellipsis" aria-live="off">
        <span className="muted">port</span> {ph.portId} <span className="muted">on</span> {compName || ph.componentId}
      </span>
    );
  if (!hover) return <span className="status-item muted ellipsis">Hover the model for details</span>;
  const [x, y, z] = hover.point;
  return (
    <span className="status-item ellipsis num" aria-live="off" title={`mesh ${hover.meshId}, link ${linkName || hover.linkId}, triangle ${hover.triangle}`}>
      <span className="muted">mesh</span> {hover.meshId} <span className="muted">link</span> {linkName || hover.linkId} <span className="muted">tri</span> {hover.triangle}{' '}
      <span className="muted">at</span> {fmtMm(x)}, {fmtMm(y)}, {fmtMm(z)}
    </span>
  );
}

/** Fails and warnings across all wires; a click selects the first wire that fails (else the first with a warning). */
function CheckSummary() {
  const checks = useApp((s) => s.wireChecks);
  const cables = useApp((s) => s.design.cables);
  const sum = useMemo(() => {
    let fail = 0;
    let warn = 0;
    let checking = 0;
    let firstFail: string | null = null;
    let firstWarn: string | null = null;
    for (const c of cables) {
      const v = wireVerdict(checks[c.id]);
      if (v === 'fail') {
        fail++;
        firstFail ??= c.id;
      } else if (v === 'warn') {
        warn++;
        firstWarn ??= c.id;
      } else if (v === 'checking') checking++;
    }
    return { fail, warn, checking, target: firstFail ?? firstWarn };
  }, [checks, cables]);
  if (cables.length === 0) return null;
  const verdict = sum.fail ? 'fail' : sum.warn ? 'warn' : sum.checking ? 'checking' : 'ok';
  const text =
    [
      sum.checking ? `Checking ${sum.checking} wire${sum.checking === 1 ? '' : 's'}` : '',
      sum.fail ? `${sum.fail} wire${sum.fail === 1 ? ' fails' : 's fail'}` : '',
      sum.warn ? `${sum.warn} warning${sum.warn === 1 ? '' : 's'}` : '',
    ]
      .filter(Boolean)
      .join(', ') || 'All wires pass';
  return (
    <button
      type="button"
      className={`check-chip ${verdict}`}
      disabled={!sum.target}
      onClick={() => sum.target && useApp.getState().select({ kind: 'cable', id: sum.target })}
      title={sum.target ? 'Select the first wire that needs attention' : sum.checking ? 'The wires are being checked' : 'Every wire passes its checks at this pose'}
    >
      <StatusIcon verdict={verdict} size={13} />
      {text}
    </button>
  );
}

export function StatusBar() {
  const tris = useApp((s) => s.triangleCount);
  const pending = useApp((s) => s.bvhPending);
  const progress = useApp((s) => s.progress);
  return (
    <footer className="statusbar">
      <HoverReadout />
      <span className="status-spacer" />
      {progress && (
        <span className="status-item num">
          {progress.label} {Math.round(progress.fraction * 100)}%
        </span>
      )}
      {pending > 0 && <span className="status-item muted num">Building pick index ({pending} left)</span>}
      <CheckSummary />
      <span className="status-item num">{tris.toLocaleString()} triangles</span>
      <span className="status-item">mm</span>
      <span className="status-item muted">Z up</span>
    </footer>
  );
}
