import { useEffect, useState, type ReactNode } from 'react';
import { findPart, type Pose } from '@core';
import { PartFacts } from './PartDetails';
import { PortEditor } from './PortEditor';
import { zoneUnderPose } from '../placement/checks';
import { normalisedPose, surfaceFromPose, withSpin, wrapAngle } from '../placement/pose';
import { addComponent, removeComponent, updateComponent } from '../state/designOps';
import { duplicateOf } from '../placement/placing';
import { useApp } from '../state/store';
import { fmt, RAD2DEG } from '../units';

function Prop({ k, children }: { k: string; children: ReactNode }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{children}</dd>
    </>
  );
}

function NumInput({ label, value, digits = 2, onCommit }: { label: string; value: number; digits?: number; onCommit: (v: number) => void }) {
  const [text, setText] = useState(fmt(value, digits));
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setText(fmt(value, digits));
  }, [value, digits, editing]);
  return (
    <input
      className="num"
      type="text"
      inputMode="decimal"
      aria-label={label}
      value={text}
      onFocus={() => setEditing(true)}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        setEditing(false);
        const v = Number(text.replace(',', '.'));
        if (Number.isFinite(v) && Math.abs(v - value) > 1e-9) onCommit(v);
        else setText(fmt(value, digits));
      }}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}

export function deleteComponent(id: string): void {
  const s = useApp.getState();
  s.commit((d) => removeComponent(d, id));
  if (s.selection?.kind === 'component' && s.selection.id === id) s.select(null);
}

/** Duplicate a placed component (Ctrl+D): same part, beside it on the same surface, no wires; the copy is selected. */
export function duplicateComponent(id: string): void {
  const s = useApp.getState();
  const c = s.design.components.find((x) => x.id === id);
  const part = c && s.library ? findPart(s.library, c.part) : undefined;
  if (!c || !part) return;
  const copy = duplicateOf(s.design, part, id);
  if (!copy) return;
  const zone = zoneUnderPose(s.design, copy.link, copy.pose, s.jointValues);
  const placed = zone ? { ...copy, zone } : copy;
  s.commit((d) => addComponent(d, placed));
  s.select({ kind: 'component', id: placed.id });
}

export function ComponentProps({ id }: { id: string }) {
  const c = useApp((s) => s.design.components.find((x) => x.id === id));
  const library = useApp((s) => s.library);
  const scene = useApp((s) => s.design.scene);
  const zones = useApp((s) => s.design.zones);
  const warnings = useApp((s) => s.componentWarnings[id]);
  const [name, setName] = useState(c?.name ?? '');
  useEffect(() => setName(c?.name ?? ''), [c?.name]);
  if (!c) return null;
  const part = library ? findPart(library, c.part) : undefined;
  const link = scene.links.find((l) => l.id === c.link);
  const zone = zones.find((z) => z.id === c.zone);
  const surf = surfaceFromPose(c.pose);
  const commit = (patch: Parameters<typeof updateComponent>[2]) => useApp.getState().commit((d) => updateComponent(d, id, patch));
  // A move re-reads the zone under the part, so `zone` never goes stale.
  const move = (pose: Pose) => {
    const s = useApp.getState();
    commit({
      pose,
      zone: zoneUnderPose(s.design, c.link, pose, s.jointValues),
    });
  };
  const setPos = (k: 0 | 1 | 2, v: number) => {
    const p: [number, number, number] = [...c.pose.p_mm];
    p[k] = v;
    move(normalisedPose({ p_mm: p, q: c.pose.q }));
  };
  const setSpin = (rad: number) => move(normalisedPose(withSpin(c.pose, wrapAngle(rad))));
  return (
    <>
      <dl className="props">
        <Prop k="Component">
          <input
            className="text"
            value={name}
            aria-label="Component name"
            onChange={(e) => setName(e.target.value)}
            onBlur={() => {
              const v = name.trim();
              if (v && v !== c.name) commit({ name: v });
              else setName(c.name);
            }}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
        </Prop>
        <Prop k="Id">{c.id}</Prop>
        <Prop k="Part">{part ? `${part.name} (${part.category})` : `${c.part} (not in library)`}</Prop>
        {part && <PartFacts part={part} />}
        <Prop k="Link">{link?.name || c.link}</Prop>
        <Prop k="Area">{zone ? zone.name : 'none'}</Prop>
        <Prop k="Position">
          <span className="inline-row">
            <NumInput label="Position X in link frame, mm" value={c.pose.p_mm[0]} onCommit={(v) => setPos(0, v)} />
            <NumInput label="Position Y in link frame, mm" value={c.pose.p_mm[1]} onCommit={(v) => setPos(1, v)} />
            <NumInput label="Position Z in link frame, mm" value={c.pose.p_mm[2]} onCommit={(v) => setPos(2, v)} />
          </span>
          <span className="muted small">x, y, z in mm, link frame</span>
        </Prop>
        <Prop k="Normal">{[surf.normal.x, surf.normal.y, surf.normal.z].map((v) => fmt(v, 3)).join(', ')}</Prop>
        <Prop k="Rotation">
          <span className="inline-row">
            <button type="button" aria-label="Rotate minus 15 degrees" onClick={() => setSpin(surf.spin - Math.PI / 12)}>
              -15°
            </button>
            <NumInput label="Rotation about the surface normal, degrees" value={surf.spin * RAD2DEG} digits={1} onCommit={(v) => setSpin(v / RAD2DEG)} />
            <button type="button" aria-label="Rotate plus 15 degrees" onClick={() => setSpin(surf.spin + Math.PI / 12)}>
              +15°
            </button>
          </span>
          <span className="muted small">degrees about the surface normal</span>
        </Prop>
        {warnings && warnings.length > 0 && (
          <Prop k="Warnings">
            <ul className="warn-list">
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </Prop>
        )}
        <Prop k="">
          <span className="inline-row">
            <button type="button" onClick={() => duplicateComponent(id)} title="Duplicate (Ctrl+D): the same part beside this one, without wires">
              Duplicate
            </button>
            <button type="button" onClick={() => deleteComponent(id)} title="Delete (Del)">
              Delete component
            </button>
          </span>
        </Prop>
      </dl>
      {part && <PortEditor part={part} />}
    </>
  );
}
