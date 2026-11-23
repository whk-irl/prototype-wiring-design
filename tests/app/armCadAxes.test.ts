/**
 * Axis fitting against ground truth: the CAD-only arm sample and its true
 * joint axes (`public/fixtures/arm-cad/axes.json`). For every recorded pick,
 * take the triangle of that body nearest the picked surface point, flood the
 * smooth region and fit, as the app does on a click.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Triangle, Vector3 } from 'three';
import { importModel } from '../../src/app/ingest';
import type { ImportedModel } from '../../src/app/ingest/types';
import { fitAxisFromSeed } from '../../src/app/placement/axisFit';
import { topologyOf } from '../../src/app/scene/topology';

const DIR = resolve(process.cwd(), 'public', 'fixtures', 'arm-cad');

interface NotAxis {
  body: string;
  surface_point_mm: [number, number, number];
  kind: string;
}
interface Pick {
  edge?: string;
  body: string;
  feature: 'shaft' | 'hole' | 'face';
  surface_point_mm: [number, number, number];
  radius_mm: number;
}
interface TrueJoint {
  name: string;
  point_mm: [number, number, number];
  dir: [number, number, number];
  pick: Pick[];
}

/** The triangle of the mesh closest to `p` (true point-to-triangle distance, as a click would hit). */
function nearestTriangle(model: ImportedModel, meshId: string, p: Vector3): number {
  const mesh = model.meshes.find((m) => m.id === meshId);
  if (!mesh) throw new Error(`mesh ${meshId} not in the import`);
  const pos = mesh.geometry.getAttribute('position');
  const index = mesh.geometry.getIndex()!;
  let best = -1;
  let bestD = Infinity;
  const tri = new Triangle();
  const q = new Vector3();
  for (let t = 0; t < index.count / 3; t++) {
    tri.setFromAttributeAndIndices(pos, index.getX(3 * t), index.getX(3 * t + 1), index.getX(3 * t + 2));
    if (tri.getArea() === 0) continue;
    const d = tri.closestPointToPoint(p, q).distanceToSquared(p);
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  return best;
}

describe('axis fit on the arm-cad ground truth', () => {
  it('has the sample (public/fixtures/arm-cad/arm-cad.step and axes.json)', () => {
    expect(existsSync(resolve(DIR, 'arm-cad.step')), 'arm-cad.step is missing').toBe(true);
    expect(existsSync(resolve(DIR, 'axes.json')), 'axes.json is missing').toBe(true);
  });

  let model: ImportedModel;
  let joints: TrueJoint[] = [];
  let notAxes: NotAxis[] = [];
  beforeAll(async () => {
    if (!existsSync(resolve(DIR, 'arm-cad.step'))) return;
    const buf = readFileSync(resolve(DIR, 'arm-cad.step'));
    model = await importModel([{ path: 'arm-cad.step', data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer }]);
    const axes = JSON.parse(readFileSync(resolve(DIR, 'axes.json'), 'utf8')) as { joints: TrueJoint[]; not_axes?: NotAxis[] };
    joints = axes.joints;
    notAxes = axes.not_axes ?? [];
  }, 60_000);

  it('fits every recorded pick within 0.5 degrees, 0.2 mm and 2 percent radius', () => {
    expect(joints.length).toBeGreaterThan(0);
    const report: string[] = [];
    for (const j of joints) {
      const truthP = new Vector3(...j.point_mm);
      const truthD = new Vector3(...j.dir).normalize();
      for (const pick of j.pick) {
        const meshId = `arm-cad.${pick.body}`;
        const mesh = model.meshes.find((m) => m.id === meshId)!;
        const tri = nearestTriangle(model, meshId, new Vector3(...pick.surface_point_mm));
        const fit = fitAxisFromSeed(topologyOf(mesh.geometry), tri)!;
        const d = new Vector3(...fit.dir).normalize();
        const angle = (Math.acos(Math.min(1, Math.abs(d.dot(truthD)))) * 180) / Math.PI;
        const p = new Vector3(...fit.point);
        const w = truthP.clone().sub(p);
        const line = Math.max(w.clone().sub(d.clone().multiplyScalar(w.dot(d))).length(), w.clone().sub(truthD.clone().multiplyScalar(w.dot(truthD))).length());
        const radiusErr = Math.abs(fit.radius - pick.radius_mm) / pick.radius_mm;
        report.push(
          `${j.name} ${pick.body} ${pick.feature}/${pick.edge ?? '-'}: ${fit.kind}, angle ${angle.toFixed(4)} deg, line ${line.toFixed(4)} mm, radius ${fit.radius.toFixed(3)} (${(radiusErr * 100).toFixed(2)}%), ${fit.triangles} tri, ${fit.quality}`,
        );
        expect(fit.quality, `${j.name}/${pick.body}/${pick.feature} quality: ${fit.note}`).toBe('good');
        expect(angle, `${j.name}/${pick.body}/${pick.feature} direction`).toBeLessThan(0.5);
        expect(line, `${j.name}/${pick.body}/${pick.feature} axis line`).toBeLessThan(0.2);
        expect(radiusErr, `${j.name}/${pick.body}/${pick.feature} radius`).toBeLessThan(0.02);
      }
    }
    console.log(report.join('\n'));
  });

  it('has the not_axes list (regenerated sample)', () => {
    expect(notAxes.length, 'axes.json has no "not_axes" list').toBeGreaterThan(0);
  });

  it('reports no good, positioned axis on any not_axes point', () => {
    const report: string[] = [];
    for (const na of notAxes) {
      const meshId = `arm-cad.${na.body}`;
      const mesh = model.meshes.find((m) => m.id === meshId)!;
      const tri = nearestTriangle(model, meshId, new Vector3(...na.surface_point_mm));
      const fit = fitAxisFromSeed(topologyOf(mesh.geometry), tri);
      report.push(`${na.body} ${na.kind}: ${fit ? `${fit.kind} ${fit.quality} position ${fit.position}` : 'none'}`);
      expect(!fit || fit.quality !== 'good' || fit.position !== 'determined', `${na.body} ${na.kind} gave a good axis`).toBe(true);
    }
    console.log(report.join('\n'));
  });
});
