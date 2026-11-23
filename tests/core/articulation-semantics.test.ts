// What the joint-editing operations mean, checked against rotation and
// translation formulas written out in plain arithmetic here, not taken from
// the code under test or from three.js.
import { describe, expect, it } from 'vitest';
import {
  emptyDesign,
  moveMeshes,
  removeJoint,
  setJointAxis,
  splitLink,
  validateDesign,
  type Design,
  type Vec3,
} from '@core';
import { add, expectClose, rotateAbout, scale, sub, unit, worldPoint, type V } from './helpers';

/** One rigid body with four meshes, as a CAD file imports. */
function cadDesign(): Design {
  const d = emptyDesign('cad');
  d.scene.sources.push({ id: 's', kind: 'step', uri: 's.step', mm_per_unit: 1 });
  d.scene.links.push({
    id: 'body',
    name: 'body',
    meshes: ['base', 'upper', 'fore', 'hand'].map((id) => ({ id, source: 's', node: id, tri_count: 12 })),
  });
  d.zones.push({ id: 'z-fore', name: 'z', kind: 'mount_allowed', link: 'body', mesh: 'fore', triangles: [0, 4] });
  d.components.push(
    { id: 'c-zone', name: 'in zone', part: 'p', link: 'body', pose: { p_mm: [120, 40, 310], q: [0, 0, 0, 1] }, zone: 'z-fore' },
    { id: 'c-free', name: 'no zone', part: 'p', link: 'body', pose: { p_mm: [5, 5, 5], q: [0, 0, 0, 1] } },
  );
  return d;
}

const X: V = [37.5, -12.25, 410]; // some vertex, in imported coordinates
const C1: V = [10, 20, 100];
const D1: V = [0, 3, 4]; // deliberately not unit, not axis-aligned
const C2: V = [60, -30, 300];
const D2: V = [1, 0, 0];

const shoulder = (d: Design) =>
  splitLink(d, {
    parent: 'body',
    link: { id: 'arm', name: 'arm' },
    joint: { id: 'shoulder', name: 'shoulder', type: 'revolute', axis_point_mm: C1, axis_dir: D1, limit: { lower: -3, upper: 3 } },
    meshes: ['upper', 'fore', 'hand'],
  });

/** Second split, distal: its axis is given in the frame of link `arm`, which is the world frame shifted by C1. */
const elbow = (d: Design) =>
  splitLink(d, {
    parent: 'arm',
    link: { id: 'forearm', name: 'forearm' },
    joint: { id: 'elbow', name: 'elbow', type: 'revolute', axis_point_mm: sub(C2, C1) as Vec3, axis_dir: D2, limit: { lower: -2, upper: 2 } },
    meshes: ['fore', 'hand'],
  });

