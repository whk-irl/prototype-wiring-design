// Property tests for src/core/articulation.ts: random designs, random operation
// sequences, and expected values from plain arithmetic (see helpers.ts).
import fc from 'fast-check';
import { Matrix4, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  computeLinkPoses,
  DesignSchema,
  emptyDesign,
  flipJointAxis,
  meshPoseMatrix,
  moveMeshes,
  poseToMatrix,
  removeJoint,
  segmentCentreLine,
  setJointAxis,
  parseDesign,
  splitLink,
  updateJoint,
  validateDesign,
  type Design,
  type Joint,
  type JointPatch,
  type SplitLinkSpec,
} from '@core';
import { add, expectClose, rotateAbout, scale, unit, worldPoint, type V } from './helpers';

fc.configureGlobal({ seed: 20261121 });

// ------------------------------------------------------------ generators

const num = (lo: number, hi: number) => fc.double({ min: lo, max: hi, noNaN: true, noDefaultInfinity: true });
const vec3 = fc.tuple(num(-500, 500), num(-500, 500), num(-500, 500)) as fc.Arbitrary<V>;
const dir3 = fc
  .tuple(num(-1, 1), num(-1, 1), num(-1, 1))
  .filter((v) => Math.hypot(...v) > 0.1)
  .map((v) => scale(v, 5)) as fc.Arbitrary<V>; // deliberately not unit length
const quat = fc
  .tuple(num(-1, 1), num(-1, 1), num(-1, 1), num(-1, 1))
  .filter((v) => Math.hypot(...v) > 0.1)
  .map((v) => {
    const n = Math.hypot(...v);
    return [v[0] / n, v[1] / n, v[2] / n, v[3] / n] as [number, number, number, number];
  });
const pose = fc.record({ p_mm: vec3, q: quat });
const jointType = fc.constantFrom<Joint['type']>('fixed', 'revolute', 'continuous', 'prismatic');
const nat = fc.nat(1_000_000);

const startArb = fc.record({
  rootMeshes: fc.integer({ min: 2, max: 8 }),
  links: fc.array(
    fc.record({
      isRoot: fc.boolean(),
      parentPick: nat,
      meshCount: fc.integer({ min: 0, max: 3 }),
      type: jointType,
      p: vec3,
      q: quat,
      axis: dir3.map((v) => unit(v)),
      lo: num(-3, 0),
      span: num(0, 6),
      frac: num(0, 1),
    }),
    { minLength: 0, maxLength: 4 },
  ),
  meshPoses: fc.array(fc.option(pose, { nil: undefined }), { minLength: 40, maxLength: 40 }),
  zones: fc.array(nat, { maxLength: 4 }),
  components: fc.array(fc.record({ linkPick: nat, pose, zonePick: fc.option(nat, { nil: undefined }) }), { minLength: 2, maxLength: 4 }),
  segments: fc.array(
    fc.record({
      linkPick: nat,
      pts: fc.array(vec3, { minLength: 2, maxLength: 3 }),
      withNormals: fc.boolean(),
      norms: fc.array(fc.oneof(fc.constant<V>([0, 0, 0]), dir3.map((v) => unit(v))), { minLength: 3, maxLength: 3 }),
    }),
    { minLength: 1, maxLength: 3 },
  ),
});
type StartSpec = typeof startArb extends fc.Arbitrary<infer T> ? T : never;

function build(spec: StartSpec): Design {
  const d = DesignSchema.parse({ schema: 1 });
  d.scene.sources.push({ id: 's', kind: 'step', uri: 's.step', mm_per_unit: 1 });
  let meshN = 0;
  const addMeshes = (linkIdx: number, count: number) => {
    for (let k = 0; k < count; k++) {
      const p = spec.meshPoses[meshN % spec.meshPoses.length];
      d.scene.links[linkIdx]!.meshes.push({ id: `m${meshN}`, source: 's', node: `n${meshN}`, tri_count: 12, ...(p ? { pose: structuredClone(p) } : {}) });
      meshN++;
    }
  };
  d.scene.links.push({ id: 'l0', name: 'l0', meshes: [] });
  addMeshes(0, spec.rootMeshes);
  spec.links.forEach((s, k) => {
    const i = k + 1;
    d.scene.links.push({ id: `l${i}`, name: `l${i}`, meshes: [] });
    if (s.isRoot) {
      addMeshes(i, Math.max(1, s.meshCount));
      return;
    }
    addMeshes(i, s.meshCount);
    const limited = s.type === 'revolute' || s.type === 'prismatic';
    const lower = s.lo;
    const upper = s.lo + s.span;
    d.scene.joints.push({
      id: `j${i}`,
      name: `j${i}`,
      type: s.type,
      parent: `l${s.parentPick % i}`,
      child: `l${i}`,
      origin: { p_mm: s.p, q: s.q },
      axis: s.axis,
      ...(limited ? { limit: { lower, upper } } : {}),
      value: limited ? lower + s.frac * s.span : 0,
    });
  });
  const allMeshes = d.scene.links.flatMap((l) => l.meshes.map((m) => ({ m, link: l.id })));
  spec.zones.forEach((pick, i) => {
    const t = allMeshes[pick % allMeshes.length]!;
    d.zones.push({ id: `z${i}`, name: `z${i}`, kind: i % 2 ? 'keep_out' : 'mount_allowed', link: t.link, mesh: t.m.id, triangles: [0, 3, 6, 2] });
  });
  spec.components.forEach((c, i) => {
    const link = d.scene.links[c.linkPick % d.scene.links.length]!.id;
    const zones = d.zones.filter((z) => z.link === link);
    const zone = c.zonePick !== undefined && zones.length > 0 ? zones[c.zonePick % zones.length]!.id : undefined;
    d.components.push({ id: `c${i}`, name: `c${i}`, part: 'p', link, pose: structuredClone(c.pose), ...(zone ? { zone } : {}) });
  });
  d.connections.push({ id: 'cn0', from: { component: 'c0', port: 'p' }, to: { component: 'c1', port: 'p' }, interface: 'i2c' });
  d.cables.push({ id: 'cb0', connections: ['cn0'], type: 'x', count: 1, twisted: false, sleeve_wall_mm: 0, reasons: [] });
  d.routes.push({
    id: 'rt0',
    cable: 'cb0',
    segments: spec.segments.map((s) => ({ link: d.scene.links[s.linkPick % d.scene.links.length]!.id, points_mm: s.pts.map((p) => [...p] as V), ...(s.withNormals ? { normals: s.pts.map((_, i) => [...s.norms[i]!] as V) } : {}) })),
    crossings: [],
  });
  return d;
}

