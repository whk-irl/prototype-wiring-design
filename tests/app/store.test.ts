import { beforeEach, describe, expect, it } from 'vitest';
import { validateDesign, type Design } from '@core';
import { addComponent, removeComponent, removeZones, updateComponent, updateZone, upsertZone } from '../../src/app/state/designOps';
import { nextId } from '../../src/app/state/integrity';
import { isDirty, useApp } from '../../src/app/state/store';
import { armDesign, armDesignWithZones, loadLibrary } from './helpers';

const library = loadLibrary();
const errors = (d: Design) => validateDesign(d, library).filter((i) => i.severity === 'error');
const s = () => useApp.getState();

beforeEach(() => {
  useApp.setState({ library, hiddenZones: {}, componentWarnings: {}, notices: [] });
  s().replaceDesign(armDesignWithZones());
});

describe('undo and redo', () => {
  it('round-trips zone and component edits with a valid design at every step', () => {
    const steps: Array<(d: Design) => Design> = [
      (d) => upsertZone(d, { id: 'keepout-1', name: 'K', kind: 'keep_out', link: 'turret', mesh: 'demo.turret.drum', triangles: [0, 10] }),
      (d) => addComponent(d, { id: 'controller-1', name: 'C', part: 'generic-controller-70x50', link: 'upper_arm', pose: { p_mm: [0, -20, 100], q: [0.7071068, 0, 0, 0.7071068] } }),
      (d) => updateZone(d, 'mount-1', { name: 'Renamed' }),
      (d) => updateComponent(d, 'sensor-1', { pose: { p_mm: [90, 60, 12], q: [0, 0, 0, 1] } }),
      (d) => updateZone(d, 'mount-1', { kind: 'keep_out' }),
      (d) => removeZones(d, new Set(['mount-2'])),
      (d) => removeComponent(d, 'controller-1'),
    ];
    const seen: Design[] = [s().design];
    for (const step of steps) {
      s().commit(step);
      seen.push(s().design);
      expect(errors(s().design)).toEqual([]);
    }
    for (let i = steps.length - 1; i >= 0; i--) {
      s().undo();
      expect(s().design).toBe(seen[i]);
      expect(errors(s().design)).toEqual([]);
    }
    for (let i = 1; i <= steps.length; i++) {
      s().redo();
      expect(s().design).toBe(seen[i]);
    }
  });
});

describe('view state keyed by id', () => {
  it('a deleted zone does not leave its hidden flag to a new zone that reuses the id', () => {
    s().toggleZoneHidden('mount-1');
    s().select({ kind: 'zone', id: 'mount-1' });
    s().commit((d) => removeZones(d, new Set(['mount-1'])));
    expect(s().hiddenZones['mount-1']).toBeUndefined();
    expect(s().selection).toBeNull();
    const id = nextId('mount', s().design.zones.map((z) => z.id));
    expect(id).toBe('mount-1');
    s().commit((d) => upsertZone(d, { id, name: 'New', kind: 'mount_allowed', link: 'base', mesh: 'demo.base.plate', triangles: [0, 1] }));
    expect(s().hiddenZones[id]).toBeUndefined();
  });

  it('clears view state when undo or redo removes the item', () => {
    s().commit((d) => upsertZone(d, { id: 'mount-3', name: 'N', kind: 'mount_allowed', link: 'base', mesh: 'demo.base.plate', triangles: [0, 1] }));
    s().toggleZoneHidden('mount-3');
    s().select({ kind: 'zone', id: 'mount-3' });
    s().undo();
    expect(s().hiddenZones['mount-3']).toBeUndefined();
    expect(s().selection).toBeNull();

    useApp.setState({ componentWarnings: { 'sensor-1': ['x'] } });
    s().select({ kind: 'component', id: 'sensor-1' });
    s().commit((d) => removeComponent(d, 'sensor-1'));
    expect(s().componentWarnings['sensor-1']).toBeUndefined();
    expect(s().selection).toBeNull();
  });
});