describe('splitLink', () => {
  it('does not move anything at the zero pose and leaves the input untouched', () => {
    const before = cadDesign();
    const frozen = JSON.stringify(before);
    const after = elbow(shoulder(before));
    expect(JSON.stringify(before)).toBe(frozen);
    expect(validateDesign(after)).toEqual([]);
    for (const mesh of ['base', 'upper', 'fore', 'hand']) expectClose(worldPoint(after, mesh, X), X);
  });

  it('turns the split-off meshes about the given axis line, and only those', () => {
    const d = shoulder(cadDesign());
    const angle = 0.7;
    expectClose(worldPoint(d, 'base', X, { shoulder: angle }), X);
    for (const mesh of ['upper', 'fore', 'hand']) expectClose(worldPoint(d, mesh, X, { shoulder: angle }), rotateAbout(X, C1, D1, angle));
  });

  it('composes two joints: the distal axis is carried round by the proximal joint', () => {
    const d = elbow(shoulder(cadDesign()));
    const a1 = -0.9;
    const a2 = 1.3;
    const values = { shoulder: a1, elbow: a2 };
    expectClose(worldPoint(d, 'upper', X, values), rotateAbout(X, C1, D1, a1));
    // Distal first about its own axis as imported, then the whole arm about the shoulder.
    const expected = rotateAbout(rotateAbout(X, C2, D2, a2), C1, D1, a1);
    expectClose(worldPoint(d, 'fore', X, values), expected);
    expectClose(worldPoint(d, 'hand', X, values), expected);
  });

  it('slides a prismatic link along the axis direction by the value in mm', () => {
    const d = splitLink(cadDesign(), {
      parent: 'body',
      link: { id: 'slide', name: 'slide' },
      joint: { id: 'rail', name: 'rail', type: 'prismatic', axis_point_mm: C1, axis_dir: D1, limit: { lower: 0, upper: 80 } },
      meshes: ['hand'],
    });
    expectClose(worldPoint(d, 'hand', X, { rail: 25 }), add(X, scale(unit(D1), 25)));
    expectClose(worldPoint(d, 'fore', X, { rail: 25 }), X);
  });

  it('takes zones, and components recorded in them, along with their mesh', () => {
    const d = elbow(shoulder(cadDesign()));
    expect(d.zones[0]!.link).toBe('forearm');
    const inZone = d.components.find((c) => c.id === 'c-zone')!;
    const free = d.components.find((c) => c.id === 'c-free')!;
    expect(inZone.link).toBe('forearm');
    expect(free.link).toBe('body');
    // forearm frame at zero = world shifted by C2, so the component's world position is unchanged.
    expectClose(add(inZone.pose.p_mm as V, C2), [120, 40, 310]);
    expectClose(free.pose.p_mm as V, [5, 5, 5]);
  });

  it('re-parents an existing joint onto the new link when asked, keeping its axis line', () => {
    // Distal joint first, straight off the body; then split the upper arm and take that joint along.
    let d = splitLink(cadDesign(), {
      parent: 'body',
      link: { id: 'forearm', name: 'forearm' },
      joint: { id: 'elbow', name: 'elbow', type: 'revolute', axis_point_mm: C2, axis_dir: D2, limit: { lower: -2, upper: 2 } },
      meshes: ['fore', 'hand'],
    });
    d = splitLink(d, {
      parent: 'body',
      link: { id: 'arm', name: 'arm' },
      joint: { id: 'shoulder', name: 'shoulder', type: 'revolute', axis_point_mm: C1, axis_dir: D1, limit: { lower: -3, upper: 3 } },
      meshes: ['upper'],
      joints: ['elbow'],
    });
    expect(validateDesign(d)).toEqual([]);
    expect(d.scene.joints.find((j) => j.id === 'elbow')!.parent).toBe('arm');
    const values = { shoulder: 0.4, elbow: -1.1 };
    expectClose(worldPoint(d, 'fore', X, values), rotateAbout(rotateAbout(X, C2, D2, -1.1), C1, D1, 0.4));
  });

  it('refuses to leave the base with nothing on it', () => {
    expect(() =>
      splitLink(cadDesign(), {
        parent: 'body',
        link: { id: 'all', name: 'all' },
        joint: { id: 'j', name: 'j', type: 'revolute', axis_point_mm: C1, axis_dir: D1, limit: { lower: -1, upper: 1 } },
        meshes: ['base', 'upper', 'fore', 'hand'],
      }),
    ).toThrow(/base/i);
  });
});

describe('setJointAxis', () => {
  it('keeps the zero pose and turns the link about the new axis line afterwards', () => {
    const newPoint: V = [-40, 15, 220];
    const newDir: V = [1, 1, 0];
    const d = setJointAxis(elbow(shoulder(cadDesign())), 'shoulder', newPoint, newDir);
    expect(validateDesign(d)).toEqual([]);
    for (const mesh of ['base', 'upper', 'fore', 'hand']) expectClose(worldPoint(d, mesh, X), X);
    expectClose(worldPoint(d, 'upper', X, { shoulder: 0.6 }), rotateAbout(X, newPoint, newDir, 0.6));
    // The elbow, hanging off the moved link, still turns about its own original line.
    expectClose(worldPoint(d, 'fore', X, { elbow: 0.8 }), rotateAbout(X, C2, D2, 0.8));
    expectClose(worldPoint(d, 'fore', X, { shoulder: 0.6, elbow: 0.8 }), rotateAbout(rotateAbout(X, C2, D2, 0.8), newPoint, newDir, 0.6));
  });
});