const opArb = fc.record({
  kind: fc.integer({ min: 0, max: 5 }),
  withAxis: fc.boolean(),
  a: nat,
  b: nat,
  c: nat,
  mask: fc.nat(1023),
  mask2: fc.nat(1023),
  type: jointType,
  p: vec3,
  dir: dir3,
  lo: num(-3, 0),
  span: num(0, 6),
  limitChoice: fc.integer({ min: 0, max: 2 }),
  newType: fc.option(jointType, { nil: undefined }),
});
type OpSpec = typeof opArb extends fc.Arbitrary<infer T> ? T : never;

const bit = (mask: number, i: number) => ((mask >> (i % 10)) & 1) === 1;

/** Pick valid arguments from the CURRENT design and apply one operation; null when there are none. */
function applyOp(d: Design, op: OpSpec, n: number, zonedExplicit: boolean): Design | null {
  const links = d.scene.links;
  const joints = d.scene.joints;
  const limitFor = (type: Joint['type']) => {
    const k = type === 'prismatic' ? 50 : 1;
    return type === 'revolute' || type === 'prismatic' ? { lower: op.lo * k, upper: (op.lo + op.span) * k } : undefined;
  };
  switch (op.kind) {
    case 0: {
      const withMeshes = links.filter((l) => l.meshes.length > 0);
      if (withMeshes.length === 0) return null;
      const parent = withMeshes[op.a % withMeshes.length]!;
      const isRoot = joints.every((j) => j.child !== parent.id);
      let meshes = parent.meshes.filter((_, i) => bit(op.mask, i)).map((m) => m.id);
      const takenJoints = joints.filter((j, i) => j.parent === parent.id && bit(op.mask2, i)).map((j) => j.id);
      if (isRoot && meshes.length === parent.meshes.length && joints.every((j) => j.parent !== parent.id || takenJoints.includes(j.id))) meshes = meshes.slice(1);
      if (meshes.length === 0) return null;
      const comps = d.components.filter((c, i) => c.link === parent.id && bit(op.mask2 >> 3, i) && (zonedExplicit || c.zone === undefined)).map((c) => c.id);
      const spec: SplitLinkSpec = {
        parent: parent.id,
        link: { id: `nl${n}`, name: `nl${n}` },
        joint: { id: `nj${n}`, name: `nj${n}`, type: op.type, axis_point_mm: op.p, axis_dir: op.dir, limit: limitFor(op.type) },
        meshes,
        joints: takenJoints,
        components: comps,
      };
      return splitLink(d, spec);
    }
    case 1: {
      const target = links[op.a % links.length]!;
      const others = links.filter((l) => l.id !== target.id).flatMap((l) => l.meshes.map((m) => ({ id: m.id, link: l.id })));
      const picked = others.filter((_, i) => bit(op.mask, i));
      if (picked.length === 0) return null;
      const fromLinks = new Set(picked.map((m) => m.link));
      const comps = d.components.filter((c, i) => fromLinks.has(c.link) && bit(op.mask2, i) && (zonedExplicit || c.zone === undefined)).map((c) => c.id);
      return moveMeshes(d, picked.map((m) => m.id), target.id, { components: comps });
    }
    case 2: {
      const movable = joints.filter((j) => j.type !== 'fixed');
      if (movable.length === 0) return null;
      return setJointAxis(d, movable[op.a % movable.length]!.id, op.p, op.dir);
    }
    case 3: {
      if (joints.length === 0) return null;
      return removeJoint(d, joints[op.a % joints.length]!.id);
    }
    case 5: {
      const movable = joints.filter((j) => j.type !== 'fixed');
      if (movable.length === 0) return null;
      return flipJointAxis(d, movable[op.a % movable.length]!.id);
    }
    default: {
      if (joints.length === 0) return null;
      const j = joints[op.a % joints.length]!;
      const type = op.newType ?? j.type;
      const patch: JointPatch = { name: `renamed${n}` };
      if (op.newType !== undefined) patch.type = op.newType;
      const needsLimit = type === 'revolute' || type === 'prismatic';
      if (op.limitChoice === 2 || (needsLimit && !(op.limitChoice === 0 && j.limit))) patch.limit = limitFor(needsLimit ? type : 'revolute')!;
      else if (op.limitChoice === 1 && !needsLimit) patch.limit = null;
      // A fixed joint has no axis: making it movable needs one.
      if (type !== 'fixed' && (j.type === 'fixed' || op.withAxis)) patch.axis = { point_mm: op.p, dir: op.dir };
      return updateJoint(d, j.id, patch);
    }
  }
}

// ------------------------------------------------------------ world helpers

const TEST_POINT: V = [37.5, -12.25, 410];

function zeroPoses(d: Design): Map<string, Matrix4> {
  const zeros: Record<string, number> = {};
  for (const j of d.scene.joints) zeros[j.id] = 0;
  return computeLinkPoses(d.scene, zeros);
}

