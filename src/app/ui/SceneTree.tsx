import { useEffect, useMemo, useRef, useState } from 'react';
import { rootLinks, type Joint, type Link } from '@core';
import { registry } from '../scene/registry';
import { rangeIds, toggleId } from '../state/selection';
import { meshLabels, meshTooltip } from './labels';
import { useApp, type Selection } from '../state/store';
import { getViewport } from '../viewport/instance';

function same(a: Selection, kind: string, id: string): boolean {
  return a !== null && a.kind === kind && a.id === id;
}

function Row({
  kind,
  id,
  label,
  detail,
  warning,
  depth,
  expandable,
  expanded,
  onToggle,
  onSelect,
  tooltip,
}: {
  kind: 'link' | 'mesh' | 'joint' | 'component';
  id: string;
  label: string;
  detail?: string;
  warning?: string;
  depth: number;
  expandable?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  tooltip?: string;
  /** Overrides the plain click (used by mesh rows for Ctrl/Shift selection). */
  onSelect?: (e: React.MouseEvent) => void;
}) {
  const selected = useApp((s) => same(s.selection, kind, id) || (kind === 'mesh' && s.selectedMeshes.includes(id)));
  const hiddenMesh = useApp((s) => kind === 'mesh' && !!s.hiddenMeshes[id]);
  const hovered = useApp((s) => kind === 'mesh' && s.hover?.meshId === id);
  const ref = useRef<HTMLDivElement>(null);
  // Read out by its name and kind ("Link Base"), not its id.
  const name = `${{ link: 'Link', mesh: 'Body', joint: 'Joint', component: 'Part' }[kind]} ${label}`;
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [selected]);
  return (
    <div
      ref={ref}
      className={`tree-row${selected ? ' selected' : ''}${hovered ? ' hovered' : ''}${hiddenMesh ? ' hidden-mesh' : ''}`}
      style={{ paddingLeft: 4 + depth * 10 }}
      role="treeitem"
      aria-label={name}
      aria-selected={selected}
      aria-expanded={expandable ? expanded : undefined}
    >
      {expandable ? (
        <button type="button" className="twisty" aria-label={expanded ? `Collapse ${label}` : `Expand ${label}`} onClick={onToggle}>
          <span className={`chev${expanded ? ' open' : ''}`} aria-hidden="true" />
        </button>
      ) : (
        <span className="twisty-spacer" />
      )}
      <button
        type="button"
        className="tree-label"
        onClick={(e) => (onSelect ? onSelect(e) : useApp.getState().select({ kind, id }))}
        onDoubleClick={() => {
          useApp.getState().select({ kind, id });
          getViewport()?.fit('selection');
        }}
        title={tooltip ?? id}
        aria-label={`${name}${detail ? `, ${detail}` : ''}${warning ? `, warning: ${warning}` : ''}`}
      >
        <span className={`kind kind-${kind}`} aria-hidden="true">
          {kind === 'link' ? 'L' : kind === 'mesh' ? 'M' : kind === 'joint' ? 'J' : 'C'}
        </span>
        <span className="tree-text">{label}</span>
        {warning && (
          <span className="warn-badge" title={warning} aria-label={`Warning: ${warning}`}>
            !
          </span>
        )}
        {detail && <span className="tree-detail">{detail}</span>}
      </button>
    </div>
  );
}

