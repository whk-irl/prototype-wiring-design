/** The joint editor panel: new joint from selected parts, or a new axis for an existing joint. */
import { useEffect, useState } from 'react';
import type { JointType } from '@core';
import {
  adoptSuggestion,
  applyEditAxis,
  axisToWorld,
  cancelDraft,
  createJointFromDraft,
  defaultLimits,
  draftAxisWorld,
  setDraftAxisWorldComponent,
  startPicking,
  startTypedAxis,
} from '../joints/editor';
import { draftKey, runSuggestions, type AxisSuggestionView } from '../joints/suggestions';
import { useApp, type JointDraft } from '../state/store';
import { fmt } from '../units';

export function Num({ label, value, digits = 3, onCommit, width }: { label: string; value: number; digits?: number; onCommit: (v: number) => void; width?: number }) {
  const [text, setText] = useState(fmt(value, digits));
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setText(fmt(value, digits));
  }, [value, digits, editing]);
  return (
    <input
      className="num"
      style={width ? { width } : undefined}
      type="text"
      inputMode="decimal"
      aria-label={label}
      title={label}
      value={text}
      onFocus={() => setEditing(true)}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        setEditing(false);
        const v = Number(text.replace(',', '.'));
        if (Number.isFinite(v) && Math.abs(v - value) > 1e-12) onCommit(v);
        else setText(fmt(value, digits));
      }}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}

const set = (f: (d: JointDraft) => JointDraft) => useApp.getState().setJointDraft(f);

function AxisSection({ d }: { d: JointDraft }) {
  const tool = useApp((s) => s.activeTool);
  const picking = tool === 'axis';
  const a = d.axis;
  const fit = a?.fit;
  // The draft keeps the axis in the parent link's frame; it is shown and typed in world at the pose shown.
  const design = useApp((s) => s.design);
  const jointValues = useApp((s) => s.jointValues);
  const world = draftAxisWorld(design, jointValues, d);
  const setVec = (which: 'point' | 'dir', k: number, v: number) => setDraftAxisWorldComponent(which, k as 0 | 1 | 2, v);
  return (
    <div className="je-section">
      <div className="je-row">
        <strong>Axis</strong>
        <button
          type="button"
          className={picking ? 'primary' : ''}
          aria-pressed={picking}
          onClick={() => (picking ? useApp.getState().setActiveTool('select') : startPicking())}
          title="Click a pin, shaft, hole or round flat face on the model"
        >
          {picking ? 'Picking: click the model' : a ? 'Pick again' : 'Pick on model'}
        </button>
        <button
          type="button"
          disabled={!a}
          onClick={() => set((x) => (x.axis ? { ...x, axis: { ...x.axis, dir: [-x.axis.dir[0], -x.axis.dir[1], -x.axis.dir[2]] } } : x))}
          title="Reverse the direction (positive rotation turns the other way)"
        >
          Flip
        </button>
        {!a && (
          <button
            type="button"
            onClick={() => startTypedAxis()}
            title="Enter the axis by hand instead of picking it"
          >
            Type it
          </button>
        )}
      </div>
      {!a && picking && <p className="je-hint">Click a pin, shaft or hole (a cylinder), or a flat round face. The axis is fitted to the surface you click.</p>}
      <SuggestionList />
      {fit && (
        <p className={`je-fit${fit.quality === 'poor' ? ' warn-text' : ''}`}>
          {fit.suggested
            ? `Suggested axis: ${fit.suggested}`
            : fit.kind === 'cylinder'
              ? `Picked cylinder, radius ${fmt(fit.radius, 2)} mm`
              : `Picked flat face (axis is its normal)${fit.position === 'determined' ? `, radius ${fmt(fit.radius, 2)} mm` : ''}`}
          {/* Fit figures only when they mean something: a guessed position has none worth showing. */}
          {!fit.suggested && fit.kind === 'cylinder' && fit.position === 'determined' &&
            `, fit error ${fmt(fit.rmsRelative * 100, 2)}%, taper ${fmt((Math.asin(Math.min(1, fit.maxNormalDot)) * 180) / Math.PI, 1)}°`}
          {fit.position === 'guess' ? (
            <>
              <br />
              <strong>Unreliable: the axis position is a guess{fit.kind === 'cylinder' ? ' (too little of the round surface)' : ''}.</strong> {fit.note}
            </>
          ) : (
            fit.quality === 'poor' && (
              <>
                <br />
                Check this axis: {fit.note}
              </>
            )
          )}
        </p>
      )}
      {a && world && (
        <div className="je-grid">
          <span className="muted">Point (world, mm)</span>
          <span className="inline-row">
            {[0, 1, 2].map((k) => (
              <Num key={k} label={`Axis point ${'xyz'[k]}, mm, world`} value={world.point[k]!} digits={2} width={64} onCommit={(v) => setVec('point', k, v)} />
            ))}
          </span>
          <span className="muted">Direction</span>
          <span className="inline-row">
            {[0, 1, 2].map((k) => (
              <Num key={k} label={`Axis direction ${'xyz'[k]}, world`} value={world.dir[k]!} digits={4} width={64} onCommit={(v) => setVec('dir', k, v)} />
            ))}
          </span>
        </div>
      )}
    </div>
  );
}

