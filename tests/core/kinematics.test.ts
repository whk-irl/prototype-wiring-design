import { Matrix4, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  clampJointValue,
  computeLinkPoses,
  IDENTITY_POSE,
  matrixToPose,
  poseToMatrix,
  rootLinks,
  savedJointValues,
  type Joint,
  type Pose,
} from '@core';
import { mkJoint, mkLink, sceneDesign } from './helpers';

const S = Math.SQRT1_2;
const RZ90: [number, number, number, number] = [0, 0, S, S];
const RX90: [number, number, number, number] = [S, 0, 0, S];

function expectVec(v: Vector3, x: number, y: number, z: number) {
  expect(v.x).toBeCloseTo(x, 9);
  expect(v.y).toBeCloseTo(y, 9);
  expect(v.z).toBeCloseTo(z, 9);
}
const originOf = (m: Matrix4) => new Vector3().setFromMatrixPosition(m);
const map = (m: Matrix4, x: number, y: number, z: number) => new Vector3(x, y, z).transformDirection(m);

describe('kinematics', () => {
  // base --revolute--> l1 --prismatic--> l2 --fixed--> l3 --continuous--> l4
  const links = ['base', 'l1', 'l2', 'l3', 'l4'].map(mkLink);
  const chain = (v: { j1?: number; j2?: number; j4?: number } = {}) =>
    sceneDesign(links, [
      mkJoint('j1', 'base', 'l1', { type: 'revolute', origin: { p_mm: [10, 0, 0], q: [0, 0, 0, 1] }, axis: [0, 0, 1], limit: { lower: -4, upper: 4 }, value: v.j1 ?? Math.PI / 2 }),
      mkJoint('j2', 'l1', 'l2', { type: 'prismatic', origin: { p_mm: [0, 5, 0], q: RZ90 }, axis: [1, 0, 0], limit: { lower: 0, upper: 10 }, value: v.j2 ?? 3 }),
      mkJoint('j3', 'l2', 'l3', { type: 'fixed', origin: { p_mm: [1, 0, 0], q: RX90 }, value: 123 }),
      mkJoint('j4', 'l3', 'l4', { type: 'continuous', axis: [0, 0, 1], value: v.j4 ?? 4 * Math.PI + Math.PI / 2 }),
    ]).scene;

  it('matches hand-computed poses of the 4-joint chain', () => {
    const poses = computeLinkPoses(chain());
    expect([...poses.keys()].sort()).toEqual(['base', 'l1', 'l2', 'l3', 'l4']);
    // base: identity
    expectVec(originOf(poses.get('base')!), 0, 0, 0);
    // l1 = T(10,0,0) Rz(90)
    expectVec(originOf(poses.get('l1')!), 10, 0, 0);
    expectVec(map(poses.get('l1')!, 1, 0, 0), 0, 1, 0);
    // l2 = l1 T(0,5,0) Rz(90) Tx(3): origin (10,0,0) + Rz90*(0,5+... ) = (2,0,0); frame is Rz(180)
    expectVec(originOf(poses.get('l2')!), 2, 0, 0);
    expectVec(map(poses.get('l2')!, 1, 0, 0), -1, 0, 0);
    expectVec(map(poses.get('l2')!, 0, 1, 0), 0, -1, 0);
    // l3 = l2 T(1,0,0) Rx(90): origin (1,0,0); z axis -> (0,1,0)
    expectVec(originOf(poses.get('l3')!), 1, 0, 0);
    expectVec(map(poses.get('l3')!, 0, 0, 1), 0, 1, 0);
    // l4 = l3 Rz(4 pi + pi/2): not clamped (continuous); x axis -> (0,0,1)
    expectVec(originOf(poses.get('l4')!), 1, 0, 0);
    expectVec(map(poses.get('l4')!, 1, 0, 0), 0, 0, 1);
  });

  it('uses the values override instead of joint.value, and does not clamp it', () => {
    const scene = chain();
    // j2 = 20 is beyond its limit of 10; prismatic motion is along the child x axis
    const poses = computeLinkPoses(scene, { j1: 0, j2: 20, j4: 0 });
    // l1 = T(10,0,0); l2 = l1 T(0,5,0) Rz90 Tx(20): origin (10,0,0) + (0,5,0) + Rz90*(20,0,0)=(0,20,0) -> (10,25,0)
    expectVec(originOf(poses.get('l2')!), 10, 25, 0);
  });

  it('a fixed joint ignores its value', () => {
    const a = computeLinkPoses(chain()).get('l3')!;
    const scene = chain();
    scene.joints[2]!.value = -77;
    expect(computeLinkPoses(scene).get('l3')!.equals(a)).toBe(true);
  });

  it('rotates about a non-axis-aligned axis', () => {
    // 120 degrees about (1,1,1) permutes the axes: x -> y -> z -> x
    const scene = sceneDesign([mkLink('a'), mkLink('b')], [mkJoint('j', 'a', 'b', { type: 'continuous', axis: [1, 1, 1] })]).scene;
    const m = computeLinkPoses(scene, { j: (2 * Math.PI) / 3 }).get('b')!;
    expectVec(map(m, 1, 0, 0), 0, 1, 0);
    expectVec(map(m, 0, 1, 0), 0, 0, 1);
    expectVec(map(m, 0, 0, 1), 1, 0, 0);
    // A non-unit axis behaves the same
    const scene2 = sceneDesign([mkLink('a'), mkLink('b')], [mkJoint('j', 'a', 'b', { type: 'continuous', axis: [2, 2, 2] })]).scene;
    const m2 = computeLinkPoses(scene2, { j: (2 * Math.PI) / 3 }).get('b')!;
    expect(m2.equals(m) || m2.elements.every((e, i) => Math.abs(e - m.elements[i]!) < 1e-12)).toBe(true);
  });

  it('translates along a non-axis-aligned, non-unit prismatic axis', () => {
    const scene = sceneDesign([mkLink('a'), mkLink('b')], [mkJoint('j', 'a', 'b', { type: 'prismatic', axis: [3, 4, 0], limit: { lower: 0, upper: 20 } })]).scene;
    expectVec(originOf(computeLinkPoses(scene, { j: 10 }).get('b')!), 6, 8, 0);
  });

  it('applies the origin rotation before the motion (child-frame axis)', () => {
    // origin Rx(90); revolute about child x: motion must not change the child x axis in the parent frame
    const scene = sceneDesign([mkLink('a'), mkLink('b')], [mkJoint('j', 'a', 'b', { type: 'revolute', origin: { p_mm: [0, 0, 0], q: RX90 }, axis: [1, 0, 0], limit: { lower: -4, upper: 4 } })]).scene;
    const m = computeLinkPoses(scene, { j: 1 }).get('b')!;
    expectVec(map(m, 1, 0, 0), 1, 0, 0);
    // child z after Rx(90)*Rx(1) = Rx(90 deg + 1 rad)
    const a = Math.PI / 2 + 1;
    expectVec(map(m, 0, 0, 1), 0, -Math.sin(a), Math.cos(a));
  });

  it('a zero axis leaves the child at the origin pose', () => {
    const scene = sceneDesign([mkLink('a'), mkLink('b')], [mkJoint('j', 'a', 'b', { type: 'revolute', axis: [0, 0, 0], origin: { p_mm: [1, 2, 3], q: IDENTITY_POSE.q }, limit: { lower: 0, upper: 1 } })]).scene;
    const m = computeLinkPoses(scene, { j: 1 }).get('b')!;
    expectVec(originOf(m), 1, 2, 3);
    expectVec(map(m, 1, 0, 0), 1, 0, 0);
  });

  it('handles two separate roots, each at the world origin', () => {
    const scene = sceneDesign(
      [mkLink('r1'), mkLink('c1'), mkLink('r2'), mkLink('c2')],
      [
        mkJoint('a', 'r1', 'c1', { origin: { p_mm: [1, 0, 0], q: [0, 0, 0, 1] } }),
        mkJoint('b', 'r2', 'c2', { origin: { p_mm: [0, 7, 0], q: [0, 0, 0, 1] } }),
      ],
    ).scene;
    expect(rootLinks(scene)).toEqual(['r1', 'r2']);
    const poses = computeLinkPoses(scene);
    expect(poses.size).toBe(4);
    expectVec(originOf(poses.get('r1')!), 0, 0, 0);
    expectVec(originOf(poses.get('r2')!), 0, 0, 0);
    expectVec(originOf(poses.get('c1')!), 1, 0, 0);
    expectVec(originOf(poses.get('c2')!), 0, 7, 0);
  });

  it('leaves out links in a cycle', () => {
    const scene = sceneDesign([mkLink('r'), mkLink('a'), mkLink('b')], [mkJoint('j1', 'a', 'b'), mkJoint('j2', 'b', 'a')]).scene;
    expect([...computeLinkPoses(scene).keys()]).toEqual(['r']);
  });

  it('rootLinks lists links that are not the child of any joint', () => {
    expect(rootLinks(chain())).toEqual(['base']);
    expect(rootLinks(sceneDesign([], []).scene)).toEqual([]);
    expect(rootLinks(sceneDesign([mkLink('x'), mkLink('y')], []).scene)).toEqual(['x', 'y']);
  });

  it('savedJointValues reads joint.value', () => {
    expect(savedJointValues(chain())).toEqual({ j1: Math.PI / 2, j2: 3, j3: 123, j4: 4 * Math.PI + Math.PI / 2 });
  });

  describe('clampJointValue', () => {
    const j = (extra: Partial<Joint>): Joint => mkJoint('j', 'a', 'b', extra);
    it('clamps revolute and prismatic joints to their limits', () => {
      for (const type of ['revolute', 'prismatic'] as const) {
        const joint = j({ type, limit: { lower: -1, upper: 2 } });
        expect(clampJointValue(joint, -5)).toBe(-1);
        expect(clampJointValue(joint, 5)).toBe(2);
        expect(clampJointValue(joint, 0.5)).toBe(0.5);
        expect(clampJointValue(joint, -1)).toBe(-1);
        expect(clampJointValue(joint, 2)).toBe(2);
      }
    });
    it('passes continuous joints and unlimited joints through', () => {
      expect(clampJointValue(j({ type: 'continuous', limit: { lower: 0, upper: 1 } }), 99)).toBe(99);
      expect(clampJointValue(j({ type: 'revolute' }), 99)).toBe(99);
    });
    it('returns 0 for fixed joints', () => {
      expect(clampJointValue(j({ type: 'fixed' }), 5)).toBe(0);
    });
  });

  describe('poseToMatrix and matrixToPose', () => {
    it('maps a known pose', () => {
      const m = poseToMatrix({ p_mm: [1, 2, 3], q: RZ90 });
      expectVec(originOf(m), 1, 2, 3);
      expectVec(map(m, 1, 0, 0), 0, 1, 0);
    });
    it('round-trips', () => {
      const poses: Pose[] = [
        IDENTITY_POSE,
        { p_mm: [1, -2, 3.5], q: RX90 },
        { p_mm: [100, 200, -300], q: [0.5, 0.5, 0.5, 0.5] },
        { p_mm: [0, 0, 0], q: [1, 0, 0, 0] },
      ];
      for (const p of poses) {
        const back = matrixToPose(poseToMatrix(p));
        p.p_mm.forEach((v, i) => expect(back.p_mm[i]).toBeCloseTo(v, 9));
        // q and -q are the same rotation
        const sign = Math.sign(p.q.reduce((s, v, i) => s + v * back.q[i]!, 0));
        p.q.forEach((v, i) => expect(sign * back.q[i]!).toBeCloseTo(v, 9));
      }
    });
    it('normalises a slightly non-unit quaternion', () => {
      const m = poseToMatrix({ p_mm: [0, 0, 0], q: [0, 0, 2 * S, 2 * S] });
      expectVec(map(m, 1, 0, 0), 0, 1, 0);
    });
  });
});
