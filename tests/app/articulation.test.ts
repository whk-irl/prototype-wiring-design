/**
 * Mesh poses (`MeshRef.pose`) in the app: a mesh regrouped onto another link
 * must give the same answers for picking, zone lookup and collision checks
 * as in its original place; and a regrouped design reopens intact.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Group, Matrix4, Mesh, Raycaster, Vector3 } from 'three';
import { computeLinkPoses, moveMeshes, splitLink, validateDesign, type Design, type Pose } from '@core';
import { demoArm } from '../../src/app/demo/builtin';
import { openProject } from '../../src/app/io/load';
import { componentWarnings, zoneUnderPose } from '../../src/app/placement/checks';
import { meshPlacements, resolveHit } from '../../src/app/scene/placement';
import { registry } from '../../src/app/scene/registry';
import '../../src/app/scene/bvh';
import { idsInRect, invertWithin, rangeIds, toggleId } from '../../src/app/state/selection';
import { isDirty, useApp } from '../../src/app/state/store';
import { armDesignWithZones, designFile, fileOf, loadLibrary, stubImporter } from './helpers';

const library = loadLibrary();
const s = () => useApp.getState();

async function buildRegistry(): Promise<void> {
  registry.replace(demoArm().meshes);
  for (let i = 0; i < 100 && s().bvhPending > 0; i++) await new Promise((r) => setTimeout(r, 10));
}

/** Base plate with a zone on its top face (triangles 8, 9 of a BoxGeometry). */
function plateDesign(): Design {
  const d = armDesignWithZones();
  return {
    ...d,
    zones: [{ id: 'top', name: 'Top', kind: 'mount_allowed', link: 'base', mesh: 'demo.base.plate', triangles: [8, 2] }],
    components: [],
  };
}

/** The same model with the plate regrouped onto the turret link. */
function movedDesign(): Design {
  return moveMeshes(plateDesign(), ['demo.base.plate'], 'turret');
}

function poseIn(design: Design, linkId: string, world: Matrix4): Pose {
  const lw = computeLinkPoses(design.scene, {}).get(linkId)!;
  const m = new Matrix4().copy(lw).invert().multiply(world);
  const p = new Vector3().setFromMatrixPosition(m);
  return { p_mm: [p.x, p.y, p.z], q: [0, 0, 0, 1] };
}

beforeAll(async () => {
  useApp.setState({ library });
  await buildRegistry();
});

beforeEach(() => {
  useApp.setState({ library, notices: [] });
});

describe('mesh poses', () => {
  it('the regrouped plate has a non-identity pose on the turret', () => {
    const pl = meshPlacements(movedDesign()).get('demo.base.plate')!;
    expect(pl.link).toBe('turret');
    expect(pl.pose.equals(new Matrix4())).toBe(false);
  });

  function hitOn(design: Design) {
    const pl = meshPlacements(design).get('demo.base.plate')!;
    const lw = computeLinkPoses(design.scene, {}).get(pl.link)!;
    const group = new Group();
    group.matrixAutoUpdate = false;
    group.matrix.copy(lw);
    const mesh = new Mesh(registry.get('demo.base.plate')!.geometry);
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(pl.pose);
    group.add(mesh);
    group.updateMatrixWorld(true);
    const rc = new Raycaster(new Vector3(100, 70, 200), new Vector3(0, 0, -1));
    const hit = rc.intersectObject(mesh)[0]!;
    return { r: resolveHit(hit, mesh.matrixWorld, group.matrixWorld)!, lw };
  }

  it('picking gives the same world hit, triangle and local point; the link point follows the link', () => {
    const a = hitOn(plateDesign());
    const b = hitOn(movedDesign());
    expect(b.r.triangle).toBe(a.r.triangle);
    expect(b.r.world.point.distanceTo(a.r.world.point)).toBeLessThan(1e-9);
    expect(b.r.world.normal.distanceTo(a.r.world.normal)).toBeLessThan(1e-9);
    expect(b.r.local.point.distanceTo(a.r.local.point)).toBeLessThan(1e-9);
    expect(b.r.link.point.clone().applyMatrix4(b.lw).distanceTo(b.r.world.point)).toBeLessThan(1e-9);
    expect(b.r.link.point.distanceTo(a.r.link.point)).toBeGreaterThan(1);
  });

  it('zone-under-pose finds the zone on the moved mesh', () => {
    const world = new Matrix4().makeTranslation(100, 70, 12);
    const a = plateDesign();
    const b = movedDesign();
    expect(b.zones[0]!.link).toBe('turret');
    expect(zoneUnderPose(a, 'base', poseIn(a, 'base', world), {})).toBe('top');
    expect(zoneUnderPose(b, 'turret', poseIn(b, 'turret', world), {})).toBe('top');
  });

  it('the collision check sees the moved mesh in the same place', () => {
    const world = new Matrix4().makeTranslation(100, 70, 8); // sunk 4 mm into the 12 mm plate
    const comp = (d: Design, link: string) => ({
      ...d,
      components: [{ id: 'sensor-1', name: 'S', part: 'generic-breakout-25x18', link, pose: poseIn(d, link, world) }],
    });
    const a = componentWarnings(comp(plateDesign(), 'base'), library, {});
    const b = componentWarnings(comp(movedDesign(), 'turret'), library, {});
    expect(a['sensor-1']!.join(' ')).toMatch(/demo\.base\.plate|intersects/);
    expect(b['sensor-1']!.filter((w) => w.startsWith('Body'))).toEqual(a['sensor-1']!.filter((w) => w.startsWith('Body')).map((w) => w.replace('(Base)', '(Turret)')));
    // and resting on top of it is clean in both
    const top = new Matrix4().makeTranslation(100, 70, 12);
    const ca = componentWarnings({ ...plateDesign(), components: [{ id: 'c', name: 'C', part: 'generic-breakout-25x18', link: 'base', pose: poseIn(plateDesign(), 'base', top), zone: 'top' }] }, library, {});
    const cb = componentWarnings({ ...movedDesign(), components: [{ id: 'c', name: 'C', part: 'generic-breakout-25x18', link: 'turret', pose: poseIn(movedDesign(), 'turret', top), zone: 'top' }] }, library, {});
    expect(ca).toEqual({});
    expect(cb).toEqual({});
  });
});