/** The placed parts that go along with the new link; the user can untick one. */
function PartsGoingAlong({ d }: { d: JointDraft }) {
  const components = useApp((s) => s.design.components);
  const [initial] = useState(() => d.components);
  const listed = components.filter((c) => initial.includes(c.id) || d.components.includes(c.id));
  if (listed.length === 0) return null;
  return (
    <fieldset className="je-section">
      <legend>Placed parts that move with the new link</legend>
      {listed.map((c) => (
        <label key={c.id} className="je-check">
          <input
            type="checkbox"
            checked={d.components.includes(c.id)}
            onChange={(e) => set((x) => ({ ...x, components: e.target.checked ? [...x.components, c.id] : x.components.filter((id) => id !== c.id) }))}
          />{' '}
          {c.name} <span className="muted">({c.part})</span>
        </label>
      ))}
      <p className="je-hint">Chosen by where most of each part's footprint sits. Parts recorded in an area on a moving part always go with it.</p>
    </fieldset>
  );
}

/** Suggested axes for the draft, found from features the moving and staying parts share. */
function SuggestionList() {
  const d = useApp((s) => s.jointDraft);
  const sug = useApp((s) => s.axisSuggestions);
  const key = draftKey(d);
  useEffect(() => {
    if (key) void runSuggestions();
  }, [key]);
  if (!d || (d.mode === 'new' && d.type === 'fixed')) return null;
  const mine = sug && sug.key === key ? sug : null;
  // Items are in the parent link's frame; the hover preview is drawn in world at the pose shown.
  const hover = (it: AxisSuggestionView | null) => {
    const s = useApp.getState();
    if (!it || !d) return useApp.setState({ axisHover: null });
    const w = axisToWorld(s.design, s.jointValues, d.parent, it.point, it.dir);
    useApp.setState({ axisHover: { point: w.point, dir: w.dir } });
  };
  return (
    <div className="je-suggest" aria-live="polite">
      <div className="muted">Suggested axes</div>
      {!mine || mine.status === 'running' ? (
        <div className="je-hint">
          Looking for shafts and holes the parts share... {Math.round((mine?.progress ?? 0) * 100)}%
        </div>
      ) : mine.status === 'error' ? (
        <div className="je-hint warn-text">Could not look for axes: {mine.note}</div>
      ) : mine.items.length === 0 ? (
        <div className="je-hint">
          No shared shaft or hole found between the moving and the staying parts. Pick the axis on the model or type it.
          {mine.note && (
            <>
              <br />
              <span className="warn-text">{mine.note}</span>
            </>
          )}
        </div>
      ) : (
        <>
          {mine.bolted && <div className="je-hint warn-text">{mine.note}</div>}
          <ul className="je-suggest-list">
            {mine.items.map((it, i) => (
              <li key={i}>
                <button
                  type="button"
                  className={d.axis?.fit?.suggested?.startsWith(it.label) ? 'primary' : ''}
                  onMouseEnter={() => hover(it)}
                  onMouseLeave={() => hover(null)}
                  onFocus={() => hover(it)}
                  onBlur={() => hover(null)}
                  onClick={() => adoptSuggestion(it)}
                  title="Use this axis (the trial slider then shows the motion)"
                >
                  <strong>{it.grade === 'likely' ? (i === 0 ? 'Likely joint: ' : 'Also likely: ') : 'Possible, could be a fastener: '}</strong>
                  {it.label}
                  <span className="muted"> ({it.features} features)</span>
                  {it.grade === 'possible' && <span className="muted"> - check it with the trial slider</span>}
                </button>
              </li>
            ))}
          </ul>
          <div className="je-hint">Geometry cannot tell a pivot from a screw; the trial slider confirms. A shared line also works for a sliding joint: choose Prismatic.</div>
          {mine.ms !== undefined && <div className="je-hint">Found in {(mine.ms / 1000).toFixed(1)} s.</div>}
        </>
      )}
    </div>
  );
}

