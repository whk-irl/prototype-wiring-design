/**
 * A part's details: what it is, its size, its ports with connector names,
 * where the figures come from and, when it has a 3D model, the model's
 * licence and credit (Creative Commons models REQUIRE the credit to be
 * visible, so it is always shown with the model).
 */
import { useEffect, useState, type ReactNode } from 'react';
import type { Part } from '@core';
import { useApp } from '../state/store';
import { fmtMm } from '../units';
import { CATEGORY_LABEL, connectorText, portSummary } from './partText';
import { PartThumb } from './PartsList';
import { PortEditor } from './PortEditor';
import { deleteUserPart, exportPartFile, renameUserPart } from '../userParts/actions';

function Prop({ k, children }: { k: string; children: ReactNode }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{children}</dd>
    </>
  );
}

const CONFIDENCE: Record<Part['confidence'], string> = {
  datasheet: "from the maker's drawing or model",
  measured: 'measured on a sample or a third-party model',
  generic: 'a generic stand-in with plausible sizes, not a real product',
};

export function PartFacts({ part }: { part: Part }) {
  const connectors = useApp((s) => s.connectorLibrary);
  const m = part.model;
  return (
    <>
      <Prop k="Kind">
        {CATEGORY_LABEL[part.category]}
        {part.manufacturer || part.mpn ? ` · ${[part.manufacturer, part.mpn].filter(Boolean).join(' ')}` : ''}
      </Prop>
      {part.description && <Prop k="About">{part.description}</Prop>}
      <Prop k="Size">{part.body.size_mm.map(fmtMm).join(' x ')} mm</Prop>
      <Prop k="Ports">
        {part.ports.length === 0 ? (
          'none'
        ) : (
          <details className="expander">
            <summary>
              {part.ports.length} port{part.ports.length === 1 ? '' : 's'}: {portSummary(part, connectors)}
            </summary>
            <ul className="notice-details">
              {part.ports.map((p) => (
                <li key={p.id}>
                  <strong>{p.name ?? p.id}</strong>: {connectorText(p, connectors)} <span className="muted">({p.interfaces.join(', ')})</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </Prop>
      <Prop k="Figures">
        {CONFIDENCE[part.confidence]}
        {part.source && (
          <>
            {' '}
            <a href={part.source} target="_blank" rel="noreferrer">
              source
            </a>
          </>
        )}
      </Prop>
      {m && (
        <Prop k="3D model">
          <div className="model-credit">
            {m.attribution ? <>by {m.attribution}</> : 'credit not recorded'}
            {m.license && <>, licence {m.license}</>}
            {m.source && (
              <>
                {' '}
                <a href={m.source} target="_blank" rel="noreferrer">
                  original
                </a>
              </>
            )}
            {m.changes && <div className="muted small">Changes: {m.changes}</div>}
            {!m.uri.startsWith('custom:') && (
              <div className="small">
                <a href={`${import.meta.env.BASE_URL}parts/NOTICE.md`} target="_blank" rel="noreferrer">
                  Licences of the bundled models
                </a>
              </div>
            )}
            {m.uri.startsWith('custom:') && <div className="muted small">Your own model, kept on this PC and inside the design and its part file.</div>}
          </div>
        </Prop>
      )}
    </>
  );
}

/** The part chosen in the Parts tab, before it is placed. */
export function PartDetails({ part }: { part: Part }) {
  const connectors = useApp((s) => s.connectorLibrary);
  const placing = useApp((s) => s.placingPart === part.id);
  const haveModel = useApp((s) => s.design.scene.links.length > 0);
  const [name, setName] = useState(part.name);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const stored = useApp((s) => s.customParts.some((p) => p.id === part.id));
  useEffect(() => {
    setName(part.name);
    setRefusal(null);
    setConfirming(false);
  }, [part.id, part.name]);
  const remove = async (exportFirst: boolean) => {
    if (exportFirst && !(await exportPartFile(part))) return;
    setRefusal(await deleteUserPart(part));
    setConfirming(false);
  };
  return (
    <div className="part-details">
      <div className="inline-row">
        <PartThumb part={part} connectors={connectors} size={96} />
        <div>
          {part.custom ? (
            <input
              className="text"
              aria-label="Part name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => (name.trim() && name.trim() !== part.name ? void renameUserPart(part, name.trim()) : setName(part.name))}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
          ) : (
            <strong>{part.name}</strong>
          )}
          {part.confidence === 'generic' && <span className="standin"> stand-in</span>}
          <div className="muted small">{placing ? 'Click a surface of the model to place it; Esc cancels.' : haveModel ? 'Click it in the Parts list to place it.' : 'Open a model to place it.'}</div>
        </div>
      </div>
      <dl className="props">
        <PartFacts part={part} />
      </dl>
      <PortEditor part={part} />
      {part.custom && (
        <div className="inline-row part-actions">
          <button type="button" onClick={() => void exportPartFile(part)} title="A .part.glb file: the model with this definition inside, to open on another PC">
            Export part file
          </button>
          {stored && (
            <button type="button" onClick={() => setConfirming(true)} disabled={confirming}>
              Delete from my parts...
            </button>
          )}
        </div>
      )}
      {confirming && (
        <div className="confirm-box" role="alertdialog" aria-label="Delete this part">
          <p className="small">
            Delete "{part.name}" and its 3D model from this PC? Designs saved with it still open, but show it only as an outline unless you keep its part file
            (open it later with Add your own part to bring the model back).
          </p>
          <div className="inline-row part-actions">
            <button type="button" className="primary" onClick={() => void remove(true)}>
              Export part file, then delete
            </button>
            <button type="button" onClick={() => void remove(false)}>
              Delete
            </button>
            <button type="button" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {refusal && <p className="warn-text small">{refusal}</p>}
    </div>
  );
}
