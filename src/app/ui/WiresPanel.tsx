/**
 * The Wires tab: the design's own wires first (status at a glance, the cut
 * list), then the cable to draw with (one card; "Change" opens the library
 * with search, family filter and the user's own cables), then the build
 * options as a compact form.
 */
import { useEffect, useMemo, useState } from 'react';
import { findCableType, type CableFamily, type CableType, type Design } from '@core';
import { attachedEnds, fitAtPort, portInfo, type PortInfo } from '../wires/ports';
import { FAMILY_LABEL, groupByFamily, searchCableTypes } from './cableText';
import { downloadText } from '../io/files';
import { useApp } from '../state/store';
import { cutListCsv, sizeText } from '../wires/compare';
import { wireColor } from '../viewport/wireLayer';
import { fmt } from '../units';
import { CableThumb } from './CableThumb';
import {
  applyStoredCableInDesign,
  deleteUserCable,
  designCableDiffers,
  designOnlyCableTypes,
  keepDesignCableTypes,
  keepDesignCableVersion,
  wiresUsing,
} from '../userCables/actions';
import type { StoredCable } from '../parts/store';
import { IconEdit, IconFile, IconInfo, IconPlus, IconSearch, IconTrash, IconWire } from './icons';
import { StatusIcon, Tag } from './StatusIcon';
import { wireVerdict } from './wireStatus';

/** Why a wire's length is not final yet: its shape is still being worked out, or did not settle (the drape stands in). Empty when it is final. */
export function lengthApproximateWhy(st: ReturnType<typeof useApp.getState>['wireChecks'][string] | undefined): string {
  if (!st) return 'not checked yet';
  if (st.stale || st.shapePending) return 'approximate: the shape is still being worked out';
  if (st.shapeApproximate?.length || (st.crossings ?? []).some((c) => c.approximate > 0)) return 'approximate: part of the shape did not settle';
  return '';
}

export function lengthApproximate(st: ReturnType<typeof useApp.getState>['wireChecks'][string] | undefined): boolean {
  return lengthApproximateWhy(st) !== '';
}

export function statusText(st: ReturnType<typeof useApp.getState>['wireChecks'][string] | undefined): string {
  if (!st) return 'checking...';
  if (!st.known) return 'type not in library';
  if (st.stale || st.shapePending) return 'checking: working out the shape';
  const parts: string[] = [];
  parts.push(st.fits ? 'fits' : 'does not fit');
  parts.push(st.bendGrade === 'fail' ? 'bend too tight' : st.bendGrade === 'warn' ? 'bend tighter than the size rule (warning)' : 'bends ok on links');
  if ((st.folds ?? []).length > 0) parts.push(`${st.folds!.length} fold(s) needed`);
  const cr = st.crossings ?? [];
  if (cr.some((c) => !c.reaches)) parts.push('a joint crossing does not reach');
  if (cr.some((c) => c.reaches && !c.bend.ok))
    parts.push(cr.some((c) => c.reaches && c.bend.grade === 'fail') ? 'too tight over a joint' : 'tighter than the size rule over a joint (warning)');
  if (cr.some((c) => c.press)) parts.push('a loop would press into the model (warning)');
  if (cr.some((c) => c.reaches && c.bend.ok && c.bend.noFlexFigure)) parts.push('flexing over a joint not judged: no flexing bend radius known (warning)');
  if (cr.some((c) => c.continuousWarning)) parts.push('crosses a joint that turns without limit (warning)');
  if (cr.some((c) => c.flatWarning)) parts.push('ribbon would twist across a joint (warning)');
  if (st.complete === false) parts.push(`length is a lower bound: ${st.incomplete}`);
  for (const e of st.ends ?? []) {
    if (e.problems.length) parts.push(`${e.end === 'from' ? 'start' : 'end'} at ${e.label}: ${e.problems.join(' ')}`);
    if (e.detached) parts.push(`${e.end === 'from' ? 'start' : 'end'} is no longer attached to ${e.label} (that port is gone)`);
  }
  if ((st.keepClear ?? []).length) parts.push(`lies on keep-clear area ${st.keepClear!.join(', ')} (warning)`);
  if (st.cutTooShort) parts.push('your cut length is too short');
  return parts.join(', ');
}

