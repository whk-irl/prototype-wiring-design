/**
 * The libraries, bundled at build time: parts (every `library/parts*.yaml`),
 * connectors (`library/connectors.yaml`, when present) and cable types
 * (`library/cables.yaml`).
 *
 * The parts library the app looks parts up in (`library` in the store) is the
 * bundled one merged with the design's own part definitions (`design.parts`),
 * the design's winning where ids clash; it is rebuilt whenever either changes,
 * so every lookup (`findPart(s.library, id)`) resolves a design's own parts
 * first, like `resolvePart`.
 */
import { mergeCableLibrary, mergeLibrary, parseCableLibrary, type CableLibrary, type CableType, parseConnectorLibrary, parseLibrary, type ConnectorLibrary, type Design, type Library, type Part } from '@core';
import cablesYaml from '../../../library/cables.yaml?raw';
import { useApp } from './store';
import { isCustomId } from '../userParts/ids';

// The connector library may not exist yet in a checkout: a glob is empty then, an import would fail the build.
const connectorFiles = import.meta.glob('../../../library/connectors.yaml', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

/**
 * The library lookups use: the bundled parts, then the user's own parts kept
 * on this PC, then the design's own part definitions on top (a design opened
 * from elsewhere brings its parts with it).
 *
 * A part kept on this PC can never take a bundled part's place: one with a
 * bundled id (or without the `custom-` prefix) is left out. A design's own
 * part with a bundled id IS used in its place, for that design only, as the
 * core documents (`validateDesign` warns about it); it is never written to
 * the parts store (userParts/actions.ts).
 */
export function runtimeLibrary(base: Library | null, design: Pick<Design, 'parts'>, custom: readonly Part[] = []): Library | null {
  if (!base && design.parts.length === 0 && custom.length === 0) return null;
  const bundled = new Set(base?.parts.map((p) => p.id));
  const mine = custom.filter((p) => isCustomId(p.id) && !bundled.has(p.id));
  return mergeLibrary(mergeLibrary(base ?? { version: 1, parts: [] }, mine), design.parts);
}

/**
 * The cable types lookups use, by the same rule as parts: the bundled types,
 * then the user's own kept on this PC (never in place of a bundled one: ids
 * `custom-...`, and none with a bundled id), then the design's own
 * (`design.cable_types`) on top, which win for that design.
 */
export function runtimeCableLibrary(base: CableLibrary | null, design: Pick<Design, 'cable_types'>, custom: readonly CableType[] = []): CableLibrary | null {
  if (!base && design.cable_types.length === 0 && custom.length === 0) return null;
  const bundled = new Set(base?.cables.map((t) => t.id));
  const mine = custom.filter((t) => isCustomId(t.id) && !bundled.has(t.id));
  return mergeCableLibrary(mergeCableLibrary(base ?? { version: 1, cables: [] }, mine), design.cable_types);
}

export function loadBundledConnectorLibrary(): ConnectorLibrary | null {
  const text = Object.values(connectorFiles)[0];
  if (text === undefined) return null;
  try {
    const lib = parseConnectorLibrary(text);
    useApp.setState({ connectorLibrary: lib });
    return lib;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    useApp.setState({ connectorLibrary: null });
    useApp.getState().notify('error', 'The connector library could not be read', [message]);
    return null;
  }
}

/**
 * Parse several part files and merge them. A file that fails is left out and
 * reported (the others still load); a part id found in two files is an error
 * naming both, and the second file's copy is left out. Pure: no store.
 */
export function mergePartFiles(
  files: ReadonlyArray<[name: string, text: string]>,
  connectors?: ConnectorLibrary,
): { library: Library; problems: Array<{ file: string; message: string }> } {
  const problems: Array<{ file: string; message: string }> = [];
  const parts: Library['parts'] = [];
  const from = new Map<string, string>();
  for (const [file, text] of files) {
    let lib: Library;
    try {
      try {
        lib = parseLibrary(text, connectors);
      } catch (e) {
        if (!connectors) throw e;
        // Parts naming connectors the connector library does not know: still usable, with a warning.
        lib = parseLibrary(text);
        problems.push({ file, message: `${e instanceof Error ? e.message : String(e)} (loaded without the connector check)` });
      }
    } catch (e) {
      problems.push({ file, message: e instanceof Error ? e.message : String(e) });
      continue;
    }
    for (const part of lib.parts) {
      const first = from.get(part.id);
      if (first) {
        problems.push({ file, message: `part id "${part.id}" is also in ${first}; this copy was left out` });
        continue;
      }
      from.set(part.id, file);
      parts.push(part);
    }
  }
  return { library: { version: 1, parts }, problems };
}

const partFiles = import.meta.glob('../../../library/parts*.yaml', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

export function loadBundledLibrary(): void {
  const connectors = useApp.getState().connectorLibrary ?? undefined;
  const files = Object.entries(partFiles)
    .map(([path, text]): [string, string] => [path.split('/').pop()!, text])
    .sort(([a], [b]) => a.localeCompare(b));
  const { library: base, problems } = mergePartFiles(files, connectors);
  const loaded = files.length - new Set(problems.filter((p) => !p.message.includes('loaded without') && !p.message.includes('also in')).map((p) => p.file)).size;
  if (problems.length) {
    useApp.getState().notify(
      loaded === 0 ? 'error' : 'warning',
      loaded === 0 ? 'The parts library could not be read' : 'Some parts could not be loaded',
      problems.map((p) => `${p.file}: ${p.message}`),
    );
  }
  if (loaded === 0 && files.length > 0) {
    useApp.setState({ baseLibrary: null, library: runtimeLibrary(null, useApp.getState().design, useApp.getState().customParts), libraryError: problems[0]?.message ?? 'no part file could be read' });
    return;
  }
  useApp.setState({ baseLibrary: base, library: runtimeLibrary(base, useApp.getState().design, useApp.getState().customParts), libraryError: null });
}

/** Keep `library` = bundled + stored + the design's own parts, and `cableLibrary` the same for cable types. */
export function watchRuntimeLibrary(): () => void {
  return useApp.subscribe((s, prev) => {
    if (s.design.parts !== prev.design.parts || s.baseLibrary !== prev.baseLibrary || s.customParts !== prev.customParts) {
      if (s.baseLibrary || s.design.parts.length || prev.design.parts.length || s.customParts.length || prev.customParts.length)
        useApp.setState({ library: runtimeLibrary(s.baseLibrary, s.design, s.customParts) });
    }
    if (s.design.cable_types !== prev.design.cable_types || s.baseCableLibrary !== prev.baseCableLibrary || s.customCables !== prev.customCables) {
      if (s.baseCableLibrary || s.design.cable_types.length || prev.design.cable_types.length || s.customCables.length || prev.customCables.length)
        useApp.setState({ cableLibrary: runtimeCableLibrary(s.baseCableLibrary, s.design, s.customCables.map((c) => c.type)) });
    }
  });
}

/** The cable library, bundled at build time from `library/cables.yaml`. */
export function loadBundledCableLibrary(): void {
  try {
    const base = parseCableLibrary(cablesYaml);
    const s = useApp.getState();
    useApp.setState({ baseCableLibrary: base, cableLibrary: runtimeCableLibrary(base, s.design, s.customCables.map((c) => c.type)) });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    useApp.setState({ cableLibrary: null });
    useApp.getState().notify('error', 'The cable library could not be read', [message]);
  }
}
