/**
 * Imports every fixture through the app's own importer and writes, per scene:
 *   public/fixtures/<id>/design.json    a design whose `scene` comes from the import
 *   public/fixtures/<id>/expected.json  counts, bounding box and joints, for the golden tests
 * plus public/fixtures/index.json for the "Open sample" menu.
 *
 * Run from the repository root:  npx tsx tools/fixtures/make-designs.ts
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { Box3, Vector3 } from 'three';
import { computeLinkPoses, emptyDesign, parseDesign } from '@core';
import { importModel, type ImportedModel } from '../../src/app/ingest';

// URDF parsing needs DOMParser; Node has none.
(globalThis as { DOMParser?: unknown }).DOMParser ??= new JSDOM('').window.DOMParser;

const FIXTURES = fileURLToPath(new URL('../../public/fixtures/', import.meta.url));

export interface FixtureSpec {
  id: string;
  title: string;
  description: string;
  /** Paths relative to public/fixtures/<id>/ that make up the model. */
  files: string[];
}

export const FIXTURE_SPECS: FixtureSpec[] = [
  {
    id: 'enclosure',
    title: 'Electronics enclosure',
    description: 'Open-top 160 x 100 x 60 mm enclosure with standoffs, a divider wall and two cable holes (STEP assembly).',
    files: ['enclosure.step'],
  },
  {
    id: 'chassis',
    title: 'Mobile robot chassis',
    description: 'Plate, two motors, two wheels and a battery block (GLB).',
    files: ['chassis.glb'],
  },
  {
    id: 'arm-cad',
    title: 'CAD-only arm (no joints yet)',
    description:
      'A STEP assembly of a three-joint arm in one rigid pose, as a CAD export would give it. It has no joints: define them yourself by clicking the pivots (true axes are in axes.json for testing).',
    files: ['arm-cad.step'],
  },
  {
    id: 'arm3',
    title: 'Three-axis arm with gripper',
    description: 'Hand-written URDF: base yaw, shoulder, elbow and a prismatic gripper finger.',
    files: ['arm3.urdf', 'meshes/gripper_base.stl'],
  },
];

export async function importFixture(spec: FixtureSpec): Promise<ImportedModel> {
  const files = await Promise.all(
    spec.files.map(async (path) => {
      const buf = await readFile(`${FIXTURES}${spec.id}/${path}`);
      return { path, data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer };
    }),
  );
  return importModel(files);
}

export function sceneOf(model: ImportedModel) {
  return { sources: model.sources, links: model.links, joints: model.joints };
}

/** Bounding box in mm of the whole model at the zero pose. */
export function zeroPoseBox(model: ImportedModel): { min: number[]; max: number[] } {
  const poses = computeLinkPoses(sceneOf(model), {});
  const box = new Box3();
  const v = new Vector3();
  for (const mesh of model.meshes) {
    const pose = poses.get(mesh.link);
    if (!pose) throw new Error(`link ${mesh.link} has no pose`);
    const pos = mesh.geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i++) box.expandByPoint(v.fromBufferAttribute(pos, i).applyMatrix4(pose));
  }
  return { min: box.min.toArray(), max: box.max.toArray() };
}

export function expectedOf(model: ImportedModel) {
  const meshTriangles: Record<string, number> = {};
  let total = 0;
  for (const mesh of model.meshes) {
    const n = (mesh.geometry.getIndex()?.count ?? 0) / 3;
    meshTriangles[mesh.id] = n;
    total += n;
  }
  return {
    links: model.links.length,
    joints: model.joints.length,
    meshes: model.meshes.length,
    triangles: total,
    mesh_triangles: meshTriangles,
    bbox_mm: zeroPoseBox(model),
    joint_list: model.joints.map((j) => ({ name: j.name, type: j.type, limit: j.limit ?? null })),
  };
}

async function main() {
  const index = [];
  for (const spec of FIXTURE_SPECS) {
    const model = await importFixture(spec);
    const design = emptyDesign(spec.title);
    design.scene = sceneOf(model);
    const parsed = parseDesign(JSON.parse(JSON.stringify(design)));
    if (!parsed.ok) throw new Error(`${spec.id}: design does not validate: ${JSON.stringify(parsed.issues)}`);
    await writeFile(`${FIXTURES}${spec.id}/design.json`, JSON.stringify(parsed.design, null, 2) + '\n');
    await writeFile(`${FIXTURES}${spec.id}/expected.json`, JSON.stringify(expectedOf(model), null, 2) + '\n');
    index.push({ id: spec.id, title: spec.title, description: spec.description, files: spec.files, design: 'design.json' });
    console.log(`${spec.id}: ${model.links.length} links, ${model.joints.length} joints, ${model.meshes.length} meshes` + (model.warnings.length ? `, warnings: ${model.warnings.join(' | ')}` : ''));
  }
  await writeFile(`${FIXTURES}index.json`, JSON.stringify(index, null, 2) + '\n');
}

// Only run when executed directly, so that tests can import the helpers above.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