function NewJoint({ d }: { d: JointDraft }) {
  const design = useApp((s) => s.design);
  const parent = design.scene.links.find((l) => l.id === d.parent);
  const childJoints = design.scene.joints.filter((j) => j.parent === d.parent);
  const rotary = d.type === 'revolute' || d.type === 'continuous';
  const unit = rotary ? '°' : 'mm';
  const hasLimit = d.type === 'revolute' || d.type === 'prismatic';
  const [lo, hi] = d.type === 'continuous' ? [-180, 180] : hasLimit ? [d.lower, d.upper] : [0, 0];
  const previewOk = !!d.axis && d.type !== 'fixed';
  return (
    <div className="joint-editor" role="region" aria-label="New joint">
      <div className="je-title">
        New joint: {d.meshes.length} part{d.meshes.length === 1 ? '' : 's'} leave <strong>{parent?.name || d.parent}</strong>
      </div>
      <div className="je-grid">
        <label htmlFor="je-name" className="muted">
          Name
        </label>
        <input id="je-name" className="text" value={d.name} onChange={(e) => set((x) => ({ ...x, name: e.target.value }))} />
        <label htmlFor="je-type" className="muted">
          Type
        </label>
        <select
          id="je-type"
          value={d.type}
          onChange={(e) => {
            const type = e.target.value as JointType;
            const [lower, upper] = defaultLimits(type);
            set((x) => ({ ...x, type, lower, upper, preview: 0 }));
          }}
        >
          <option value="revolute">Revolute (turns, limited)</option>
          <option value="continuous">Continuous (turns freely)</option>
          <option value="prismatic">Prismatic (slides)</option>
          <option value="fixed">Fixed (rigid)</option>
        </select>
        {hasLimit && (
          <>
            <span className="muted">Limits ({unit})</span>
            <span className="inline-row">
              <Num label={`Lower limit, ${unit}`} value={d.lower} digits={1} width={64} onCommit={(v) => set((x) => ({ ...x, lower: v }))} />
              <span>to</span>
              <Num label={`Upper limit, ${unit}`} value={d.upper} digits={1} width={64} onCommit={(v) => set((x) => ({ ...x, upper: v }))} />
            </span>
          </>
        )}
      </div>
      {d.type !== 'fixed' && <AxisSection d={d} />}
      {childJoints.length > 0 && (
        <fieldset className="je-section">
          <legend>Joints that move with the new link</legend>
          {childJoints.map((j) => (
            <label key={j.id} className="je-check">
              <input
                type="checkbox"
                checked={d.takeJoints.includes(j.id)}
                onChange={(e) =>
                  set((x) => ({ ...x, takeJoints: e.target.checked ? [...x.takeJoints, j.id] : x.takeJoints.filter((t) => t !== j.id) }))
                }
              />{' '}
              {j.name || j.id} <span className="muted">(and what hangs from it)</span>
            </label>
          ))}
        </fieldset>
      )}
      <PartsGoingAlong d={d} />
      {previewOk && (
        <div className="je-section">
          <label className="je-row" htmlFor="je-try">
            <span className="muted">Try it</span>
            <span>
              {fmt(d.preview, 1)} {unit}
            </span>
          </label>
          <input
            id="je-try"
            type="range"
            min={Math.min(lo, 0)}
            max={Math.max(hi, 0)}
            step={rotary ? 0.5 : 0.1}
            value={d.preview}
            onChange={(e) => set((x) => ({ ...x, preview: Number(e.target.value) }))}
            onPointerUp={() => undefined}
            aria-label="Trial joint value (preview only)"
          />
        </div>
      )}
      <div className="joint-actions je-footer">
        <button type="button" className="primary" onClick={() => void createJointFromDraft()} disabled={d.type !== 'fixed' && !d.axis}>
          Create joint
        </button>
        <button type="button" onClick={cancelDraft}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function EditAxis({ d }: { d: JointDraft }) {
  const joint = useApp((s) => s.design.scene.joints.find((j) => j.id === d.jointId));
  const hasLimit = d.retype === 'revolute' || d.retype === 'prismatic';
  const unit = d.retype === 'prismatic' ? 'mm' : '°';
  return (
    <div className="joint-editor" role="region" aria-label="Change joint axis">
      <div className="je-title">
        {d.retype ? (
          <>
            Make <strong>{joint?.name || d.jointId}</strong> {d.retype}: a fixed joint has no axis, so pick or type one first.
          </>
        ) : (
          <>
            New axis for <strong>{joint?.name || d.jointId}</strong>
          </>
        )}
      </div>
      {hasLimit && (
        <div className="je-grid">
          <span className="muted">Limits ({unit})</span>
          <span className="inline-row">
            <Num label={`Lower limit, ${unit}`} value={d.lower} digits={1} width={64} onCommit={(v) => set((x) => ({ ...x, lower: v }))} />
            <span>to</span>
            <Num label={`Upper limit, ${unit}`} value={d.upper} digits={1} width={64} onCommit={(v) => set((x) => ({ ...x, upper: v }))} />
          </span>
        </div>
      )}
      <AxisSection d={d} />
      <div className="joint-actions je-footer">
        <button type="button" className="primary" disabled={!d.axis} onClick={() => void applyEditAxis()}>
          {d.retype ? `Make ${d.retype}` : 'Apply axis'}
        </button>
        <button type="button" onClick={cancelDraft}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function JointEditor() {
  const d = useApp((s) => s.jointDraft);
  if (!d) return null;
  return d.mode === 'new' ? <NewJoint d={d} /> : <EditAxis d={d} />;
}
