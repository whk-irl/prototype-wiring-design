/**
 * "Add your own cable": pick the kind, enter its figures (units on every
 * field; optional ones say what happens when left empty), and see live what
 * the app makes of it: the thumbnail, the size and bend radii, and the
 * figures it worked out (under a heading that says they were not entered).
 * Problems are shown next to the field they concern; the cable can be saved
 * only when the figures describe a cable.
 *
 * Opened by `useApp.cableDialog` (`{}` for a new cable, `{ editId }` to edit
 * a stored one, re-opened with the parameters it was saved with).
 */
import { useMemo, useState } from 'react';
import { useApp } from '../state/store';
import { saveUserCable, specForEditing, wiresUsing } from '../userCables/actions';
import { emptyCommon, evaluateForm, specFromForm, fieldsFor, formFromSpec, KIND_LABEL, type CableKind, type CommonFields } from '../userCables/form';
import { cableThumbScene } from '../viewport/cableThumb';
import { renderPreview } from '../viewport/thumbnails';
import { disposeObject } from '../viewport/partVisual';
import { dialogKeys, useModalFocus } from './Dialog';
import { sizeText } from '../wires/compare';
import { fmt } from '../units';

const ROUND_FAMILY_LABEL: Record<CommonFields['round_family'], string> = {
  multicore: 'Multi-core',
  twisted_pair: 'Twisted pair',
  coax: 'Coaxial',
  usb: 'USB',
  ethernet: 'Ethernet',
};

const CONFIDENCE_TEXT = {
  datasheet: "from the maker's datasheet",
  measured: 'measured',
  derived: 'your sizes, a bend radius worked out by rule',
  generic: 'a size was assumed: measure the cable to replace it',
} as const;

export function AddCableDialog() {
  const dialog = useApp((s) => s.cableDialog);
  if (!dialog) return null;
  // A fresh form each time it opens (it is unmounted while closed): its state starts from what is edited, never from the last session.
  return <CableForm key={dialog.editId ?? 'new'} editId={dialog.editId} />;
}

/** Where an edit starts: the version the open design uses when it carries one, else the stored one. */
function startOf(editId: string | undefined) {
  const s = useApp.getState();
  if (!editId) return { form: { kind: 'wire' as CableKind, values: {}, common: emptyCommon(), hidden: {} }, withoutParameters: false };
  const type = s.design.cable_types.find((t) => t.id === editId) ?? s.customCables.find((c) => c.type.id === editId)?.type;
  if (!type) return { form: { kind: 'wire' as CableKind, values: {}, common: emptyCommon(), hidden: {} }, withoutParameters: false };
  const { spec, withoutParameters } = specForEditing(type);
  return { form: formFromSpec(spec), withoutParameters };
}