describe('previewed joint pose', () => {
  it('survives undo and redo of unrelated edits', () => {
    s().setJointValue('j2', 0.5);
    s().commit((d) => ({ ...d, meta: { ...d.meta, name: 'Renamed' } }));
    s().undo();
    expect(s().jointValues.j2).toBeCloseTo(0.5, 12);
    s().redo();
    expect(s().jointValues.j2).toBeCloseTo(0.5, 12);
  });

  it('follows the saved pose when the undone edit was a pose save', () => {
    const saved = s().design.scene.joints.find((j) => j.id === 'j2')!.value;
    s().setJointValue('j2', 0.5);
    s().savePose();
    s().setJointValue('j3', 0.25);
    s().undo();
    expect(s().jointValues.j2).toBeCloseTo(saved, 12);
    expect(s().jointValues.j3).toBeCloseTo(0.25, 12);
  });

  it('drops joints that no longer exist and starts new ones at their saved value', () => {
    s().commit((d) => ({ ...d, scene: { ...d.scene, joints: d.scene.joints.filter((j) => j.id !== 'j3') } }));
    s().setJointValue('j1', 0.3);
    s().undo();
    expect(s().jointValues.j1).toBeCloseTo(0.3, 12);
    expect(s().jointValues.j3).toBe(armDesign().scene.joints.find((j) => j.id === 'j3')!.value);
    s().redo();
    expect('j3' in s().jointValues).toBe(false);
  });
});

describe('stale component zones', () => {
  it('keeps the zone through a keep-out round trip (validation only warns)', () => {
    s().commit((d) => updateZone(d, 'mount-1', { kind: 'keep_out' }));
    expect(s().design.components[0]!.zone).toBe('mount-1');
    expect(errors(s().design)).toEqual([]);
    s().commit((d) => updateZone(d, 'mount-1', { kind: 'mount_allowed' }));
    expect(s().design.components[0]!.zone).toBe('mount-1');
  });

  it('clears the zone when the component moves to another link', () => {
    s().commit((d) => updateComponent(d, 'sensor-1', { link: 'turret' }));
    expect(s().design.components[0]!.zone).toBeUndefined();
    expect(errors(s().design)).toEqual([]);
  });

  it('keeps a valid zone reference', () => {
    s().commit((d) => updateComponent(d, 'sensor-1', { name: 'S' }));
    expect(s().design.components[0]!.zone).toBe('mount-1');
    expect(isDirty(s())).toBe(true);
  });
});

describe('zone under a moved component', () => {
  it('finds the mount zone under the part centre, and none once moved off it', async () => {
    const { registry } = await import('../../src/app/scene/registry');
    const { demoArm } = await import('../../src/app/demo/builtin');
    const { zoneUnderPose } = await import('../../src/app/placement/checks');
    registry.replace(demoArm().meshes);
    for (let i = 0; i < 50 && useApp.getState().bvhPending > 0; i++) await new Promise((r) => setTimeout(r, 10));
    const d = { ...s().design, zones: [{ id: 'top', name: 'Top', kind: 'mount_allowed' as const, link: 'base', mesh: 'demo.base.plate', triangles: [8, 2] }] };
    const on = { p_mm: [100, 70, 12] as [number, number, number], q: [0, 0, 0, 1] as [number, number, number, number] };
    expect(zoneUnderPose(d, 'base', on, {})).toBe('top');
    const off = { ...on, p_mm: [400, 70, 12] as [number, number, number] };
    expect(zoneUnderPose(d, 'base', off, {})).toBeUndefined();
    const keep = { ...d, zones: [...d.zones, { id: 'k', name: 'K', kind: 'keep_out' as const, link: 'base', mesh: 'demo.base.plate', triangles: [8, 2] }] };
    expect(zoneUnderPose(keep, 'base', on, {})).toBeUndefined();
  });
});
