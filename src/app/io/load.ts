/**
 * Everything that replaces the current model or design: importing model
 * files, the built-in demo, samples, opening a saved project, and saving.
 */
import { emptyDesign, parseDesign, validateDesign, type Design, type Issue } from '@core';
import { builtinModel, clampTriangles, demoArm, perfModel } from '../demo/builtin';
import { chooseModelFile, importModel, lengthUnitFromMmPerUnit } from '../ingest';
import type { ImportFile, ImportedMesh, ImportedModel, ImportModel, LengthUnit } from '../ingest/types';
import { registry, triangleCountOf } from '../scene/registry';
import { removeZones } from '../state/designOps';
import { confirmDiscard, useApp } from '../state/store';
import { getViewport } from '../viewport/instance';
import { baseName, downloadText, normalisePath } from './files';
import { serializeForSave } from './saveGuard';

const app = () => useApp.getState();

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

function issueLines(issues: readonly Issue[]): string[] {
  return issues.map((i) => `${i.severity === 'error' ? 'Error' : 'Warning'} at ${i.path || '(file)'}: ${i.message}`);
}

function stripExt(name: string): string {
  return name.replace(/\.[^.]+$/, '');
}

/** Show a model: put its meshes in the registry and its design in the store. */
function showModel(design: Design, meshes: readonly ImportedMesh[]): void {
  registry.replace(meshes.map((m) => ({ id: m.id, link: m.link, geometry: m.geometry, color: m.color })));
  app().replaceDesign(design);
  getViewport()?.onModelLoaded();
}