function CableForm({ editId }: { editId: string | undefined }) {
  const dialog = { ...(editId ? { editId } : {}) };
  const design = useApp((s) => s.design);
  const usedBy = useMemo(() => (editId && design.cable_types.some((t) => t.id === editId) ? wiresUsing(design, editId) : []), [editId, design]);
  const [start] = useState(() => startOf(editId));
  const [kind, setKind] = useState<CableKind>(start.form.kind);
  const [values, setValues] = useState<Record<string, string>>(start.form.values);
  const [common, setCommon] = useState<CommonFields>(start.form.common);
  const hidden = start.form.hidden;
  // Asked, not assumed: the design's wires change only when the user ticks this.
  const [updateDesign, setUpdateDesign] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const modalRef = useModalFocus<HTMLDivElement>();
  const [editing, setEditing] = useState<string | null>(null);

  const result = useMemo(() => evaluateForm(kind, values, common, 'custom-preview', hidden), [kind, values, common, hidden]);
  const preview = useMemo(() => {
    if (!result.type) return null;
    const scene = cableThumbScene(result.type);
    try {
      return renderPreview(scene, 160);
    } catch {
      return null;
    } finally {
      disposeObject(scene);
    }
  }, [result.type]);

  const close = () => useApp.setState({ cableDialog: null });
  const fields = fieldsFor(kind).filter((f) => !f.when || f.when(values));
  // A field not filled in yet is listed once beside the preview, not under the field (the form would jump while typing).
  const isMissing = (p: { field?: string; message: string }) => !!p.field && / is needed\.$/.test(p.message);
  const missing = result.problems.filter(isMissing).map((p) => p.message.replace(/ is needed\.$/, ''));
  // A field's problems wait until the user leaves it: lines appearing under it while typing push the fields below down.
  const problemFor = (key: string) => (editing === `ac-${key}` ? [] : result.problems.filter((p) => p.field === key && !isMissing(p)));
  const shownAtField = new Set([...fields.map((f) => f.key), 'name', 'manufacturer', 'mpn', 'source', 'bend_static_mm', 'bend_dynamic_mm']);
  const general = result.problems.filter((p) => !isMissing(p) && (!p.field || !shownAtField.has(p.field)));
  const setC = (patch: Partial<CommonFields>) => setCommon((c) => ({ ...c, ...patch }));
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const type = await saveUserCable(specFromForm(kind, values, common, hidden), { ...(dialog.editId ? { id: dialog.editId } : {}), updateDesign: usedBy.length > 0 && updateDesign });
      useApp.setState((s) => ({ cableDialog: null, wireSettings: { ...s.wireSettings, type: type.id } }));
      useApp
        .getState()
        .notify('info', dialog.editId ? `Saved "${type.name}"` : `Added "${type.name}" to your cables`, [
          dialog.editId && usedBy.length > 0
            ? updateDesign
              ? `The wires in this design that use it (${usedBy.join(', ')}) now use the new figures and are checked again.`
              : `This design keeps its own copy for ${usedBy.join(', ')}; your stored version is changed.`
            : 'It is chosen for the next wire you draw, and listed first in its group in the Wires tab.',
        ]);
    } catch (e) {
      setError(`Not saved. ${e instanceof Error ? e.message : String(e)}`);
      setSaving(false);
    }
  };
  const textField = (key: keyof CommonFields, label: string, placeholder = '', note?: string) => (
    <>
      <label className="muted" htmlFor={`ac-${key}`}>
        {label}
      </label>
      <input id={`ac-${key}`} className="text" value={String(common[key])} placeholder={placeholder} onChange={(e) => setC({ [key]: e.target.value } as Partial<CommonFields>)} />
      {note && <span className="field-note muted small">{note}</span>}
      {problemFor(key).map((p, i) => (
        <span key={i} className="field-problem small">
          {p.message}
        </span>
      ))}
    </>
  );
  const numField = (key: 'bend_static_mm' | 'bend_dynamic_mm', label: string, note: string) => (
    <>
      <label className="muted" htmlFor={`ac-${key}`}>
        {label}
      </label>
      <span>
        <input id={`ac-${key}`} className="num" inputMode="decimal" value={common[key]} onChange={(e) => setC({ [key]: e.target.value })} /> mm{' '}
        <span className="muted small">optional</span>
      </span>
      <span className="field-note muted small">{note}</span>
      {problemFor(key).map((p, i) => (
        <span key={i} className="field-problem small">
          {p.message}
        </span>
      ))}
    </>
  );
  const t = result.type;
  return (
    <div className="modal-backdrop">
      <div
        ref={modalRef}
        tabIndex={-1}
        className="modal add-cable"
        role="dialog"
        aria-modal="true"
        aria-labelledby="addcable-title"
        onKeyDown={dialogKeys(close)}
      >
        <h2 id="addcable-title">{dialog.editId ? 'Edit your cable' : 'Add your own cable'}</h2>
        {start.withoutParameters && (
          <p className="small warn-text">
            This cable came without the parameters it was built from (it was written by hand or by an older version), so every figure below is shown as entered,
            including any that were worked out by a rule.
          </p>
        )}
        <div className="add-cable-body">
          <div
            className="add-cable-form je-grid"
            onFocus={(e) => setEditing((e.target as HTMLElement).id || null)}
            onBlur={() => setEditing(null)}
          >
            <label className="muted" htmlFor="ac-kind">
              Kind
            </label>
            <select id="ac-kind" value={kind} onChange={(e) => setKind(e.target.value as CableKind)}>
              {(Object.keys(KIND_LABEL) as CableKind[]).map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>
            {kind === 'round_cable' && (
              <>
                <label className="muted" htmlFor="ac-family">
                  Kind of round cable
                </label>
                <select id="ac-family" value={common.round_family} onChange={(e) => setC({ round_family: e.target.value as CommonFields['round_family'] })}>
                  {(Object.keys(ROUND_FAMILY_LABEL) as Array<CommonFields['round_family']>).map((f) => (
                    <option key={f} value={f}>
                      {ROUND_FAMILY_LABEL[f]}
                    </option>
                  ))}
                </select>
              </>
            )}
            {fields.map((f) => (
              <FieldRow
                key={`${kind}-${f.key}`}
                id={`ac-${f.key}`}
                label={f.label}
                unit={f.unit}
                optional={f.empty}
                help={f.help}
                value={values[f.key] ?? ''}
                onChange={(v) => setValues((x) => ({ ...x, [f.key]: v }))}
                problems={problemFor(f.key).map((p) => p.message)}
                warnings={result.warnings.filter((w) => w.field === f.key).map((w) => w.message)}
              />
            ))}
            <span className="muted">Figures from</span>
            <span className="seg" role="group" aria-label="Where your figures come from">
              <button type="button" aria-pressed={common.basis === 'datasheet'} onClick={() => setC({ basis: 'datasheet' })}>
                Datasheet
              </button>
              <button type="button" aria-pressed={common.basis === 'measured'} onClick={() => setC({ basis: 'measured' })}>
                Measured
              </button>
            </span>
            <span />
            <label className="small">
              <input type="checkbox" checked={common.flexing} onChange={(e) => setC({ flexing: e.target.checked })} /> Flexes in use (crosses a joint that moves)
            </label>
            {numField('bend_static_mm', 'Bend radius, installed', 'Worked out by rule from the size if left empty.')}
            {common.flexing && numField('bend_dynamic_mm', 'Bend radius, flexing in use', 'Worked out by rule if left empty, where there is one.')}
            {textField('name', 'Name', t?.name ?? '', 'Optional: made from the figures if left empty.')}
            {textField('manufacturer', 'Maker', '', 'Optional.')}
            {textField('mpn', 'Part number', '', 'Optional.')}
            {textField('source', 'Datasheet link', 'https://...', 'Optional.')}
          </div>
          <div className="add-cable-preview">
            <div className="add-part-preview" style={{ width: 160, height: 160 }}>
              {preview ? <img src={preview} alt="The cable, drawn from these figures" width={160} height={160} /> : <span className="muted small">no preview yet</span>}
            </div>
            {t ? (
              <dl className="props small">
                <dt>Size</dt>
                <dd>{sizeText(t)}</dd>
                <dt>Bend radius</dt>
                <dd>
                  {fmt(t.min_bend_mm.static, 1)} mm installed
                  {t.min_bend_mm.dynamic !== undefined ? `, ${fmt(t.min_bend_mm.dynamic, 1)} mm flexing` : common.flexing ? ', no flexing figure' : ''}
                </dd>
                <dt>Figures</dt>
                <dd>{CONFIDENCE_TEXT[t.confidence]}</dd>
              </dl>
            ) : null}
            {result.derived.length > 0 && (
              <>
                <h3 className="small">Worked out by the app, not entered</h3>
                <ul className="derived-list small">
                  {result.derived.map((d, i) => (
                    <li key={i}>{d}</li>
                  ))}
                </ul>
              </>
            )}
            {missing.length > 0 && <p className="small muted">Still to fill in: {missing.join(', ')}.</p>}
            {general.length > 0 && (
              <ul className="derived-list small warn-text" aria-live="polite">
                {general.map((p, i) => (
                  <li key={i}>{p.message}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
        {dialog.editId && usedBy.length > 0 && (
          <label className="small">
            <input type="checkbox" checked={updateDesign} onChange={(e) => setUpdateDesign(e.target.checked)} /> Also change this design's copy, used by {usedBy.join(', ')} (their
            sizes change and they are checked again). Left unticked, only the version kept on this PC changes and this design keeps its own.
          </label>
        )}
        {error && <p className="warn-text">{error}</p>}
        <div className="modal-actions">
          <button type="button" onClick={close}>
            Cancel
          </button>
          <button type="button" className="primary" disabled={!t || saving} onClick={() => void save()} title={t ? '' : 'Fix the figures first'}>
            {dialog.editId ? 'Save' : 'Add cable'}
          </button>
        </div>
      </div>
    </div>
  );
}

function FieldRow(props: {
  id: string;
  label: string;
  unit?: string | undefined;
  optional?: string | undefined;
  help?: string | undefined;
  value: string;
  onChange: (v: string) => void;
  problems: string[];
  warnings: string[];
}) {
  return (
    <>
      <label className="muted" htmlFor={props.id}>
        {props.label}
      </label>
      <span>
        <input id={props.id} className="num" inputMode="decimal" value={props.value} onChange={(e) => props.onChange(e.target.value)} aria-invalid={props.problems.length > 0} />
        {props.unit && ` ${props.unit}`} {props.optional && <span className="muted small">optional</span>}
      </span>
      {(props.optional || props.help) && (
        <span className="field-note muted small">
          {props.optional ? `Left empty: ${props.optional}.` : ''}
          {props.optional && props.help ? ' ' : ''}
          {props.help}
        </span>
      )}
      {props.problems.map((p, i) => (
        <span key={i} className="field-problem small">
          {p}
        </span>
      ))}
      {props.warnings.map((p, i) => (
        <span key={`w${i}`} className="field-note small warn-text">
          {p}
        </span>
      ))}
    </>
  );
}
