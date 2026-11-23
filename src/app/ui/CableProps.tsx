/** Properties of a selected wire: build, lengths, checks with numbers and limits, notes, and actions. */
import { useEffect, useState } from 'react';
import { findCableType } from '@core';
import { useApp } from '../state/store';
import { CableThumb } from './CableThumb';
import { CheckRow, Tag } from './StatusIcon';
import { IconExternal, IconTrash } from './icons';
import { fmt } from '../units';
import { removeWire, setCrossingSlack, updateCable } from '../wires/routeEdit';
import { crossingHeadline, FLAT_TWIST_WARN_DEG, lengthWhy, plural, poseText, type CrossingReport } from '../wires/crossings';
import { commitCableEdit, showPose } from '../wires/editing';
import { runRangeCheck } from '../wires/run';
import { sizeText } from '../wires/compare';
import { routePortFit } from '../wires/ports';
import { bendSourceText, bendSummary } from '../wires/checks';
import { meshLabels } from './labels';

const mm = (v: number | undefined, d = 1) => (v === undefined ? '-' : Number.isFinite(v) ? `${fmt(v, d)} mm` : 'straight');

/** One check row per joint crossing: the verdict with its numbers, and the details, slack and "Show tightest pose" in the expander. */
/** A bend radius for a summary line: a wire that runs straight has none worth a number. */
function radiusText(radius_mm: number | undefined): string {
  return radius_mm !== undefined && Number.isFinite(radius_mm) && radius_mm < 10_000 ? mm(radius_mm) : 'none (runs straight)';
}