/** Load a freshly imported model as a new design. */
export function loadImportedModel(model: ImportedModel, name: string): void {
  const base = emptyDesign(name);
  const design: Design = { ...base, scene: { sources: model.sources, links: model.links, joints: model.joints } };
  showModel(design, model.meshes);
  const issues = validateDesign(design, app().library ?? undefined, app().connectorLibrary ?? undefined);
  if (model.warnings.length > 0) app().notify('warning', `Imported "${name}" with ${plural(model.warnings.length, 'warning')}`, model.warnings);
  if (issues.length > 0) app().notify(issues.some((i) => i.severity === 'error') ? 'error' : 'warning', 'The imported model has problems', issueLines(issues));
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

async function withProgress<T>(label: string, fn: (report: (f: number, l: string) => void) => Promise<T>): Promise<T> {
  app().setProgress({ fraction: 0, label });
  try {
    return await fn((fraction, l) => app().setProgress({ fraction: Math.max(0, Math.min(1, fraction)), label: l || label }));
  } finally {
    app().setProgress(null);
  }
}

export async function openDemoArm(): Promise<void> {
  if (!(await confirmDiscard('Opening the demo arm'))) return;
  loadImportedModel(demoArm(), 'Demo arm');
}

export function openPerfModel(requested: number): void {
  const triangles = clampTriangles(requested);
  loadImportedModel(perfModel(triangles), `Performance test, ${triangles.toLocaleString()} triangles`);
  if (triangles !== Math.round(requested)) {
    app().notify('info', `Performance model limited to ${triangles.toLocaleString()} triangles`, [`${Math.round(requested).toLocaleString()} were requested.`]);
  }
}

/** Does this look like a design file? */
function looksLikeDesign(f: ImportFile): unknown {
  if (!f.path.toLowerCase().endsWith('.json')) return undefined;
  try {
    const raw: unknown = JSON.parse(new TextDecoder().decode(f.data));
    if (raw && typeof raw === 'object' && 'schema' in raw && 'scene' in raw) return raw;
  } catch {
    // not JSON: not a design
  }
  return undefined;
}

/**
 * Entry point for anything the user picks or drops. A set that contains a
 * design file opens as a project; anything else is imported as a model.
 */
export async function openFiles(files: ImportFile[]): Promise<void> {
  if (files.length === 0) return;
  const designFile = files.find((f) => looksLikeDesign(f) !== undefined);
  if (designFile) return openProject(designFile, files.filter((f) => f !== designFile));
  return importFiles(files);
}

export async function importFiles(files: ImportFile[]): Promise<void> {
  const main = files[0];
  if (!main) return;
  if (!(await confirmDiscard('Importing a model'))) return;
  const name = stripExt(baseName(pickMainName(files)));
  // STL and OBJ carry no unit: ask, and only for them.
  let unitlessAs: LengthUnit | undefined;
  try {
    const chosen = chooseModelFile(files);
    if (chosen.kind === 'stl' || chosen.kind === 'obj') {
      const unit = await app().askUnit(baseName(chosen.file.path));
      if (!unit) return;
      unitlessAs = unit;
    }
  } catch {
    // No supported file: importModel below reports it in plain language.
  }
  try {
    const model = await withProgress('Importing', (report) => importModel(files, { onProgress: report, unitlessAs }));
    loadImportedModel(model, name);
  } catch (e) {
    app().notify('error', 'The model could not be imported', [
      errorText(e),
      `Files: ${files.map((f) => f.path).slice(0, 8).join(', ')}${files.length > 8 ? ', ...' : ''}`,
    ]);
  }
}

const MODEL_EXT = /\.(urdf|step|stp|iges|igs|glb|gltf|stl|obj)$/i;
function pickMainName(files: readonly ImportFile[]): string {
  return (files.find((f) => /\.urdf$/i.test(f.path)) ?? files.find((f) => MODEL_EXT.test(f.path)) ?? files[0]!).path;
}

/** Files that belong to a source `uri`: exact or suffix match on the path, then by file name. */
function filesForUri(uri: string, files: readonly ImportFile[]): ImportFile | undefined {
  const u = normalisePath(uri).toLowerCase();
  const byPath = files.find((f) => {
    const p = f.path.toLowerCase();
    return p === u || p.endsWith(`/${u}`) || u.endsWith(`/${p}`);
  });
  if (byPath) return byPath;
  const name = baseName(u);
  return files.find((f) => baseName(f.path).toLowerCase() === name);
}

interface MeshChange {
  meshId: string;
  linkId: string;
  expected: number;
  actual: number;
}

/**
 * Open a saved design together with its model files: parse and validate the
 * design, re-import every source, and check each mesh's triangle count and
 * each source's hash.
 *
 * Opening never changes the design by itself. Items on a model file that is
 * missing or fails to import are kept untouched (just not drawn). Only a
 * mesh that did import with a different triangle count loses its zones, and
 * that happens as a separate, undoable edit after opening.
 */
export async function openProject(designFile: ImportFile, modelFiles: ImportFile[], importer: ImportModel = importModel): Promise<void> {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(designFile.data));
  } catch (e) {
    app().notify('error', `"${baseName(designFile.path)}" is not valid JSON`, [errorText(e)]);
    return;
  }
  const parsed = parseDesign(raw, app().library ?? undefined, app().connectorLibrary ?? undefined);
  if (!parsed.ok) {
    app().notify('error', `"${baseName(designFile.path)}" is not a valid design file`, issueLines(parsed.issues));
    return;
  }
  if (!(await confirmDiscard('Opening a project'))) return;
  const design = parsed.design;
  const problems: string[] = [];
  const importNotes: string[] = [];
  const meshes = new Map<string, ImportedMesh>();
  const sources = design.scene.sources;
  /** Source id -> true once it imported. */
  const imported = new Set<string>();
  const changedHash = new Set<string>();
  const ownFile = new Map(sources.map((src) => [src.id, src.kind === 'builtin' ? undefined : filesForUri(src.uri, modelFiles)]));

  const itemsOn = (sourceId: string): string => {
    const meshIds = new Set(design.scene.links.flatMap((l) => l.meshes.filter((m) => m.source === sourceId).map((m) => m.id)));
    const zones = design.zones.filter((z) => meshIds.has(z.mesh)).length;
    return zones > 0 ? ` Its ${plural(zones, 'zone')} and everything else in the design are kept and will be shown again when the file is supplied.` : ' Everything in the design is kept.';
  };

  await withProgress('Opening project', async (report) => {
    for (const [i, source] of sources.entries()) {
      const span = (f: number, label: string) => report((i + f) / Math.max(1, sources.length), `${source.uri}: ${label}`);
      let model: ImportedModel | null;
      try {
        model = builtinModel(source.uri);
      } catch (e) {
        problems.push(`${errorText(e)}${itemsOn(source.id)}`);
        continue;
      }
      if (!model) {
        const file = ownFile.get(source.id);
        if (!file) {
          problems.push(`The model file "${source.uri}" was not among the files you opened, so its meshes are not shown.${itemsOn(source.id)}`);
          continue;
        }
        // Everything supplied goes along (a .gltf needs its .bin, a URDF its
        // meshes), except the files of the other sources.
        const others = new Set([...ownFile.entries()].filter(([id]) => id !== source.id).map(([, f]) => f));
        const set = [file, ...modelFiles.filter((f) => f !== file && !others.has(f))];
        try {
          model = await importer(set, { onProgress: span, idPrefix: source.id, unitlessAs: lengthUnitFromMmPerUnit(source.mm_per_unit) });
        } catch (e) {
          problems.push(`"${source.uri}" could not be read again: ${errorText(e)}. Its meshes are not shown.${itemsOn(source.id)}`);
          continue;
        }
        const newHash = model.sources.find((x) => x.id === source.id)?.sha256 ?? model.sources[0]?.sha256;
        if (source.sha256 && newHash && newHash !== source.sha256) changedHash.add(source.id);
      }
      imported.add(source.id);
      // The importer's own notes (degenerate triangles removed, etc.) were already shown on first import; on reopen they are information, not problems.
      for (const w of model.warnings) importNotes.push(`${source.uri}: ${w}`);
      for (const m of model.meshes) meshes.set(m.id, m);
      span(1, 'done');
    }
  });

  // Check every mesh of an imported source against the design.
  const kept: ImportedMesh[] = [];
  const changes: MeshChange[] = [];
  for (const link of design.scene.links) {
    for (const ref of link.meshes) {
      if (!imported.has(ref.source)) continue;
      const m = meshes.get(ref.id);
      const source = sources.find((x) => x.id === ref.source);
      if (!m) {
        const zones = design.zones.filter((z) => z.mesh === ref.id).length;
        problems.push(
          `Mesh "${ref.id}" (link "${link.id}") is no longer in "${source?.uri ?? ref.source}", so it is not shown.` +
            (zones > 0 ? ` Its ${plural(zones, 'zone')} are kept.` : ''),
        );
        continue;
      }
      const tris = triangleCountOf(m.geometry);
      if (tris !== ref.tri_count) changes.push({ meshId: ref.id, linkId: link.id, expected: ref.tri_count, actual: tris });
      kept.push({ ...m, link: link.id });
    }
  }
  for (const id of changedHash) {
    const src = sources.find((x) => x.id === id)!;
    const anyCountChanged = changes.some((c) => design.scene.links.some((l) => l.meshes.some((m) => m.id === c.meshId && m.source === id)));
    problems.push(
      `The model file "${src.uri}" has changed since the design was saved (its contents differ).` +
        (anyCountChanged ? '' : ' Its triangle counts still match, but zones may no longer sit on the same faces: check them.'),
    );
  }

  registry.replace(kept.map((m) => ({ id: m.id, link: m.link, geometry: m.geometry, color: m.color })));
  app().replaceDesign(design);
  getViewport()?.onModelLoaded();
  const name = design.meta.name;
  if (parsed.issues.length > 0) app().notify('warning', `"${name}" opened with validation warnings`, issueLines(parsed.issues));
  // Cable types missing from the library: the wires are kept (drawn as placeholders), not dropped.
  const cableLib = app().cableLibrary;
  const missingTypes = design.cables.filter((c) => !cableLib || !cableLib.cables.some((t) => t.id === c.type));
  if (missingTypes.length > 0) {
    app().notify(
      'warning',
      `${plural(missingTypes.length, 'wire')} use${missingTypes.length === 1 ? 's' : ''} a cable type that is not in the cable library`,
      missingTypes.map((c) => `Wire "${c.name ?? c.id}" uses cable type "${c.type}", which this build's cable library does not have. The wire is kept and drawn as a grey placeholder; choose a type to check it.`),
    );
  }
  if (importNotes.length > 0) app().notify('info', `Notes from reading the model files (${importNotes.length})`, importNotes);
  if (problems.length > 0) {
    app().notify('warning', `"${name}" opened, but ${plural(problems.length, 'problem')} ${problems.length === 1 ? 'needs' : 'need'} attention`, problems);
  }
  if (changes.length > 0) applyTriangleCountChanges(changes);
}

