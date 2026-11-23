/**
 * The user's own parts in the app: loading them from the parts store at
 * start-up, adding (from a model, a KiCad board or a part file), renaming,
 * deleting, exporting a part file, editing a definition, and making an
 * editable copy of a library part.
 *
 * A definition can live in two places: the parts store on this PC (reused
 * across designs) and, once placed, the open design's `design.parts` (so the
 * design carries it; see state/designParts.ts). The two can differ: a design
 * made with an older version of the part, or an undo of a port edit.
 *
 * The parts store is written ONLY by explicit user actions: adding, renaming,
 * editing ports, deleting. Opening a design, undo and redo never write it.
 * An edit (rename, ports) of a part the open design carries goes:
 *  - to both copies when they were identical before the edit;
 *  - otherwise to the design's copy only (the design has its own version;
 *    the part details say so and offer "Use my stored version here").
 * An edit of a part the open design does not carry goes to the store.
 * A design part with the id of a bundled part is never written to the store.
 */
import { isDeepStrictEqualJson } from './json';
import type { Part } from '@core';
import { downloadBytes } from '../io/files';
import { decodePartGlb, encodePartGlb } from '../parts/glb';
import { deleteCustomPart, listCustomParts, loadCustomModel, saveCustomPart, updateCustomPart } from '../parts/store';
import { slugify } from '../parts/fromModel';
import { useApp } from '../state/store';
import { forgetPartModel } from '../viewport/partModels';
import { isCustomId, newCustomId } from './ids';

export async function loadUserParts(): Promise<void> {
  const parts = await listCustomParts();
  useApp.setState({ customParts: parts });
}

function putInState(part: Part): void {
  useApp.setState((s) => ({ customParts: [...s.customParts.filter((p) => p.id !== part.id), part].sort((a, b) => a.name.localeCompare(b.name)) }));
}

/** Keep a new part (and its model) on this PC. Its id must be a user part id (`custom-...`) and not a bundled part's. */
/** Rejects (with the reason in plain words) when it was not stored; the parts list then does not show it. */
export async function addUserPart(part: Part, modelGlb?: ArrayBuffer): Promise<void> {
  if (!isCustomId(part.id) || isBundled(part.id)) throw new Error(`"${part.id}" is not a user part id (they start with "custom-").`);
  await saveCustomPart({ ...part, custom: true }, modelGlb);
  if (part.model) forgetPartModel(part.model.uri);
  putInState({ ...part, custom: true });
}

/** Is the bundled library's part with this id there (a user part may never take its id)? */
function isBundled(id: string): boolean {
  return !!useApp.getState().baseLibrary?.parts.some((p) => p.id === id);
}

/** Where an edit of `id` goes: see the header. */
export function editTarget(id: string): { design: boolean; store: boolean } {
  const s = useApp.getState();
  const inDesign = s.design.parts.find((p) => p.id === id);
  const stored = isBundled(id) ? undefined : s.customParts.find((p) => p.id === id);
  return { design: !!inDesign, store: !!stored && (!inDesign || isDeepStrictEqualJson(inDesign, stored)) };
}

/** Does the open design carry a version of this part that differs from the one kept on this PC? */
export function designHasOwnVersion(id: string): boolean {
  const s = useApp.getState();
  const inDesign = s.design.parts.find((p) => p.id === id);
  const stored = s.customParts.find((p) => p.id === id);
  return !!inDesign && !!stored && !isDeepStrictEqualJson(inDesign, stored);
}

/**
 * Change a part's definition (rename, port edits): the design's copy (one
 * undo step; components and attached wire ends follow, wire ends on deleted
 * ports are detached) and/or the stored copy, by `editTarget`.
 */
export async function updatePartDefinition(part: Part): Promise<void> {
  const s = useApp.getState();
  const target = editTarget(part.id);
  if (target.design) s.commit((d) => ({ ...d, parts: d.parts.map((p) => (p.id === part.id ? part : p)) }));
  if (target.store) {
    // Stored first: the list shows it as kept only once it is. A failure is said, and the design's copy (if any) still has the edit.
    try {
      await updateCustomPart(part);
      putInState(part);
    } catch (e) {
      s.notify('error', `The change to "${part.name}" was not kept on this PC`, [
        e instanceof Error ? e.message : String(e),
        target.design ? 'This design has the change; the version kept on this PC does not.' : 'Nothing was changed.',
      ]);
    }
  }
}

