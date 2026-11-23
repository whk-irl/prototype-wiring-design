/**
 * A design carries the DEFINITIONS of the user's own parts it uses
 * (`design.parts`: size, ports, the model's sha256), so it opens on another
 * PC with every part, port and wire in place. It does not carry their 3D
 * MODELS: a model lives in the parts store of the PC it was imported on, and
 * where it is missing the part is drawn from its outline until its part file
 * (Parts > Add your own part) is opened there. To hand a design on, export
 * the part files it uses as well (Toolbar > Part files).
 *
 * A custom part placed in the design is copied in, and its definition leaves
 * again with its last component. Definitions that are not custom (`custom`
 * unset) are left alone. Pure.
 */
import { findCableType, findPart, type CableLibrary, type Design, type Library } from '@core';

export function syncDesignParts(design: Design, library: Library | null): Design {
  const used = new Set(design.components.map((c) => c.part));
  const kept = design.parts.filter((p) => !p.custom || used.has(p.id));
  const have = new Set(kept.map((p) => p.id));
  const added = [...used].flatMap((id) => {
    if (have.has(id)) return [];
    const part = library ? findPart(library, id) : undefined;
    return part?.custom ? [part] : [];
  });
  if (added.length === 0 && kept.length === design.parts.length) return design;
  return { ...design, parts: [...kept, ...added] };
}

/**
 * The same for the user's own cable types: a design carries the definition of
 * every custom type its wires use (`design.cable_types`), so it keeps working
 * when the copy kept on this PC is edited, deleted or absent (another PC).
 * A type is copied in when a wire starts using it and leaves with the last
 * wire that uses it. Types that are not custom are left alone. Pure.
 */
export function syncDesignCableTypes(design: Design, library: CableLibrary | null): Design {
  const used = new Set(design.cables.map((c) => c.type));
  const kept = design.cable_types.filter((t) => !t.custom || used.has(t.id));
  const have = new Set(kept.map((t) => t.id));
  const added = [...used].flatMap((id) => {
    if (have.has(id)) return [];
    const type = library ? findCableType(library, id) : undefined;
    return type?.custom ? [type] : [];
  });
  if (added.length === 0 && kept.length === design.cable_types.length) return design;
  return { ...design, cable_types: [...kept, ...added] };
}
