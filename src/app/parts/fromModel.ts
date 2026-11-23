/**
 * A user part from an imported model (STEP, GLB, STL, OBJ).
 *
 * The model is flattened at its zero pose (a part is rigid), turned so the
 * chosen axis points along +Z, and moved into the part frame: origin at the
 * centre of the mounting face, envelope x in [-sx/2, sx/2], y in [-sy/2, sy/2],
 * z in [0, sz]. The mounting face is taken to be the lowest face of the
 * bounding box after turning.
 */
import { Matrix4 } from 'three';
import { meshPoseMatrix, zeroLinkPoses, type MeshRef, type Part, type PartCategory } from '@core';
import type { ImportedModel } from '../ingest/types';
import { encodePartGlb, mergeByColour, meshBounds, sha256Hex, triangleCount, type PartMesh } from './glb';
import { simplifyMeshes } from './simplify';

export type UpAxis = '+x' | '-x' | '+y' | '-y' | '+z' | '-z';
export const UP_AXES: readonly UpAxis[] = ['+x', '-x', '+y', '-y', '+z', '-z'];

/** Default triangle budget for a user's own part. */
export const DEFAULT_MAX_TRIANGLES = 60000;

/**
 * Every mesh of the model in one frame, mm, with all joints at zero: the pose
 * the model was imported in. Names are the source node names.
 */
export function flattenModel(model: ImportedModel): PartMesh[] {
  const linkPoses = zeroLinkPoses({ sources: model.sources, links: model.links, joints: model.joints });
  const refs = new Map<string, MeshRef>();
  for (const link of model.links) for (const ref of link.meshes) refs.set(ref.id, ref);
  const out: PartMesh[] = [];
  for (const mesh of model.meshes) {
    const ref = refs.get(mesh.id);
    const m = new Matrix4();
    const link = linkPoses.get(mesh.link);
    if (link) m.copy(link);
    if (ref) m.multiply(meshPoseMatrix(ref));
    const e = m.elements;
    const pos = mesh.geometry.getAttribute('position');
    if (!pos) continue;
    const positions = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      positions[3 * i] = e[0]! * x + e[4]! * y + e[8]! * z + e[12]!;
      positions[3 * i + 1] = e[1]! * x + e[5]! * y + e[9]! * z + e[13]!;
      positions[3 * i + 2] = e[2]! * x + e[6]! * y + e[10]! * z + e[14]!;
    }
    const index = mesh.geometry.getIndex();
    const count = index ? index.count : pos.count;
    const indices = new Uint32Array(count - (count % 3));
    for (let i = 0; i < indices.length; i++) indices[i] = index ? index.getX(i) : i;
    // A mirroring link or mesh pose would turn triangles inside out.
    if (m.determinant() < 0) {
      for (let t = 0; t + 2 < indices.length; t += 3) {
        const a = indices[t + 1]!;
        indices[t + 1] = indices[t + 2]!;
        indices[t + 2] = a;
      }
    }
    out.push({ name: ref?.node || mesh.id, positions, indices, color: [...mesh.color] });
  }
  return out;
}

/**
 * Rotation that takes the model axis `up` to +Z, followed by `spin_deg` about
 * the new +Z (counter-clockwise seen from above). A proper rotation, never a
 * mirror.
 */
export function upRotation(up: UpAxis, spin_deg = 0): Matrix4 {
  const m = new Matrix4();
  // Rows give the new x, y, z in terms of the old ones.
  switch (up) {
    case '+z':
      break;
    case '-z':
      m.set(1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1); // half turn about X
      break;
    case '+y':
      m.set(1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1); // (x, y, z) -> (x, -z, y)
      break;
    case '-y':
      m.set(1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1); // (x, y, z) -> (x, z, -y)
      break;
    case '+x':
      m.set(0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1); // (x, y, z) -> (-z, y, x)
      break;
    case '-x':
      m.set(0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 0, 1); // (x, y, z) -> (z, y, -x)
      break;
  }
  if (spin_deg !== 0) m.premultiply(new Matrix4().makeRotationZ((spin_deg * Math.PI) / 180));
  return m;
}

