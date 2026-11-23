/**
 * Contract between model import and the rest of the app.
 *
 * Import turns user files into a scene fragment for the design file plus the
 * triangle meshes that go with it. Whatever the source format, the result
 * follows the same rules:
 *
 * - Geometry is in MILLIMETRES, in the frame of the link it imports into, with
 *   every node transform already baked into the vertices. The importer never
 *   sets `MeshRef.pose`. If the user later regroups meshes into links of their
 *   own, the design records a `pose` per mesh and the imported vertices stay
 *   as they are (see `MeshRefSchema`), so a re-import still matches.
 * - Geometry is indexed, has a `position` and a `normal` attribute, and no
 *   other attribute the app depends on.
 * - A file with no joints (STEP, glTF, STL, OBJ) becomes one link holding all
 *   of its meshes. A URDF becomes its links and joints.
 * - Mesh ids are stable: importing the same file twice gives the same ids, the
 *   same triangle order and the same `tri_count`. Zones depend on this.
 * - Ids satisfy `IdSchema` (letters, digits, `_ . : -`).
 */
import type { BufferGeometry } from 'three';
import type { Joint, Link, Source } from '@core';

/** A file handed to the importer. */
export interface ImportFile {
  /** Path relative to what the user picked or dropped, forward slashes.
   *  For a single file this is just its name. */
  path: string;
  data: ArrayBuffer;
}

export interface ImportedMesh {
  /** Same id as the matching `MeshRef` in `links[].meshes`. */
  id: string;
  link: string;
  geometry: BufferGeometry;
  /** Display colour from the source file, linear RGB 0..1. */
  color: [number, number, number];
}

export interface ImportedModel {
  sources: Source[];
  links: Link[];
  joints: Joint[];
  meshes: ImportedMesh[];
  /** Things the user should know: skipped files, missing meshes, guessed units. */
  warnings: string[];
}

export type LengthUnit = 'mm' | 'cm' | 'm' | 'inch';

export interface ImportOptions {
  /** Unit to assume for formats that carry none (STL, OBJ). Default `mm`. */
  unitlessAs?: LengthUnit;
  /** Progress in 0..1 with a short label, for a progress bar. */
  onProgress?: (fraction: number, label: string) => void;
  /** Prefix for generated source, link and mesh ids, so that several imports
   *  into one design cannot collide. Default: derived from the file name. */
  idPrefix?: string;
}

/**
 * Import one model. `files` is everything the user supplied together: a single
 * STEP/GLB/STL file, or a URDF plus the mesh files it references (matched by
 * path suffix, since `package://` and relative paths rarely survive a drop).
 *
 * Rejects with an Error whose message can be shown to the user when no
 * supported model file is present or the file cannot be read.
 */
export type ImportModel = (files: ImportFile[], options?: ImportOptions) => Promise<ImportedModel>;
