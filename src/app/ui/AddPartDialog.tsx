/**
 * "Add your own part": a 3D model file (STEP, STP, GLB, STL, OBJ), a KiCad
 * board (.kicad_pcb) or a part file exported from this app. Files arrive
 * through `useApp.pendingPartFiles` (the Parts tab's button or a drop on it).
 *
 * A model: imported (with progress; Cancel abandons it), then a small form:
 * name, category, which side is the mounting face (six choices, live preview
 * of the part on a plane) and a quarter-turn spin; then `partFromModel`.
 * A board: its warnings and the ports it found are shown; name and category.
 * A part file: checked and added at once.
 *
 * Every new part goes through `planPartImport`: an id that is not a user part
 * id (`custom-...`) or is a bundled part's gets a new one; the same part
 * already on this PC is left as it is (with a notice); a different part with
 * the same id asks "Replace" or "Keep both".
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { BufferAttribute, BufferGeometry, Color, Group, Mesh, MeshStandardMaterial, PlaneGeometry, MeshBasicMaterial, DoubleSide } from 'three';
import type { Part, PartCategory } from '@core';
import { importModel } from '../ingest';
import type { ImportedModel } from '../ingest/types';
import { flattenModel, orientMeshes, partFromModel, UP_AXES, type UpAxis } from '../parts/fromModel';
import type { PartMesh } from '../parts/glb';
import { useApp } from '../state/store';
import { addUserPart } from '../userParts/actions';
import { planPartImport, readKicadPart, readPartFile, userFileKind } from '../userParts/partFile';
import { newCustomId } from '../userParts/ids';
import { renderPreview } from '../viewport/thumbnails';
import { fmtMm } from '../units';
import { CATEGORY_LABEL, portSummary } from './partText';
import { dialogKeys, useModalFocus } from './Dialog';

type Stage =
  | { kind: 'idle' }
  | { kind: 'loading'; file: string; fraction: number; label: string }
  | { kind: 'orient'; file: string; model: ImportedModel; meshes: PartMesh[] }
  | { kind: 'kicad'; file: string; part: Part; warnings: string[] }
  | { kind: 'saving'; file: string }
  | { kind: 'conflict'; file: string; part: Part; existing: Part; glb?: ArrayBuffer }
  | { kind: 'error'; file: string; message: string };

const UP_LABEL: Record<UpAxis, string> = { '+z': 'Top (+Z up)', '-z': 'Bottom (-Z up)', '+y': 'Back (+Y up)', '-y': 'Front (-Y up)', '+x': 'Right (+X up)', '-x': 'Left (-X up)' };

/** The part's meshes turned for a mounting side, on a plane, for the preview. */
function previewGroup(meshes: readonly PartMesh[], up: UpAxis, spin: number): Group {
  const g = new Group();
  const { meshes: turned } = orientMeshes(meshes, up, spin);
  let sx = 1;
  let sy = 1;
  for (const m of turned) {
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(m.positions, 3));
    geo.setIndex(new BufferAttribute(m.indices, 1));
    geo.computeVertexNormals();
    geo.computeBoundingBox();
    const bb = geo.boundingBox!;
    sx = Math.max(sx, Math.abs(bb.min.x), Math.abs(bb.max.x));
    sy = Math.max(sy, Math.abs(bb.min.y), Math.abs(bb.max.y));
    g.add(new Mesh(geo, new MeshStandardMaterial({ color: m.color ? new Color(...m.color) : new Color(0x8a8f96), roughness: 0.6 })));
  }
  const plane = new Mesh(new PlaneGeometry(sx * 3, sy * 3), new MeshBasicMaterial({ color: 0x9aa3ad, transparent: true, opacity: 0.45, side: DoubleSide }));
  plane.position.z = -0.01;
  g.add(plane);
  return g;
}