const LIFT = 3.7;

interface World {
  /** World direction at the zero pose of each route normal, in order (zero stays zero). */
  normals: V[];
  /** World position at the zero pose of each lifted route point, in order. */
  lifted: V[];
  meshes: Map<string, V>;
  components: Map<string, number[]>;
  routes: V[];
}

function worldOf(d: Design): World {
  const poses = zeroPoses(d);
  const meshes = new Map<string, V>();
  for (const link of d.scene.links) {
    for (const mesh of link.meshes) {
      const p = new Vector3(...TEST_POINT).applyMatrix4(meshPoseMatrix(mesh)).applyMatrix4(poses.get(link.id)!);
      meshes.set(mesh.id, [p.x, p.y, p.z]);
    }
  }
  const components = new Map<string, number[]>();
  for (const c of d.components) components.set(c.id, new Matrix4().multiplyMatrices(poses.get(c.link)!, poseToMatrix(c.pose)).elements.slice());
  const routes: V[] = [];
  const normals: V[] = [];
  const lifted: V[] = [];
  for (const r of d.routes) {
    for (const s of r.segments) {
      s.normals?.forEach((n) => {
        const v = new Vector3(...n).transformDirection(poses.get(s.link)!);
        normals.push(n[0] === 0 && n[1] === 0 && n[2] === 0 ? [0, 0, 0] : [v.x, v.y, v.z]);
      });
      for (const lp of segmentCentreLine(s, LIFT)) {
        const p = new Vector3(...lp).applyMatrix4(poses.get(s.link)!);
        lifted.push([p.x, p.y, p.z]);
      }
      for (const pt of s.points_mm) {
        const p = new Vector3(...pt).applyMatrix4(poses.get(s.link)!);
        routes.push([p.x, p.y, p.z]);
      }
    }
  }
  return { meshes, components, routes, normals, lifted };
}

const errorsOf = (d: Design) => validateDesign(d).filter((i) => i.severity === 'error');
const sortedIds = (xs: Array<{ id: string }>) => xs.map((x) => x.id).sort();
const meshIds = (d: Design) => d.scene.links.flatMap((l) => l.meshes).map((m) => m.id).sort();

function checkInvariants(start: Design, base: World, cur: Design) {
  expect(errorsOf(cur)).toEqual([]);

  const now = worldOf(cur);
  expect(now.meshes.size).toBe(base.meshes.size);
  for (const [id, p] of base.meshes) expectClose(now.meshes.get(id)!, p, 1e-6);
  for (const [id, m] of base.components) {
    const got = now.components.get(id)!;
    m.forEach((v, i) => expect(Math.abs(got[i]! - v), `component ${id} element ${i}`).toBeLessThan(1e-6));
  }
  expect(now.routes.length).toBe(base.routes.length);
  base.routes.forEach((p, i) => expectClose(now.routes[i]!, p, 1e-6));

  expect(now.normals.length).toBe(base.normals.length);
  base.normals.forEach((n, i) => expectClose(now.normals[i]!, n, 1e-9));
  expect(now.lifted.length).toBe(base.lifted.length);
  base.lifted.forEach((p, i) => expectClose(now.lifted[i]!, p, 1e-6));
  cur.routes.forEach((r, ri) =>
    r.segments.forEach((seg, si) =>
      seg.normals?.forEach((n, i) => {
        const was = start.routes[ri]!.segments[si]!.normals![i]!;
        const isZero = was[0] === 0 && was[1] === 0 && was[2] === 0;
        if (isZero) expect(n, 'zero normal stays zero').toEqual([0, 0, 0]);
        else expect(Math.abs(Math.hypot(...n) - 1), 'normal is unit length').toBeLessThan(1e-9);
      }),
    ),
  );

  expect(meshIds(cur)).toEqual(meshIds(start));
  expect(sortedIds(cur.zones)).toEqual(sortedIds(start.zones));
  expect(sortedIds(cur.components)).toEqual(sortedIds(start.components));
  expect(sortedIds(cur.connections)).toEqual(sortedIds(start.connections));

  const linkOfMesh = new Map<string, string>();
  for (const l of cur.scene.links) for (const m of l.meshes) linkOfMesh.set(m.id, l.id);
  for (const z of cur.zones) expect(z.link, `zone ${z.id}`).toBe(linkOfMesh.get(z.mesh));

  for (const l of cur.scene.links) if (l.user_defined) for (const m of l.meshes) expect(m.pose, `mesh ${m.id} on user-defined link ${l.id}`).toBeDefined();
  const unitErr = (q: readonly number[]) => Math.abs(Math.hypot(...q) - 1);
  for (const j of cur.scene.joints) expect(unitErr(j.origin.q), `joint ${j.id}`).toBeLessThan(1e-9);
  for (const c of cur.components) expect(unitErr(c.pose.q), `component ${c.id}`).toBeLessThan(1e-9);
  for (const l of cur.scene.links) for (const m of l.meshes) if (m.pose) expect(unitErr(m.pose.q), `mesh ${m.id}`).toBeLessThan(1e-9);
}

// ------------------------------------------------------------ tests

describe('generated starting designs', () => {
  it('are valid', () => {
    fc.assert(
      fc.property(startArb, (spec) => {
        const d = build(spec);
        expect(errorsOf(d)).toEqual([]);
        expect(d.scene.links[0]!.meshes.length).toBeGreaterThanOrEqual(2);
      }),
      { numRuns: 200 },
    );
  });
});