describe('reopen of a regrouped design', () => {
  it('matches meshes by id on their new links, keeps zones and stays clean', async () => {
    const base = armDesignWithZones();
    const split = splitLink(base, {
      parent: 'base',
      link: { id: 'housing-link', name: 'Housing' },
      joint: { id: 'housing-joint', name: 'Housing joint', type: 'revolute', axis_point_mm: [0, 0, 32], axis_dir: [0, 0, 1], limit: { lower: -1, upper: 1 } },
      meshes: ['demo.base.housing'],
    });
    expect(validateDesign(split, library).filter((i) => i.severity === 'error')).toEqual([]);
    await openProject(designFile(split), [fileOf('arm.glb')], stubImporter());
    const d = s().design;
    expect(d.zones.map((z) => [z.id, z.link])).toEqual([
      ['mount-1', 'base'],
      ['mount-2', 'housing-link'],
    ]);
    expect(isDirty(s())).toBe(false);
    expect(s().notices).toEqual([]);
    const pl = meshPlacements(d).get('demo.base.housing')!;
    expect(pl.link).toBe('housing-link');
    // At the zero pose the housing sits where it was imported.
    const world = computeLinkPoses(d.scene, { 'housing-joint': 0 }).get('housing-link')!.clone().multiply(pl.pose);
    const e = world.elements;
    const id = new Matrix4().elements;
    for (let k = 0; k < 16; k++) expect(e[k]!).toBeCloseTo(id[k]!, 9);
    expect(registry.get('demo.base.housing')).toBeDefined();
  });
});

describe('mesh selection logic', () => {
  const order = ['a', 'b', 'c', 'd', 'e'];
  it('toggles', () => {
    expect(toggleId(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggleId(['a', 'b'], 'a')).toEqual(['b']);
  });
  it('selects a range either way, and falls back without an anchor', () => {
    expect(rangeIds(order, 'b', 'd')).toEqual(['b', 'c', 'd']);
    expect(rangeIds(order, 'd', 'b')).toEqual(['b', 'c', 'd']);
    expect(rangeIds(order, null, 'c')).toEqual(['c']);
    expect(rangeIds(order, 'zz', 'c')).toEqual(['c']);
  });
  it('inverts within a link only', () => {
    expect(invertWithin(['a', 'b', 'c'], ['a', 'x'])).toEqual(['x', 'b', 'c']);
  });
  it('selects meshes whose projected box lies inside the rectangle', () => {
    const box = (id: string, x0: number, y0: number, x1: number, y1: number) => ({
      id,
      corners: [
        [x0, y0],
        [x1, y0],
        [x0, y1],
        [x1, y1],
      ] as Array<[number, number]>,
    });
    const boxes = [box('in', 10, 10, 20, 20), box('partly', 15, 15, 40, 40), box('out', 50, 50, 60, 60), { id: 'behind', corners: [[12, 12] as [number, number], null] }];
    expect(idsInRect({ x0: 30, y0: 30, x1: 5, y1: 5 }, boxes)).toEqual(['in']);
  });
});