export function AddPartDialog() {
  const files = useApp((s) => s.pendingPartFiles);
  const connectors = useApp((s) => s.connectorLibrary);
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  const [name, setName] = useState('');
  const [category, setCategory] = useState<PartCategory>('other');
  const [up, setUp] = useState<UpAxis>('+z');
  const [spin, setSpin] = useState(0);
  const run = useRef(0);
  const modalRef = useModalFocus<HTMLDivElement>(stage.kind !== 'idle');

  const close = () => {
    run.current++;
    setStage({ kind: 'idle' });
    useApp.setState({ pendingPartFiles: null });
  };

  /** Add a part by `planPartImport`. False when the user must choose first (the conflict stage is shown). */
  const keep = async (file: string, part: Part, glb: ArrayBuffer | undefined, detail: string): Promise<boolean> => {
    const s = useApp.getState();
    const plan = planPartImport(part, new Set(s.baseLibrary?.parts.map((p) => p.id)), s.customParts);
    if (plan.kind === 'same') {
      s.notify('info', `"${plan.part.name}" is already in My parts`, ['This PC already has exactly this part; nothing was changed.']);
      useApp.setState({ partDetails: plan.part.id });
      return true;
    }
    if (plan.kind === 'conflict') {
      setStage({ kind: 'conflict', file, part: plan.part, existing: plan.existing, ...(glb ? { glb } : {}) });
      return false;
    }
    await addUserPart(plan.part, glb);
    useApp.setState({ partDetails: plan.part.id });
    s.notify('info', `Added "${plan.part.name}" to My parts`, [
      detail,
      ...(plan.renamedFrom ? [`Its id "${plan.renamedFrom}" is not a user part id${s.baseLibrary?.parts.some((p) => p.id === plan.renamedFrom) ? ' (a part in the library has it)' : ''}, so it was given a new one: ${plan.part.id}.`] : []),
    ]);
    return true;
  };

  const settle = async (choice: 'replace' | 'both') => {
    if (stage.kind !== 'conflict') return;
    const { part, glb, existing } = stage;
    const next = choice === 'replace' ? part : { ...part, id: newCustomId(part.name), name: part.name === existing.name ? `${part.name} (2)` : part.name };
    try {
      await addUserPart(next, glb);
      useApp.setState({ partDetails: next.id });
      useApp.getState().notify('info', choice === 'replace' ? `Replaced "${existing.name}" in My parts` : `Added "${next.name}" to My parts`, []);
      close();
    } catch (e) {
      setStage({ kind: 'error', file: stage.file, message: e instanceof Error ? e.message : String(e) });
    }
  };

  useEffect(() => {
    const file = files?.[0];
    if (!file) return;
    const me = ++run.current;
    const alive = () => run.current === me;
    const base = file.name.replace(/\.[^.]+$/, '');
    setName(base);
    setCategory('other');
    setUp('+z');
    setSpin(0);
    void (async () => {
      try {
        const kind = userFileKind(file.name);
        if (kind === 'unknown') throw new Error('Choose a STEP, STP, GLB, STL or OBJ model, a .kicad_pcb board, or a part file exported from this app.');
        setStage({ kind: 'loading', file: file.name, fraction: 0, label: 'Reading the file' });
        const data = await file.arrayBuffer();
        if (!alive()) return;
        if (kind === 'kicad') {
          const { part, warnings } = readKicadPart(new TextDecoder().decode(data), undefined, connectors);
          setName(part.name);
          setCategory(part.category);
          setStage({ kind: 'kicad', file: file.name, part, warnings });
          return;
        }
        if (kind === 'glb') {
          const pf = await readPartFile(data, connectors);
          if (pf) {
            if (!alive()) return;
            if (await keep(file.name, pf.part, pf.modelGlb, 'From a part file. It is in the Parts tab under My parts.')) close();
            return;
          }
        }
        const model = await importModel([{ path: file.name, data }], {
          onProgress: (fraction, label) => alive() && setStage({ kind: 'loading', file: file.name, fraction, label }),
        });
        if (!alive()) return;
        setStage({ kind: 'orient', file: file.name, model, meshes: flattenModel(model) });
      } catch (e) {
        if (alive()) setStage({ kind: 'error', file: file.name, message: e instanceof Error ? e.message : String(e) });
      }
    })();
  }, [files, connectors]);

  const preview = useMemo(() => {
    if (stage.kind !== 'orient') return null;
    try {
      return renderPreview(previewGroup(stage.meshes, up, spin), 220);
    } catch {
      return null;
    }
  }, [stage, up, spin]);

  if (stage.kind === 'idle') return null;
  const save = async () => {
    const me = run.current;
    try {
      if (stage.kind === 'orient') {
        const st = stage;
        setStage({ kind: 'saving', file: st.file });
        const { part, glb } = await partFromModel(st.model, { name: name.trim() || 'My part', category, up, spin_deg: spin });
        if (run.current !== me) return;
        if (!(await keep(st.file, part, glb, 'It has no ports yet: select it and use Add port so wires can be attached.'))) return;
      } else if (stage.kind === 'kicad') {
        const part = { ...stage.part, name: name.trim() || stage.part.name, category };
        setStage({ kind: 'saving', file: stage.file });
        if (!(await keep(stage.file, part, undefined, `${part.ports.length} port(s) found on the board.`))) return;
      }
      close();
    } catch (e) {
      if (run.current === me) setStage({ kind: 'error', file: stage.file, message: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div className="modal-backdrop">
      <div
        ref={modalRef}
        tabIndex={-1}
        className="modal add-part"
        role="dialog"
        aria-modal="true"
        aria-labelledby="addpart-title"
        onKeyDown={dialogKeys(close)}
      >
        <h2 id="addpart-title">Add your own part{'file' in stage ? `: ${stage.file}` : ''}</h2>
        {stage.kind === 'loading' && (
          <>
            <p>
              {stage.label}... {Math.round(stage.fraction * 100)}%
            </p>
            <progress max={1} value={stage.fraction} style={{ width: '100%' }} />
          </>
        )}
        {stage.kind === 'saving' && <p>Making the part (simplifying the model if it is large)...</p>}
        {stage.kind === 'error' && <p className="warn-text">{stage.message}</p>}
        {stage.kind === 'conflict' && (
          <p>
            My parts already has a different part with this id: "{stage.existing.name}" ({stage.existing.ports.length} ports). Replace it with the one in this file
            ({stage.part.ports.length} ports), or keep both?
          </p>
        )}
        {(stage.kind === 'orient' || stage.kind === 'kicad') && (
          <div className="je-grid">
            <label className="muted" htmlFor="ap-name">
              Name
            </label>
            <input id="ap-name" className="text" value={name} onChange={(e) => setName(e.target.value)} />
            <label className="muted" htmlFor="ap-cat">
              Kind
            </label>
            <select id="ap-cat" value={category} onChange={(e) => setCategory(e.target.value as PartCategory)}>
              {(Object.keys(CATEGORY_LABEL) as PartCategory[]).map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_LABEL[c]}
                </option>
              ))}
            </select>
          </div>
        )}
        {stage.kind === 'orient' && (
          <>
            <p className="small">Which side of the model sits on the surface it is mounted on? The preview shows it on a plane.</p>
            <div className="add-part-orient">
              <div className="seg seg-wrap" role="group" aria-label="Mounting side">
                {UP_AXES.map((a) => (
                  <button key={a} type="button" aria-pressed={up === a} onClick={() => setUp(a)}>
                    {UP_LABEL[a]}
                  </button>
                ))}
                <button type="button" onClick={() => setSpin((s) => (s + 90) % 360)} title="Turn a quarter about the vertical">
                  Turn 90° ({spin}°)
                </button>
              </div>
              <div className="add-part-preview">{preview ? <img src={preview} alt="The part on its mounting face" width={220} height={220} /> : <span className="muted">no preview</span>}</div>
            </div>
          </>
        )}
        {stage.kind === 'kicad' && (
          <>
            <p className="small">
              Board {stage.part.body.size_mm.map(fmtMm).join(' x ')} mm; ports: {portSummary(stage.part, connectors)}.
            </p>
            {stage.warnings.length > 0 && (
              <ul className="notice-details small">
                {stage.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}
          </>
        )}
        <div className="modal-actions">
          <button type="button" onClick={close}>
            {stage.kind === 'error' ? 'Close' : 'Cancel'}
          </button>
          {(stage.kind === 'orient' || stage.kind === 'kicad') && (
            <button type="button" className="primary" onClick={() => void save()}>
              Add part
            </button>
          )}
          {stage.kind === 'conflict' && (
            <>
              <button type="button" onClick={() => void settle('replace')}>
                Replace
              </button>
              <button type="button" className="primary" onClick={() => void settle('both')}>
                Keep both
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
