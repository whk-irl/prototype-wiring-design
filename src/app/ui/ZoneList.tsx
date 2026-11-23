import { useEffect, useState } from 'react';
import { countTriangles, type Zone, type ZoneKind } from '@core';
import { removeZones, updateZone } from '../state/designOps';
import { useApp } from '../state/store';
import { getViewport } from '../viewport/instance';

export const KIND_LABEL: Record<ZoneKind, string> = { mount_allowed: 'Parts may go here', keep_out: 'Keep clear' };

/** Solid swatch for mount-allowed, striped for keep-out, so kind reads without colour. */
export function ZoneSwatch({ kind }: { kind: ZoneKind }) {
  return <span className={`zone-swatch zone-${kind}`} aria-hidden="true" />;
}

export function ZoneName({ zone }: { zone: Zone }) {
  const [text, setText] = useState(zone.name);
  useEffect(() => setText(zone.name), [zone.name]);
  const commit = () => {
    const v = text.trim();
    if (!v || v === zone.name) return setText(zone.name);
    useApp.getState().commit((d) => updateZone(d, zone.id, { name: v }));
  };
  return (
    <input
      className="text"
      value={text}
      aria-label={`Name of area ${zone.name}`}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setText(zone.name);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

export function ZoneKindSelect({ zone }: { zone: Zone }) {
  return (
    <select
      value={zone.kind}
      aria-label={`Kind of area ${zone.name}`}
      onChange={(e) => useApp.getState().commit((d) => updateZone(d, zone.id, { kind: e.target.value as ZoneKind }))}
    >
      <option value="mount_allowed">Parts may go here</option>
      <option value="keep_out">Keep clear</option>
    </select>
  );
}

export function deleteZone(id: string): void {
  const s = useApp.getState();
  s.commit((d) => removeZones(d, new Set([id])));
  if (s.selection?.kind === 'zone' && s.selection.id === id) s.select(null);
}

function ZoneRow({ zone }: { zone: Zone }) {
  const selected = useApp((s) => s.selection?.kind === 'zone' && s.selection.id === zone.id);
  const hidden = useApp((s) => !!s.hiddenZones[zone.id]);
  const [editing, setEditing] = useState(false);
  return (
    <div className={`zone-row${selected ? ' selected' : ''}${hidden ? ' hidden-zone' : ''}`} role="listitem">
      <ZoneSwatch kind={zone.kind} />
      {editing ? (
        <div className="zone-edit" onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setEditing(false)}>
          <ZoneName zone={zone} />
        </div>
      ) : (
        <button
          type="button"
          className="zone-label"
          title={`${zone.name}: ${KIND_LABEL[zone.kind]} on ${zone.mesh}. Double-click to rename.`}
          onClick={() => {
            useApp.getState().select({ kind: 'zone', id: zone.id });
            useApp.getState().setZoneTool({ kind: zone.kind });
          }}
          onDoubleClick={() => setEditing(true)}
        >
          <span className="tree-text">{zone.name}</span>
          <span className="zone-kind">{KIND_LABEL[zone.kind]}</span>
          <span className="tree-detail">{countTriangles(zone.triangles).toLocaleString()} tri</span>
        </button>
      )}
      <button
        type="button"
        className="icon-text"
        aria-pressed={!hidden}
        aria-label={hidden ? `Show area ${zone.name}` : `Hide area ${zone.name}`}
        title={hidden ? 'Show' : 'Hide'}
        onClick={() => useApp.getState().toggleZoneHidden(zone.id)}
      >
        {hidden ? 'Show' : 'Hide'}
      </button>
      <button type="button" className="icon-btn" aria-label={`Delete area ${zone.name}`} title="Delete area" onClick={() => deleteZone(zone.id)}>
        <span className="x" aria-hidden="true" />
      </button>
    </div>
  );
}

export function ZoneList() {
  const zones = useApp((s) => s.design.zones);
  const tool = useApp((s) => s.activeTool);
  const hasModel = useApp((s) => s.design.scene.links.length > 0);
  const intro = (
    <p className="empty-note">
      Optional. Paint faces of the model where parts may go, or areas to keep clear: a part placed outside the first or on the second, and a wire lying on a keep-clear area, get a
      warning.
    </p>
  );
  if (!hasModel)
    return (
      <div className="zones">
        {intro}
        <p className="empty-note">Open a model first.</p>
      </div>
    );
  return (
    <div className="zones">
      {intro}
      <div className="panel-actions">
        <button
          type="button"
          className={tool === 'zones' ? 'primary' : ''}
          aria-pressed={tool === 'zones'}
          onClick={() => {
            useApp.getState().setActiveTool(tool === 'zones' ? 'select' : 'zones');
            getViewport()?.renderer.domElement.focus();
          }}
        >
          {tool === 'zones' ? 'Stop painting' : 'Paint areas'}
        </button>
      </div>
      {zones.length === 0 ? (
        <p className="empty-note">No areas yet. With Paint areas on, pick the kind above the view and click faces of the model.</p>
      ) : (
        <div role="list" aria-label="Areas">
          {zones.map((z) => (
            <ZoneRow key={z.id} zone={z} />
          ))}
        </div>
      )}
    </div>
  );
}