/**
 * Meshes whose triangle count changed: their zones index triangles that no
 * longer exist, so remove those zones and record the new counts, as one
 * undoable edit, and say exactly what was removed.
 */
function applyTriangleCountChanges(changes: readonly MeshChange[]): void {
  const byMesh = new Map(changes.map((c) => [c.meshId, c]));
  const before = app().design;
  const dropped = before.zones.filter((z) => byMesh.has(z.mesh));
  app().commit((d) => {
    const next = removeZones(d, new Set(dropped.map((z) => z.id)));
    return {
      ...next,
      scene: {
        ...next.scene,
        links: next.scene.links.map((l) => ({
          ...l,
          meshes: l.meshes.map((m) => (byMesh.has(m.id) ? { ...m, tri_count: byMesh.get(m.id)!.actual } : m)),
        })),
      },
    };
  });
  const lines = changes.map(
    (c) => `Mesh "${c.meshId}" (link "${c.linkId}") now has ${c.actual.toLocaleString()} triangles; the design expected ${c.expected.toLocaleString()}.`,
  );
  for (const z of dropped) lines.push(`Zone "${z.name}" on mesh "${z.mesh}" was removed because its triangles no longer exist.`);
  lines.push('Undo (Ctrl+Z) brings the removed zones back; saving makes the change permanent.');
  app().notify('warning', dropped.length > 0 ? `Removed ${plural(dropped.length, 'zone')} on changed meshes` : 'Updated triangle counts of changed meshes', lines);
}