describe('removeJoint', () => {
  it('merges the child into the parent where it sits at the zero pose', () => {
    const split = elbow(shoulder(cadDesign()));
    const d = removeJoint(split, 'shoulder');
    expect(validateDesign(d)).toEqual([]);
    expect(d.scene.links.map((l) => l.id).sort()).toEqual(['body', 'forearm']);
    expect(d.scene.joints.map((j) => `${j.parent}>${j.child}`)).toEqual(['body>forearm']);
    for (const mesh of ['base', 'upper', 'fore', 'hand']) expectClose(worldPoint(d, mesh, X), X);
    // The surviving elbow still turns about its original line.
    expectClose(worldPoint(d, 'fore', X, { elbow: -0.5 }), rotateAbout(X, C2, D2, -0.5));
    expectClose(worldPoint(d, 'upper', X, { elbow: -0.5 }), X);
  });

  it('undoes a split completely', () => {
    const d = removeJoint(removeJoint(elbow(shoulder(cadDesign())), 'elbow'), 'shoulder');
    expect(validateDesign(d)).toEqual([]);
    expect(d.scene.links.map((l) => l.id)).toEqual(['body']);
    expect(d.scene.links[0]!.meshes.map((m) => m.id).sort()).toEqual(['base', 'fore', 'hand', 'upper']);
    expect(d.zones[0]!.link).toBe('body');
    expectClose(d.components.find((c) => c.id === 'c-zone')!.pose.p_mm as V, [120, 40, 310]);
  });
});

describe('moveMeshes', () => {
  it('moves a mesh between existing links without moving it in the world', () => {
    const d = moveMeshes(elbow(shoulder(cadDesign())), ['hand'], 'arm');
    expect(validateDesign(d)).toEqual([]);
    expectClose(worldPoint(d, 'hand', X), X);
    // Now on the upper arm: follows the shoulder, ignores the elbow.
    expectClose(worldPoint(d, 'hand', X, { shoulder: 0.3, elbow: 1 }), rotateAbout(X, C1, D1, 0.3));
  });

  it('rejects an unknown mesh', () => {
    expect(() => moveMeshes(cadDesign(), ['nope'], 'body')).toThrow(/nope/);
  });
});

describe('updateJoint and the saved value', () => {
  // A split whose limit excludes 0 starts with its saved value outside the limit.
  const offLimit = () =>
    splitLink(cadDesign(), {
      parent: 'body',
      link: { id: 'arm', name: 'arm' },
      joint: { id: 'j', name: 'j', type: 'revolute', axis_point_mm: C1, axis_dir: D1, limit: { lower: 0.2, upper: 1.5 } },
      meshes: ['upper'],
    });

  it('leaves the saved value alone on a rename or an axis change', async () => {
    const { updateJoint } = await import('@core');
    expect(updateJoint(offLimit(), 'j', { name: 'renamed' }).scene.joints[0]!.value).toBe(0);
    expect(updateJoint(offLimit(), 'j', { axis: { point_mm: C2, dir: D2 } }).scene.joints[0]!.value).toBe(0);
  });

  it('clamps the saved value when the limit or the type changes', async () => {
    const { updateJoint } = await import('@core');
    expect(updateJoint(offLimit(), 'j', { limit: { lower: 0.5, upper: 1 } }).scene.joints[0]!.value).toBe(0.5);
    expect(updateJoint(offLimit(), 'j', { type: 'prismatic' }).scene.joints[0]!.value).toBe(0.2);
  });
});
