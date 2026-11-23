/** Properties and actions for mesh selections, links and joints (the joint editor's side). */
import { useEffect, useState } from 'react';
import { jointAxisInParent, type JointType } from '@core';
import { axisToWorld, deleteJoint, editJoint, flipJointAxis, moveSelectedMeshesTo, renameLink, startEditAxis, startMakeMovable, startNewJoint } from '../joints/editor';
import { meshPlacements } from '../scene/placement';
import { invertWithin } from '../state/selection';
import { useApp } from '../state/store';
import { fmt, isRotary, RAD2DEG } from '../units';
import { Num } from './JointEditor';

/** Mesh ids of a link, in tree order. */
function linkMeshes(linkId: string): string[] {
  return useApp.getState().design.scene.links.find((l) => l.id === linkId)?.meshes.map((m) => m.id) ?? [];
}

/** Actions on the mesh selection: shown under one mesh or many. */
export function MeshActions() {
  const selected = useApp((s) => s.selectedMeshes);
  const design = useApp((s) => s.design);
  const hiddenCount = useApp((s) => Object.keys(s.hiddenMeshes).length);
  const drafting = useApp((s) => s.jointDraft !== null);
  const [target, setTarget] = useState('');
  const placements = meshPlacements(design);
  const links = [...new Set(selected.map((id) => placements.get(id)?.link).filter((x): x is string => !!x))];
  const oneLink = links.length === 1 ? links[0]! : null;
  const s = useApp.getState;
  return (
    <div className="mesh-actions">
      <div className="joint-actions">
        <button type="button" disabled={!oneLink || drafting} onClick={() => startNewJoint()} title="The selected parts become a new link on a new joint">
          New joint from selection
        </button>
      </div>
      <div className="joint-actions">
        <button
          type="button"
          disabled={!oneLink}
          onClick={() => {
            const ids = linkMeshes(oneLink!);
            s().selectMeshes(ids, ids[0] ?? null);
          }}
        >
          Select all on link
        </button>
        <button type="button" disabled={!oneLink} onClick={() => s().selectMeshes(invertWithin(linkMeshes(oneLink!), s().selectedMeshes))}>
          Invert within link
        </button>
      </div>
      <div className="joint-actions">
        <button
          type="button"
          disabled={selected.length === 0}
          onClick={() => {
            const hidden = { ...s().hiddenMeshes };
            for (const id of selected) hidden[id] = true;
            s().setHiddenMeshes(hidden);
          }}
        >
          Hide selected
        </button>
        <button type="button" disabled={hiddenCount === 0} onClick={() => s().setHiddenMeshes({})}>
          Show all{hiddenCount ? ` (${hiddenCount} hidden)` : ''}
        </button>
      </div>
      <div className="joint-actions">
        <select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Link to move the selected parts to">
          <option value="">Move selected to link...</option>
          {design.scene.links.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name || l.id}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={!target || selected.length === 0}
          onClick={() => {
            moveSelectedMeshesTo(target);
            setTarget('');
          }}
        >
          Move
        </button>
      </div>
    </div>
  );
}

export function MultiMeshProps() {
  const selected = useApp((s) => s.selectedMeshes);
  const design = useApp((s) => s.design);
  const placements = meshPlacements(design);
  const links = [...new Set(selected.map((id) => placements.get(id)?.link))];
  const tris = selected.reduce((n, id) => n + (placements.get(id)?.ref.tri_count ?? 0), 0);
  return (
    <>
      <dl className="props">
        <dt>Selected</dt>
        <dd>{selected.length} meshes</dd>
        <dt>Links</dt>
        <dd>{links.map((id) => design.scene.links.find((l) => l.id === id)?.name || id).join(', ')}</dd>
        <dt>Triangles</dt>
        <dd>{tris.toLocaleString()}</dd>
      </dl>
      <MeshActions />
    </>
  );
}

export function LinkName({ linkId }: { linkId: string }) {
  const name = useApp((s) => s.design.scene.links.find((l) => l.id === linkId)?.name ?? '');
  const [text, setText] = useState(name);
  useEffect(() => setText(name), [name]);
  return (
    <input
      className="text"
      value={text}
      aria-label="Link name"
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const v = text.trim();
        if (v && v !== name) renameLink(linkId, v);
        else setText(name);
      }}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}

