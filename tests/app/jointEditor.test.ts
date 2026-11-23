/**
 * Joint editor logic (no browser): trial preview reset when picking starts,
 * which placed parts go along with a split, flipping an axis without moving
 * anything, and fixed -> movable requiring an axis.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { BoxGeometry, CylinderGeometry, Matrix4 } from 'three';
import { computeLinkPoses, emptyDesign, splitLink, updateJoint, type Design } from '@core';
import { applyEditAxis, componentsOnMeshes, flipJointAxis, startMakeMovable, startPicking } from '../../src/app/joints/editor';
import { registry } from '../../src/app/scene/registry';
import '../../src/app/scene/bvh';
import { useApp } from '../../src/app/state/store';
import { armDesign, loadLibrary } from './helpers';

const library = loadLibrary();
const s = () => useApp.getState();

async function waitForBvh(): Promise<void> {
  for (let i = 0; i < 100 && s().bvhPending > 0; i++) await new Promise((r) => setTimeout(r, 10));
}

beforeEach(() => {
  useApp.setState({ library, notices: [], jointDraft: null, activeTool: 'select', confirm: null });
});

describe('trial preview and picking', () => {
  it('starting a pick resets the trial value to zero', () => {
    s().replaceDesign(armDesign());
    s().setJointDraft({
      mode: 'new',
      parent: 'base',
      meshes: ['demo.base.housing'],
      components: [],
      takeJoints: [],
      name: 'J',
      type: 'revolute',
      lower: -90,
      upper: 90,
      axis: { point: [0, 0, 0], dir: [0, 0, 1] },
      preview: 35,
      picking: false,
    });
    startPicking();
    expect(s().jointDraft!.preview).toBe(0);
    expect(s().activeTool).toBe('axis');
  });
});

describe('parts that go along with a split', () => {
  /** One link with a big plate (B) and a small pin (A) whose top is level with the plate, under the part centre. */
  function plateAndPin(): Design {
    const d = emptyDesign('P');
    return {
      ...d,
      scene: {
        sources: [{ id: 'src', kind: 'builtin', uri: 'builtin:demo-arm', mm_per_unit: 1 }],
        links: [
          {
            id: 'L',
            name: 'L',
            meshes: [
              { id: 'B', source: 'src', node: 'B', tri_count: 12 },
              { id: 'A', source: 'src', node: 'A', tri_count: 0 },
            ],
          },
        ],
        joints: [],
      },
      components: [{ id: 'sensor-1', name: 'S', part: 'generic-breakout-25x18', link: 'L', pose: { p_mm: [0, 0, 10], q: [0, 0, 0, 1] } }],
    };
  }

  it('follows where most of the footprint sits, not just the centre', async () => {
    const plate = new BoxGeometry(100, 60, 10).translate(0, 0, 5); // top at z = 10
    const pin = new CylinderGeometry(2, 2, 10.2, 16).rotateX(Math.PI / 2).translate(0, 0, 5.1); // top at z = 10.2, just above the plate
    for (const g of [plate, pin]) {
      g.deleteAttribute('uv');
      g.clearGroups();
    }
    registry.replace([
      { id: 'B', link: 'L', geometry: plate, color: [0.5, 0.5, 0.5] },
      { id: 'A', link: 'L', geometry: pin, color: [0.5, 0.5, 0.5] },
    ]);
    await waitForBvh();
    const d = plateAndPin();
    // The centre lands on the pin (A) ...
    // ... but 8 of 9 footprint samples land on the plate (B).
    expect(componentsOnMeshes(d, library, {}, 'L', ['B'])).toEqual(['sensor-1']);
    expect(componentsOnMeshes(d, library, {}, 'L', ['A'])).toEqual([]);
  });
});

describe('flip and type changes', () => {
  function withJoint(): Design {
    return splitLink(armDesign(), {
      parent: 'base',
      link: { id: 'L2', name: 'L2' },
      joint: { id: 'J2', name: 'J2', type: 'revolute', axis_point_mm: [0, 0, 32], axis_dir: [0, 0, 1], limit: { lower: -1, upper: 2 } },
      meshes: ['demo.base.housing'],
    });
  }

  it('flipping an axis at a non-zero preview moves nothing', () => {
    s().replaceDesign(withJoint());
    s().setJointValue('J2', 0.7);
    const before = computeLinkPoses(s().design.scene, s().jointValues).get('L2')!.clone();
    flipJointAxis('J2');
    const j = s().design.scene.joints.find((x) => x.id === 'J2')!;
    expect(j.limit).toEqual({ lower: -2, upper: 1 });
    expect(s().jointValues.J2).toBeCloseTo(-0.7, 12);
    const after = computeLinkPoses(s().design.scene, s().jointValues).get('L2')!;
    const a = after.elements;
    const b = before.elements;
    for (let k = 0; k < 16; k++) expect(a[k]!).toBeCloseTo(b[k]!, 9);
    // and undo restores both
    s().undo();
    expect(s().design.scene.joints.find((x) => x.id === 'J2')!.limit).toEqual({ lower: -1, upper: 2 });
  });

  it('making a fixed joint movable requires an axis, sent in one updateJoint', async () => {
    const fixed = splitLink(armDesign(), {
      parent: 'base',
      link: { id: 'L3', name: 'L3' },
      joint: { id: 'J3', name: 'J3', type: 'fixed', axis_point_mm: [0, 0, 0], axis_dir: [0, 0, 1] },
      meshes: ['demo.base.housing'],
    });
    // The core refuses without an axis.
    expect(() => updateJoint(fixed, 'J3', { type: 'revolute', limit: { lower: -1, upper: 1 } })).toThrow(/axis/i);
    s().replaceDesign(fixed);
    startMakeMovable('J3', 'revolute');
    expect(s().jointDraft?.retype).toBe('revolute');
    expect(s().jointDraft?.axis).toBeNull();
    expect(s().activeTool).toBe('axis');
    // Apply without an axis does nothing.
    expect(await applyEditAxis()).toBe(false);
    expect(s().design.scene.joints.find((j) => j.id === 'J3')!.type).toBe('fixed');
    // A typed axis (world coordinates at the shown pose) makes it revolute in one step.
    s().setJointDraft((d) => ({ ...d, axis: { point: [0, 0, 32], dir: [0, 0, 1] } }));
    const past = s().past.length;
    expect(await applyEditAxis()).toBe(true);
    const j = s().design.scene.joints.find((x) => x.id === 'J3')!;
    expect(j.type).toBe('revolute');
    expect(j.limit!.lower).toBeCloseTo(-Math.PI / 2, 9);
    expect(s().past.length).toBe(past + 1);
    // Nothing moved at zero.
    const m = computeLinkPoses(s().design.scene, { J3: 0 }).get('L3')!;
    expect(new Matrix4().copy(m).elements[14]).toBeCloseTo(32, 9);
  });
});