function sequenceProperty(zonedExplicit: boolean) {
  fc.assert(
    fc.property(startArb, fc.array(opArb, { minLength: 1, maxLength: 8 }), (spec, ops) => {
      const start = build(spec);
      expect(errorsOf(start)).toEqual([]);
      const base = worldOf(start);
      let cur = start;
      ops.forEach((op, i) => {
        const before = JSON.stringify(cur);
        const next = applyOp(cur, op, i, zonedExplicit);
        expect(JSON.stringify(cur), 'input design was modified').toBe(before);
        if (!next) return;
        checkInvariants(start, base, next);
        cur = next;
      });
    }),
    { numRuns: 300 },
  );
}

describe('random operation sequences', () => {
  it('keep the zero pose, ids, zones and quaternions intact after every operation (explicit components never sit in a zone)', () => {
    sequenceProperty(false);
  });
  // A component taken along explicitly whose zone stays behind loses its zone.
  it('same, with explicitly moved components that are recorded in a zone', () => {
    sequenceProperty(true);
  });
});

describe('meaning of a joint', () => {
  const splitArb = fc.record({
    start: startArb,
    parentPick: nat,
    mask: fc.integer({ min: 1, max: 1023 }),
    prismatic: fc.boolean(),
    p: vec3,
    dir: dir3,
    lo: num(-3, 0),
    span: num(0, 6),
    frac: num(0, 1),
    p2: vec3,
    dir2: dir3,
  });
  type SplitCase = typeof splitArb extends fc.Arbitrary<infer T> ? T : never;

  function doSplit(c: SplitCase, fixed = false) {
    const orig = build(c.start);
    const withMeshes = orig.scene.links.filter((l) => l.meshes.length > 0);
    const parent = withMeshes[c.parentPick % withMeshes.length]!;
    const isRoot = orig.scene.joints.every((j) => j.child !== parent.id);
    let meshes = parent.meshes.filter((_, i) => bit(c.mask, i)).map((m) => m.id);
    if (meshes.length === 0) meshes = [parent.meshes[0]!.id];
    if (isRoot && meshes.length === parent.meshes.length && orig.scene.joints.every((j) => j.parent !== parent.id)) meshes = meshes.slice(1);
    if (meshes.length === 0) return null;
    const k = c.prismatic ? 50 : 1;
    const lower = c.lo * k;
    const upper = (c.lo + c.span) * k;
    const value = lower + c.frac * (upper - lower);
    const after = splitLink(orig, {
      parent: parent.id,
      link: { id: 'newlink', name: 'newlink' },
      joint: { id: 'newjoint', name: 'newjoint', type: fixed ? 'fixed' : c.prismatic ? 'prismatic' : 'revolute', axis_point_mm: c.p, axis_dir: c.dir, ...(fixed ? {} : { limit: { lower, upper } }) },
      meshes,
    });
    const parentZero = zeroPoses(orig).get(parent.id)!;
    return { orig, after, parent: parent.id, meshes: new Set(meshes), parentZero, value };
  }

  /** Axis line in world coordinates, from point and direction given in the parent frame. */
  const worldAxis = (m: Matrix4, p: V, d: V) => {
    const c = new Vector3(...p).applyMatrix4(m);
    const e = new Vector3(...add(p, d)).applyMatrix4(m);
    return { c: [c.x, c.y, c.z] as V, d: [e.x - c.x, e.y - c.y, e.z - c.z] as V };
  };

  /** Everything on the new link moves per `moved`; everything else stays where the original design had it. */
  function expectMotion(c: NonNullable<ReturnType<typeof doSplit>>, design: Design, joint: string, moved: (p0: V) => V) {
    for (const link of design.scene.links) {
      for (const mesh of link.meshes) {
        const p0 = worldPoint(c.orig, mesh.id, TEST_POINT);
        const got = worldPoint(design, mesh.id, TEST_POINT, { [joint]: c.value });
        expectClose(got, c.meshes.has(mesh.id) ? moved(p0) : p0, 1e-6);
      }
    }
  }

  const motion = (c: NonNullable<ReturnType<typeof doSplit>>, prismatic: boolean, p: V, d: V) => {
    const ax = worldAxis(c.parentZero, p, d);
    return (p0: V) => (prismatic ? add(p0, scale(unit(ax.d), c.value)) : rotateAbout(p0, ax.c, ax.d, c.value));
  };

  it('splitLink: the new joint turns or slides exactly the moved meshes about the given axis line', () => {
    fc.assert(
      fc.property(splitArb, (c) => {
        const r = doSplit(c);
        if (!r) return;
        expect(errorsOf(r.after)).toEqual([]);
        expectMotion(r, r.after, 'newjoint', motion(r, c.prismatic, c.p, c.dir));
      }),
      { numRuns: 300 },
    );
  });

  it('setJointAxis: the same joint then moves about the NEW axis line', () => {
    fc.assert(
      fc.property(splitArb, (c) => {
        const r = doSplit(c);
        if (!r) return;
        const moved = setJointAxis(r.after, 'newjoint', c.p2, c.dir2);
        expect(errorsOf(moved)).toEqual([]);
        // At zero nothing moves
        for (const link of moved.scene.links) for (const mesh of link.meshes) expectClose(worldPoint(moved, mesh.id, TEST_POINT), worldPoint(r.orig, mesh.id, TEST_POINT), 1e-6);
        expectMotion(r, moved, 'newjoint', motion(r, c.prismatic, c.p2, c.dir2));
      }),
      { numRuns: 300 },
    );
  });

  const movableType = (c: SplitCase) => (c.prismatic ? 'prismatic' : 'revolute') as 'prismatic' | 'revolute';
  const limitOf = (c: SplitCase) => {
    const k = c.prismatic ? 50 : 1;
    return { lower: c.lo * k, upper: (c.lo + c.span) * k };
  };
  const zeroPoseUnchanged = (r: NonNullable<ReturnType<typeof doSplit>>, d: Design) => {
    for (const link of d.scene.links) {
      for (const mesh of link.meshes) expectClose(worldPoint(d, mesh.id, TEST_POINT), worldPoint(r.orig, mesh.id, TEST_POINT), 1e-6);
    }
  };

  it('updateJoint: fixed to movable with an axis keeps the zero pose, then turns about the given line', () => {
    fc.assert(
      fc.property(splitArb, (c) => {
        const r = doSplit(c, true);
        if (!r) return;
        expect(r.after.scene.joints.find((j) => j.id === 'newjoint')!.axis).toEqual([0, 0, 0]);
        const updated = updateJoint(r.after, 'newjoint', { type: movableType(c), limit: limitOf(c), axis: { point_mm: c.p2, dir: c.dir2 } });
        expect(errorsOf(updated)).toEqual([]);
        zeroPoseUnchanged(r, updated);
        expectMotion(r, updated, 'newjoint', motion(r, c.prismatic, c.p2, c.dir2));
      }),
      { numRuns: 200 },
    );
  });

  it('updateJoint: movable to fixed and back to movable keeps the zero pose and uses the new axis', () => {
    fc.assert(
      fc.property(splitArb, (c) => {
        const r = doSplit(c);
        if (!r) return;
        const fixed = updateJoint(r.after, 'newjoint', { type: 'fixed' });
        expect(fixed.scene.joints.find((j) => j.id === 'newjoint')!.value).toBe(0);
        const again = updateJoint(fixed, 'newjoint', { type: movableType(c), limit: limitOf(c), axis: { point_mm: c.p2, dir: c.dir2 } });
        expect(errorsOf(again)).toEqual([]);
        zeroPoseUnchanged(r, again);
        expectMotion(r, again, 'newjoint', motion(r, c.prismatic, c.p2, c.dir2));
      }),
      { numRuns: 200 },
    );
  });

  it('updateJoint with patch.axis on a movable joint behaves exactly like setJointAxis', () => {
    fc.assert(
      fc.property(splitArb, (c) => {
        const r = doSplit(c);
        if (!r) return;
        // updateJoint also clamps the saved value into the joint's limit; setJointAxis does not. Compare where that is a no-op.
        const lim = r.after.scene.joints.find((j) => j.id === 'newjoint')!.limit!;
        if (lim.lower > 0 || lim.upper < 0) return;
        const viaPatch = updateJoint(r.after, 'newjoint', { axis: { point_mm: c.p2, dir: c.dir2 } });
        const viaSet = setJointAxis(r.after, 'newjoint', c.p2, c.dir2);
        expect(viaPatch).toEqual(viaSet);
      }),
      { numRuns: 200 },
    );
  });

  it('splitLink marks only the link it creates as user-defined, and removeJoint removes it', () => {
    fc.assert(
      fc.property(splitArb, (c) => {
        const r = doSplit(c);
        if (!r) return;
        expect(r.orig.scene.links.some((l) => l.user_defined)).toBe(false);
        expect(r.after.scene.links.filter((l) => l.user_defined).map((l) => l.id)).toEqual(['newlink']);
        const back = removeJoint(r.after, 'newjoint');
        expect(back.scene.links.some((l) => l.id === 'newlink' || l.user_defined)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});

describe('flipJointAxis', () => {
  const flipArb = fc.record({ start: startArb, pick: nat, v: num(-5, 5) });
  const movableOf = (d: Design, pick: number) => {
    const movable = d.scene.joints.filter((j) => j.type !== 'fixed');
    return movable.length === 0 ? null : movable[pick % movable.length]!;
  };
  const roundTrip = (d: Design) => JSON.parse(JSON.stringify(d)) as Design;

  it('moves nothing: same world points at the saved value, and at v before versus -v after', () => {
    fc.assert(
      fc.property(flipArb, ({ start, pick, v }) => {
        const d = build(start);
        const j = movableOf(d, pick);
        if (!j) return;
        const flipped = flipJointAxis(d, j.id);
        expect(errorsOf(flipped)).toEqual([]);
        const fj = flipped.scene.joints.find((x) => x.id === j.id)!;
        expect(fj.value).toBe(0 - j.value);
        for (const link of d.scene.links) {
          for (const mesh of link.meshes) {
            expectClose(worldPoint(flipped, mesh.id, TEST_POINT, { [j.id]: fj.value }), worldPoint(d, mesh.id, TEST_POINT, { [j.id]: j.value }), 1e-6);
            expectClose(worldPoint(flipped, mesh.id, TEST_POINT, { [j.id]: -v }), worldPoint(d, mesh.id, TEST_POINT, { [j.id]: v }), 1e-6);
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  it('flipping twice gives back the original design', () => {
    fc.assert(
      fc.property(flipArb, ({ start, pick }) => {
        const d = roundTrip(build(start)); // JSON form, so -0 and 0 are the same
        const j = movableOf(d, pick);
        if (!j) return;
        const twice = roundTrip(flipJointAxis(flipJointAxis(d, j.id), j.id));
        expect(twice).toEqual(d);
      }),
      { numRuns: 300 },
    );
  });

  it('mirrors the limits so that they contain the negated value whenever they contained the value', () => {
    fc.assert(
      fc.property(flipArb, ({ start, pick }) => {
        const d = build(start);
        const j = movableOf(d, pick);
        if (!j?.limit) return;
        expect(j.limit.lower <= j.value && j.value <= j.limit.upper).toBe(true);
        const fj = flipJointAxis(d, j.id).scene.joints.find((x) => x.id === j.id)!;
        expect(fj.limit).toEqual({ lower: 0 - j.limit.upper, upper: 0 - j.limit.lower });
        expect(fj.limit!.lower <= fj.value && fj.value <= fj.limit!.upper).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it('throws for a fixed joint and for an unknown joint', () => {
    const d = emptyDesign('f');
    d.scene.links.push({ id: 'a', name: 'a', meshes: [] }, { id: 'b', name: 'b', meshes: [] });
    d.scene.joints.push({ id: 'jf', name: 'jf', type: 'fixed', parent: 'a', child: 'b', origin: { p_mm: [0, 0, 0], q: [0, 0, 0, 1] }, axis: [0, 0, 0], value: 0 });
    expect(() => flipJointAxis(d, 'jf')).toThrow(/fixed/);
    expect(() => flipJointAxis(d, 'nope')).toThrow(/nope/);
  });
});

describe('user-defined links and pose', () => {
  const mk = (type: 'revolute' | 'fixed', extra: Partial<SplitLinkSpec> = {}): SplitLinkSpec => ({
    parent: 'body',
    link: { id: 'n1', name: 'n1' },
    joint: { id: 'nj', name: 'nj', type, axis_point_mm: [1, 2, 3], axis_dir: [0, 0, 1], ...(type === 'fixed' ? {} : { limit: { lower: -1, upper: 1 } }) },
    meshes: ['a'],
    ...extra,
  });
  const design = () => {
    const d = emptyDesign('u');
    d.scene.sources.push({ id: 's', kind: 'step', uri: 's.step', mm_per_unit: 1 });
    d.scene.links.push({ id: 'body', name: 'body', meshes: ['a', 'b'].map((id) => ({ id, source: 's', node: id, tri_count: 12 })) });
    return d;
  };
  const split = (d: Design) => splitLink(d, mk('revolute'));

  it('splitLink sets the flag on the new link only', () => {
    const d = split(design());
    expect(d.scene.links.find((l) => l.id === 'n1')!.user_defined).toBe(true);
    expect(d.scene.links.find((l) => l.id === 'body')!.user_defined).toBeUndefined();
  });

  it('removing the pose of a mesh on a user-defined link gives exactly one error at its path', () => {
    const d = split(design());
    expect(errorsOf(d)).toEqual([]);
    const i = d.scene.links.findIndex((l) => l.id === 'n1');
    delete d.scene.links[i]!.meshes[0]!.pose;
    const e = errorsOf(d);
    expect(e).toHaveLength(1);
    expect(e[0]!.path).toBe(`scene.links[${i}].meshes[0].pose`);
  });

  it('a mesh without a pose on an ordinary link is fine', () => {
    const d = split(design());
    expect(d.scene.links.find((l) => l.id === 'body')!.meshes.every((m) => m.pose === undefined)).toBe(true);
    expect(errorsOf(d)).toEqual([]);
  });

  it('the flag survives a JSON round trip through parseDesign', () => {
    const r = parseDesign(JSON.parse(JSON.stringify(split(design()))));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.design.scene.links.find((l) => l.id === 'n1')!.user_defined).toBe(true);
  });

  it('removeJoint of the split removes the user-defined link', () => {
    const d = removeJoint(split(design()), 'nj');
    expect(d.scene.links.map((l) => l.id)).toEqual(['body']);
    expect(d.scene.joints).toEqual([]);
  });

  it('a fixed joint is stored with a zero axis', () => {
    const d = splitLink(design(), mk('fixed'));
    expect(d.scene.joints[0]!.axis).toEqual([0, 0, 0]);
    expect(errorsOf(d)).toEqual([]);
  });

  it('moveMeshes may leave the base without meshes', () => {
    const r = moveMeshes(split(design()), ['b'], 'n1');
    expect(r.scene.links.find((l) => l.id === 'body')!.meshes).toEqual([]);
    expect(errorsOf(r)).toEqual([]);
  });

  it('a component taken along explicitly loses its zone when the zone stays behind', () => {
    const d = design();
    d.zones.push({ id: 'z', name: 'z', kind: 'mount_allowed', link: 'body', mesh: 'b', triangles: [0, 2] });
    d.components.push({ id: 'c', name: 'c', part: 'p', link: 'body', pose: { p_mm: [1, 2, 3], q: [0, 0, 0, 1] }, zone: 'z' });
    const r = splitLink(d, mk('revolute', { components: ['c'] }));
    const c = r.components[0]!;
    expect(c.link).toBe('n1');
    expect(c.zone).toBeUndefined();
    expect(errorsOf(r)).toEqual([]);
  });
});

describe('splitLink followed by removeJoint', () => {
  it('restores meshes, zones, components, joints and links', () => {
    fc.assert(
      fc.property(startArb, nat, fc.integer({ min: 1, max: 1023 }), fc.nat(1023), jointType, vec3, dir3, (spec, pick, mask, mask2, type, p, dir) => {
        const orig = build(spec);
        const withMeshes = orig.scene.links.filter((l) => l.meshes.length > 0);
        const parent = withMeshes[pick % withMeshes.length]!;
        const isRoot = orig.scene.joints.every((j) => j.child !== parent.id);
        let meshes = parent.meshes.filter((_, i) => bit(mask, i)).map((m) => m.id);
        if (meshes.length === 0) meshes = [parent.meshes[0]!.id];
        const joints = orig.scene.joints.filter((j, i) => j.parent === parent.id && bit(mask2, i)).map((j) => j.id);
        if (isRoot && meshes.length === parent.meshes.length && orig.scene.joints.every((j) => j.parent !== parent.id || joints.includes(j.id))) meshes = meshes.slice(1);
        if (meshes.length === 0) return;
        const components = orig.components.filter((c, i) => c.link === parent.id && bit(mask2 >> 2, i)).map((c) => c.id);
        const limit = type === 'revolute' || type === 'prismatic' ? { lower: -1, upper: 1 } : undefined;
        const split = splitLink(orig, {
          parent: parent.id,
          link: { id: 'newlink', name: 'newlink' },
          joint: { id: 'newjoint', name: 'newjoint', type, axis_point_mm: p, axis_dir: dir, limit },
          meshes,
          joints,
          components,
        });
        const back = removeJoint(split, 'newjoint');
        expect(errorsOf(back)).toEqual([]);

        expect(sortedIds(back.scene.links)).toEqual(sortedIds(orig.scene.links));
        expect(sortedIds(back.scene.joints)).toEqual(sortedIds(orig.scene.joints));
        const close = (a: Matrix4, b: Matrix4, what: string) =>
          a.elements.forEach((v, i) => expect(Math.abs(v - b.elements[i]!), `${what} element ${i}`).toBeLessThan(1e-9));
        for (const l of orig.scene.links) {
          const bl = back.scene.links.find((x) => x.id === l.id)!;
          expect(bl.meshes.map((m) => m.id).sort()).toEqual(l.meshes.map((m) => m.id).sort());
          for (const m of l.meshes) close(meshPoseMatrix(bl.meshes.find((x) => x.id === m.id)!), meshPoseMatrix(m), `mesh ${m.id}`);
        }
        for (const z of orig.zones) expect(back.zones.find((x) => x.id === z.id)!.link).toBe(z.link);
        for (const c of orig.components) {
          const bc = back.components.find((x) => x.id === c.id)!;
          expect(bc.link).toBe(c.link);
          close(poseToMatrix(bc.pose), poseToMatrix(c.pose), `component ${c.id}`);
        }
        for (const j of orig.scene.joints) {
          const bj = back.scene.joints.find((x) => x.id === j.id)!;
          expect(bj.parent).toBe(j.parent);
          close(poseToMatrix(bj.origin), poseToMatrix(j.origin), `joint ${j.id}`);
        }
        back.routes.forEach((r, i) =>
          r.segments.forEach((s, k) => {
            expect(s.link).toBe(orig.routes[i]!.segments[k]!.link);
            s.points_mm.forEach((pt, n) => expectClose(pt as V, orig.routes[i]!.segments[k]!.points_mm[n] as V, 1e-9));
          }),
        );
      }),
      { numRuns: 300 },
    );
  });
});

describe('errors', () => {
  function base(): Design {
    const d = emptyDesign('errors');
    d.scene.sources.push({ id: 's', kind: 'step', uri: 's.step', mm_per_unit: 1 });
    const mesh = (id: string) => ({ id, source: 's', node: id, tri_count: 12 });
    d.scene.links.push(
      { id: 'body', name: 'body', meshes: ['a', 'b', 'c'].map(mesh) },
      { id: 'arm', name: 'arm', meshes: ['d', 'e'].map(mesh) },
      { id: 'plate', name: 'plate', meshes: [mesh('f')] },
      { id: 'wrist', name: 'wrist', meshes: [mesh('g')] },
    );
    const origin = { p_mm: [0, 0, 0] as V, q: [0, 0, 0, 1] as [number, number, number, number] };
    d.scene.joints.push(
      { id: 'j1', name: 'j1', type: 'revolute', parent: 'body', child: 'arm', origin, axis: [0, 0, 1], limit: { lower: -3, upper: 3 }, value: 2 },
      { id: 'jf', name: 'jf', type: 'fixed', parent: 'body', child: 'plate', origin, axis: [0, 0, 1], value: 0 },
      { id: 'jc', name: 'jc', type: 'continuous', parent: 'arm', child: 'wrist', origin, axis: [0, 0, 1], value: 9 },
    );
    return d;
  }
  const split = (over: Partial<Omit<SplitLinkSpec, 'joint'>> & { joint?: Partial<SplitLinkSpec['joint']> } = {}): SplitLinkSpec => {
    const { joint, ...rest } = over;
    return {
      parent: 'body',
      link: { id: 'n1', name: 'n1' },
      meshes: ['a'],
      ...rest,
      joint: { id: 'nj', name: 'nj', type: 'revolute', axis_point_mm: [0, 0, 0], axis_dir: [0, 0, 1], limit: { lower: -1, upper: 1 }, ...joint },
    };
  };

  it('base design is valid', () => {
    expect(errorsOf(base())).toEqual([]);
  });

  const cases: Array<[string, (d: Design) => unknown, RegExp]> = [
    ['splitLink unknown parent', (d) => splitLink(d, split({ parent: 'nope' })), /nope/],
    ['splitLink unknown mesh', (d) => splitLink(d, split({ meshes: ['zz'] })), /zz/],
    ['splitLink mesh on another link', (d) => splitLink(d, split({ meshes: ['d'] })), /"d"/],
    ['splitLink unknown joint to take', (d) => splitLink(d, split({ joints: ['nojoint'] })), /nojoint/],
    ['splitLink re-parent joint not on parent', (d) => splitLink(d, split({ parent: 'arm', meshes: ['d'], joints: ['j1'] })), /j1/],
    ['splitLink link id in use by link', (d) => splitLink(d, split({ link: { id: 'arm', name: 'x' } })), /arm/],
    ['splitLink link id in use by joint', (d) => splitLink(d, split({ link: { id: 'j1', name: 'x' } })), /j1/],
    ['splitLink joint id in use by joint', (d) => splitLink(d, split({ joint: { id: 'j1' } })), /j1/],
    ['splitLink joint id in use by link', (d) => splitLink(d, split({ joint: { id: 'body' } })), /body/],
    ['splitLink link id equals joint id', (d) => splitLink(d, split({ link: { id: 'same', name: 'x' }, joint: { id: 'same' } })), /different ids/],
    ['splitLink empty mesh list', (d) => splitLink(d, split({ meshes: [] })), /at least one mesh/],
    ['splitLink zero axis', (d) => splitLink(d, split({ joint: { axis_dir: [0, 0, 0] } })), /axis/],
    ['splitLink NaN axis', (d) => splitLink(d, split({ joint: { axis_dir: [NaN, 0, 1] } })), /axis/],
    ['splitLink infinite axis', (d) => splitLink(d, split({ joint: { axis_dir: [Infinity, 0, 0] } })), /axis/],
    ['splitLink NaN axis point', (d) => splitLink(d, split({ joint: { axis_point_mm: [NaN, 0, 0] } })), /point/],
    ['splitLink infinite axis point', (d) => splitLink(d, split({ joint: { axis_point_mm: [0, -Infinity, 0] } })), /point/],
    ['splitLink revolute without limit', (d) => splitLink(d, split({ joint: { limit: undefined } })), /limit/],
    ['splitLink prismatic without limit', (d) => splitLink(d, split({ joint: { type: 'prismatic', limit: undefined } })), /limit/],
    ['splitLink lower above upper', (d) => splitLink(d, split({ joint: { limit: { lower: 2, upper: 1 } } })), /lower/],
    ['splitLink emptying the base', (d) => splitLink(d, split({ meshes: ['a', 'b', 'c'], joints: ['j1', 'jf'] })), /base/],
    ['moveMeshes unknown target link', (d) => moveMeshes(d, ['a'], 'nope'), /nope/],
    ['moveMeshes unknown mesh', (d) => moveMeshes(d, ['zz'], 'body'), /zz/],
    ['setJointAxis unknown joint', (d) => setJointAxis(d, 'nope', [0, 0, 0], [1, 0, 0]), /nope/],
    ['setJointAxis fixed joint', (d) => setJointAxis(d, 'jf', [0, 0, 0], [1, 0, 0]), /fixed/],
    ['setJointAxis zero direction', (d) => setJointAxis(d, 'j1', [0, 0, 0], [0, 0, 0]), /axis/],
    ['setJointAxis NaN direction', (d) => setJointAxis(d, 'j1', [0, 0, 0], [0, NaN, 1]), /axis/],
    ['setJointAxis NaN point', (d) => setJointAxis(d, 'j1', [0, NaN, 0], [1, 0, 0]), /point/],
    ['removeJoint unknown joint', (d) => removeJoint(d, 'nope'), /nope/],
    ['updateJoint unknown joint', (d) => updateJoint(d, 'nope', { name: 'x' }), /nope/],
    ['updateJoint continuous to revolute without limit', (d) => updateJoint(d, 'jc', { type: 'revolute' }), /limit/],
    ['updateJoint continuous to prismatic without limit', (d) => updateJoint(d, 'jc', { type: 'prismatic' }), /limit/],
    ['updateJoint removing the limit of a revolute joint', (d) => updateJoint(d, 'j1', { limit: null }), /limit/],
    ['updateJoint fixed to revolute without an axis', (d) => updateJoint(d, 'jf', { type: 'revolute', limit: { lower: -1, upper: 1 } }), /axis/],
    ['updateJoint fixed to continuous without an axis', (d) => updateJoint(d, 'jf', { type: 'continuous' }), /axis/],
    ['flipJointAxis fixed joint', (d) => flipJointAxis(d, 'jf'), /fixed/],
    ['updateJoint lower above upper', (d) => updateJoint(d, 'j1', { limit: { lower: 2, upper: 1 } }), /lower/],
  ];
  it.each(cases)('%s throws an Error that names the problem', (_name, run, message) => {
    const d = base();
    const frozen = JSON.stringify(d);
    let thrown: unknown;
    try {
      run(d);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(message);
    expect(JSON.stringify(d)).toBe(frozen);
  });

  it('allows emptying a link that is not the base', () => {
    const r = splitLink(base(), split({ parent: 'arm', meshes: ['d', 'e'], joints: ['jc'] }));
    expect(errorsOf(r)).toEqual([]);
    expect(r.scene.links.find((l) => l.id === 'arm')!.meshes).toEqual([]);
    expect(r.scene.joints.find((j) => j.id === 'jc')!.parent).toBe('n1');
  });

  it('allows emptying the base of meshes while a child joint stays on it', () => {
    const r = splitLink(base(), split({ meshes: ['a', 'b', 'c'], joints: ['j1'] }));
    expect(errorsOf(r)).toEqual([]);
  });

  describe('updateJoint value handling', () => {
    const value = (d: Design, id: string) => d.scene.joints.find((j) => j.id === id)!.value;
    it('clamps the saved value into a new limit', () => {
      expect(value(updateJoint(base(), 'j1', { limit: { lower: -1, upper: 1 } }), 'j1')).toBe(1);
      expect(value(updateJoint(base(), 'j1', { limit: { lower: 2.5, upper: 4 } }), 'j1')).toBe(2.5);
      expect(value(updateJoint(base(), 'j1', { limit: { lower: 0, upper: 5 } }), 'j1')).toBe(2);
    });
    it('zeroes the saved value when the joint becomes fixed', () => {
      const r = updateJoint(base(), 'j1', { type: 'fixed' });
      expect(value(r, 'j1')).toBe(0);
      expect(r.scene.joints.find((j) => j.id === 'j1')!.type).toBe('fixed');
    });
    it('does not clamp a continuous joint, and renames', () => {
      const r = updateJoint(base(), 'jc', { name: 'wrist turn' });
      expect(value(r, 'jc')).toBe(9);
      expect(r.scene.joints.find((j) => j.id === 'jc')!.name).toBe('wrist turn');
    });
    it('allows a revolute joint to become continuous without a limit', () => {
      const r = updateJoint(base(), 'j1', { type: 'continuous', limit: null });
      expect(r.scene.joints.find((j) => j.id === 'j1')!.limit).toBeUndefined();
      expect(errorsOf(r)).toEqual([]);
    });
  });
});

