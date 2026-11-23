/**
 * The user's own cable types: built from parameters (`cableTypeFromSpec`),
 * kept on this PC (parts/store.ts, `cables`), and used like any library type.
 * A generated type carries its parameters (`type.spec`), so the form reopens
 * with exactly what was entered.
 *
 * The same rules as for the user's own parts:
 *  - ids start with `custom-` and are never a bundled type's id, so a stored
 *    type never takes a bundled one's place (state/library.ts);
 *  - the store is written only by explicit user actions (add, edit, delete,
 *    "keep on this PC", "keep the design's version"), and a write that fails
 *    is reported as such: nothing is shown as kept that was not;
 *  - a design carries the definitions of the custom types its wires use
 *    (`design.cable_types`, state/designParts.ts), so it keeps working when
 *    the stored copy is edited, deleted or absent;
 *  - when the design's copy and the stored one differ, neither is changed
 *    until the user chooses which way to bring them together.
 */
import { cableTypeFromSpec, type CableSpecInput, type CableType, type Design } from '@core';
import { deleteCustomCable, listCustomCables, saveCustomCable, type StoredCable } from '../parts/store';
import { useApp } from '../state/store';
import { newCustomId } from '../userParts/ids';
import { isDeepStrictEqualJson } from '../userParts/json';
import { cableThumbKey } from '../viewport/cableThumb';
import { forgetThumbnail } from '../viewport/thumbnails';

export async function loadUserCables(): Promise<void> {
  const cables = await listCustomCables();
  useApp.setState({ customCables: cables });
}

function putInState(c: StoredCable): void {
  useApp.setState((s) => ({ customCables: [...s.customCables.filter((x) => x.type.id !== c.type.id), c].sort((a, b) => a.type.name.localeCompare(b.type.name)) }));
}

/** Let an old picture go once no type in use looks like it any more. */
function forgetUnusedThumbnail(old: CableType): void {
  const key = cableThumbKey(old);
  const s = useApp.getState();
  if (!s.cableLibrary?.cables.some((t) => cableThumbKey(t) === key)) forgetThumbnail(key);
}

function isBundled(id: string): boolean {
  return !!useApp.getState().baseCableLibrary?.cables.some((t) => t.id === id);
}

/** The wires of a design that use a type, by name. */
export function wiresUsing(design: Design, typeId: string): string[] {
  return design.cables.filter((c) => c.type === typeId).map((c) => c.name || c.id);
}

/**
 * Save a cable from its parameters: a new type (no `id`), or a new version of
 * a stored one. Stored first: if that fails the error says why and nothing
 * else changes. With `updateDesign`, the open design's copy is replaced too
 * (one undo step) so its wires use the new figures. Returns the type.
 */
export async function saveUserCable(spec: CableSpecInput, opts: { id?: string; updateDesign?: boolean } = {}): Promise<CableType> {
  const id = opts.id ?? newCustomId(spec.name || 'cable');
  if (isBundled(id) || !id.startsWith('custom-')) throw new Error(`"${id}" is not an id for a cable of your own.`);
  const { type } = cableTypeFromSpec(spec, id);
  const before = useApp.getState().customCables.find((c) => c.type.id === id)?.type;
  await saveCustomCable({ type });
  putInState({ type });
  if (before) forgetUnusedThumbnail(before);
  const s = useApp.getState();
  if (opts.updateDesign && s.design.cable_types.some((t) => t.id === id)) {
    s.commit((d) => ({ ...d, cable_types: d.cable_types.map((t) => (t.id === id ? type : t)) }));
  }
  return type;
}

/** Delete a stored type. The open design keeps its own copy of it, if it uses it. Returns what to tell the user; rejects when nothing was deleted. */
export async function deleteUserCable(id: string): Promise<string> {
  const s = useApp.getState();
  const name = s.customCables.find((c) => c.type.id === id)?.type.name ?? id;
  const before = s.customCables.find((c) => c.type.id === id)?.type;
  await deleteCustomCable(id);
  useApp.setState((x) => ({ customCables: x.customCables.filter((c) => c.type.id !== id) }));
  if (before) forgetUnusedThumbnail(before);
  const users = wiresUsing(s.design, id);
  return users.length
    ? `"${name}" was deleted from this PC. This design uses it in ${users.join(', ')} and keeps its own copy, so those wires are unchanged.`
    : `"${name}" was deleted from this PC.`;
}

/** The open design's own cable types that this PC does not keep. */
export function designOnlyCableTypes(design: Design, stored: readonly StoredCable[]): CableType[] {
  return design.cable_types.filter((t) => t.custom && !stored.some((c) => c.type.id === t.id));
}