export function SceneTree() {
  const scene = useApp((s) => s.design.scene);
  const components = useApp((s) => s.design.components);
  const warnings = useApp((s) => s.componentWarnings);
  useApp((s) => s.geometryVersion);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const selection = useApp((s) => s.selection);

  const { roots, linkById, jointsByParent } = useMemo(() => {
    const linkById = new Map<string, Link>(scene.links.map((l) => [l.id, l]));
    const jointsByParent = new Map<string, Joint[]>();
    for (const j of scene.joints) {
      const list = jointsByParent.get(j.parent) ?? [];
      list.push(j);
      jointsByParent.set(j.parent, list);
    }
    return { roots: rootLinks(scene), linkById, jointsByParent };
  }, [scene]);

  // Expand the path to the selection when it comes from the viewport.
  useEffect(() => {
    if (!selection) return;
    let linkId: string | undefined;
    if (selection.kind === 'mesh') linkId = scene.links.find((l) => l.meshes.some((m) => m.id === selection.id))?.id;
    else if (selection.kind === 'link') linkId = selection.id;
    else if (selection.kind === 'component') linkId = components.find((c) => c.id === selection.id)?.link;
    else if (selection.kind === 'zone') return;
    else linkId = scene.joints.find((j) => j.id === selection.id)?.parent;
    const open = new Set<string>();
    const guard = new Set<string>();
    while (linkId && !guard.has(linkId)) {
      guard.add(linkId);
      if (selection.kind === 'mesh' || selection.kind === 'component' || linkId !== selection.id) open.add(`l:${linkId}`);
      const parentJoint = scene.joints.find((j) => j.child === linkId);
      if (!parentJoint) break;
      open.add(`j:${parentJoint.id}`);
      linkId = parentJoint.parent;
    }
    setCollapsed((c) => {
      if (![...open].some((k) => c.has(k))) return c;
      const next = new Set(c);
      for (const k of open) next.delete(k);
      return next;
    });
  }, [selection, scene, components]);

  const toggle = (key: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  if (scene.links.length === 0) return <p className="empty-note">No model yet. Open one from the Open menu, or drop files on the view.</p>;

  const out: React.ReactNode[] = [];
  const labels = meshLabels(useApp.getState().design);
  /** Mesh rows in display order, for Shift+click ranges. */
  const meshOrder: string[] = [];
  const selectMesh = (id: string) => (e: React.MouseEvent) => {
    const s = useApp.getState();
    if (e.ctrlKey || e.metaKey) s.selectMeshes(toggleId(s.selectedMeshes, id), id);
    else if (e.shiftKey) s.selectMeshes(rangeIds(meshOrder, s.meshAnchor, id), s.meshAnchor ?? id);
    else s.select({ kind: 'mesh', id });
  };
  const visited = new Set<string>();
  const emitLink = (id: string, depth: number) => {
    const link = linkById.get(id);
    if (!link || visited.has(id)) return;
    visited.add(id);
    const key = `l:${id}`;
    const children = jointsByParent.get(id) ?? [];
    const expanded = !collapsed.has(key);
    const tris = link.meshes.reduce((n, m) => n + (registry.get(m.id)?.triCount ?? m.tri_count), 0);
    out.push(
      <Row
        key={key}
        kind="link"
        id={id}
        label={link.name || id}
        detail={`${link.meshes.length} mesh${link.meshes.length === 1 ? '' : 'es'}, ${tris.toLocaleString()} tri`}
        depth={depth}
        expandable={link.meshes.length + children.length + components.filter((c) => c.link === id).length > 0}
        expanded={expanded}
        onToggle={() => toggle(key)}
      />,
    );
    if (!expanded) return;
    for (const c of components.filter((x) => x.link === id)) {
      const w = warnings[c.id];
      out.push(<Row key={`c:${c.id}`} kind="component" id={c.id} label={c.name} detail={c.part} depth={depth + 1} warning={w?.join(' ')} />);
    }
    for (const m of link.meshes) {
      meshOrder.push(m.id);
      out.push(
        <Row
          key={`m:${m.id}`}
          kind="mesh"
          id={m.id}
          label={labels.get(m.id) ?? m.id}
          tooltip={meshTooltip(m.id, m.node)}
          detail={`${m.tri_count.toLocaleString()} tri`}
          depth={depth + 1}
          onSelect={selectMesh(m.id)}
        />,
      );
    }
    for (const j of children) {
      const jkey = `j:${j.id}`;
      const jexp = !collapsed.has(jkey);
      out.push(
        <Row key={jkey} kind="joint" id={j.id} label={j.name || j.id} detail={j.type} depth={depth + 1} expandable expanded={jexp} onToggle={() => toggle(jkey)} />,
      );
      if (jexp) emitLink(j.child, depth + 2);
    }
  };
  for (const r of roots) emitLink(r, 0);

  return (
    <div className="tree" role="tree" aria-label="Scene tree">
      {out}
    </div>
  );
}