function CrossingRows({ id, crossings, jointName, checking }: { id: string; crossings: CrossingReport[]; jointName: (j: string) => string; checking: boolean }) {
  const design = useApp((s) => s.design);
  const route = design.routes.find((r) => r.cable === id);
  if (!route) return null;
  const setSlack = (i: number, v: number | undefined) => useApp.getState().commit((d) => setCrossingSlack(d, route.id, i, v));
  const bodies = (links: readonly string[]) => (links.length ? links.map((l) => design.scene.links.find((x) => x.id === l)?.name || l).join(' and ') : 'the model');
  return (
    <>
      {crossings.map((c) => {
        const over = c.joints.map(jointName).join(', ') || 'a fixed joint';
        const at = poseText(design, c.bend.values);
        const head = crossingHeadline(c, checking);
        return (
          <CheckRow key={c.index} verdict={head.verdict} title={`Over ${over}`} summary={head.text}>
            <div className="num">{lengthWhy(design, c, jointName)}.</div>
            <div className="small num">
              Straight distance {mm(c.chord_min_mm)} to {mm(c.chord_max_mm)}. Slack {mm(c.slack_mm)}, {c.basis === 'user' ? 'stated by you' : 'chosen automatically'}.
            </div>
            <ul className="notice-details">
              {c.reaches && c.detour?.setsLength && (
                <li>
                  The wire has to go round {bodies(c.detour.around)} at {poseText(design, c.detour.values)}. The straight distance there is {mm(c.detour.chord_mm, 0)}; the way
                  round is {mm(c.detour.length_mm, 0)}, and the cut adds 2%.
                </li>
              )}
              {c.detour && !c.detour.setsLength && c.reaches && (
                <li className="muted">
                  The longest way round the model is {mm(c.detour.length_mm, 0)}, round {bodies(c.detour.around)} at {poseText(design, c.detour.values)}. The length covers it.
                </li>
              )}
              {c.joints.length > 0 && c.free_length_mm > 1.3 * c.chordHere_mm && (
                <li className="muted">To need less cable, hold the wire nearer the joint on both sides, or narrow the joint&apos;s range.</li>
              )}
              {!c.reaches && c.short && c.short.round_mm !== undefined && (
                <li className="warn-text">
                  Does not reach at {poseText(design, c.short.values)}. The way round {c.detour ? bodies(c.detour.around) : 'the model'} there is {mm(c.short.round_mm, 0)}, which is{' '}
                  {mm(c.short.by_mm)} more than the {mm(c.free_length_mm, 0)} your slack gives. Give it at least {mm(c.slack_mm + c.short.by_mm, 0)} of slack, or choose Auto.
                </li>
              )}
              {!c.reaches && c.short && c.short.round_mm === undefined && (
                <li className="warn-text">
                  Does not reach: {mm(c.short.by_mm)} short at {poseText(design, c.short.values)}. Give it more slack.
                </li>
              )}
              {c.press && (
                <li className="warn-text">
                  The loop presses {mm(c.press.depth_mm, 2)} into {c.press.what} at {poseText(design, c.press.values)}. The settled loop could not get clear of it there. This is a
                  warning.
                </li>
              )}
              {c.approximate > 0 && (
                <li className="warn-text">The loop did not settle at {plural(c.approximate, 'sampled pose')}: the solver stopped at its time limit, so the figures there are approximate.</li>
              )}
              {c.detourFailed.length > 0 && (
                <li className="warn-text">
                  At {plural(c.detourFailed.length, 'sampled pose')} the way round the model could not be worked out: {c.detourFailed[0]!.why}. The length does not account for the model
                  there.
                </li>
              )}
              {c.reaches && !c.bend.ok && (
                <li className={c.bend.grade === 'fail' ? 'warn-text' : ''}>
                  Bends to {mm(c.bend.radius_mm)} at {at}. The {c.bend.kind === 'flexing' ? 'flexing' : 'installed'} limit is {mm(c.bend.limit_mm)}.
                  {c.bend.noFlexFigure ? ' This type states no flexing figure, so the installed one was used.' : ''}
                  {c.bend.grade === 'warn' ? " The limit is a size rule, not the maker's figure, so this is a warning." : ''}
                </li>
              )}
              {c.reaches && c.bend.ok && c.joints.length > 0 && !c.bend.noFlexFigure && <li className="muted">The bend holds the flexing limit {mm(c.bend.limit_mm)}.</li>}
              {c.reaches && c.bend.ok && c.bend.noFlexFigure && (
                <li className="warn-text">
                  No flexing bend radius is known for this cable. The loop bends to {mm(c.bend.radius_mm)} at {at} and was judged against the installed limit of{' '}
                  {mm(c.bend.limit_mm)}, which is not meant for a cable that keeps moving. Enter the cable&apos;s flexing bend radius under Own bend radius, or pick a cable rated to
                  flex.
                </li>
              )}
              {c.continuousWarning && <li className="warn-text">{c.continuousWarning}</li>}
              {c.flatWarning && <li className="warn-text">{c.flatWarning}</li>}
              {c.sharedSlack && (
                <li className="muted">
                  This loop crosses {c.sharedSlack.map(jointName).join(' and ')} with no hold between them. One slack applies to all of it: the first one stated for a joint on its
                  path.
                </li>
              )}
              {c.unsampled.length > 0 && <li className="muted">Not swept: {c.unsampled.map(jointName).join(', ')}. They are held at their saved values, so the range may be too narrow.</li>}
            </ul>
            <div className="inline-row">
              <span className="muted">Slack</span>
              <SlackInput basis={c.basis} value={c.slack_mm} onChange={(v) => setSlack(c.index, v)} />
              {c.joints.length > 0 && (
                <button type="button" className="small-btn" onClick={() => showPose(c.tightestValues)} title="Move the joints to the pose where this crossing bends most tightly">
                  Show tightest pose
                </button>
              )}
            </div>
            <p className="muted small">
              The loop is the stiff wire settled at its fixed length between the holds either side. It rests on the model and the parts, and sags where the cable&apos;s weight is
              known; twist is not modelled. Its length is at least the way round the model at every sampled pose. Poses are sampled across each joint&apos;s range. A ribbon twisted
              more than {FLAT_TWIST_WARN_DEG} degrees, or shifted sideways by more than half its width, is flagged: our judgement, not a sourced limit.
            </p>
          </CheckRow>
        );
      })}
    </>
  );
}

