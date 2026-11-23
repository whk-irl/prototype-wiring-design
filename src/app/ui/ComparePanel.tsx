/** Design selection: every library cable type on the selected wire's route, side by side. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../state/store';
import { fmt } from '../units';
import { sortRows, type CompareRow, type SortKey } from '../wires/compare';
import { bendIsFirm } from '../wires/checks';
import { commitCableEdit } from '../wires/editing';
import { compareAll, compareCandidates } from '../wires/run';
import { FAMILY_LABEL } from './cableText';

const COLS: Array<[SortKey | null, string]> = [
  [null, ''],
  ['name', 'Type'],
  ['family', 'Family'],
  ['width_mm', 'Size here'],
  ['bend_static_mm', 'Bend static / dyn.'],
  ['tightest_bend_mm', 'Tightest bend here'],
  ['clearance_mm', 'Clearance here'],
  ['joint_bend_min_mm', 'Over joints'],
  [null, 'Port'],
  ['cut_mm', 'Cut length'],
  ['mass_g', 'Mass'],
  [null, 'Notes'],
  [null, 'Confidence'],
];

const n = (v: number, d = 1) => (Number.isFinite(v) ? fmt(v, d) : '-');

export function ComparePanel() {
  const cableId = useApp((s) => s.compareCable);
  const cable = useApp((s) => s.design.cables.find((c) => c.id === s.compareCable));
  const [rows, setRows] = useState<CompareRow[]>([]);
  const [progress, setProgress] = useState<[number, number]>([0, 0]);
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>({ key: 'cut_mm', asc: true });
  const [family, setFamily] = useState('');
  const [fitsOnly, setFitsOnly] = useState(false);
  const [noWarnings, setNoWarnings] = useState(false);
  const [pinned, setPinned] = useState<string[]>([]);
  const [showAll, setShowAll] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);
  const run = useRef(0);
  // Anything the rows depend on: the whole design (cable build incl. bend override, routes, scene, parts, other wires),
  // the pose, the end allowance, the libraries and the geometry.
  const design = useApp((s) => s.design);
  const jointValues = useApp((s) => s.jointValues);
  const allowance = useApp((s) => s.wireAllowance_mm);
  const cableLibrary = useApp((s) => s.cableLibrary);
  const partLibrary = useApp((s) => s.library);
  const geometryVersion = useApp((s) => s.geometryVersion);
  const bvhPending = useApp((s) => s.bvhPending);

  // Focus moves into the panel when it opens and back to where it was when it closes.
  useEffect(() => {
    if (!cableId) return;
    opener.current = document.activeElement;
    panel.current?.focus();
    return () => {
      if (opener.current instanceof HTMLElement && opener.current.isConnected) opener.current.focus();
    };
  }, [cableId]);
  useEffect(() => setShowAll(false), [cableId]);
  const candidates = useMemo(() => (cableId ? compareCandidates(cableId) : []), [cableId, design, cableLibrary, partLibrary]);
  const total = cableLibrary?.cables.length ?? 0;

  useEffect(() => {
    if (!cableId) return;
    const me = ++run.current;
    setRows([]);
    setProgress([0, showAll ? total : candidates.length]);
    void compareAll(
      cableId,
      (row, done, total) => {
        if (run.current !== me) return;
        setRows((r) => [...r.filter((x) => x.typeId !== row.typeId), row]);
        setProgress([done, total]);
      },
      () => run.current !== me,
      showAll ? undefined : candidates,
    );
    return () => {
      run.current++;
    };
  }, [cableId, design, jointValues, allowance, cableLibrary, partLibrary, geometryVersion, bvhPending, showAll, candidates, total]);

  const families = useMemo(() => [...new Set(rows.map((r) => r.family))].sort(), [rows]);
  const shown = useMemo(() => {
    let r = rows;
    if (family) r = r.filter((x) => x.family === family);
    // "Fits here": clear of everything and no firm bend limit broken (size-rule warnings allowed unless excluded).
    if (fitsOnly) r = r.filter((x) => x.fits && x.bend_grade !== 'fail' && x.folds === 0 && x.crossing_grade !== 'fail' && x.port_fit !== false);
    if (noWarnings) r = r.filter((x) => x.bend_grade === 'ok');
    const sorted = sortRows(r, sort.key, sort.asc);
    return [...sorted.filter((x) => pinned.includes(x.typeId)), ...sorted.filter((x) => !pinned.includes(x.typeId))];
  }, [rows, family, fitsOnly, noWarnings, sort, pinned]);

  if (!cableId || !cable) return null;
  const close = () => useApp.setState({ compareCable: null });
  const apply = (typeId: string) => commitCableEdit(cable.id, { type: typeId });
  return (
    <div
      className="compare-panel"
      role="dialog"
      aria-label="Compare cable types"
      tabIndex={-1}
      ref={panel}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          close();
        }
      }}
    >
      <div className="compare-head">
        <strong>Cable types on "{cable.name ?? cable.id}"</strong>
        <span className="muted" aria-live="polite">
          {cable.count > 1 ? `${cable.count} cables together${cable.twisted ? ', twisted' : ''}. ` : ''}
          {cable.sleeve_wall_mm > 0 ? `Sleeve wall ${cable.sleeve_wall_mm} mm. ` : ''}
          {progress[0] < progress[1] ? `Checking ${progress[0]} of ${progress[1]}...` : `${rows.length} ${rows.length === 1 ? 'type' : 'types'} checked at the pose shown.`}
        </span>
        {!showAll && candidates.length < total && (
          <button type="button" className="small-btn" onClick={() => setShowAll(true)} title="Check every cable type in the library (slower)">
            Show all {total}
          </button>
        )}
        <span className="status-spacer" />
        <select value={family} onChange={(e) => setFamily(e.target.value)} aria-label="Filter by family">
          <option value="">All families</option>
          {families.map((f) => (
            <option key={f} value={f}>
              {FAMILY_LABEL[f as keyof typeof FAMILY_LABEL] ?? f}
            </option>
          ))}
        </select>
        <label>
          <input type="checkbox" checked={fitsOnly} onChange={(e) => setFitsOnly(e.target.checked)} /> fits here
        </label>
        <label title="Also hide types whose size-rule bend limit is broken">
          <input type="checkbox" checked={noWarnings} onChange={(e) => setNoWarnings(e.target.checked)} /> no bend warnings
        </label>
        <button type="button" className="icon-btn" aria-label="Close comparison" title="Close" onClick={close}>
          <span className="x" aria-hidden="true" />
        </button>
      </div>
      <div className="compare-scroll">
        <table className="compare-table">
          <thead>
            <tr>
              {COLS.map(([k, label], i) => (
                <th key={i}>
                  {k ? (
                    <button type="button" className="linkish" onClick={() => setSort((s) => ({ key: k, asc: s.key === k ? !s.asc : true }))}>
                      {label}
                      {sort.key === k ? (sort.asc ? ' ▲' : ' ▼') : ''}
                    </button>
                  ) : (
                    label
                  )}
                </th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const current = r.typeId === cable.type;
              return (
                <tr key={r.typeId} className={`${current ? 'current' : ''}${pinned.includes(r.typeId) ? ' pinned' : ''}`}>
                  <td>
                    <button
                      type="button"
                      className="icon-text"
                      aria-pressed={pinned.includes(r.typeId)}
                      onClick={() => setPinned((p) => (p.includes(r.typeId) ? p.filter((x) => x !== r.typeId) : [...p, r.typeId]))}
                      title="Pin to the top to compare a shortlist"
                    >
                      {pinned.includes(r.typeId) ? 'Pinned' : 'Pin'}
                    </button>
                  </td>
                  <td title={r.typeId}>
                    {r.name}
                    <div className="muted small">{r.size} each</div>
                  </td>
                  <td>{FAMILY_LABEL[r.family as keyof typeof FAMILY_LABEL] ?? r.family}</td>
                  <td>{r.width_mm === r.height_mm ? `${n(r.width_mm, 2)} mm` : `${n(r.width_mm, 1)} x ${n(r.height_mm, 2)} mm`}</td>
                  <td>
                    {n(r.bend_static_mm)}
                    {r.bend_dynamic_mm !== undefined ? ` / ${n(r.bend_dynamic_mm)}` : ' / -'} mm
                    <div className={`small${bendIsFirm(r.bend_source) ? '' : ' muted'}`} title={bendIsFirm(r.bend_source) ? "The cable's own figure" : "A rule applied to the cable's size, not the maker's figure"}>
                      {r.bend_source === 'user' ? 'your value' : bendIsFirm(r.bend_source) ? r.bend_source : `${r.bend_source}: size rule`}
                    </div>
                  </td>
                  <td className={r.bend_grade === 'ok' ? 'ok' : r.bend_grade === 'warn' ? 'warnish' : 'bad'}>
                    {Number.isFinite(r.tightest_bend_mm) ? `${n(r.tightest_bend_mm)} mm` : 'straight'} {r.bend_grade === 'ok' ? 'ok' : r.bend_grade === 'warn' ? 'warns' : 'fails'}
                    {r.folds > 0 && <div className="bad small">{r.folds} fold{r.folds === 1 ? '' : 's'} needed (turns sideways)</div>}
                  </td>
                  <td className={r.approximate ? 'warnish' : r.fits ? 'ok' : 'bad'} title={r.approximate ? `Approximate: ${r.approximate}.` : undefined}>
                    {n(r.clearance_mm, 2)} mm {r.approximate ? 'approximate' : r.fits ? 'fits' : 'does not fit'}
                  </td>
                  <td className={r.crossing_grade === 'ok' ? 'ok' : r.crossing_grade === 'warn' ? 'warnish' : 'bad'}>
                    {Number.isFinite(r.joint_bend_min_mm) ? `${n(r.joint_bend_min_mm)} mm` : '-'} {r.joint_bend_ok ? '' : 'too tight'}
                    {r.crossing_grade !== 'ok' && <div className="small">{r.crossing_grade === 'fail' ? 'fails' : 'warns'}</div>}
                  </td>
                  <td className={r.port_fit === undefined ? '' : r.port_fit ? 'ok' : 'bad'} title={r.port_problems.join('\n')}>
                    {r.port_fit === undefined ? <span className="muted">not attached</span> : r.port_fit ? 'fits' : 'does not fit'}
                  </td>
                  <td>
                    {r.complete ? (r.approximate ? '≈ ' : '') : '≥ '}
                    {n(r.cut_mm, 0)} mm
                  </td>
                  <td>{r.mass_g !== undefined ? `${n(r.mass_g, 2)} g` : '-'}</td>
                  <td className="compare-notes">
                    {r.notes.length > 0 ? (
                      <ul className="notice-details">
                        {r.notes.map((t, k) => (
                          <li key={k}>{t}</li>
                        ))}
                      </ul>
                    ) : (
                      <span className="muted">-</span>
                    )}
                  </td>
                  <td>
                    {r.confidence}
                    {r.source && (
                      <>
                        {' '}
                        <a href={r.source} target="_blank" rel="noreferrer">
                          source
                        </a>
                      </>
                    )}
                  </td>
                  <td>
                    <button type="button" disabled={current} onClick={() => apply(r.typeId)} title="Use this type for the wire (undoable)">
                      {current ? 'In use' : 'Use'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="muted small compare-foot">
        Clearance is to anything other than the surface the wire lies on (negative: it hits). A bend that breaks a datasheet, measured or user limit fails; one that breaks a derived
        or generic limit (a rule applied to the cable&apos;s size, not the maker&apos;s figure) only warns. &quot;Over joints&quot;: the tightest bend of the free loop over any joint
        crossing, across the joints&apos; range. Cut length includes each crossing&apos;s free length and the per-end allowance; &ge; marks a lower bound (a crossing does not reach
        or was not fully swept); &asymp; marks an approximate one (part of the shape did not settle). &quot;Fits here&quot; also leaves out flat types that would have to be folded,
        types that fail over a joint, types that do not fit the port the wire is attached to, and approximate results. Each type is settled as a stiff wire of its own size and
        stiffness between the same holds; the loops over joints rest on the model and sag under their weight, and twist is not modelled. Poses are sampled across each
        joint&apos;s range. Using a type re-drapes the route for its size. Shown: the types of the same family and those the wire&apos;s ports accept, unless you asked for all.
      </div>
    </div>
  );
}
