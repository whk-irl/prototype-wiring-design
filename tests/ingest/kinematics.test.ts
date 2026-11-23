// @vitest-environment jsdom
// Cross-check (docs/TEST_PLAN.md section 2): our importer + core kinematics against urdf-loader.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import URDFLoader from 'urdf-loader';
import { computeLinkPoses, clampJointValue } from '@core';
import { importModel } from '../../src/app/ingest';
import { FIXTURE_DIR, readFixture } from './helpers';

/** Small seeded PRNG so the vectors are the same on every run. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('kinematics vs urdf-loader (arm3)', () => {
  it('agrees on every link pose for 1,000 random joint vectors within limits', async () => {
    const text = readFileSync(`${FIXTURE_DIR}arm3/arm3.urdf`, 'utf8');
    const loader = new URDFLoader();
    loader.loadMeshCb = (_path, _manager, _material, done) => done(new Object3D()); // geometry is not needed for poses
    const robot = loader.parse(text);

    const model = await importModel([readFixture('arm3', 'arm3.urdf'), readFixture('arm3', 'meshes/gripper_base.stl')]);
    const scene = { sources: model.sources, links: model.links, joints: model.joints };
    expect(Object.keys(robot.links).sort()).toEqual(model.links.map((l) => l.name).sort());
    const linkIdByName = new Map(model.links.map((l) => [l.name, l.id]));

    const rand = mulberry32(20261121);
    let worstPos = 0;
    let worstRot = 0;
    for (let n = 0; n < 1000; n++) {
      const metric: Record<string, number> = {}; // urdf-loader: rad and metres
      const ours: Record<string, number> = {}; // core: rad and mm
      for (const j of model.joints) {
        const lo = j.limit!.lower;
        const hi = j.limit!.upper;
        const mm = lo + rand() * (hi - lo);
        expect(clampJointValue(j, mm)).toBe(mm);
        ours[j.id] = mm;
        metric[j.name] = j.type === 'prismatic' ? mm / 1000 : mm;
      }
      robot.setJointValues(metric);
      robot.updateMatrixWorld(true);
      const poses = computeLinkPoses(scene, ours);
      expect(poses.size).toBe(model.links.length);

      for (const [name, link] of Object.entries(robot.links)) {
        const theirs = link.matrixWorld.elements;
        const mine = poses.get(linkIdByName.get(name)!)!.elements;
        for (const k of [12, 13, 14]) worstPos = Math.max(worstPos, Math.abs(theirs[k]! * 1000 - mine[k]!));
        for (const k of [0, 1, 2, 4, 5, 6, 8, 9, 10]) worstRot = Math.max(worstRot, Math.abs(theirs[k]! - mine[k]!));
      }
    }
    expect(worstPos).toBeLessThan(1e-3); // mm
    expect(worstRot).toBeLessThan(1e-9);
    console.log(`urdf-loader cross-check: worst position error ${worstPos.toExponential(2)} mm, worst rotation entry error ${worstRot.toExponential(2)}`);
  });
});
