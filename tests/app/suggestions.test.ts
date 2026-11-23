/**
 * The app side of suggested axes, in Node without a worker: draft axes held
 * in the parent link's frame (independent of preview joint values), the
 * feature cache tied to the loaded geometry, grading, scale-relative
 * tolerances, tree labels, and undo of an axis flip.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BufferGeometry, Float32BufferAttribute, Matrix4, Triangle, Vector3 } from 'three';
import { computeLinkPoses, emptyDesign, jointAxisInParent, meshPoseMatrix, splitLink, zeroLinkPoses, type Design } from '@core';
import { importModel } from '../../src/app/ingest';
import type { ImportedModel } from '../../src/app/ingest/types';
import {
  adoptSuggestion,
  axisFromHit,
  createJointFromDraft,
  draftAxisWorld,
  flipJointAxis,
  setDraftAxisFromWorld,
  setDraftAxisWorldComponent,
  startNewJoint,
  startTypedAxis,
} from '../../src/app/joints/editor';
import { extractFeatures, suggestAxes, suggestFromFeatures, toFrame, type MeshInput } from '../../src/app/joints/suggest';
import { computeSuggestions, featuresForMesh } from '../../src/app/joints/suggestions';
import { tolerancesFor } from '../../src/app/joints/suggest';
import { registry } from '../../src/app/scene/registry';
import '../../src/app/scene/bvh';
import { topologyOf } from '../../src/app/scene/topology';
import { useApp } from '../../src/app/state/store';
import { commonPrefix, meshLabels } from '../../src/app/ui/labels';
import type { RayHit } from '../../src/app/tools/types';
import { loadLibrary } from './helpers';

type V3 = [number, number, number];
const library = loadLibrary();
const s = () => useApp.getState();

async function waitForBvh(): Promise<void> {
  for (let i = 0; i < 200 && s().bvhPending > 0; i++) await new Promise((r) => setTimeout(r, 10));
}

/** Open tube about +Z (outer normals unless `inner`), scaled by `k`. */
function tube(r: number, z0: number, z1: number, inner: boolean, k = 1, seg = 32, rings = 4): BufferGeometry {
  const positions: number[] = [];
  const index: number[] = [];
  for (let i = 0; i <= rings; i++) {
    const z = z0 + ((z1 - z0) * i) / rings;
    for (let j = 0; j < seg; j++) {
      const a = (j / seg) * 2 * Math.PI;
      positions.push(k * r * Math.cos(a), k * r * Math.sin(a), k * z);
    }
  }
  for (let i = 0; i < rings; i++)
    for (let j = 0; j < seg; j++) {
      const a = i * seg + j;
      const b = i * seg + ((j + 1) % seg);
      if (inner) index.push(a, b + seg, b, a, a + seg, b + seg);
      else index.push(a, b, b + seg, a, b + seg, a + seg);
    }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(positions, 3));
  g.setIndex(index);
  g.computeBoundingBox();
  return g;
}

function input(id: string, g: BufferGeometry, m = new Matrix4()): MeshInput {
  const bb = g.boundingBox!;
  return { id, bounds: { min: bb.min.toArray() as V3, max: bb.max.toArray() as V3 }, toFrame: m };
}

describe('tree labels', () => {
  it('strips only a prefix of whole name components', () => {
    expect(commonPrefix(['x.link_2', 'x.link_3'])).toBe('x.');
    expect(commonPrefix(['Assembly 1/arm', 'Assembly 1/hand'])).toBe('Assembly 1/');
    expect(commonPrefix(['arm-cad.base', 'arm-cad.base_plate'])).toBe('arm-cad.');
    const d: Design = {
      ...emptyDesign(),
      scene: {
        sources: [],
        links: [{ id: 'L', name: 'L', meshes: ['x.link_2', 'x.link_3'].map((id) => ({ id, source: 's', node: 'Assembly 1/arm', tri_count: 1 })) }],
        joints: [],
      },
    };
    expect([...meshLabels(d).values()]).toEqual(['link_2', 'link_3']);
  });
});

describe('grading', () => {
  it('one small screw in a large plate is only a possible joint', () => {
    const screw = tube(1.5, 0, 10, false);
    const hole = tube(1.7, 2, 7, true);
    const fs = extractFeatures('screw', topologyOf(screw)).map((f) => toFrame(f, new Matrix4(), 'S'));
    const fr = extractFeatures('plate', topologyOf(hole)).map((f) => toFrame(f, new Matrix4(), 'R'));
    const res = suggestFromFeatures(fs, fr, { bodySize: new Map([['screw', 12], ['plate', 140]]) });
    expect(res.suggestions).toHaveLength(1);
    expect(res.suggestions[0]!.grade).toBe('possible');
  });
});

