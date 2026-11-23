/**
 * The Parts tab: search, a category filter, parts grouped by category with
 * counts, each row with a thumbnail, its size and its ports in words. Generic
 * stand-ins come last in each group, labelled as such. Clicking a row arms
 * placement and shows the part's details on the right.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ConnectorLibrary, Part, PartCategory } from '@core';
import { useApp } from '../state/store';
import { IconPlus, IconSearch } from './icons';
import { fmtMm } from '../units';
import { requestThumbnail } from '../viewport/thumbnails';
import { CATEGORY_LABEL, groupByCategory, portSummary, searchParts } from './partText';

/** A thumbnail, rendered only once its row scrolls into view. */
export function PartThumb({ part, connectors, size = 56 }: { part: Part; connectors: ConnectorLibrary | null; size?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setVisible(true), { rootMargin: '120px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    return requestThumbnail(part, connectors, setUrl);
  }, [visible, part, connectors]);
  return (
    <div ref={ref} className="part-thumb" style={{ width: size, height: size }} aria-hidden="true">
      {url && <img src={url} alt="" width={size} height={size} />}
    </div>
  );
}

/** Real parts first, generic stand-ins last; by name within each. */
function ordered(parts: Part[]): Part[] {
  return [...parts].sort((a, b) => Number(a.confidence === 'generic') - Number(b.confidence === 'generic') || a.name.localeCompare(b.name));
}

export function PartsList() {
  const library = useApp((s) => s.library);
  const connectors = useApp((s) => s.connectorLibrary);
  const placing = useApp((s) => s.placingPart);
  const hasModel = useApp((s) => s.design.scene.links.length > 0);
  const error = useApp((s) => s.libraryError);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<PartCategory | ''>('');
  const found = useMemo(() => (library ? searchParts(library.parts, query, connectors, category) : []), [library, query, connectors, category]);
  const mine = useMemo(() => ordered(found.filter((p) => p.custom)), [found]);
  const groups = useMemo(() => groupByCategory(found.filter((p) => !p.custom)).map((g) => ({ ...g, parts: ordered(g.parts) })), [found]);
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  if (!library) return <p className="empty-note">{error ? `Parts library not loaded: ${error}` : 'Loading parts...'}</p>;
  const categories = groupByCategory(library.parts);
  const row = (p: Part) => {
    const armed = placing === p.id;
    const [sx, sy, sz] = p.body.size_mm;
    return (
      <div key={p.id} role="listitem" className={`part-row${armed ? ' selected' : ''}`}>
        <button
          type="button"
          className="lib-row part-lib-row"
          aria-pressed={armed}
          onClick={() => {
            useApp.setState({ partDetails: p.id });
            if (hasModel) useApp.getState().startPlacing(armed ? null : p.id);
          }}
          title={`${p.name}
${[p.manufacturer, p.mpn].filter(Boolean).join(' ')}
${fmtMm(sx)} x ${fmtMm(sy)} x ${fmtMm(sz)} mm
${p.ports.length ? portSummary(p, connectors) : 'no ports'}`}
        >
          <PartThumb part={p} connectors={connectors} size={36} />
          <span className="lib-text">
            <span className="lib-name ellipsis">
              {p.name}
              {p.confidence === 'generic' && <span className="standin"> stand-in</span>}
            </span>
            <span className="lib-meta">
              <span className="ellipsis num">
                {fmtMm(sx)} x {fmtMm(sy)} x {fmtMm(sz)} mm · {p.ports.length ? portSummary(p, connectors) : p.custom ? 'no ports yet' : 'no ports'}
              </span>
            </span>
          </span>
        </button>
      </div>
    );
  };
  return (
    <div
      className={`parts${dragOver ? ' drop-target' : ''}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        e.stopPropagation();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        e.stopPropagation();
        setDragOver(false);
        useApp.setState({ pendingPartFiles: [...e.dataTransfer.files] });
      }}
    >
      <div className="lib-head">
        <div className="search-field">
          <IconSearch />
          <input className="text" type="search" placeholder={`Search ${library.parts.length} parts`} value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search parts" />
        </div>
        <select value={category} onChange={(e) => setCategory(e.target.value as PartCategory | '')} aria-label="Category">
          <option value="">All categories</option>
          {categories.map((g) => (
            <option key={g.category} value={g.category}>
              {CATEGORY_LABEL[g.category]} ({g.parts.length})
            </option>
          ))}
        </select>
        <button
          type="button"
          className="icon-btn"
          aria-label="Add your own part"
          onClick={() => fileInput.current?.click()}
          title="Add your own part: a 3D model (STEP, STL, OBJ, GLB), a KiCad board (.kicad_pcb), or a part file exported from this app. You can also drop the file here."
        >
          <IconPlus />
        </button>
        <input
          ref={fileInput}
          type="file"
          hidden
          accept=".step,.stp,.glb,.gltf,.stl,.obj,.kicad_pcb"
          onChange={(e) => {
            if (e.target.files?.length) useApp.setState({ pendingPartFiles: [...e.target.files] });
            e.target.value = '';
          }}
        />
      </div>
      <p className="hint-line muted small" title={hasModel ? 'R turns it 15 degrees, Shift+R 90, Esc cancels.' : ''}>
        {hasModel ? 'Choose a part, then click the model to place it.' : 'Open a model first, then choose a part and click where it goes.'}
      </p>
      {mine.length > 0 && (
        <section className="part-group" aria-label="My parts">
          <h3 className="type-group">
            My parts <span className="count">{mine.length}</span>
          </h3>
          <div role="list">{mine.map(row)}</div>
        </section>
      )}
      {groups.length === 0 && mine.length === 0 && <p className="empty-note">No part matches. Try fewer words, or a connector name such as &quot;Qwiic&quot; or &quot;USB-C&quot;.</p>}
      {groups.map((g) => (
        <section key={g.category} className="part-group" aria-label={CATEGORY_LABEL[g.category]}>
          <h3 className="type-group">
            {CATEGORY_LABEL[g.category]} <span className="count">{g.parts.length}</span>
          </h3>
          <div role="list">
            {g.parts.map(row)}
          </div>
        </section>
      ))}
    </div>
  );
}