function transformMeshes(meshes: readonly PartMesh[], m: Matrix4): PartMesh[] {
  const e = m.elements;
  return meshes.map((mesh) => {
    const p = mesh.positions;
    const positions = new Float32Array(p.length);
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i]!, y = p[i + 1]!, z = p[i + 2]!;
      positions[i] = e[0]! * x + e[4]! * y + e[8]! * z + e[12]!;
      positions[i + 1] = e[1]! * x + e[5]! * y + e[9]! * z + e[13]!;
      positions[i + 2] = e[2]! * x + e[6]! * y + e[10]! * z + e[14]!;
    }
    return { ...mesh, positions };
  });
}

/**
 * Turn `meshes` so `up` becomes +Z (then spin about Z), and move them so the
 * bounding box is centred in x and y with its lowest face at z = 0. Returns
 * the meshes and the transform applied (model mm -> part mm).
 */
export function orientMeshes(meshes: readonly PartMesh[], up: UpAxis, spin_deg = 0): { meshes: PartMesh[]; transform: Matrix4 } {
  const rotation = upRotation(up, spin_deg);
  const turned = transformMeshes(meshes, rotation);
  const { min_mm, max_mm } = meshBounds(turned);
  if (!(min_mm[0] <= max_mm[0])) throw new Error('The model has no triangles.');
  const shift = new Matrix4().makeTranslation(-(min_mm[0] + max_mm[0]) / 2, -(min_mm[1] + max_mm[1]) / 2, -min_mm[2]);
  return { meshes: transformMeshes(turned, shift), transform: shift.multiply(rotation) };
}

/** Lowercase letters, digits and single hyphens, at most 40 characters. */
export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug || 'part';
}

/** Smallest envelope side, mm: a flat model (one sheet) still needs a positive size. */
const MIN_SIZE_MM = 0.1;

export interface PartFromModelOptions {
  name: string;
  category: PartCategory;
  /** Which axis of the model points away from the mounting surface. */
  up: UpAxis;
  /** Turn about the new +Z after `up`, degrees, counter-clockwise seen from above. Default 0. */
  spin_deg?: number;
  /** Triangle budget; the model is simplified when it has more. Default 60000. */
  maxTriangles?: number;
}

/**
 * Make a user part from an imported model. The returned `glb` is the model
 * alone (no part embedded: its sha256 is the model's id, so it cannot contain
 * itself); `encodePartGlb(meshes, part)` makes a stand-alone part file.
 */
export async function partFromModel(model: ImportedModel, opts: PartFromModelOptions): Promise<{ part: Part; glb: ArrayBuffer; meshes: PartMesh[] }> {
  const flat = flattenModel(model);
  const { meshes: oriented } = orientMeshes(flat, opts.up, opts.spin_deg ?? 0);
  const meshes = await simplifyMeshes(oriented, opts.maxTriangles ?? DEFAULT_MAX_TRIANGLES);
  const { min_mm, max_mm } = meshBounds(meshes);
  const size_mm: [number, number, number] = [0, 1, 2].map((k) => Math.max(MIN_SIZE_MM, round3(max_mm[k]! - min_mm[k]!))) as [number, number, number];
  const glb = encodePartGlb(mergeByColour(meshes));
  const sha256 = await sha256Hex(glb);
  const part: Part = {
    id: `custom-${slugify(opts.name)}-${sha256.slice(0, 8)}`,
    name: opts.name,
    category: opts.category,
    tags: [],
    body: { size_mm },
    model: { uri: `custom:${sha256}`, sha256, triangles: triangleCount(meshes) },
    mounting_holes: [],
    ports: [],
    confidence: 'measured',
    custom: true,
  };
  return { part, glb, meshes };
}

/** Round to 0.001 mm, which is all a part envelope needs. */
function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