describe('tolerances scale with the bodies', () => {
  for (const k of [0.1, 10]) {
    it(`finds a pin in a bore at ${k}x scale`, () => {
      const pin = tube(2.5, -5, 15, false, k);
      const bore = tube(2.6, 0, 8, true, k);
      const geoms = new Map([
        ['pin', pin],
        ['bore', bore],
      ]);
      const res = suggestAxes([input('pin', pin)], [input('bore', bore)], (id) => topologyOf(geoms.get(id)!));
      const top = res.suggestions[0];
      expect(top, `nothing found at ${k}x`).toBeDefined();
      expect(Math.abs(top!.dir[2])).toBeGreaterThan(Math.cos((0.1 * Math.PI) / 180));
      expect(Math.hypot(top!.point[0], top!.point[1])).toBeLessThan(0.001 * k * 25);
      expect(top!.label).toMatch(/shaft .* in hole/);
    });
  }
});

describe('feature cache follows the loaded geometry', () => {
  it('a second load with different geometry under the same ids does not reuse features', async () => {
    const tol = tolerancesFor(100);
    registry.replace([{ id: 'm', link: 'L', geometry: tube(3, 0, 10, false), color: [1, 1, 1] }]);
    const a = await featuresForMesh('m', [{ min: [-100, -100, -100], max: [100, 100, 100] }], tol);
    const moved = tube(3, 0, 10, false);
    moved.translate(40, 0, 0);
    registry.replace([{ id: 'm', link: 'L', geometry: moved, color: [1, 1, 1] }]);
    const b = await featuresForMesh('m', [{ min: [-100, -100, -100], max: [100, 100, 100] }], tol);
    expect(a[0]!.point[0]).toBeCloseTo(0, 6);
    expect(b[0]!.point[0]).toBeCloseTo(40, 6);
  });
});

// ---------------------------------------------------------------- arm-cad: axes independent of the preview pose

const DIR = resolve(process.cwd(), 'public', 'fixtures', 'arm-cad');
interface TrueJoint {
  name: string;
  point_mm: V3;
  dir: V3;
  moving_bodies: string[];
  pick: Array<{ body: string; surface_point_mm: V3 }>;
}