/** The ports the type list judges against: the port a wire being drawn starts at, else the selected wire's attached ports. */
function usePortsInContext(): PortInfo[] {
  const design = useApp((s) => s.design);
  const lib = useApp((s) => s.library);
  const connectors = useApp((s) => s.connectorLibrary);
  const drawFrom = useApp((s) => s.wireDraft?.markPorts?.[0] ?? null);
  const selected = useApp((s) => (s.selection?.kind === 'cable' ? s.selection.id : null));
  return useMemo(() => {
    if (drawFrom) {
      const info = portInfo(design, lib, connectors, drawFrom);
      return info ? [info] : [];
    }
    const route = selected ? design.routes.find((r) => r.cable === selected) : undefined;
    return route ? attachedEnds(design, lib, connectors, route).flatMap((e) => (e.info ? [e.info] : [])) : [];
  }, [design, lib, connectors, drawFrom, selected]);
}

/** "1.56 mm · bend 12.5 mm, flexing 18.8 mm". */
function metaLine(c: CableType): string {
  return `${sizeText(c)} · bend ${fmt(c.min_bend_mm.static, 1)} mm${c.min_bend_mm.dynamic !== undefined ? `, flexing ${fmt(c.min_bend_mm.dynamic, 1)} mm` : ''}`;
}

const CONFIDENCE_TAG: Record<CableType['confidence'], string> = { datasheet: 'datasheet', measured: 'measured', derived: 'derived', generic: 'typical' };
const CONFIDENCE_TITLE: Record<CableType['confidence'], string> = {
  datasheet: "Figures from the maker's datasheet",
  measured: 'Figures measured on a sample',
  derived: 'Worked out from a datasheet figure by a stated rule',
  generic: 'Typical figures, not a particular product',
};

/** How the design's version of a cable differs from the stored one, in a few words. */
function differenceText(design: Design, stored: readonly StoredCable[], id: string): string {
  const d = design.cable_types.find((t) => t.id === id);
  const st = stored.find((x) => x.type.id === id)?.type;
  if (!d || !st) return '';
  const out: string[] = [];
  if (d.name !== st.name) out.push(`named "${d.name}" here, "${st.name}" on this PC`);
  if (sizeText(d) !== sizeText(st)) out.push(`${sizeText(d)} here, ${sizeText(st)} on this PC`);
  if (d.min_bend_mm.static !== st.min_bend_mm.static || d.min_bend_mm.dynamic !== st.min_bend_mm.dynamic) out.push('different bend radii');
  return out.length ? out.join('; ') : 'other figures differ';
}

async function keepDesignVersion(id: string, name: string): Promise<void> {
  try {
    await keepDesignCableVersion(id);
    useApp.getState().notify('info', `Kept this design's version of "${name}" on this PC`, ['The version that was kept on this PC before is replaced.']);
  } catch (e) {
    useApp.getState().notify('error', `"${name}" was not kept on this PC`, [e instanceof Error ? e.message : String(e)]);
  }
}

async function removeMine(id: string, name: string): Promise<void> {
  const s = useApp.getState();
  const users = wiresUsing(s.design, id);
  const ok = await s.askConfirm(
    `Delete "${name}"?`,
    users.length
      ? `It is deleted from this PC. This design uses it in ${users.join(', ')} and keeps its own copy, so those wires stay as they are.`
      : 'It is deleted from this PC. Designs saved with it keep their own copy.',
    'Delete',
  );
  if (!ok) return;
  try {
    s.notify('info', 'Cable deleted', [await deleteUserCable(id)]);
  } catch (e) {
    s.notify('error', `"${name}" was not deleted`, [e instanceof Error ? e.message : String(e), 'It is still kept on this PC.']);
  }
}