/** Slack: Auto (chosen by the model) or the user's own number of mm. */
function SlackInput({ basis, value, onChange }: { basis: 'auto' | 'user'; value: number; onChange: (v: number | undefined) => void }) {
  const [text, setText] = useState(basis === 'user' ? String(Number(value.toFixed(2))) : '');
  useEffect(() => setText(basis === 'user' ? String(Number(value.toFixed(2))) : ''), [basis, value]);
  const apply = () => {
    const v = Number(text);
    if (text.trim() === '') {
      if (basis === 'user') onChange(undefined);
    } else if (Number.isFinite(v) && v >= 0) onChange(v);
    else setText(basis === 'user' ? String(value) : '');
  };
  return (
    <span className="inline-row">
      <input
        className="num"
        type="number"
        min={0}
        step={1}
        placeholder={`auto (${value.toFixed(0)})`}
        style={{ minWidth: 92 }}
        value={text}
        aria-label="Slack for this crossing, mm"
        onChange={(e) => setText(e.target.value)}
        onBlur={apply}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      <span className="muted">mm</span>
      {basis === 'user' && (
        <button type="button" onClick={() => onChange(undefined)} title="Let the model choose the slack">
          Auto
        </button>
      )}
    </span>
  );
}

/** The user's own cut length; empty = use the computed requirement. */
function UserLength({ value, onChange }: { value: number | undefined; onChange: (v: number | undefined) => void }) {
  const [text, setText] = useState(value === undefined ? '' : String(value));
  useEffect(() => setText(value === undefined ? '' : String(value)), [value]);
  const apply = () => {
    const v = Number(text);
    if (text.trim() === '') {
      if (value !== undefined) onChange(undefined);
    } else if (Number.isFinite(v) && v > 0) {
      if (v !== value) onChange(v);
    } else setText(value === undefined ? '' : String(value));
  };
  return (
    <span className="inline-row">
      <input
        className="num"
        type="number"
        min={1}
        placeholder="auto"
        value={text}
        aria-label="Your cut length, mm"
        onChange={(e) => setText(e.target.value)}
        onBlur={apply}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      <span className="muted">mm</span>
      {value !== undefined && (
        <button type="button" onClick={() => onChange(undefined)} title="Use the computed length again">
          Clear
        </button>
      )}
    </span>
  );
}

/** The user's own minimum bend radius for this wire, with the library's value beside it. */
function BendOverride({ value, library, onChange }: { value: number | undefined; library: number | undefined; onChange: (v: number | undefined) => void }) {
  const [text, setText] = useState(value === undefined ? '' : String(value));
  useEffect(() => setText(value === undefined ? '' : String(value)), [value]);
  const apply = () => {
    const v = Number(text);
    if (text.trim() === '') {
      if (value !== undefined) onChange(undefined);
    } else if (Number.isFinite(v) && v > 0) {
      if (v !== value) onChange(v);
    } else setText(value === undefined ? '' : String(value));
  };
  return (
    <span className="inline-row">
      <input
        className="num"
        type="number"
        min={0.1}
        step={0.5}
        placeholder="library"
        value={text}
        aria-label="Own minimum bend radius, mm"
        onChange={(e) => setText(e.target.value)}
        onBlur={apply}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      <span className="muted">mm</span>
      <span className="muted small">library {library !== undefined ? `${fmt(library, 1)} mm` : '-'}</span>
      {value !== undefined && (
        <button type="button" onClick={() => onChange(undefined)} title="Use the library's bend radius again">
          Clear
        </button>
      )}
    </span>
  );
}

/** What each confidence tag means, on hover. */
const CONFIDENCE_MEANING: Record<string, string> = {
  datasheet: "Figures from the maker's datasheet",
  measured: 'Figures measured on a sample',
  derived: "Bend limit worked out by rule (from the cable's size or another datasheet figure), not the maker's own figure",
  generic: 'Typical figures for this kind of cable, not a particular product',
};

