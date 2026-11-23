import { useEffect, useState } from 'react';
import type { Joint } from '@core';
import { startNewJoint } from '../joints/editor';
import { useApp } from '../state/store';
import { displayRange, fmt, fromDisplay, isRotary, jointUnit, toDisplay } from '../units';

function JointControl({ joint }: { joint: Joint }) {
  const value = useApp((s) => s.jointValues[joint.id] ?? joint.value);
  const selected = useApp((s) => s.selection?.kind === 'joint' && s.selection.id === joint.id);
  const display = toDisplay(joint, value);
  const [lo, hi] = displayRange(joint);
  const unit = jointUnit(joint);
  const step = isRotary(joint) ? 0.1 : Math.max((hi - lo) / 1000, 0.01);
  const [text, setText] = useState(fmt(display));
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setText(fmt(display));
  }, [display, editing]);

  const set = (d: number) => useApp.getState().setJointValue(joint.id, fromDisplay(joint, d));
  const commitText = () => {
    setEditing(false);
    const n = Number(text.replace(',', '.'));
    if (Number.isFinite(n)) set(n);
    else setText(fmt(display));
  };
  const differs = Math.abs(value - joint.value) > 1e-9;
  const inputId = `joint-${joint.id}`;

  return (
    <div className={`joint${selected ? ' selected' : ''}`}>
      <div className="joint-head">
        <button type="button" className="joint-name" onClick={() => useApp.getState().select({ kind: 'joint', id: joint.id })} title={`${joint.id} (${joint.type})`}>
          {joint.name || joint.id}
        </button>
        <span className="joint-type">{joint.type}</span>
        {differs && <span className="joint-moved" title={`Saved: ${fmt(toDisplay(joint, joint.value))} ${unit}`}>moved</span>}
      </div>
      <div className="joint-row">
        <input
          type="range"
          min={lo}
          max={hi}
          step={step}
          value={Math.min(hi, Math.max(lo, display))}
          onChange={(e) => set(Number(e.target.value))}
          aria-label={`${joint.name || joint.id}, ${unit === '°' ? 'degrees' : 'millimetres'}`}
        />
        <input
          id={inputId}
          className="num"
          type="text"
          inputMode="decimal"
          value={text}
          onFocus={() => setEditing(true)}
          onChange={(e) => setText(e.target.value)}
          onBlur={commitText}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') {
              setText(fmt(display));
              setEditing(false);
              (e.target as HTMLInputElement).blur();
            }
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              e.preventDefault();
              const delta = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1);
              set(display + delta);
              setEditing(false);
            }
          }}
          aria-label={`${joint.name || joint.id} value in ${unit === '°' ? 'degrees' : 'millimetres'}`}
        />
        <span className="unit">{unit}</span>
      </div>
      {joint.limit && joint.type !== 'continuous' && (
        <div className="joint-limits">
          <span>{fmt(lo)}</span>
          <span>{fmt(hi)}</span>
        </div>
      )}
    </div>
  );
}

export function JointPanel() {
  const joints = useApp((s) => s.design.scene.joints);
  const moving = joints.filter((j) => j.type !== 'fixed');
  const dirtyPose = useApp((s) => s.design.scene.joints.some((j) => j.type !== 'fixed' && Math.abs((s.jointValues[j.id] ?? j.value) - j.value) > 1e-9));

  const links = useApp((s) => s.design.scene.links.length);
  const drafting = useApp((s) => s.jointDraft !== null);
  const selCount = useApp((s) => s.selectedMeshes.length);
  const newJoint = (
    <button type="button" disabled={drafting || links === 0} onClick={() => startNewJoint()} title="Turn the selected parts into a link that moves on a new joint">
      New joint{selCount > 0 ? ` (${selCount} selected)` : ''}
    </button>
  );

  if (moving.length === 0) {
    if (links === 1 && joints.length === 0) {
      return (
        <div className="joints">
          <p className="empty-note joint-hint">
            This model has no joints. Select the parts that move together, then New joint.
            <br />
            Start at the base and work outward: each time, select everything beyond the joint (Shift+drag a rectangle, Ctrl+click to add or remove).
          </p>
          <div className="joint-actions">{newJoint}</div>
        </div>
      );
    }
    return (
      <div className="joints">
        <p className="empty-note">{joints.length === 0 ? 'No joints.' : 'Only fixed joints.'}</p>
        <div className="joint-actions">{newJoint}</div>
      </div>
    );
  }
  return (
    <div className="joints">
      <div className="joint-actions">{newJoint}</div>
      <div className="joint-actions">
        <button type="button" onClick={() => useApp.getState().zeroPose()} title="Set every joint to 0 (clamped to its limit)">
          Zero pose
        </button>
        <button type="button" disabled={!dirtyPose} onClick={() => useApp.getState().resetPoseToSaved()} title="Back to the pose saved in the design">
          Saved pose
        </button>
        <button type="button" className="primary" disabled={!dirtyPose} onClick={() => useApp.getState().savePose()} title="Write these joint values into the design (undoable)">
          Save pose
        </button>
      </div>
      {moving.map((j) => (
        <JointControl key={j.id} joint={j} />
      ))}
    </div>
  );
}