/** The cable library: search, family filter, the user's own first in each group. */
function TypeLibrary({ onPicked }: { onPicked: () => void }) {
  const lib = useApp((s) => s.cableLibrary);
  const settings = useApp((s) => s.wireSettings);
  const stored = useApp((s) => s.customCables);
  const design = useApp((s) => s.design);
  const ports = usePortsInContext();
  const [q, setQ] = useState('');
  const [family, setFamily] = useState<CableFamily | ''>('');
  const [fitsOnly, setFitsOnly] = useState(false);
  const fitOf = (c: CableType) => {
    if (ports.length === 0) return undefined;
    const problems = ports.flatMap((p) => fitAtPort(p, c, settings.count).problems);
    return { fits: problems.length === 0, problems };
  };
  const groups = useMemo(() => groupByFamily(searchCableTypes(lib?.cables ?? [], q, family)), [lib, q, family]);
  // Keep the chosen type in view (a cable just added is chosen for the next wire).
  useEffect(() => {
    document.querySelector('.wire-type-list [aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [settings.type]);
  if (!lib) return <p className="empty-note">The cable library is not loaded.</p>;
  const pick = (c: CableType) => {
    useApp.setState((s) => ({ wireSettings: { ...s.wireSettings, type: c.id } }));
    onPicked();
  };
  const families = groupByFamily(lib.cables);
  let shown = 0;
  return (
    <div className="wire-types">
      <div className="lib-head">
        <div className="search-field">
          <IconSearch />
          <input
            className="text"
            type="search"
            placeholder={`Search ${lib.cables.length} cables`}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Search cable types"
            autoFocus
          />
        </div>
        <select value={family} onChange={(e) => setFamily(e.target.value as CableFamily | '')} aria-label="Cable family">
          <option value="">All kinds</option>
          {families.map((g) => (
            <option key={g.family} value={g.family}>
              {FAMILY_LABEL[g.family]} ({g.types.length})
            </option>
          ))}
        </select>
        <button
          type="button"
          className="icon-btn"
          onClick={() => useApp.setState({ cableDialog: {} })}
          title="Add your own cable: a wire, round cable, ribbon, FFC or FPC, by its figures"
          aria-label="Add your own cable"
        >
          <IconPlus />
        </button>
      </div>
      {ports.length > 0 && (
        <label className="check-line small" title={ports.map((p) => p.label).join(' and ')}>
          <input type="checkbox" checked={fitsOnly} onChange={(e) => setFitsOnly(e.target.checked)} />{' '}
          <span className="ellipsis">Only cables that fit {ports.length === 1 ? 'this port' : 'these ports'}</span>
        </label>
      )}
      <div className="wire-type-list" role="listbox" aria-label="Cable types">
        {groups.map((g) => {
          const types = g.types.filter((c) => !fitsOnly || fitOf(c)?.fits !== false);
          if (types.length === 0) return null;
          shown += types.length;
          return (
            <div key={g.family} role="group" aria-label={FAMILY_LABEL[g.family]}>
              <div className="type-group">{FAMILY_LABEL[g.family]}</div>
              {types.map((c) => {
                const fit = fitOf(c);
                const mine = stored.some((x) => x.type.id === c.id);
                const differs = mine && designCableDiffers(design, stored, c.id);
                const chosen = c.id === settings.type;
                return (
                  <div key={c.id} className="type-row">
                    <button
                      type="button"
                      role="option"
                      aria-selected={chosen}
                      className={`lib-row${chosen ? ' chosen' : ''}${fit && !fit.fits ? ' misfit' : ''}`}
                      onClick={() => pick(c)}
                      title={`${c.name}${fit && !fit.fits ? `\n${fit.problems.join('\n')}` : ''}${c.source ? `\n${c.source}` : ''}`}
                    >
                      <CableThumb type={c} size={32} />
                      <span className="lib-text">
                        <span className="lib-name two-lines">{c.name}</span>
                        <span className="lib-meta">
                          <span className="ellipsis num">{metaLine(c)}</span>
                          {c.custom && <Tag tone="accent">{differs ? 'this design' : mine ? 'yours' : 'this design'}</Tag>}
                          <Tag title={CONFIDENCE_TITLE[c.confidence]}>{CONFIDENCE_TAG[c.confidence]}</Tag>
                          {fit && <StatusIcon verdict={fit.fits ? 'ok' : 'fail'} size={12} label={fit.fits ? 'Fits the port' : 'Does not fit the port'} />}
                        </span>
                      </span>
                    </button>
                    {differs && chosen && (
                      <div className="inline-note small">
                        This design uses its own version ({differenceText(design, stored, c.id)}).{' '}
                        <button type="button" className="link" onClick={() => applyStoredCableInDesign(c.id)}>
                          Use this PC&apos;s version here
                        </button>{' '}
                        or{' '}
                        <button type="button" className="link" onClick={() => void keepDesignVersion(c.id, c.name)}>
                          keep the design&apos;s version on this PC
                        </button>
                        .
                      </div>
                    )}
                    {mine && !differs && chosen && (
                      <span className="type-actions">
                        <button type="button" className="small-btn" onClick={() => useApp.setState({ cableDialog: { editId: c.id } })}>
                          <IconEdit size={13} /> Edit...
                        </button>
                        <button type="button" className="small-btn" onClick={() => void removeMine(c.id, c.name)}>
                          <IconTrash size={13} /> Delete...
                        </button>
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
        {shown === 0 && (
          <p className="empty-note">
            {fitsOnly
              ? 'No cable in the library fits. Clear the filter to see them all.'
              : 'No cable matches. Try a gauge such as "24 awg" or a kind such as "ribbon".'}
          </p>
        )}
      </div>
    </div>
  );
}

/** The cable the next wire is drawn with, as one card; "Change" opens the library. */
function CableToDraw() {
  const lib = useApp((s) => s.cableLibrary);
  const settings = useApp((s) => s.wireSettings);
  const tool = useApp((s) => s.activeTool);
  const hasModel = useApp((s) => s.design.scene.links.length > 0);
  const hasWires = useApp((s) => s.design.cables.length > 0);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (lib && !findCableType(lib, settings.type) && lib.cables[0]) useApp.setState((s) => ({ wireSettings: { ...s.wireSettings, type: lib.cables[0]!.id } }));
  }, [lib, settings.type]);
  const type = lib ? findCableType(lib, settings.type) : undefined;
  return (
    <section className="tab-section" aria-label="Cable to draw with">
      <div className="section-head">
        <h3 className="section-label">Cable to draw with</h3>
      </div>
      {type && (
        <div className="cable-card">
          <CableThumb type={type} size={40} />
          <div className="lib-text">
            <span className="lib-name two-lines" title={type.name}>
              {type.name}
            </span>
            <span className="lib-meta">
              <span className="ellipsis num">{metaLine(type)}</span>
              <Tag title={CONFIDENCE_TITLE[type.confidence]}>{CONFIDENCE_TAG[type.confidence]}</Tag>
            </span>
          </div>
          <button type="button" className="small-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? 'Done' : 'Change'}
          </button>
        </div>
      )}
      {(open || !type) && <TypeLibrary onPicked={() => setOpen(false)} />}
      <DesignOwnCables />
      <BuildFields />
      {(hasWires || tool === 'wire') && (
        <button
          type="button"
          className={`draw-btn${tool === 'wire' ? '' : ' primary'}`}
          disabled={!hasModel}
          aria-pressed={tool === 'wire'}
          onClick={() => useApp.getState().setActiveTool(tool === 'wire' ? 'select' : 'wire')}
          title={hasModel ? '' : 'Open a model first'}
        >
          <IconWire /> {tool === 'wire' ? 'Stop drawing' : 'Draw wire'}
        </button>
      )}
    </section>
  );
}

/** The design's own cable types this PC does not keep: offer to keep them. */
function DesignOwnCables() {
  const design = useApp((s) => s.design);
  const stored = useApp((s) => s.customCables);
  const only = useMemo(() => designOnlyCableTypes(design, stored), [design, stored]);
  if (only.length === 0) return null;
  return (
    <div className="inline-note small" title={only.map((t) => t.name).join(', ')}>
      This design brings {only.length === 1 ? 'a cable' : `${only.length} cables`} of its own that this PC does not keep.{' '}
      <button
        type="button"
        className="link"
        onClick={() =>
          void keepDesignCableTypes().then(({ kept, failed }) => {
            const n = useApp.getState().notify;
            if (kept.length)
              n('info', `Kept ${kept.length} cable type${kept.length === 1 ? '' : 's'} on this PC`, [
                `${kept.join(', ')}: listed with your cables in the Wires tab.`,
              ]);
            if (failed.length)
              n(
                'warning',
                `${failed.length} cable type${failed.length === 1 ? ' was' : 's were'} not kept on this PC`,
                failed.map((f) => `${f.name}: ${f.why} The design still has it, so its wires are unchanged.`),
              );
          })
        }
      >
        Keep {only.length === 1 ? 'it' : 'them'} on this PC
      </button>
    </div>
  );
}

function Info({ text }: { text: string }) {
  return (
    <span className="info-tip" tabIndex={0} role="img" aria-label={text} title={text}>
      <IconInfo size={13} />
    </span>
  );
}

function BuildFields() {
  const st = useApp((s) => s.wireSettings);
  const set = (patch: Partial<typeof st>) => useApp.setState((s) => ({ wireSettings: { ...s.wireSettings, ...patch } }));
  return (
    <div className="form-grid wire-build">
      <label htmlFor="wb-count">Run together</label>
      <span className="field">
        <input
          id="wb-count"
          className="num"
          type="number"
          min={1}
          max={60}
          value={st.count}
          onChange={(e) => set({ count: Math.max(1, Math.round(Number(e.target.value) || 1)) })}
        />
        <span className="unit">cables</span>
        <Info text="How many cables of this type run together as one bundle." />
      </span>
      <label htmlFor="wb-tw">Twisted</label>
      <span className="field">
        <input id="wb-tw" type="checkbox" checked={st.twisted} onChange={(e) => set({ twisted: e.target.checked })} />
        {st.twisted && (
          <>
            <input
              className="num"
              type="number"
              min={1}
              placeholder="auto"
              value={st.lay_length_mm ?? ''}
              onChange={(e) => set({ lay_length_mm: e.target.value === '' ? undefined : Math.max(1, Number(e.target.value)) })}
              aria-label="Lay length, mm"
            />
            <span className="unit">mm lay</span>
          </>
        )}
        <Info text="A twisted bundle needs a little more length. Lay: the length of one full twist; empty works it out from the size." />
      </span>
      <label htmlFor="wb-drape">Drape</label>
      <span className="field">
        <input id="wb-drape" type="checkbox" checked={st.drape} onChange={(e) => set({ drape: e.target.checked })} />
        <Info text="On: each leg lies on the surface between the points you click. Off: straight legs, for a wire spanning free space." />
      </span>
      <label htmlFor="wb-sl">Sleeve wall</label>
      <span className="field">
        <input
          id="wb-sl"
          className="num"
          type="number"
          min={0}
          step={0.1}
          value={st.sleeve_wall_mm}
          onChange={(e) => set({ sleeve_wall_mm: Math.max(0, Number(e.target.value) || 0) })}
        />
        <span className="unit">mm</span>
        <Info text="Wall thickness of a sleeve or wrap around the bundle, if any." />
      </span>
    </div>
  );
}

function WireList() {
  const design = useApp((s) => s.design);
  const lib = useApp((s) => s.cableLibrary);
  const checks = useApp((s) => s.wireChecks);
  const selection = useApp((s) => s.selection);
  const allowance = useApp((s) => s.wireAllowance_mm);
  const hasModel = useApp((s) => s.design.scene.links.length > 0);
  if (design.cables.length === 0)
    return (
      <div className="empty-block">
        <p>No wires yet.</p>
        <button
          type="button"
          className="primary"
          disabled={!hasModel}
          onClick={() => useApp.getState().setActiveTool('wire')}
          title={hasModel ? 'Click a port or the model where the wire starts' : 'Open a model first'}
        >
          <IconWire /> Draw a wire
        </button>
      </div>
    );
  const totals = new Map<string, { name: string; mm: number; n: number }>();
  for (const c of design.cables) {
    const cut = checks[c.id]?.cut_mm;
    if (cut === undefined) continue;
    const t = totals.get(c.type) ?? { name: (lib && findCableType(lib, c.type)?.name) || c.type, mm: 0, n: 0 };
    t.mm += cut * c.count;
    t.n += 1;
    totals.set(c.type, t);
  }
  const exportCsv = () => {
    const csv = cutListCsv(
      design.cables.map((c) => ({
        cable: c,
        type: lib ? findCableType(lib, c.type) : undefined,
        cut_mm: checks[c.id]?.cut_mm,
        required_mm: checks[c.id]?.required_mm,
        crossings: checks[c.id]?.crossings?.length,
        slack_mm: checks[c.id]?.slack_mm,
        joint_bend_min_mm: checks[c.id]?.crossings?.length ? Math.min(...checks[c.id]!.crossings!.map((x) => x.bend.radius_mm)) : undefined,
        incomplete: checks[c.id]?.complete === false ? checks[c.id]!.incomplete : '',
        approximate: lengthApproximateWhy(checks[c.id]),
        from_port: checks[c.id]?.ends?.find((e) => e.end === 'from')?.label,
        to_port: checks[c.id]?.ends?.find((e) => e.end === 'to')?.label,
        lay_assumed_mm: checks[c.id]?.layAssumed_mm,
        notes: checks[c.id]?.notes ?? [],
        status: statusText(checks[c.id]),
      })),
    );
    downloadText('cut-list.csv', csv, 'text/csv');
  };
  return (
    <>
      <div role="list" aria-label="Wires" className="row-list">
        {design.cables.map((c, i) => {
          const st = checks[c.id];
          const verdict = wireVerdict(st);
          const t = lib ? findCableType(lib, c.type) : undefined;
          const selected = selection?.kind === 'cable' && selection.id === c.id;
          return (
            <div key={c.id} role="listitem" className={`wire-row${selected ? ' selected' : ''}`}>
              <button
                type="button"
                className="wire-row-btn"
                onClick={() => useApp.getState().select({ kind: 'cable', id: c.id })}
                title={`${c.name ?? c.id}: ${statusText(st)}`}
              >
                <span className="zone-swatch" style={{ background: st?.known === false ? '#8a8f96' : wireColor(i) }} aria-hidden="true" />
                {t ? <CableThumb type={t} size={24} /> : <span className="cable-thumb" style={{ width: 24, height: 24 }} />}
                <span className="wire-name ellipsis">{c.name ?? c.id}</span>
                <span className="wire-len num">
                  {c.count > 1 ? `${c.count}x ` : ''}
                  {st?.cut_mm !== undefined
                    ? `${st.complete === false && c.length_mm === undefined ? '≥ ' : lengthApproximate(st) && c.length_mm === undefined ? '≈ ' : ''}${fmt(st.cut_mm, 0)} mm`
                    : ''}
                </span>
                <StatusIcon verdict={verdict === 'unknown' ? 'unknown' : verdict} label={statusText(st)} />
              </button>
            </div>
          );
        })}
      </div>
      {totals.size > 0 && (
        <details className="cut-totals">
          <summary>
            <span className="section-label">To buy</span> <span className="muted small">cut length x count, {allowance} mm per end allowed</span>
          </summary>
          <ul className="plain-list small">
            {[...totals.entries()].map(([id, t]) => (
              <li key={id} className="num">
                <span className="ellipsis">{t.name}</span> <strong>{fmt(t.mm, 0)} mm</strong>{' '}
                <span className="muted">
                  ({t.n} wire{t.n === 1 ? '' : 's'})
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
      <button type="button" className="small-btn" onClick={exportCsv}>
        <IconFile size={13} /> Export cut list (CSV)
      </button>
    </>
  );
}

export function WiresPanel() {
  const n = useApp((s) => s.design.cables.length);
  return (
    <div className="wires-panel">
      <section className="tab-section" aria-label="Wires in this design">
        <div className="section-head">
          <h3 className="section-label">Wires in this design</h3>
          {n > 0 && <span className="count">{n}</span>}
        </div>
        <WireList />
      </section>
      <CableToDraw />
    </div>
  );
}
