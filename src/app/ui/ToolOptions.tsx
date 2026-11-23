/** Floating option bars for the active tool, and the port tooltip. */
import { findPart } from '@core';
import { portLabel } from './partText';
import { wrapAngle } from '../placement/pose';
import { useApp } from '../state/store';
import { fmt, RAD2DEG } from '../units';
import { ZoneSwatch } from './ZoneList';

function NumberField({ label, value, min, max, step, unit, onChange }: { label: string; value: number; min: number; max: number; step: number; unit: string; onChange: (v: number) => void }) {
  return (
    <label className="opt-field">
      <span>{label}</span>
      <input
        className="num"
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v)));
        }}
      />
      <span className="unit">{unit}</span>
    </label>
  );
}

function ZoneOptions() {
  const t = useApp((s) => s.zoneTool);
  const set = useApp.getState().setZoneTool;
  return (
    <div className="tool-options" role="toolbar" aria-label="Area painting options">
      <div className="seg" role="group" aria-label="Kind of area">
        <button type="button" aria-pressed={t.kind === 'mount_allowed'} onClick={() => set({ kind: 'mount_allowed' })}>
          <ZoneSwatch kind="mount_allowed" /> Parts may go here
        </button>
        <button type="button" aria-pressed={t.kind === 'keep_out'} onClick={() => set({ kind: 'keep_out' })}>
          <ZoneSwatch kind="keep_out" /> Keep clear
        </button>
      </div>
      <div className="seg" role="group" aria-label="Paint mode">
        <button type="button" aria-pressed={t.mode === 'face'} onClick={() => set({ mode: 'face' })} title="Click floods one face">
          Face
        </button>
        <button type="button" aria-pressed={t.mode === 'brush'} onClick={() => set({ mode: 'brush' })} title="Drag to paint within a radius">
          Brush
        </button>
      </div>
      <button type="button" aria-pressed={t.erase} onClick={() => set({ erase: !t.erase })} title="Erase (or hold Alt while painting)">
        Erase
      </button>
      {t.mode === 'brush' ? (
        <NumberField label="Radius" value={t.radiusMm} min={0.1} max={1000} step={0.5} unit="mm" onChange={(v) => set({ radiusMm: v })} />
      ) : (
        <NumberField label="Crease" value={t.creaseDeg} min={0} max={90} step={1} unit="°" onChange={(v) => set({ creaseDeg: v })} />
      )}
      <span className="opt-hint">{t.mode === 'face' ? 'Click a face' : 'Drag over the surface'}. Alt erases.</span>
    </div>
  );
}

function PlaceOptions() {
  const partId = useApp((s) => s.placingPart);
  const library = useApp((s) => s.library);
  const spin = useApp((s) => s.placeSpin);
  const warnings = useApp((s) => s.placeWarnings);
  const part = partId && library ? findPart(library, partId) : undefined;
  if (!part) return null;
  return (
    <div className="tool-options" role="toolbar" aria-label="Placement options">
      <span>
        Placing <strong>{part.name}</strong>
      </span>
      <span>Rotation {fmt(spin * RAD2DEG, 0)}°</span>
      <button type="button" onClick={() => useApp.setState((s) => ({ placeSpin: wrapAngle(s.placeSpin + Math.PI / 12) }))} aria-label="Rotate 15 degrees">
        Rotate 15°
      </button>
      {warnings.length > 0 ? (
        <span className="opt-hint warn-text" role="status">
          {warnings[0]}
        </span>
      ) : (
        <span className="opt-hint">Click to place. R turns, Shift+click places another, Esc cancels.</span>
      )}
      <button type="button" onClick={() => useApp.getState().startPlacing(null)}>
        Cancel
      </button>
    </div>
  );
}

/** Option bars for tools that have options. Instructions for the others are in the tool pill (ViewportOverlays.tsx). */
export function ToolOptions() {
  const tool = useApp((s) => s.activeTool);
  if (tool === 'zones') return <ZoneOptions />;
  if (tool === 'place') return <PlaceOptions />;
  return null;
}

export function PortTooltip() {
  const ph = useApp((s) => s.portHover);
  const comp = useApp((s) => (ph ? s.design.components.find((c) => c.id === ph.componentId) : undefined));
  const library = useApp((s) => s.library);
  const connectors = useApp((s) => s.connectorLibrary);
  if (!ph || !comp || !library) return null;
  const port = findPart(library, comp.part)?.ports.find((p) => p.id === ph.portId);
  if (!port) return null;
  return (
    <div className="port-tip" style={{ left: ph.x + 14, top: ph.y + 14 }} role="tooltip">
      <div>
        <strong>{port.id}</strong> <span className="muted">on {comp.name}</span>
      </div>
      <div>{portLabel(port, connectors)}</div>
      <div>
        <span className="muted">interfaces</span> {port.interfaces.join(', ')}
      </div>
    </div>
  );
}
