/** Notices, the confirm dialog, the progress bar and the perf readout. */
import { useEffect, useRef, useState } from 'react';
import { useApp, type Notice, type UnitChoice } from '../state/store';
import { getViewport } from '../viewport/instance';
import type { FrameStats } from '../viewport/Viewport';
import { dialogKeys } from './Dialog';

const MAX_LINES = 6;

function NoticeCard({ notice }: { notice: Notice }) {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (notice.level !== 'info') return;
    const t = setTimeout(() => useApp.getState().dismissNotice(notice.id), 6000);
    return () => clearTimeout(t);
  }, [notice]);
  const lines = expanded ? notice.details : notice.details.slice(0, MAX_LINES);
  return (
    <div className={`notice notice-${notice.level}`} role={notice.level === 'error' ? 'alert' : 'status'}>
      <div className="notice-head">
        <span className="notice-level">{notice.level === 'error' ? 'Error' : notice.level === 'warning' ? 'Warning' : 'Info'}</span>
        <span className="notice-title">{notice.title}</span>
        <button type="button" className="icon-btn" aria-label="Dismiss" title="Dismiss" onClick={() => useApp.getState().dismissNotice(notice.id)}>
          <span className="x" aria-hidden="true" />
        </button>
      </div>
      {lines.length > 0 && (
        <ul className="notice-details">
          {lines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      )}
      {notice.details.length > MAX_LINES && (
        <button type="button" className="linkish" onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Show fewer' : `Show all ${notice.details.length}`}
        </button>
      )}
    </div>
  );
}

export function Notices() {
  const notices = useApp((s) => s.notices);
  if (notices.length === 0) return null;
  return (
    <div className="notices" aria-live="polite">
      {notices.map((n) => (
        <NoticeCard key={n.id} notice={n} />
      ))}
    </div>
  );
}

export function ConfirmDialog() {
  const confirm = useApp((s) => s.confirm);
  const okRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirm) okRef.current?.focus();
  }, [confirm]);
  if (!confirm) return null;
  return (
    <div className="modal-backdrop">
      <div
        className="modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-msg"
        onKeyDown={dialogKeys(() => confirm.resolve(false))}
      >
        <h2 id="confirm-title">{confirm.title}</h2>
        <p id="confirm-msg">{confirm.message}</p>
        <div className="modal-actions">
          <button type="button" onClick={() => confirm.resolve(false)}>
            Cancel
          </button>
          <button type="button" ref={okRef} className="danger" onClick={() => confirm.resolve(true)}>
            {confirm.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ProgressBar() {
  const progress = useApp((s) => s.progress);
  if (!progress) return null;
  return (
    <div className="progress" role="progressbar" aria-label={progress.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress.fraction * 100)}>
      <div className="progress-label">{progress.label}</div>
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${progress.fraction * 100}%` }} />
      </div>
    </div>
  );
}

export function PerfReadout() {
  const [stats, setStats] = useState<FrameStats>({ fps: 0, frameMs: 0, intervalMs: 0 });
  const tris = useApp((s) => s.triangleCount);
  useEffect(() => {
    const t = setInterval(() => {
      const v = getViewport();
      if (v) setStats(v.getStats());
    }, 250);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="perf" aria-live="off" data-fps={stats.fps.toFixed(1)}>
      <div>{tris.toLocaleString()} tri</div>
      <div>
        {stats.fps > 0 ? stats.fps.toFixed(1) : '-'} <span className="muted">fps</span>
      </div>
      <div>
        {stats.fps > 0 ? stats.intervalMs.toFixed(1) : '-'} <span className="muted">ms/frame</span>
      </div>
      <div>
        {stats.fps > 0 ? stats.frameMs.toFixed(2) : '-'} <span className="muted">ms cpu</span>
      </div>
      {stats.fps === 0 && <div className="muted">orbit to measure</div>}
    </div>
  );
}

const UNITS: Array<[UnitChoice, string]> = [
  ['mm', 'Millimetres (mm)'],
  ['cm', 'Centimetres (cm)'],
  ['m', 'Metres (m)'],
  ['inch', 'Inches (in)'],
];

/** Asks which unit an STL or OBJ file is in. Only shown for those formats. */
export function UnitDialog() {
  const req = useApp((s) => s.unitRequest);
  const [unit, setUnit] = useState<UnitChoice>('mm');
  const okRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (req) {
      setUnit('mm');
      okRef.current?.focus();
    }
  }, [req]);
  if (!req) return null;
  return (
    <div className="modal-backdrop">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="unit-title"
        onKeyDown={dialogKeys(() => req.resolve(null))}
      >
        <h2 id="unit-title">Units of {req.fileName}</h2>
        <p>STL and OBJ files do not say which unit they use. Choose the unit the model was drawn in.</p>
        <fieldset className="unit-choices">
          <legend className="sr-only">Length unit</legend>
          {UNITS.map(([u, label]) => (
            <label key={u}>
              <input type="radio" name="unit" value={u} checked={unit === u} onChange={() => setUnit(u)} /> {label}
            </label>
          ))}
        </fieldset>
        <div className="modal-actions">
          <button type="button" onClick={() => req.resolve(null)}>
            Cancel
          </button>
          <button type="button" ref={okRef} className="primary" onClick={() => req.resolve(unit)}>
            Import
          </button>
        </div>
      </div>
    </div>
  );
}