/** Replace this design's own version of a part with the one kept on this PC (undoable). */
export function applyStoredVersion(id: string): void {
  const stored = useApp.getState().customParts.find((p) => p.id === id);
  if (!stored) return;
  useApp.getState().commit((d) => ({ ...d, parts: d.parts.map((p) => (p.id === id ? stored : p)) }));
}

export async function renameUserPart(part: Part, name: string): Promise<void> {
  await updatePartDefinition({ ...part, name });
}

/** Components of the open design that use a part, by name. */
export function componentsUsing(partId: string): string[] {
  return useApp
    .getState()
    .design.components.filter((c) => c.part === partId)
    .map((c) => c.name || c.id);
}

/** Delete a part from this PC. Refused (with the reason) while the open design uses it. */
export async function deleteUserPart(part: Part): Promise<string | null> {
  const users = componentsUsing(part.id);
  if (users.length) return `"${part.name}" is used by ${users.join(', ')} in this design. Delete those first.`;
  try {
    await deleteCustomPart(part.id);
  } catch (e) {
    return `"${part.name}" was not deleted: ${e instanceof Error ? e.message : String(e)} It is still kept on this PC.`;
  }
  useApp.setState((s) => ({ customParts: s.customParts.filter((p) => p.id !== part.id), partDetails: s.partDetails === part.id ? null : s.partDetails }));
  return null;
}

/** A part file: the model (when there is one) with the definition inside, ready to open on another PC. */
export async function partFileBytes(part: Part): Promise<ArrayBuffer> {
  let meshes: ReturnType<typeof decodePartGlb>['meshes'] = [];
  if (part.model?.uri.startsWith('custom:')) {
    const data = await loadCustomModel(part.model.uri.slice('custom:'.length));
    if (!data) throw new Error(`The model of "${part.name}" is not on this PC, so its part file cannot be written.`);
    meshes = decodePartGlb(data).meshes;
  } else if (part.model) {
    const res = await fetch(`${import.meta.env.BASE_URL}parts/${part.model.uri}`);
    if (res.ok) meshes = decodePartGlb(await res.arrayBuffer()).meshes;
  }
  return encodePartGlb(meshes, part);
}

/** Download a part's part file. False (with a notice) when it could not be written. */
export async function exportPartFile(part: Part): Promise<boolean> {
  try {
    downloadBytes(`${slugify(part.name)}.part.glb`, await partFileBytes(part), 'model/gltf-binary');
    return true;
  } catch (e) {
    useApp.getState().notify('error', `The part file of "${part.name}" was not written`, [e instanceof Error ? e.message : String(e)]);
    return false;
  }
}

/** The user's own parts the open design uses (its own definitions). */
export function designCustomParts(): Part[] {
  return useApp.getState().design.parts.filter((p) => p.custom);
}

/** One part file per part of the user's own the open design uses, so the design can be handed on with its models. */
export async function exportDesignPartFiles(): Promise<void> {
  const parts = designCustomParts();
  let written = 0;
  for (const p of parts) if (await exportPartFile(p)) written++;
  if (written) useApp.getState().notify('info', `Exported ${written} part file${written === 1 ? '' : 's'}`, [`${parts.map((p) => p.name).join(', ')}. Send them with design.json: opened with Parts > Add your own part, they bring the 3D models.`]);
}

/**
 * An editable copy of a library part: a custom part with a new id and the
 * same body, ports and model reference. A bundled model stays bundled (it is
 * read from the app's parts folder); its licence and credit go with it.
 */
export async function makeEditableCopy(part: Part): Promise<Part | null> {
  const copy: Part = { ...structuredClone(part), id: newCustomId(part.name), name: `${part.name} (my copy)`, custom: true };
  try {
    await addUserPart(copy);
  } catch (e) {
    useApp.getState().notify('error', `No copy of "${part.name}" was made`, [e instanceof Error ? e.message : String(e)]);
    return null;
  }
  useApp.setState({ partDetails: copy.id });
  return copy;
}

