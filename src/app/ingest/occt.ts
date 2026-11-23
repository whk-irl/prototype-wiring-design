/**
 * STEP / IGES through occt-import-js, split in three so that the browser and
 * Node share the interesting part:
 *
 *   tessellate()           runs in a Web Worker (browser) or directly (Node);
 *                          returns typed arrays that can be transferred
 *   tessellationToModel()  pure: tessellation -> ImportedModel
 */
import type { OcctModule, OcctRawNode } from 'occt-import-js';
import { Matrix4 } from 'three';
import { DEFAULT_COLOR, singleLinkModel, type ParsedPart } from './model';
import type { ImportedModel } from './types';

export type OcctKind = 'step' | 'iges';

export interface OcctMesh {
  name: string;
  /** Path of the assembly node that owns the mesh. */
  node: string;
  /** Linear RGB, or null when the file has no colour for it. */
  color: [number, number, number] | null;
  positions: Float32Array;
  normals: Float32Array | null;
  index: Uint32Array;
}

/** What crosses the worker boundary. Plain data and typed arrays only. */
export interface OcctTessellation {
  meshes: OcctMesh[];
}

const PARAMS = {
  linearUnit: 'millimeter',
  linearDeflectionType: 'bounding_box_ratio',
  linearDeflection: 0.001,
  angularDeflection: 0.5,
} as const;

/** Throws an Error with a user-readable message if the file cannot be read. */
export function tessellate(occt: OcctModule, kind: OcctKind, data: Uint8Array): OcctTessellation {
  const label = kind === 'step' ? 'STEP' : 'IGES';
  let result;
  try {
    result = kind === 'step' ? occt.ReadStepFile(data, PARAMS) : occt.ReadIgesFile(data, PARAMS);
  } catch (e) {
    throw new Error(`The ${label} file could not be read (${e instanceof Error ? e.message : String(e)}). It may be damaged or truncated.`);
  }
  if (!result || !result.success) {
    throw new Error(`The ${label} file could not be read. It may be damaged, truncated or not a ${label} file.`);
  }
  const paths = new Map<number, string>();
  const walk = (node: OcctRawNode, trail: string[]) => {
    const here = node.name ? [...trail, node.name] : trail;
    for (const m of node.meshes) if (!paths.has(m)) paths.set(m, here.join('/'));
    for (const c of node.children) walk(c, here);
  };
  walk(result.root, []);
  const meshes: OcctMesh[] = result.meshes.map((m, i) => {
    const normal = m.attributes.normal?.array;
    return {
      name: m.name || paths.get(i)?.split('/').pop() || '',
      node: paths.get(i) ?? m.name ?? '',
      color: m.color ? [m.color[0], m.color[1], m.color[2]] : null,
      positions: Float32Array.from(m.attributes.position.array),
      normals: normal ? Float32Array.from(normal) : null,
      index: Uint32Array.from(m.index.array),
    };
  });
  return { meshes };
}

/** The buffers of a tessellation, for `postMessage` transfer lists. */
export function transferListOf(t: OcctTessellation): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  for (const m of t.meshes) {
    out.push(m.positions.buffer as ArrayBuffer, m.index.buffer as ArrayBuffer);
    if (m.normals) out.push(m.normals.buffer as ArrayBuffer);
  }
  return out;
}

export interface OcctModelMeta {
  prefix: string;
  path: string;
  kind: OcctKind;
  sha256: string;
  warnings: string[];
}

/** Pure: no I/O, no globals. The geometry is already in millimetres (occt was asked for them). */
export function tessellationToModel(t: OcctTessellation, meta: OcctModelMeta): ImportedModel {
  const identity = new Matrix4();
  const parts: ParsedPart[] = t.meshes.map((m) => ({
    name: m.name,
    node: m.node,
    color: m.color ?? [...DEFAULT_COLOR],
    raw: { positions: m.positions, index: m.index, normals: m.normals },
    keepNormals: true,
    matrix: identity,
  }));
  return singleLinkModel({
    prefix: meta.prefix,
    path: meta.path,
    kind: meta.kind,
    mmPerUnit: 1, // occt was asked for millimetres, so the output is already mm
    sha256: meta.sha256,
    parts,
    warnings: meta.warnings,
  });
}