export function JointProps({ id }: { id: string }) {
  const joint = useApp((s) => s.design.scene.joints.find((j) => j.id === id));
  const design = useApp((s) => s.design);
  const jointValues = useApp((s) => s.jointValues);
  const drafting = useApp((s) => s.jointDraft !== null);
  const [name, setName] = useState(joint?.name ?? '');
  useEffect(() => setName(joint?.name ?? ''), [joint?.name]);
  if (!joint) return null;
  const rotary = isRotary(joint);
  const unit = rotary ? '°' : 'mm';
  const k = rotary ? RAD2DEG : 1;
  const linkName = (lid: string) => design.scene.links.find((l) => l.id === lid)?.name || lid;
  const axis = jointAxisInParent(joint);
  const world = axisToWorld(design, jointValues, joint.parent, axis.point_mm, axis.dir);
  const setType = (type: JointType) => {
    if (type === joint.type) return;
    // A fixed joint has no axis: becoming movable needs one (picked or typed) first.
    if (joint.type === 'fixed') {
      startMakeMovable(joint.id, type);
      return;
    }
    const limit =
      type === 'revolute' ? (joint.limit && rotary ? joint.limit : { lower: -Math.PI / 2, upper: Math.PI / 2 }) : type === 'prismatic' ? (joint.limit && !rotary ? joint.limit : { lower: 0, upper: 50 }) : null;
    editJoint(joint.id, { type, limit });
  };
  return (
    <>
      <dl className="props">
        <dt>Joint</dt>
        <dd>
          <input
            className="text"
            value={name}
            aria-label="Joint name"
            onChange={(e) => setName(e.target.value)}
            onBlur={() => {
              const v = name.trim();
              if (v && v !== joint.name) editJoint(joint.id, { name: v });
              else setName(joint.name);
            }}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
        </dd>
        <dt>Id</dt>
        <dd>{joint.id}</dd>
        <dt>Type</dt>
        <dd>
          <select value={joint.type} aria-label="Joint type" onChange={(e) => setType(e.target.value as JointType)}>
            <option value="revolute">Revolute</option>
            <option value="continuous">Continuous</option>
            <option value="prismatic">Prismatic</option>
            <option value="fixed">Fixed</option>
          </select>
        </dd>
        <dt>Parent</dt>
        <dd>{linkName(joint.parent)}</dd>
        <dt>Child</dt>
        <dd>{linkName(joint.child)}</dd>
        {joint.limit && joint.type !== 'continuous' && (
          <>
            <dt>Limits ({unit})</dt>
            <dd className="inline-row">
              <Num label={`Lower limit, ${unit}`} value={joint.limit.lower * k} digits={1} width={64} onCommit={(v) => editJoint(joint.id, { limit: { lower: v / k, upper: joint.limit!.upper } })} />
              <span>to</span>
              <Num label={`Upper limit, ${unit}`} value={joint.limit.upper * k} digits={1} width={64} onCommit={(v) => editJoint(joint.id, { limit: { lower: joint.limit!.lower, upper: v / k } })} />
            </dd>
          </>
        )}
        {joint.type !== 'fixed' && (
          <>
            <dt>Axis point</dt>
            <dd>{world.point.map((v) => fmt(v, 2)).join(', ')} mm (world)</dd>
            <dt>Axis direction</dt>
            <dd>{world.dir.map((v) => fmt(v, 4)).join(', ')} (world)</dd>
          </>
        )}
        <dt>Saved value</dt>
        <dd>
          {fmt(joint.value * k)} {unit}
        </dd>
      </dl>
      <div className="mesh-actions">
        <div className="joint-actions">
          {joint.type !== 'fixed' && (
            <>
              <button type="button" disabled={drafting} onClick={() => startEditAxis(joint.id)} title="Pick a new axis on the model or type it">
                Change axis
              </button>
              <button type="button" onClick={() => flipJointAxis(joint.id)} title="Reverse the axis direction">
                Flip axis
              </button>
            </>
          )}
          <button type="button" onClick={() => void deleteJoint(joint.id)} title="Merge the child link back into the parent">
            Delete joint
          </button>
        </div>
      </div>
    </>
  );
}
