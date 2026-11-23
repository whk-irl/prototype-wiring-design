/**
 * Model import: STEP/IGES (occt-import-js), GLB/GLTF, STL, OBJ and URDF, all
 * turned into the `ImportedModel` described in `types.ts`.
 *
 * Conventions beyond the contract, as implemented:
 * - glTF is Y-up by specification; it is rotated to the app's Z-up
 *   ((x, y, z) -> (x, -z, y)). STL and OBJ are taken as Z-up as they are.
 * - One source per import: the model file. A URDF's mesh files are not
 *   sources of their own; their meshes point at the URDF source.
 * - Colours are linear RGB. occt-import-js already returns linear values; URDF
 *   `rgba` is read as sRGB and converted.
 */
import type { SourceKind } from '@core';
import { defaultPrefix, extensionOf, sanitizeIdPart, sha256Hex } from './ids';
import { MM_PER_UNIT, kindOfPath, singleLinkModel } from './model';
import { parseMeshFile } from './meshfiles';
import { tessellationToModel, type OcctKind, type OcctTessellation } from './occt';
import { importUrdf } from './urdf';
import type { ImportFile, ImportModel, ImportOptions, LengthUnit } from './types';

export type * from './types';

/** Preference when several model files are supplied. */
const PRIORITY: SourceKind[] = ['urdf', 'step', 'iges', 'glb', 'gltf', 'obj', 'stl'];

export const SUPPORTED_EXTENSIONS = ['urdf', 'step', 'stp', 'iges', 'igs', 'glb', 'gltf', 'obj', 'stl'] as const;

/**
 * The `unitlessAs` option that corresponds to a stored `Source.mm_per_unit`, so
 * a project can be reopened with the same units. Undefined if it is not one of
 * the four units.
 */
export function lengthUnitFromMmPerUnit(mmPerUnit: number): LengthUnit | undefined {
  return (Object.keys(MM_PER_UNIT) as LengthUnit[]).find((u) => MM_PER_UNIT[u] === mmPerUnit);
}

function normalisePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '');
}

/** The model file to import out of everything supplied, or an Error the user can read. */
export function chooseModelFile(files: ImportFile[]): { file: ImportFile; kind: SourceKind } {
  const candidates = files
    .map((file) => ({ file, kind: kindOfPath(file.path) }))
    .filter((c): c is { file: ImportFile; kind: SourceKind } => c.kind !== null);
  if (candidates.length === 0) {
    const names = files.map((f) => f.path).join(', ');
    throw new Error(
      `No supported model file found${names ? ` in: ${names}` : ''}. Supported formats: STEP (.step, .stp), IGES (.iges, .igs), GLB/glTF, STL, OBJ and URDF.`,
    );
  }
  candidates.sort(
    (a, b) => PRIORITY.indexOf(a.kind) - PRIORITY.indexOf(b.kind) || a.file.path.split('/').length - b.file.path.split('/').length || (a.file.path < b.file.path ? -1 : 1),
  );
  return candidates[0]!;
}

async function tessellateOcct(kind: OcctKind, data: ArrayBuffer): Promise<OcctTessellation> {
  const inNode = typeof process !== 'undefined' && !!process.versions?.node;
  if (inNode) {
    const { tessellateInNode } = await import('./occtNode');
    return tessellateInNode(kind, data);
  }
  const { tessellateInWorker } = await import('./stepClient');
  return tessellateInWorker(kind, data);
}

export const importModel: ImportModel = async (rawFiles, options: ImportOptions = {}) => {
  const progress = options.onProgress ?? (() => {});
  const files = rawFiles.map((f) => ({ path: normalisePath(f.path), data: f.data }));
  const { file, kind } = chooseModelFile(files);
  const warnings: string[] = [];

  const others = files.filter((f) => f !== file && kindOfPath(f.path) !== null);
  if (kind !== 'urdf' && others.length > 0) {
    warnings.push(`Only "${file.path}" was imported. Ignored: ${others.map((f) => f.path).join(', ')}.`);
  } else if (kind === 'urdf') {
    const extra = others.filter((f) => kindOfPath(f.path) === 'urdf');
    if (extra.length > 0) warnings.push(`Only "${file.path}" was imported. Ignored other URDF files: ${extra.map((f) => f.path).join(', ')}.`);
  }

  const prefix = options.idPrefix ? sanitizeIdPart(options.idPrefix, 'model') : defaultPrefix(file.path);
  progress(0.02, `Reading ${file.path}`);
  const sha256 = await sha256Hex(file.data);

  const unit = options.unitlessAs;
  const unitlessMm = MM_PER_UNIT[unit ?? 'mm'];
  const unitWarning = (what: string) => {
    if (unit === undefined) warnings.push(`${what} files carry no unit; assuming millimetres.`);
  };

  let model;
  try {
    switch (kind) {
      case 'step':
      case 'iges': {
        progress(0.1, `Converting ${kind.toUpperCase()}`);
        const tessellation = await tessellateOcct(kind, file.data);
        progress(0.8, 'Building meshes');
        model = tessellationToModel(tessellation, { prefix, path: file.path, kind, sha256, warnings });
        break;
      }
      case 'glb':
      case 'gltf': {
        progress(0.1, 'Reading glTF');
        const parts = (await parseMeshFile(file, files))!;
        progress(0.8, 'Building meshes');
        model = singleLinkModel({ prefix, path: file.path, kind, mmPerUnit: 1000, sha256, parts, warnings });
        break;
      }
      case 'stl':
      case 'obj': {
        progress(0.1, `Reading ${kind.toUpperCase()}`);
        unitWarning(kind.toUpperCase());
        const parts = (await parseMeshFile(file, files))!;
        progress(0.8, 'Building meshes');
        model = singleLinkModel({ prefix, path: file.path, kind, mmPerUnit: unitlessMm, sha256, parts, warnings });
        break;
      }
      case 'urdf': {
        progress(0.1, 'Reading URDF');
        model = await importUrdf(file, files, prefix, sha256, warnings, progress);
        break;
      }
      default:
        // `builtin` models are generated by the app and never come from a file.
        throw new Error(`"${file.path}" is not a model file this build can import.`);
    }
  } catch (e) {
    if (e instanceof Error && /^(No supported|The |"|Joint |Link |A <)/.test(e.message)) throw e;
    throw new Error(`"${file.path}" (${extensionOf(file.path).toUpperCase()}) could not be read: ${e instanceof Error ? e.message : String(e)}`);
  }
  progress(1, 'Done');
  return model;
};
