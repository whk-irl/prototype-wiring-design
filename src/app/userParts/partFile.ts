/**
 * Reading what the user brings as their own part (pure apart from hashing):
 *  - a part file exported from this app: a GLB with the part definition
 *    inside. Checked with `PartSchema` and `partProblems`; a `custom:` model
 *    uri must name the sha256 of the model in the file (the GLB of its meshes
 *    alone, as `partFromModel` stores it), or the file has been altered.
 *  - a KiCad board (`.kicad_pcb`): `parseKicadPcb`, warnings passed on.
 * 3D model files go through the import pipeline and `partFromModel` instead
 * (see actions.ts).
 */
import { PartSchema, partProblems, type ConnectorLibrary, type Part } from '@core';
import { decodePartGlb, encodePartGlb, sha256Hex, type PartMesh } from '../parts/glb';
import { parseKicadPcb } from '../parts/kicadPcb';
import { isCustomId, newCustomId } from './ids';
import { isDeepStrictEqualJson } from './json';

export type UserFileKind = 'model' | 'kicad' | 'glb' | 'unknown';

/** What kind of file this is by its name. A `.glb` may be a part file or a plain model: see `readPartFile`. */
export function userFileKind(name: string): UserFileKind {
  const n = name.toLowerCase();
  if (n.endsWith('.kicad_pcb')) return 'kicad';
  if (n.endsWith('.glb')) return 'glb';
  if (/\.(step|stp|stl|obj|gltf)$/.test(n)) return 'model';
  return 'unknown';
}

export interface PartFileResult {
  part: Part;
  /** The model alone (no definition inside), to store under the part's sha; absent when the part has no model. */
  modelGlb?: ArrayBuffer;
  meshes: PartMesh[];
}

/**
 * Read a part file. Returns null when the GLB carries no part definition (it
 * is a plain model: import it as a model). Throws with a plain sentence when
 * the definition is broken.
 */
export async function readPartFile(data: ArrayBuffer, connectors?: ConnectorLibrary | null): Promise<PartFileResult | null> {
  const { meshes, part: raw } = decodePartGlb(data);
  if (raw === undefined) return null;
  const parsed = PartSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new Error(`This part file's definition is not valid: ${first ? `${first.path.join('.') || 'part'}: ${first.message}` : parsed.error.message}`);
  }
  const part = parsed.data;
  const problems = partProblems(part, connectors ?? undefined);
  if (problems.length) throw new Error(`This part file's definition has a problem: ${problems.join('; ')}.`);
  let modelGlb: ArrayBuffer | undefined;
  if (part.model?.uri.startsWith('custom:')) {
    if (meshes.length === 0) throw new Error('This part file names a model of its own but carries no model.');
    modelGlb = encodePartGlb(meshes);
    const sha = await sha256Hex(modelGlb);
    const named = part.model.uri.slice('custom:'.length);
    if (sha !== named) throw new Error(`This part file's model does not match its definition (the file says ${named.slice(0, 12)}..., the model in it is ${sha.slice(0, 12)}...): it may have been altered.`);
  }
  return { part: { ...part, custom: true }, ...(modelGlb ? { modelGlb } : {}), meshes };
}

export type ImportPlan =
  /** Add it (with `renamedFrom` when its id was changed). */
  | { kind: 'add'; part: Part; renamedFrom?: string }
  /** This PC already has exactly this part. */
  | { kind: 'same'; part: Part }
  /** This PC has a different part with this id: ask "Replace" or "Keep both". */
  | { kind: 'conflict'; part: Part; existing: Part };

/**
 * What to do with a part read from a part file. A part file may carry any id;
 * a user part's id must start with `custom-` and may never be a bundled
 * part's id (it would replace that part in every design), so such a part gets
 * a new id. An id equal to a stored part's is the same part when the
 * definitions are identical, otherwise a conflict for the user to settle.
 */
export function planPartImport(part: Part, bundledIds: ReadonlySet<string>, stored: readonly Part[], newId: (name: string) => string = newCustomId): ImportPlan {
  if (!isCustomId(part.id) || bundledIds.has(part.id)) return { kind: 'add', part: { ...part, id: newId(part.name), custom: true }, renamedFrom: part.id };
  const existing = stored.find((p) => p.id === part.id);
  if (!existing) return { kind: 'add', part };
  return isDeepStrictEqualJson({ ...existing, custom: true }, { ...part, custom: true }) ? { kind: 'same', part: existing } : { kind: 'conflict', part, existing };
}

/** Read a KiCad board into a part: ports from its edge connectors, board drawing from its outline. */
export function readKicadPart(text: string, name: string | undefined, connectors: ConnectorLibrary | null): { part: Part; warnings: string[] } {
  const { part, warnings } = parseKicadPcb(text, { ...(name ? { name } : {}), ...(connectors ? { connectors } : {}) });
  return { part: { ...part, custom: true }, warnings };
}
