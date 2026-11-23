import { useEffect, useState, type ReactNode } from 'react';
import { Box3, Vector3 } from 'three';
import { decodeTriangles, findPart, meshPoseMatrix } from '@core';
import { PartDetails } from './PartDetails';
import { JointProps, LinkName, MeshActions, MultiMeshProps } from './StructureProps';
import { registry } from '../scene/registry';
import { areaOf } from '../scene/topology';
import { CableProps } from './CableProps';
import { ComponentProps } from './ComponentProps';
import { useApp } from '../state/store';
import { fmt, fmtMm } from '../units';

import { ZoneKindSelect, ZoneName, ZoneSwatch, deleteZone } from './ZoneList';

function Prop({ k, children }: { k: string; children: ReactNode }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{children}</dd>
    </>
  );
}

function sizeOf(box: Box3 | null): string {
  if (!box || box.isEmpty()) return '-';
  const s = box.getSize(new Vector3());
  return `${fmtMm(s.x)} x ${fmtMm(s.y)} x ${fmtMm(s.z)} mm`;
}

function DesignName() {
  const name = useApp((s) => s.design.meta.name);
  const [text, setText] = useState(name);
  useEffect(() => setText(name), [name]);
  const commit = () => {
    const v = text.trim();
    if (!v || v === name) return setText(name);
    useApp.getState().commit((d) => ({ ...d, meta: { ...d.meta, name: v } }));
  };
  return (
    <input
      className="text"
      value={text}
      aria-label="Design name"
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}

export function Properties() {
  const selection = useApp((s) => s.selection);
  const design = useApp((s) => s.design);
  const library = useApp((s) => s.library);
  useApp((s) => s.geometryVersion);
  const multi = useApp((s) => s.selectedMeshes.length);
  const detailsId = useApp((s) => s.placingPart ?? s.partDetails);
  const detailsPart = detailsId && library ? findPart(library, detailsId) : undefined;
  const { scene } = design;

  if (!selection && detailsPart) return <PartDetails part={detailsPart} />;
  if (!selection) {
    const tris = useApp.getState().triangleCount;
    return (
      <dl className="props">
        <Prop k="Design">
          <DesignName />
        </Prop>
        <Prop k="Sources">{scene.sources.map((s) => s.uri).join(', ') || '-'}</Prop>
        <Prop k="Links">{scene.links.length}</Prop>
        <Prop k="Joints">{scene.joints.length}</Prop>
        <Prop k="Triangles">{tris.toLocaleString()}</Prop>
        <Prop k="Parts library">{library ? `${library.parts.length} parts` : 'not loaded'}</Prop>
      </dl>
    );
  }

  if (selection.kind === 'mesh' && multi > 1) return <MultiMeshProps />;

  if (selection.kind === 'mesh') {
    const link = scene.links.find((l) => l.meshes.some((m) => m.id === selection.id));
    const ref = link?.meshes.find((m) => m.id === selection.id);
    const entry = registry.get(selection.id);
    const source = scene.sources.find((s) => s.id === ref?.source);
    const [r, g, b] = entry?.color ?? [0.5, 0.5, 0.5];
    const css = `rgb(${[r, g, b].map((c) => Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055))).join(',')})`;
    return (
      <>
      <dl className="props">
        <Prop k="Mesh">{selection.id}</Prop>
        <Prop k="Link">
          <button type="button" className="linkish" onClick={() => link && useApp.getState().select({ kind: 'link', id: link.id })}>
            {link?.name || link?.id}
          </button>
        </Prop>
        <Prop k="Node">{ref?.node || '-'}</Prop>
        <Prop k="Source">{source?.uri ?? ref?.source}</Prop>
        <Prop k="Triangles">
          {(entry?.triCount ?? 0).toLocaleString()}
          {entry && ref && entry.triCount !== ref.tri_count && <span className="warn-text"> (design expects {ref.tri_count.toLocaleString()})</span>}
        </Prop>
        <Prop k="Size">{sizeOf(entry?.geometry.boundingBox ?? null)}</Prop>
        <Prop k="Colour">
          <span className="swatch" style={{ background: css }} /> {css}
        </Prop>
        <Prop k="Pick index">{entry?.bvhReady ? 'ready' : 'building'}</Prop>
      </dl>
      <MeshActions />
      </>
    );
  }

  if (selection.kind === 'link') {
    const link = scene.links.find((l) => l.id === selection.id);
    if (!link) return null;
    const parent = scene.joints.find((j) => j.child === link.id);
    const box = new Box3();
    for (const m of link.meshes) {
      const bb = registry.get(m.id)?.geometry.boundingBox;
      // Imported geometry sits in the link at the mesh's pose.
      if (bb) box.union(bb.clone().applyMatrix4(meshPoseMatrix(m)));
    }
    return (
      <dl className="props">
        <Prop k="Link">
          <LinkName linkId={link.id} />
        </Prop>
        <Prop k="Id">{link.id}</Prop>
        <Prop k="Meshes">{link.meshes.length}</Prop>
        <Prop k="Triangles">{link.meshes.reduce((n, m) => n + (registry.get(m.id)?.triCount ?? 0), 0).toLocaleString()}</Prop>
        <Prop k="Size (link frame)">{sizeOf(box)}</Prop>
        <Prop k="Parent joint">
          {parent ? (
            <button type="button" className="linkish" onClick={() => useApp.getState().select({ kind: 'joint', id: parent.id })}>
              {parent.name || parent.id}
            </button>
          ) : (
            'none (root)'
          )}
        </Prop>
        <Prop k="">
          <button
            type="button"
            onClick={() => {
              const ids = link.meshes.map((m) => m.id);
              useApp.getState().selectMeshes(ids, ids[0] ?? null);
            }}
          >
            Select its meshes
          </button>
        </Prop>
      </dl>
    );
  }

  if (selection.kind === 'zone') {
    const zone = design.zones.find((z) => z.id === selection.id);
    if (!zone) return null;
    const entry = registry.get(zone.mesh);
    const tris = decodeTriangles(zone.triangles);
    const area = entry ? areaOf(entry.geometry, tris) / 100 : 0;
    const link = scene.links.find((l) => l.id === zone.link);
    return (
      <dl className="props">
        <Prop k="Area">
          <ZoneName zone={zone} />
        </Prop>
        <Prop k="Kind">
          <span className="inline-row">
            <ZoneSwatch kind={zone.kind} /> <ZoneKindSelect zone={zone} />
          </span>
        </Prop>
        <Prop k="Id">{zone.id}</Prop>
        <Prop k="Mesh">
          <button type="button" className="linkish" onClick={() => useApp.getState().select({ kind: 'mesh', id: zone.mesh })}>
            {zone.mesh}
          </button>
        </Prop>
        <Prop k="Link">{link?.name || zone.link}</Prop>
        <Prop k="Triangles">{tris.length.toLocaleString()}</Prop>
        <Prop k="Area">{fmt(area, area >= 100 ? 0 : 2)} cm²</Prop>
        <Prop k="Shown as">{zone.kind === 'keep_out' ? 'red stripes' : 'solid green'}</Prop>
        <Prop k="">
          <button type="button" onClick={() => deleteZone(zone.id)}>
            Delete zone
          </button>
        </Prop>
      </dl>
    );
  }

  if (selection.kind === 'component') return <ComponentProps id={selection.id} />;
  if (selection.kind === 'cable') return <CableProps id={selection.id} />;

  return <JointProps id={selection.id} />;
}
