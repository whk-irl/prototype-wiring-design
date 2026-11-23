/**
 * The port editor for the user's own parts: list the ports, add one by
 * clicking the placed part in the viewport, and edit each port's name,
 * connector (searchable, aliases too), size, interfaces, exit direction (six
 * buttons relative to the part, and Flip) and position (0.5 mm nudges along
 * the part's axes). While it is open the placed components of the part show
 * each port's housing (solid) and plug (see-through blue) boxes.
 *
 * Every change goes through `updatePartDefinition`: the parts store and the
 * open design's copy, one undo step each. Library parts are read-only; they
 * offer an editable copy instead.
 */
import { useEffect, useMemo, useState } from 'react';
import { findConnector, findPart, InterfaceSchema, partProblems, type Part, type Port } from '@core';
import { useApp } from '../state/store';
import { makeEditableCopy, updatePartDefinition, applyStoredVersion } from '../userParts/actions';
import { isDeepStrictEqualJson } from '../userParts/json';
import { deletePort, exitOf, waysChoices, flipExit, nudgePort, setExit, setPortConnector, updatePort, type ExitDir } from '../userParts/portEdit';
import { fmt } from '../units';
import { connectorShort } from './partText';

const EXITS: ExitDir[] = ['+x', '-x', '+y', '-y', '+z', '-z'];
const INTERFACES = InterfaceSchema.options;

/** The part as it is now (edits made a moment ago included). */
function current(id: string): Part | undefined {
  const lib = useApp.getState().library;
  return lib ? findPart(lib, id) : undefined;
}

/**
 * Apply an edit. A result that would not pass the design's own checks (a
 * connector the library does not know, a size it does not come in) is not
 * applied: the user is told why instead, so the editor never writes a port
 * that would stop the design from saving or opening.
 */
function edit(id: string, fn: (p: Part) => Part): void {
  const p = current(id);
  if (!p) return;
  const next = fn(p);
  const s = useApp.getState();
  const problems = s.connectorLibrary ? partProblems(next, s.connectorLibrary).filter((m) => !partProblems(p, s.connectorLibrary!).includes(m)) : [];
  if (problems.length) {
    s.notify('warning', 'That change was not made', problems);
    return;
  }
  void updatePartDefinition(next);
}

function ConnectorPicker({ value, onPick }: { value: string; onPick: (id: string) => void }) {
  const connectors = useApp((s) => s.connectorLibrary);
  const [q, setQ] = useState('');
  const list = useMemo(() => {
    const all = connectors?.connectors ?? [];
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return all.filter((c) => {
      const hay = [c.id, c.name, ...c.aliases].join(' ').toLowerCase();
      return words.every((w) => hay.includes(w)) || c.id === value;
    });
  }, [connectors, q, value]);
  const current = connectors?.connectors.find((c) => c.id === value);
  const known = !!current;
  return (
    <span className="port-conn">
      <input className="text" type="search" placeholder="Search connectors (JST, Qwiic...)" aria-label="Search connectors" value={q} onChange={(e) => setQ(e.target.value)} />
      <select aria-label="Connector" value={value} onChange={(e) => onPick(e.target.value)}>
        {!known && <option value={value}>{value} (not in the connector list)</option>}
        {list.map((c) => (
          <option key={c.id} value={c.id} title={[c.name, ...c.aliases].join(', ')}>
            {c.short ?? c.name}
            {c.aliases.length ? ` (${c.aliases.slice(0, 2).join(', ')})` : ''}
          </option>
        ))}
      </select>
      {current && (
        <span className="muted small">
          {current.name}
          {current.aliases.length ? `; also ${current.aliases.join(', ')}` : ''}
        </span>
      )}
    </span>
  );
}