/** "Demo arm" -> "demo-arm.json"; a design with no usable name -> "design.json". */
export function designFileName(name: string | undefined): string {
  const base = (name ?? '')
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase()
    .slice(0, 60);
  return `${base || 'design'}.json`;
}

export function saveDesign(): void {
  const { design, library, connectorLibrary } = app();
  const result = serializeForSave(design, library, connectorLibrary);
  if (!result.ok) {
    app().notify('error', 'Not saved: the file would not open again', result.errors);
    return;
  }
  downloadText(designFileName(design.meta.name), result.text);
  app().markSaved();
}

// ------------------------------------------------------------ samples

export interface SampleEntry {
  id: string;
  title: string;
  description?: string;
  files: string[];
  design?: string | null;
}

const FIXTURES = '/fixtures/';

/** The sample list, or [] if there is none. Never throws. */
export async function loadSampleIndex(): Promise<SampleEntry[]> {
  try {
    const res = await fetch(`${FIXTURES}index.json`, { cache: 'no-cache' });
    if (!res.ok) return [];
    // The dev server answers unknown paths with index.html, so parse defensively.
    const raw: unknown = JSON.parse(await res.text());
    const list = Array.isArray(raw) ? raw : (raw as { samples?: unknown })?.samples;
    if (!Array.isArray(list)) return [];
    return list.filter(
      (e): e is SampleEntry =>
        !!e && typeof e === 'object' && typeof (e as SampleEntry).id === 'string' && Array.isArray((e as SampleEntry).files),
    );
  } catch {
    return [];
  }
}

/** Fetch one sample file. Paths are relative to the sample's own folder, `/fixtures/<id>/`. */
async function fetchFile(entry: SampleEntry, path: string): Promise<ImportFile> {
  const bases = [new URL(`${FIXTURES}${encodeURIComponent(entry.id)}/`, location.origin)];
  let lastError = `${path} was not found`;
  for (const base of bases) {
    const res = await fetch(new URL(path, base));
    const ct = res.headers.get('content-type') ?? '';
    // The dev server answers missing files with index.html.
    if (res.ok && !(ct.includes('text/html') && !/\.html?$/i.test(path))) {
      return { path: normalisePath(path), data: await res.arrayBuffer() };
    }
    lastError = res.ok ? `${path} is missing on the server` : `could not download ${path} (HTTP ${res.status})`;
  }
  throw new Error(lastError);
}

export async function openSample(entry: SampleEntry): Promise<void> {
  let files: ImportFile[];
  let designFile: ImportFile | undefined;
  try {
    files = await withProgress(`Downloading ${entry.title}`, async (report) => {
      const out: ImportFile[] = [];
      for (const [i, f] of entry.files.entries()) {
        report(i / entry.files.length, `Downloading ${f}`);
        out.push(await fetchFile(entry, f));
      }
      if (entry.design) designFile = await fetchFile(entry, entry.design);
      return out;
    });
  } catch (e) {
    app().notify('error', `The sample "${entry.title}" could not be loaded`, [errorText(e)]);
    return;
  }
  if (designFile) await openProject(designFile, files);
  else await importFiles(files);
}
