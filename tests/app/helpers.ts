import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyDesign, parseCableLibrary, parseLibrary, type CableLibrary, type Design, type Library, type Source } from '@core';
import { demoArm } from '../../src/app/demo/builtin';
import type { ImportFile, ImportModel, ImportOptions } from '../../src/app/ingest/types';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');

export function loadLibrary(): Library {
  return parseLibrary(readFileSync(resolve(ROOT, 'library/parts.yaml'), 'utf8'));
}

export function loadCableLibrary(): CableLibrary {
  return parseCableLibrary(readFileSync(resolve(ROOT, 'library/cables.yaml'), 'utf8'));
}

export const SHA_A = 'a'.repeat(64);
export const SHA_B = 'b'.repeat(64);

/** The demo arm as if it had been imported from `arm.glb`. */
export function armSource(sha = SHA_A): Source {
  return { id: 'demo', kind: 'glb', uri: 'arm.glb', mm_per_unit: 1000, sha256: sha };
}

export function armDesign(): Design {
  const m = demoArm();
  const links = m.links.map((l) => ({ ...l, meshes: l.meshes.map((r) => ({ ...r, source: 'demo' })) }));
  return { ...emptyDesign('Arm'), scene: { sources: [armSource()], links, joints: m.joints } };
}

/** A design with one zone on the base plate, one on the housing, and a component in the plate zone. */
export function armDesignWithZones(): Design {
  const d = armDesign();
  return {
    ...d,
    zones: [
      { id: 'mount-1', name: 'Plate top', kind: 'mount_allowed', link: 'base', mesh: 'demo.base.plate', triangles: [4, 2] },
      { id: 'mount-2', name: 'Housing', kind: 'mount_allowed', link: 'base', mesh: 'demo.base.housing', triangles: [0, 4] },
    ],
    components: [
      {
        id: 'sensor-1',
        name: 'Sensor 1',
        part: 'generic-breakout-25x18',
        link: 'base',
        pose: { p_mm: [100, 70, 12], q: [0, 0, 0, 1] },
        zone: 'mount-1',
      },
    ],
  };
}

export interface StubCall {
  paths: string[];
  options: ImportOptions | undefined;
}

/** An importer that "reads" arm.glb as the demo arm, with a chosen hash. */
export function stubImporter(sha = SHA_A, calls: StubCall[] = []): ImportModel {
  return async (files: ImportFile[], options?: ImportOptions) => {
    calls.push({ paths: files.map((f) => f.path), options });
    if (!files.some((f) => f.path.endsWith('arm.glb'))) throw new Error('no supported model file');
    const m = demoArm();
    return {
      ...m,
      sources: [armSource(sha)],
      links: m.links.map((l) => ({ ...l, meshes: l.meshes.map((r) => ({ ...r, source: 'demo' })) })),
    };
  };
}

export function fileOf(path: string, text = 'x'): ImportFile {
  return { path, data: new TextEncoder().encode(text).buffer as ArrayBuffer };
}

export function designFile(d: Design): ImportFile {
  return fileOf('design.json', JSON.stringify(d));
}
