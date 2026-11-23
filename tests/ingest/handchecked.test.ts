// Values worked out by hand from the modelling parameters and the URDF text, not taken from the importer.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { computeLinkPoses } from '@core';
import { importModel } from '../../src/app/ingest';
import { FIXTURE_DIR, boxOf, installDomParser, modelBox, readFixture, textFile } from './helpers';

installDomParser();

const near = (a: number, b: number, tol = 0.01) => expect(Math.abs(a - b), `${a} vs ${b}`).toBeLessThanOrEqual(tol);

describe('enclosure.step', () => {
  it('has the modelled size: 160 x 100 x 60 mm, centred in x and y, bottom at z = 0', async () => {
    const model = await importModel([readFixture('enclosure', 'enclosure.step')]);
    const box = modelBox(model);
    near(box.min.x, -80);
    near(box.max.x, 80);
    near(box.min.y, -50);
    near(box.max.y, 50);
    near(box.min.z, 0);
    near(box.max.z, 60);
  });

  it('is one link with six separately named bodies in different colours', async () => {
    const model = await importModel([readFixture('enclosure', 'enclosure.step')]);
    expect(model.links).toHaveLength(1);
    expect(model.meshes.map((m) => m.id)).toEqual(
      ['shell', 'divider', 'standoff_1', 'standoff_2', 'standoff_3', 'standoff_4'].map((n) => `enclosure.${n}`),
    );
    const colour = (id: string) => model.meshes.find((m) => m.id === id)!.color.map((c) => c.toFixed(3)).join();
    expect(new Set([colour('enclosure.shell'), colour('enclosure.divider'), colour('enclosure.standoff_1')]).size).toBe(3);
  });

  it('has 2.5 mm walls and floor (inner faces at x = +-77.5, z = 2.5) and cable holes in the +X wall', async () => {
    const model = await importModel([readFixture('enclosure', 'enclosure.step')]);
    const shell = model.meshes.find((m) => m.id === 'enclosure.shell')!.geometry;
    // The inner face of the +X wall is the plane x = 77.5 and the floor top is z = 2.5.
    const xs = new Set<number>();
    const zs = new Set<number>();
    const p = shell.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      xs.add(Math.round(p.getX(i) * 100) / 100);
      zs.add(Math.round(p.getZ(i) * 100) / 100);
    }
    expect(xs.has(77.5)).toBe(true);
    expect(xs.has(-77.5)).toBe(true);
    expect(zs.has(2.5)).toBe(true);
    // Cable holes: 12 mm diameter, centred at y = +-20, z = 30, so vertices at z = 24 and 36 exist on x = 80.
    const onWall = new Set<string>();
    for (let i = 0; i < p.count; i++) if (Math.abs(p.getX(i) - 80) < 1e-3) onWall.add(`${Math.round(p.getZ(i) * 10) / 10}`);
    expect(onWall.has('24') || onWall.has('36')).toBe(true);
  });
});

describe('chassis.glb', () => {
  it('has a plate of 200 x 150 x 4 mm, Z-up', async () => {
    const model = await importModel([readFixture('chassis', 'chassis.glb')]);
    const plate = model.meshes.find((m) => m.id === 'chassis.plate');
    expect(plate, model.meshes.map((m) => m.id).join()).toBeDefined();
    const size = boxOf(plate!.geometry).getSize(new (await import('three')).Vector3());
    near(size.x, 200);
    near(size.y, 150);
    near(size.z, 4);
  });

  it('has six meshes in several colours and the overall extent of the modelled parts', async () => {
    const model = await importModel([readFixture('chassis', 'chassis.glb')]);
    expect(model.meshes.map((m) => m.id).sort()).toEqual(
      ['battery', 'motor_left', 'motor_right', 'plate', 'wheel_left', 'wheel_right'].map((n) => `chassis.${n}`).sort(),
    );
    expect(new Set(model.meshes.map((m) => m.color.map((c) => c.toFixed(3)).join())).size).toBeGreaterThanOrEqual(4);
    const box = modelBox(model);
    // wheels: axle z = 30, radius 30, outer face at y = +-105; battery top at 56.5 + 10
    near(box.min.z, 0);
    near(box.max.z, 66.5);
    near(box.min.y, -105);
    near(box.max.y, 105);
    near(box.min.x, -100);
    near(box.max.x, 100);
  });
});