export function CableProps({ id }: { id: string }) {
  const cable = useApp((s) => s.design.cables.find((c) => c.id === id));
  const lib = useApp((s) => s.cableLibrary);
  const st = useApp((s) => s.wireChecks[id]);
  const design = useApp((s) => s.design);
  const partLib = useApp((s) => s.library);
  const connectors = useApp((s) => s.connectorLibrary);
  const route = design.routes.find((r) => r.cable === id);
  const joints = useApp((s) => s.design.scene.joints);
  const allowance = useApp((s) => s.wireAllowance_mm);
  const isMine = useApp((s) => s.customCables.some((c) => c.type.id === s.design.cables.find((x) => x.id === id)?.type));
  const [name, setName] = useState(cable?.name ?? '');
  useEffect(() => setName(cable?.name ?? ''), [cable?.name]);
  if (!cable) return null;
  const type = lib ? findCableType(lib, cable.type) : undefined;
  // A size change re-drapes the route for the new cable (one undo step).
  const commit = (patch: Parameters<typeof updateCable>[2]) => commitCableEdit(id, patch);
  const jointName = (jid: string) => joints.find((j) => j.id === jid)?.name || jid;
  const links = design.scene.links;
  const linkName = (lid: string | undefined) => (lid ? links.find((l) => l.id === lid)?.name || lid : '?');
  /** A body, placed part or wire by its name, not its id. */
  const nameOf = (what: string | undefined) => {
    if (!what) return '';
    const comp = design.components.find((c) => c.id === what);
    if (comp) return comp.name || what;
    const wire = design.cables.find((c) => c.id === what);
    if (wire) return wire.name || what;
    // A body: its label in the model list.
    const label = meshLabels(design).get(what);
    if (label) return label;
    return what;
  };
  const clear = st?.tightest_mm !== undefined && st.margin_mm !== undefined && st.tightest_mm >= st.margin_mm;
  const clearance = clear ? `at least ${fmt(st!.margin_mm!, 0)} mm clear everywhere` : `clearance ${mm(st?.tightest_mm, 2)}`;
  /** No part of the wire lies on a body (it is all loops between holds): the on-body checks have nothing to pass. */
  const offBodies = st?.onLinks_mm !== undefined && st.onLinks_mm < 0.5 && (st.crossings ?? []).length > 0;
  return (
    <div className="props-pane">
      <div className="obj-head">
        {type ? <CableThumb type={type} size={48} /> : <span className="cable-thumb" style={{ width: 48, height: 48 }} />}
        <div className="obj-title">
          <input
            className="text obj-name"
            value={name}
            aria-label="Wire name"
            onChange={(e) => setName(e.target.value)}
            onBlur={() => {
              const v = name.trim();
              if (v && v !== cable.name) commit({ name: v });
              else setName(cable.name ?? '');
            }}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
          <span className="tags">
            {type && <Tag>{type.family.replace('_', ' ')}</Tag>}
            {type && <Tag title={CONFIDENCE_MEANING[type.confidence]}>{type.confidence === 'generic' ? 'typical' : type.confidence}</Tag>}
            {type?.custom && <Tag tone="accent">{isMine ? 'yours' : 'this design'}</Tag>}
            {type?.source && (
              <a className="tag tag-link" href={type.source} target="_blank" rel="noreferrer" title={`Open the source of these figures (new tab): ${type.source}`}>
                Datasheet
                <IconExternal size={11} aria-hidden="true" />
              </a>
            )}
          </span>
        </div>
      </div>
      <dl className="props">
        <dt>Type</dt>
        <dd>
          <select value={cable.type} aria-label="Cable type" onChange={(e) => commit({ type: e.target.value })}>
            {!type && <option value={cable.type}>{cable.type} (not in library)</option>}
            {lib?.cables.map((c) => {
              const fit = route ? routePortFit(design, partLib, connectors, route, c, cable.count) : undefined;
              return (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {fit ? (fit.fits ? ' - fits the port' : ' - does not fit the port') : ''}
                </option>
              );
            })}
          </select>
          {type && (
            <span className="muted small num">
              {sizeText(type)} · {type.conductors} conductor{type.conductors === 1 ? '' : 's'}
            </span>
          )}
          {!type && <span className="warn-text small">Not in the cable library: drawn grey and not checked.</span>}
        </dd>
        <dt>Run together</dt>
        <dd>
          <span className="inline-row">
            <input className="num" type="number" min={1} value={cable.count} aria-label="Number of cables run together" onChange={(e) => commit({ count: Math.max(1, Math.round(Number(e.target.value) || 1)) })} />
            <label className="check-line">
              <input type="checkbox" checked={cable.twisted} onChange={(e) => commit({ twisted: e.target.checked })} /> twisted
            </label>
          </span>
        </dd>
        {cable.twisted && (
          <>
            <dt>Lay length</dt>
            <dd>
              <span className="inline-row">
                <input
                  className="num"
                  type="number"
                  min={1}
                  placeholder="auto"
                  value={cable.lay_length_mm ?? ''}
                  aria-label="Lay length, mm"
                  onChange={(e) => commit({ lay_length_mm: e.target.value === '' ? undefined : Math.max(1, Number(e.target.value)) })}
                />
                <span className="unit">mm</span>
              </span>
            </dd>
          </>
        )}
        <dt>Sleeve wall</dt>
        <dd>
          <span className="inline-row">
            <input className="num" type="number" min={0} step={0.1} value={cable.sleeve_wall_mm} aria-label="Sleeve wall, mm" onChange={(e) => commit({ sleeve_wall_mm: Math.max(0, Number(e.target.value) || 0) })} />
            <span className="unit">mm</span>
          </span>
        </dd>
        {st?.known && (
          <>
            <dt>Size</dt>
            <dd className="num">
              {st.shape === 'flat' ? `${fmt(st.width_mm ?? 0, 2)} x ${fmt(st.height_mm ?? 0, 2)} mm` : `${fmt(st.width_mm ?? 0, 2)} mm across`}
              {cable.count > 1 && st.shape === 'round' && <span className="muted"> ({cable.count} wires{cable.twisted ? ', twisted' : ', parallel'})</span>}
            </dd>
            <dt>Own bend radius</dt>
            <dd>
              <BendOverride value={cable.bend_override_mm} library={st.libraryBend_mm ?? st.bendLimit_mm} onChange={(v) => commit({ bend_override_mm: v })} />
            </dd>
          </>
        )}
      </dl>

      {!st && <p className="muted small">Checking...</p>}
      {st?.known && (
        <>
          <h3 className="section-label">Checks</h3>
          {(st.shapePending || st.stale) && <p className="muted small">Working out the shape of the wire...</p>}
          {st.shapeApproximate && (
            <div className="inline-note small warn-text">
              The shape is approximate: {st.shapeApproximate.join(' ')} Nothing is passed on it until it settles.
            </div>
          )}
          <div className="checks">
            <CheckRow
              verdict={st.shapePending || st.stale ? 'checking' : !st.fits ? 'fail' : offBodies ? 'info' : st.shapeApproximate ? 'warn' : 'ok'}
              title="Fit"
              summary={
                st.shapePending || st.stale
                  ? 'working out the shape'
                  : offBodies && st.fits
                    ? 'no part of this wire lies on a body: see the joints below'
                    : `${clearance}${!clear && st.tightestWhat ? ` to ${nameOf(st.tightestWhat)}` : ''}`
              }
            >
              <div className="small num">
                {st.fits ? 'Fits' : 'Does not fit'} at the pose shown; tolerance {fmt(st.tolerance_mm ?? 0, 2)} mm.
              </div>
              {(st.crossings ?? []).length > 0 && <div className="muted small">On links; the loops over joints are checked in their own rows.</div>}
              {(st.uncertainMeshes ?? []).length > 0 && (
                <div className="small warn-text">Not watertight near the wire: {st.uncertainMeshes!.map(nameOf).join(', ')}. Inside or outside there was decided by a majority of five rays.</div>
              )}
              {(st.failing ?? []).length > 0 && (
                <ul className="warn-list num">
                  {st.failing!.slice(0, 5).map((f, i) => (
                    <li key={i}>
                      {fmt(f.from_mm, 0)}-{fmt(f.to_mm, 0)} mm along: {fmt(-f.clearance_mm, 2)} mm into {nameOf(f.what)}
                    </li>
                  ))}
                </ul>
              )}
              <button type="button" className="small-btn" disabled={st.range?.running} onClick={() => void runRangeCheck(id)} title="Sample every joint that can bring a body near this wire and report the worst pose">
                Check across the range of motion
              </button>
              {st.range && (
                <div className={`small num${st.range.fitsAll === false ? ' warn-text' : ''}`}>
                  {st.range.running ? `Checking pose ${st.range.done} of ${st.range.poses}...` : `${st.range.poses} poses: ${st.range.fitsAll ? 'fits at every pose' : st.range.approximate ? `not known at ${plural(st.range.approximate, 'pose')} where the shape did not settle` : 'does not fit at some poses'}`}
                  {` (moving ${st.range.sampled.length ? st.range.sampled.map(jointName).join(', ') : 'no joint: none can reach this wire'}${st.range.sampled.length ? `, ${st.range.perJoint} values each` : ''})`}
                  {st.range.worst_mm !== undefined &&
                    `; worst clearance ${fmt(st.range.worst_mm, 2)} mm${st.range.worstWhat ? ` to ${st.range.worstWhat}` : ''} at ${Object.entries(st.range.worstPose ?? {})
                      .map(([j, v]) => `${jointName(j)} ${fmt((v * 180) / Math.PI, 0)}°`)
                      .join(', ') || 'the pose shown'}`}
                  {!st.range.running && st.range.skipped.length > 0 && `. Left at the pose shown (too many joints to sample): ${st.range.skipped.map(jointName).join(', ')}.`}
                </div>
              )}
            </CheckRow>

            <CheckRow
              verdict={
                st.shapePending || st.stale
                  ? 'checking'
                  : st.bendGrade === 'fail'
                    ? 'fail'
                    : st.bendGrade === 'warn' || (st.folds ?? []).length > 0 || st.shapeApproximate
                      ? 'warn'
                      : offBodies
                        ? 'info'
                        : 'ok'
              }
              title="Bend"
              summary={
                st.shapePending || st.stale
                  ? 'working out the shape'
                  : offBodies
                    ? 'no part of this wire lies on a body: see the joints below'
                    : `tightest ${radiusText(st.tightestBend_mm)}, limit ${mm(st.bendLimit_mm)}`
              }
            >
              <div className="small">Limit from: {bendSourceText(st.bendSource ?? 'generic')} (installed).</div>
              <div className="small">
                The wire is drawn and checked as a stiff wire laid snug between the points you placed, resting on what it touches and rounding edges as its stiffness
                lets it; over a joint it hangs under its own weight with the length it is cut to.
                {st.shape === 'flat' ? ' A flat cable is given no sag.' : ' The sag is an estimate.'} Twist and friction are not modelled.
              </div>
              {(st.shapeNotes ?? []).length > 0 && (
                <ul className="notice-details muted">
                  {st.shapeNotes!.map((n, i) => (
                    <li key={i}>{n}</li>
                  ))}
                </ul>
              )}
              {st.bendGrade === 'warn' && (
                <div className="small">
                  This limit is a rule applied to the cable&apos;s size, not the maker&apos;s figure, so breaking it is a warning, not a failure. Enter a measured or datasheet radius
                  as the own bend radius to check against it.
                </div>
              )}
              {(st.tightBends ?? []).length > 0 &&
                (() => {
                  const sum = bendSummary(st.tightBends!);
                  const item = (b: (typeof sum.worst)[number], i: number) => (
                    <li key={i} className="num">
                      {mm(b.radius_mm)} on {linkName(b.link)} at ({b.point.map((v) => fmt(v, 0)).join(', ')}) mm
                    </li>
                  );
                  return (
                    <div className={st.bendGrade === 'fail' ? 'warn-text small' : 'small'}>
                      {sum.count} corner{sum.count === 1 ? '' : 's'} tighter than the limit (marked orange on the wire); the worst:
                      <ul className={st.bendGrade === 'fail' ? 'warn-list' : 'notice-details'}>{sum.worst.map(item)}</ul>
                      {sum.more.length > 0 && (
                        <details>
                          <summary>{sum.more.length} more</summary>
                          <ul className="notice-details">{sum.more.map((b, i) => item(b, i + 3))}</ul>
                        </details>
                      )}
                    </div>
                  );
                })()}
              {(st.folds ?? []).length > 0 && (
                <ul className="warn-list">
                  {st.folds!.map((f, i) => (
                    <li key={i}>
                      Turns {fmt(f.angle_deg, 0)}° sideways in the surface on segment {f.segment + 1}: a flat cable must be folded here, or the route changed (marked purple).
                    </li>
                  ))}
                </ul>
              )}
            </CheckRow>

            {(st.crossings ?? []).length > 0 && <CrossingRows id={id} crossings={st.crossings!} jointName={jointName} checking={!!(st.shapePending || st.stale)} />}

            {(st.ends ?? []).map((e) => (
              <CheckRow
                key={e.end}
                verdict={e.problems.length ? 'fail' : e.detached ? 'warn' : 'ok'}
                title={e.end === 'from' ? 'Start' : 'End'}
                summary={e.problems.length ? 'does not fit the port' : e.detached ? 'no longer attached' : 'fits the port'}
              >
                <div className="small">At {e.label}.</div>
                {e.problems.length > 0 && <div className="warn-text small">{e.problems.join(' ')}</div>}
                {e.detached && <div className="warn-text small">This end is no longer at the port: drag the end back onto the port or redraw the wire.</div>}
                {e.notes.map((n, i) => (
                  <div key={i} className="muted small">
                    {n}
                  </div>
                ))}
              </CheckRow>
            ))}
            {(st.ends ?? []).length === 0 && <CheckRow verdict="info" title="Ports" summary="not attached to a port" />}

            {(st.keepClear ?? []).length > 0 && (
              <CheckRow verdict="warn" title="Areas" summary={`on ${st.keepClear!.join(', ')}`}>
                <div className="small">Lies on a keep-clear area: move the wire off it, or change the area if it may go there.</div>
              </CheckRow>
            )}
          </div>

          <h3 className="section-label">Length</h3>
          <div className="length-block">
            <div className="big-number num">
              {st.complete === false && cable.length_mm === undefined ? '≥ ' : ''}
              {mm(st.required_mm)}
              <span className="muted small"> required</span>
            </div>
            <div className="inline-row">
              <span className="muted">Cut length</span>
              <UserLength value={cable.length_mm} onChange={(v) => commit({ length_mm: v })} />
            </div>
            {st.cutTooShort && <div className="warn-text small">Shorter than the {mm(st.required_mm)} this route needs.</div>}
            {st.complete === false && <div className="warn-text small">Lower bound: {st.incomplete}.</div>}
            <details className="expander">
              <summary>How it adds up</summary>
              <div className="small num">On bodies {mm(st.onLinks_mm)}</div>
              {(st.crossings ?? []).map((c, i) => (
                <div key={i} className="small num">
                  Over {c.joints.map(jointName).join(', ') || `joint ${i + 1}`}: {lengthWhy(design, c, jointName)}.
                </div>
              ))}
              <div className="small num">Route {mm(st.length_mm)}</div>
              <div className="small num">
                Required = route x {fmt(st.length_factor ?? 1, 3)} + 2 x{' '}
                <input
                  className="num"
                  type="number"
                  min={0}
                  value={allowance}
                  aria-label="Allowance per end, mm"
                  onChange={(e) => useApp.setState({ wireAllowance_mm: Math.max(0, Number(e.target.value) || 0) })}
                  style={{ width: 52 }}
                />{' '}
                mm per end
              </div>
            </details>
          </div>

          {(st.notes ?? []).length > 0 && (
            <details className="expander">
              <summary>Notes ({st.notes!.length})</summary>
              <ul className="notice-details">
                {st.notes!.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}

      <div className="action-row">
        <button type="button" disabled={!lib} onClick={() => useApp.setState({ compareCable: id })}>
          Compare cable types
        </button>
        <button
          type="button"
          onClick={() => {
            useApp.getState().commit((d) => removeWire(d, id));
            useApp.getState().select(null);
          }}
        >
          <IconTrash size={14} /> Delete wire
        </button>
      </div>
      <p className="muted small hint">Drag a white point to move it. Ctrl+click adds a point; Delete removes the selected one.</p>
    </div>
  );
}
