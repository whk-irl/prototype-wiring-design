/** Shared pieces: file kinds, units, and building `ImportedModel`s from parsed parts. */
import { Matrix4, type BufferGeometry } from 'three';
import type { SourceKind } from '@core';
import { buildGeometry, type RawMesh } from './geometry';
import { extensionOf, makeId, uniqueId } from './ids';
import type { ImportedMesh, ImportedModel, ImportFile, LengthUnit } from './types';

export const DEFAULT_COLOR: [number, number, number] = [0.5, 0.5, 0.5];

export const MM_PER_UNIT: Record<LengthUnit, number> = { mm: 1, cm: 10, m: 1000, inch: 25.4 };

const EXTENSION_KIND: Record<string, SourceKind> = {
  step: 'step',
  stp: 'step',
  iges: 'iges',
  igs: 'iges',
  glb: 'glb',
  gltf: 'gltf',
  stl: 'stl',
  obj: 'obj',
  urdf: 'urdf',
};

export function kindOfPath(path: string): SourceKind | null {
  return EXTENSION_KIND[extensionOf(path)] ?? null;
}

/** A mesh as parsed from a file, in the file's own length unit. */
export interface ParsedPart {
  /** Used in the mesh id. */
  name: string;
  /** Name or path of the node inside the source file. */
  node: string;
  color: [number, number, number];
  raw: RawMesh;
  /** Part frame to link frame, in file units (node transforms, axis conversion). */
  matrix?: Matrix4;
  keepNormals?: boolean;
}

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * Bake `part` into a link frame in millimetres. `frame` is an extra transform
 * (file units) applied after the part's own matrix, for example a URDF visual
 * origin. Returns null, with a warning, if nothing usable is left.
 */
export function bakePart(
  part: ParsedPart,
  mmPerUnit: number,
  frame: Matrix4 | null,
  label: string,
  warnings: string[],
  quiet = false,
): BufferGeometry | null {
  const m = new Matrix4().makeScale(mmPerUnit, mmPerUnit, mmPerUnit);
  if (frame) m.multiply(frame);
  if (part.matrix) m.multiply(part.matrix);
  const { geometry, dropped } = buildGeometry(part.raw, { matrix: m, keepNormals: part.keepNormals });
  if (!geometry) {
    warnings.push(`Skipped ${label}: it has no usable triangles.`);
    return null;
  }
  if (dropped > 0 && !quiet) warnings.push(`${label}: removed ${dropped} degenerate triangle${dropped === 1 ? '' : 's'}.`);
  return geometry;
}

export interface SingleLinkArgs {
  prefix: string;
  path: string;
  kind: SourceKind;
  mmPerUnit: number;
  sha256: string;
  parts: ParsedPart[];
  warnings: string[];
}

/** A file without joints: one link holding every mesh. */
export function singleLinkModel(a: SingleLinkArgs): ImportedModel {
  const usedIds = new Set<string>();
  const meshes: ImportedMesh[] = [];
  const refs: ImportedModel['links'][number]['meshes'] = [];
  const linkId = makeId(a.prefix, 'link');
  for (const part of a.parts) {
    const geometry = bakePart(part, a.mmPerUnit, null, `"${part.name || 'mesh'}"`, a.warnings);
    if (!geometry) continue;
    const id = uniqueId(usedIds, a.prefix, part.name || 'mesh');
    meshes.push({ id, link: linkId, geometry, color: part.color });
    refs.push({ id, source: a.prefix, node: part.node, tri_count: (geometry.getIndex()?.count ?? 0) / 3 });
  }
  if (meshes.length === 0) throw new Error(`"${a.path}" contains no usable geometry.`);
  return {
    sources: [{ id: a.prefix, kind: a.kind, uri: a.path, mm_per_unit: a.mmPerUnit, sha256: a.sha256 }],
    links: [{ id: linkId, name: a.prefix, meshes: refs }],
    joints: [],
    meshes,
    warnings: a.warnings,
  };
}

/** Path segments of a model-internal file reference: drops `package://name/`, `file://`, `.` and `..`. */
export function pathSegments(p: string): string[] {
  let s = p.replaceAll('\\', '/');
  const pkg = /^package:\/\/[^/]*\/(.*)$/i.exec(s);
  s = pkg ? pkg[1]! : s.replace(/^file:\/\/\/?/i, '');
  return s.split('/').filter((x) => x !== '' && x !== '.' && x !== '..');
}

/** Find the supplied file a path inside a model refers to: the longest common run of trailing path segments wins. */
export function findByPathSuffix(wanted: string, files: ImportFile[]): ImportFile | null {
  const clean = pathSegments;
  const want = clean(wanted);
  if (want.length === 0) return null;
  let best: ImportFile | null = null;
  let bestScore = 0;
  for (const f of files) {
    const have = clean(f.path);
    let n = 0;
    while (n < want.length && n < have.length && have[have.length - 1 - n] === want[want.length - 1 - n]) n++;
    if (n === 0) {
      // case-insensitive file name as a last resort
      if (have.length && have[have.length - 1]!.toLowerCase() === want[want.length - 1]!.toLowerCase()) n = 0.5;
      else continue;
    }
    const better =
      n > bestScore ||
      (n === bestScore && best !== null && (have.length < clean(best.path).length || (have.length === clean(best.path).length && f.path < best.path)));
    if (better) {
      best = f;
      bestScore = n;
    }
  }
  return best;
}