/** Does the design carry a version of a stored type that differs from the stored one? */
export function designCableDiffers(design: Design, stored: readonly StoredCable[], id: string): boolean {
  const d = design.cable_types.find((t) => t.id === id);
  const st = stored.find((c) => c.type.id === id);
  return !!d && !!st && !isDeepStrictEqualJson(d, st.type);
}

/** Put this PC's version of a type into the open design (one undo step; its wires are checked again). */
export function applyStoredCableInDesign(id: string): void {
  const st = useApp.getState().customCables.find((c) => c.type.id === id);
  if (!st) return;
  useApp.getState().commit((d) => ({ ...d, cable_types: d.cable_types.map((t) => (t.id === id ? st.type : t)) }));
}

/** Keep the open design's version of a type on this PC, replacing the stored one. Rejects when it was not stored. */
export async function keepDesignCableVersion(id: string): Promise<void> {
  const d = useApp.getState().design.cable_types.find((t) => t.id === id);
  if (!d || isBundled(id) || !id.startsWith('custom-')) return;
  await saveCustomCable({ type: d });
  putInState({ type: d });
}

/**
 * The form's starting point for a type: its own parameters when it carries
 * them (`type.spec`), otherwise every figure of the type as entered, and
 * `withoutParameters` set so the dialog can say the cable came without them.
 */
export function specForEditing(type: CableType): { spec: CableSpecInput; withoutParameters: boolean } {
  if (type.spec) return { spec: type.spec, withoutParameters: false };
  return { spec: specWithFigures(type), withoutParameters: true };
}

/** Every figure of a type that has no parameters, as if entered (used only to edit such a type). */
function specWithFigures(type: CableType): CableSpecInput {
  const common = {
    name: type.name,
    ...(type.manufacturer ? { manufacturer: type.manufacturer } : {}),
    ...(type.mpn ? { mpn: type.mpn } : {}),
    basis: type.confidence === 'datasheet' ? ('datasheet' as const) : ('measured' as const),
    flexing: type.min_bend_mm.dynamic !== undefined,
    bend_static_mm: type.min_bend_mm.static,
    ...(type.min_bend_mm.dynamic !== undefined ? { bend_dynamic_mm: type.min_bend_mm.dynamic } : {}),
    ...(type.max_current_a !== undefined ? { max_current_a: type.max_current_a } : {}),
    ...(type.mass_g_per_m !== undefined ? { mass_g_per_m: type.mass_g_per_m } : {}),
    ...(type.source ? { source: type.source } : {}),
    ...(type.note ? { note: type.note } : {}),
    connectors: type.connectors,
    interfaces: type.interfaces,
  };
  const awg = type.awg !== undefined && Number.isInteger(type.awg) ? { awg: type.awg } : {};
  if (type.section.shape === 'flat') {
    const ways = type.conductors;
    const pitch = type.pitch_mm ?? type.section.width_mm / ways;
    if (type.family === 'ribbon') return { kind: 'ribbon', ...common, ways, pitch_mm: pitch, thickness_mm: type.section.thickness_mm, ...awg };
    return { kind: 'flat_flex', ...common, construction: 'ffc', ways, pitch_mm: pitch, thickness_mm: type.section.thickness_mm, width_mm: type.section.width_mm };
  }
  if (type.conductors === 1 && type.awg !== undefined) return { kind: 'wire', ...common, awg: Math.round(type.awg), od_mm: type.section.od_mm };
  const family = (['multicore', 'twisted_pair', 'coax', 'usb', 'ethernet'] as const).find((f) => f === type.family) ?? 'multicore';
  return { kind: 'round_cable', ...common, family, conductors: type.conductors, od_mm: type.section.od_mm, ...awg };
}

/**
 * Keep the open design's own cable types on this PC, each as it is (with its
 * parameters when it has them). Each is tried on its own; the result says
 * which were kept and which were not, and why.
 */
export async function keepDesignCableTypes(): Promise<{ kept: string[]; failed: Array<{ name: string; why: string }> }> {
  const s = useApp.getState();
  const kept: string[] = [];
  const failed: Array<{ name: string; why: string }> = [];
  for (const type of designOnlyCableTypes(s.design, s.customCables)) {
    if (!type.id.startsWith('custom-') || isBundled(type.id)) {
      failed.push({ name: type.name, why: 'its id is not one for a cable of your own' });
      continue;
    }
    try {
      await saveCustomCable({ type });
      putInState({ type });
      kept.push(type.name);
    } catch (e) {
      failed.push({ name: type.name, why: e instanceof Error ? e.message : String(e) });
    }
  }
  return { kept, failed };
}