describe('arm3.urdf', () => {
  const text = readFileSync(`${FIXTURE_DIR}arm3/arm3.urdf`, 'utf8');
  const load = () => importModel([readFixture('arm3', 'arm3.urdf'), readFixture('arm3', 'meshes/gripper_base.stl')]);

  it('has the links and joint limits written in the URDF', async () => {
    const model = await load();
    expect(model.links.map((l) => l.name)).toEqual([...text.matchAll(/<link name="([^"]+)"/g)].map((m) => m[1]));
    expect(model.links).toHaveLength(5);
    expect(model.joints).toHaveLength(4);
    for (const m of text.matchAll(/<joint name="([^"]+)" type="([^"]+)">[\s\S]*?<limit lower="([^"]+)" upper="([^"]+)"/g)) {
      const joint = model.joints.find((j) => j.name === m[1])!;
      expect(joint.type).toBe(m[2]);
      const k = m[2] === 'prismatic' ? 1000 : 1; // metres -> mm
      expect(joint.limit!.lower).toBeCloseTo(Number(m[3]) * k, 9);
      expect(joint.limit!.upper).toBeCloseTo(Number(m[4]) * k, 9);
    }
    near(model.joints.find((j) => j.name === 'base_yaw')!.limit!.upper, (170 * Math.PI) / 180, 1e-9);
    expect(model.joints.find((j) => j.name === 'finger_slide')!.limit).toEqual({ lower: 0, upper: 30 });
  });

  it('keeps non-trivial axes and converts joint origins to mm', async () => {
    const model = await load();
    const by = Object.fromEntries(model.joints.map((j) => [j.name, j]));
    expect(by['shoulder']!.axis).toEqual([0, 1, 0]);
    expect(by['finger_slide']!.axis).toEqual([1, 0, 0]);
    expect(by['elbow']!.origin.p_mm).toEqual([10, 0, 200]);
    expect(by['base_yaw']!.origin.p_mm).toEqual([0, 0, 40]);
  });

  it('puts a known vertex where the URDF chain says at a non-zero pose', async () => {
    const model = await load();
    // Finger visual: box 8 x 6 x 40 mm centred at z = 20 mm in the finger frame. Corner (+4, +3, +40) mm.
    const finger = model.meshes.find((m) => m.link.endsWith('.finger'))!;
    const p = finger.geometry.getAttribute('position');
    let found = false;
    for (let i = 0; i < p.count; i++) found ||= Math.abs(p.getX(i) - 4) + Math.abs(p.getY(i) - 3) + Math.abs(p.getZ(i) - 40) < 1e-4;
    expect(found).toBe(true);

    // Independent forward kinematics with plain 4x4 arrays (row-major), in metres, straight from the URDF text.
    type M = number[][];
    const mul = (a: M, b: M): M => a.map((_, i) => b[0]!.map((_, j) => a[i]!.reduce((s, _v, k) => s + a[i]![k]! * b[k]![j]!, 0)));
    const tr = (x: number, y: number, z: number): M => [[1, 0, 0, x], [0, 1, 0, y], [0, 0, 1, z], [0, 0, 0, 1]];
    const rz = (a: number): M => [[Math.cos(a), -Math.sin(a), 0, 0], [Math.sin(a), Math.cos(a), 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
    const ry = (a: number): M => [[Math.cos(a), 0, Math.sin(a), 0], [0, 1, 0, 0], [-Math.sin(a), 0, Math.cos(a), 0], [0, 0, 0, 1]];
    const q = { base_yaw: 0.5, shoulder: 0.3, elbow: -0.4, finger_slide: 0.02 }; // rad, rad, rad, m
    let T = mul(tr(0, 0, 0.04), rz(q.base_yaw)); // base_link -> turret
    T = mul(T, mul(mul(tr(0, 0, 0.06), rz(0.3)), ry(q.shoulder))); // -> upper_arm (origin rpy 0 0 0.3, axis y)
    T = mul(T, mul(mul(tr(0.01, 0, 0.2), ry(0.4)), ry(q.elbow))); // -> forearm (origin rpy 0 0.4 0, axis y)
    T = mul(T, mul(mul(tr(0, 0, 0.14), rz(Math.PI / 2)), tr(q.finger_slide, 0, 0))); // -> finger (origin rpy 0 0 pi/2, axis x)
    const corner = [0.004, 0.003, 0.04, 1];
    const expected = T.slice(0, 3).map((row) => row.reduce((s, v, k) => s + v * corner[k]!, 0) * 1000);

    const values = Object.fromEntries(model.joints.map((j) => [j.id, j.name === 'finger_slide' ? q.finger_slide * 1000 : q[j.name as keyof typeof q]]));
    const pose = computeLinkPoses({ sources: model.sources, links: model.links, joints: model.joints }, values).get(finger.link)!;
    const world = { x: 4, y: 3, z: 40 };
    const v = new (await import('three')).Vector3(world.x, world.y, world.z).applyMatrix4(pose);
    near(v.x, expected[0]!, 1e-6);
    near(v.y, expected[1]!, 1e-6);
    near(v.z, expected[2]!, 1e-6);
  });

  it('reads rpy as R = Rz(yaw) * Ry(pitch) * Rx(roll)', async () => {
    const urdf = `<robot name="t"><link name="a"/><link name="b"/>
      <joint name="j" type="fixed"><parent link="a"/><child link="b"/><origin xyz="0.1 0.2 0.3" rpy="0.3 0.5 0.7"/></joint></robot>`;
    const model = await importModel([textFile('t.urdf', urdf)]);
    const m = computeLinkPoses({ sources: model.sources, links: model.links, joints: model.joints }).get('t.b')!.elements; // column-major
    const [sr, cr, sp, cp, sy, cy] = [Math.sin(0.3), Math.cos(0.3), Math.sin(0.5), Math.cos(0.5), Math.sin(0.7), Math.cos(0.7)];
    const R = [
      [cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr],
      [sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr],
      [-sp, cp * sr, cp * cr],
    ];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) expect(m[c * 4 + r]).toBeCloseTo(R[r]![c]!, 12);
    expect([m[12], m[13], m[14]]).toEqual([100, 200, 300].map((x) => expect.closeTo(x, 9)));
  });
});