describe('draft axes do not depend on preview joint values (arm-cad)', () => {
  let model: ImportedModel;
  let truth: TrueJoint[];
  let base: Design;

  beforeAll(async () => {
    const buf = readFileSync(resolve(DIR, 'arm-cad.step'));
    model = await importModel([{ path: 'arm-cad.step', data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer }]);
    truth = (JSON.parse(readFileSync(resolve(DIR, 'axes.json'), 'utf8')) as { joints: TrueJoint[] }).joints;
    registry.replace(model.meshes);
    await waitForBvh();
    const d0: Design = { ...emptyDesign('arm'), scene: { sources: model.sources, links: model.links, joints: model.joints } };
    // Base joint from the true axis.
    const t = truth[0]!;
    base = splitLink(d0, {
      parent: d0.scene.links[0]!.id,
      link: { id: 'L1', name: 'L1' },
      joint: { id: 'J1', name: 'J1', type: 'revolute', axis_point_mm: t.point_mm, axis_dir: t.dir, limit: { lower: -3, upper: 3 } },
      meshes: t.moving_bodies.map((b) => `arm-cad.${b}`),
    });
  }, 120_000);

  beforeEach(() => {
    useApp.setState({ library, notices: [], jointDraft: null, activeTool: 'select', confirm: null, axisSuggestions: null });
  });

  /** The newest joint's axis in world at the zero pose. */
  function newestAxisWorld(): { p: Vector3; d: Vector3 } {
    const d = s().design;
    const j = d.scene.joints[d.scene.joints.length - 1]!;
    const a = jointAxisInParent(j);
    const m = zeroLinkPoses(d.scene).get(j.parent)!;
    return { p: new Vector3(...a.point_mm).applyMatrix4(m), d: new Vector3(...a.dir).transformDirection(m) };
  }

  function expectTrue(k: number): void {
    const t = truth[k]!;
    const { p, d } = newestAxisWorld();
    const td = new Vector3(...t.dir).normalize();
    const angle = (Math.acos(Math.min(1, Math.abs(d.dot(td)))) * 180) / Math.PI;
    const w = p.clone().sub(new Vector3(...t.point_mm));
    const off = w.clone().sub(td.clone().multiplyScalar(w.dot(td))).length();
    expect(angle, `${t.name} direction`).toBeLessThan(0.1);
    expect(off, `${t.name} line`).toBeLessThan(0.1);
  }

  /** Current world matrix of a mesh (link at the previewed pose times its mesh pose). */
  function meshWorldNow(meshId: string): Matrix4 {
    const d = s().design;
    const link = d.scene.links.find((l) => l.meshes.some((m) => m.id === meshId))!;
    const ref = link.meshes.find((m) => m.id === meshId)!;
    return computeLinkPoses(d.scene, s().jointValues).get(link.id)!.clone().multiply(meshPoseMatrix(ref));
  }

  /** Open New joint for truth[k]'s moving bodies with `previews` set. */
  function openDraft(k: number, design: Design, previews: Record<string, number>): void {
    s().replaceDesign(design);
    for (const [id, v] of Object.entries(previews)) s().setJointValue(id, v);
    const ids = truth[k]!.moving_bodies.map((b) => `arm-cad.${b}`);
    s().selectMeshes(ids, ids[0]!);
    startNewJoint();
    expect(s().jointDraft).not.toBeNull();
  }

  async function viaSuggestion(): Promise<void> {
    const res = await computeSuggestions(s().design, s().jointDraft!);
    expect(res.items.length).toBeGreaterThan(0);
    expect(res.items[0]!.grade).toBe('likely');
    adoptSuggestion(res.items[0]!);
  }

  function viaPick(k: number): void {
    const pick = truth[k]!.pick[0]!;
    const meshId = `arm-cad.${pick.body}`;
    const mw = meshWorldNow(meshId);
    // The truth point is at the zero pose: move it with the mesh to where it is shown now.
    const zeroMw = (() => {
      const d = s().design;
      const link = d.scene.links.find((l) => l.meshes.some((m) => m.id === meshId))!;
      return zeroLinkPoses(d.scene).get(link.id)!.clone().multiply(meshPoseMatrix(link.meshes.find((m) => m.id === meshId)!));
    })();
    const local = new Vector3(...pick.surface_point_mm).applyMatrix4(zeroMw.clone().invert());
    const g = registry.get(meshId)!.geometry;
    const pos = g.getAttribute('position');
    const idx = g.getIndex()!;
    const tri = new Triangle();
    const q = new Vector3();
    let best = -1;
    let bd = Infinity;
    for (let t = 0; t < idx.count / 3; t++) {
      tri.setFromAttributeAndIndices(pos, idx.getX(3 * t), idx.getX(3 * t + 1), idx.getX(3 * t + 2));
      if (tri.getArea() === 0) continue;
      const d = tri.closestPointToPoint(local, q).distanceToSquared(local);
      if (d < bd) {
        bd = d;
        best = t;
      }
    }
    const hit = { meshId, linkId: '', triangle: best } as unknown as RayHit;
    const axis = axisFromHit(hit, mw)!;
    expect(axis.fit?.quality).toBe('good');
    setDraftAxisFromWorld(axis);
  }

  function viaTyping(k: number): void {
    const t = truth[k]!;
    const d = s().design;
    const parent = s().jointDraft!.parent;
    const zeroP = zeroLinkPoses(d.scene).get(parent)!;
    // Where the true axis is shown NOW (parent at its previewed pose).
    const nowP = computeLinkPoses(d.scene, s().jointValues).get(parent)!;
    const m = nowP.clone().multiply(zeroP.clone().invert());
    const p = new Vector3(...t.point_mm).applyMatrix4(m);
    const dir = new Vector3(...t.dir).transformDirection(m);
    startTypedAxis();
    const comps: Array<['point' | 'dir', 0 | 1 | 2, number]> = [
      ['point', 0, p.x],
      ['point', 1, p.y],
      ['point', 2, p.z],
      ['dir', 0, dir.x],
      ['dir', 1, dir.y],
      ['dir', 2, dir.z],
    ];
    for (const [w, c, v] of comps) setDraftAxisWorldComponent(w, c, v);
    const shown = draftAxisWorld(d, s().jointValues, s().jointDraft)!;
    expect(new Vector3(...shown.point).distanceTo(p)).toBeLessThan(1e-6);
  }

  for (const how of ['suggested', 'picked', 'typed'] as const) {
    it(`${how} axis: computed at a posed preview, created after the preview moves`, async () => {
      // Shoulder (first level: parent L1 sits at the origin at zero).
      openDraft(1, base, { J1: 0.7 });
      if (how === 'suggested') await viaSuggestion();
      else if (how === 'picked') viaPick(1);
      else viaTyping(1);
      s().setJointValue('J1', 0);
      expect(await createJointFromDraft()).toBe(true);
      expectTrue(1);
      // Elbow (second level: its parent's zero pose is not the identity).
      const withShoulder = s().design;
      const shoulderId = withShoulder.scene.joints[withShoulder.scene.joints.length - 1]!.id;
      const parentLink = withShoulder.scene.joints[withShoulder.scene.joints.length - 1]!.child;
      expect(zeroLinkPoses(withShoulder.scene).get(parentLink)!.equals(new Matrix4())).toBe(false);
      openDraft(2, withShoulder, { J1: 0.5, [shoulderId]: -0.4 });
      if (how === 'suggested') await viaSuggestion();
      else if (how === 'picked') viaPick(2);
      else viaTyping(2);
      s().setJointValue('J1', -0.3);
      s().setJointValue(shoulderId, 0.6);
      expect(await createJointFromDraft()).toBe(true);
      expectTrue(2);
    }, 120_000);
  }

  it('undo of an axis flip at a non-zero preview restores the preview sign', () => {
    s().replaceDesign(base);
    s().setJointValue('J1', 0.6);
    flipJointAxis('J1');
    expect(s().jointValues.J1).toBeCloseTo(-0.6, 12);
    s().undo();
    expect(s().jointValues.J1).toBeCloseTo(0.6, 12);
    s().redo();
    expect(s().jointValues.J1).toBeCloseTo(-0.6, 12);
  });
});