function PortRow({ part, port, open, onToggle }: { part: Part; port: Port; open: boolean; onToggle: () => void }) {
  const connectors = useApp((s) => s.connectorLibrary);
  const conn = connectors ? findConnector(connectors, port.connector) : undefined;
  const [name, setName] = useState(port.name ?? '');
  useEffect(() => setName(port.name ?? ''), [port.name]);
  const exit = exitOf(port);
  const id = part.id;
  return (
    <li className="port-row">
      <button type="button" className="port-head" aria-expanded={open} onClick={onToggle}>
        <strong>{port.name ?? port.id}</strong> <span className="muted small">{connectorShort(port, connectors)}</span>
      </button>
      {open && (
        <div className="je-grid port-edit">
          <label className="muted" htmlFor={`pn-${port.id}`}>
            Name
          </label>
          <input
            id={`pn-${port.id}`}
            className="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name.trim() !== (port.name ?? '') && edit(id, (p) => updatePort(p, port.id, { name: name.trim() || undefined }))}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
          <span className="muted">Connector</span>
          <ConnectorPicker value={port.connector} onPick={(c) => edit(id, (p) => setPortConnector(p, port.id, c, connectors))} />
          {conn && conn.ways.min !== conn.ways.max && (
            <>
              <label className="muted" htmlFor={`pw-${port.id}`}>
                Ways
              </label>
              <select id={`pw-${port.id}`} value={port.ways ?? conn.ways.min} onChange={(e) => edit(id, (p) => updatePort(p, port.id, { ways: Number(e.target.value) }))}>
                {waysChoices(conn).map((w) => (
                  <option key={w} value={w}>
                    {w}
                  </option>
                ))}
              </select>
            </>
          )}
          <span className="muted">Carries</span>
          <span className="port-ifaces">
            {INTERFACES.map((f) => (
              <label key={f} className="small">
                <input
                  type="checkbox"
                  checked={port.interfaces.includes(f)}
                  disabled={port.interfaces.length === 1 && port.interfaces[0] === f}
                  onChange={(e) =>
                    edit(id, (p) => updatePort(p, port.id, { interfaces: e.target.checked ? [...port.interfaces, f] : port.interfaces.filter((x) => x !== f) }))
                  }
                />
                {f}
              </label>
            ))}
          </span>
          <span className="muted">Cable leaves</span>
          <span className="seg seg-wrap" role="group" aria-label="Cable exit direction, relative to the part">
            {EXITS.map((d) => (
              <button key={d} type="button" aria-pressed={exit === d} onClick={() => edit(id, (p) => setExit(p, port.id, d))}>
                {d.toUpperCase()}
              </button>
            ))}
            <button type="button" title="Turn the port half round: the cable leaves the other way" onClick={() => edit(id, (p) => flipExit(p, port.id))}>
              Flip
            </button>
          </span>
          <span className="muted">Position</span>
          <span>
            {(['X', 'Y', 'Z'] as const).map((a, i) => (
              <span key={a} className="inline-row port-nudge">
                <button type="button" aria-label={`Move ${a} minus 0.5 mm`} onClick={() => edit(id, (p) => nudgePort(p, port.id, i as 0 | 1 | 2, -0.5))}>
                  -
                </button>
                <span className="small">
                  {a} {fmt(port.pose.p_mm[i]!, 1)}
                </span>
                <button type="button" aria-label={`Move ${a} plus 0.5 mm`} onClick={() => edit(id, (p) => nudgePort(p, port.id, i as 0 | 1 | 2, 0.5))}>
                  +
                </button>
              </span>
            ))}
            <span className="muted small"> mm, part axes, 0.5 mm steps</span>
          </span>
          <span />
          <span>
            <button type="button" onClick={() => edit(id, (p) => deletePort(p, port.id))}>
              Delete port
            </button>
          </span>
        </div>
      )}
    </li>
  );
}

/** Ports of `part`, editable when it is the user's own. */
export function PortEditor({ part }: { part: Part }) {
  const picking = useApp((s) => s.portPickPart === part.id);
  const placed = useApp((s) => s.design.components.some((c) => c.part === part.id));
  const focus = useApp((s) => s.portEditFocus);
  // The open design carries a version of this part that differs from the one kept on this PC.
  const ownVersion = useApp((s) => {
    const d = s.design.parts.find((p) => p.id === part.id);
    const st = s.customParts.find((p) => p.id === part.id);
    return !!d && !!st && !isDeepStrictEqualJson(d, st);
  });
  const [open, setOpen] = useState<string | null>(null);
  const editable = !!part.custom;

  useEffect(() => {
    if (!editable) return;
    useApp.setState({ editingPart: part.id });
    return () => {
      if (useApp.getState().editingPart === part.id) useApp.setState({ editingPart: null });
    };
  }, [part.id, editable]);
  useEffect(() => {
    if (focus && part.ports.some((p) => p.id === focus)) {
      setOpen(focus);
      useApp.setState({ portEditFocus: null });
    }
  }, [focus, part.ports]);

  if (!editable)
    return (
      <div className="port-editor">
        <p className="muted small">Library parts are read-only.</p>
        <button type="button" onClick={() => void makeEditableCopy(part)}>
          Make an editable copy
        </button>
      </div>
    );

  const startPick = () => {
    if (picking) {
      useApp.setState({ portPickPart: null });
      useApp.getState().setActiveTool('select');
      return;
    }
    useApp.setState({ portPickPart: part.id });
    useApp.getState().setActiveTool('port');
  };
  return (
    <div className="port-editor">
      <div className="inline-row">
        <strong>Ports</strong>
        <button type="button" className={picking ? 'primary' : ''} disabled={!placed} onClick={startPick} aria-pressed={picking}>
          {picking ? 'Click the part... (Esc stops)' : 'Add port'}
        </button>
      </div>
      {!placed && <p className="muted small">Place the part on the model, then use Add port and click where the connector is.</p>}
      {ownVersion && (
        <p className="muted small own-version">
          This design carries its own version of this part; edits here change this design only.{' '}
          <button type="button" className="link" onClick={() => applyStoredVersion(part.id)}>
            Use my stored version here
          </button>
        </p>
      )}
      {part.ports.length === 0 ? (
        <p className="muted small">No ports yet. Wires can only be attached to ports.</p>
      ) : (
        <ul className="port-list">
          {part.ports.map((p) => (
            <PortRow key={p.id} part={part} port={p} open={open === p.id} onToggle={() => setOpen((o) => (o === p.id ? null : p.id))} />
          ))}
        </ul>
      )}
      <p className="muted small">The housing (grey) and plug (blue) of each connector are drawn on the placed part while this list is open.</p>
    </div>
  );
}
