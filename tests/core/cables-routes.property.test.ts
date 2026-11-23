// Property tests for src/core/cables.ts and src/core/routes.ts. Expected values
// come from independent arithmetic written here: a numerical helix, a plain
// quaternion/Rodrigues forward kinematics, and trigonometry for fillets.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  bendsTighterThan,
  bundleDiameter,
  cableEnvelope,
  CableSchema,
  CableTypeSchema,
  cornerRadii,
  DesignSchema,
  jointsBetween,
  parseCableLibrary,
  parseDesign,
  polylineLength,
  routeCentreLineWorld,
  routeLength,
  segmentCentreLine,
  validateDesign,
  type CableBuild,
  type CableType,
  type Design,
  type Joint,
  type Route,
} from '@core';
import { fullDesign, readText, type V } from './helpers';

fc.configureGlobal({ seed: 20261121 });

const num = (lo: number, hi: number) => fc.double({ min: lo, max: hi, noNaN: true, noDefaultInfinity: true });
const vec3 = fc.tuple(num(-300, 300), num(-300, 300), num(-300, 300)) as fc.Arbitrary<V>;
const unitVec = fc
  .tuple(num(-1, 1), num(-1, 1), num(-1, 1))
  .filter((v) => Math.hypot(...v) > 0.1)
  .map((v) => {
    const n = Math.hypot(...v);
    return [v[0] / n, v[1] / n, v[2] / n] as V;
  });
const quat = fc
  .tuple(num(-1, 1), num(-1, 1), num(-1, 1), num(-1, 1))
  .filter((v) => Math.hypot(...v) > 0.1)
  .map((v) => {
    const n = Math.hypot(...v);
    return [v[0] / n, v[1] / n, v[2] / n, v[3] / n] as [number, number, number, number];
  });
const nat = fc.nat(1_000_000);
const close = (a: number, b: number, rel: number) => Math.abs(a - b) <= rel * (1 + Math.abs(a) + Math.abs(b));
const errorsOf = (d: Design) => validateDesign(d).filter((i) => i.severity === 'error');

// ---------------------------------------------------------------- bundleDiameter

describe('bundleDiameter', () => {
  it('for n = 1..19 lies between sqrt(n) and 2 sqrt(n) + 1 wire diameters', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 19 }), num(0.05, 20), (n, d) => {
        const v = bundleDiameter(d, n) / d;
        expect(v).toBeGreaterThanOrEqual(Math.sqrt(n) * (1 - 1e-12));
        expect(v).toBeLessThanOrEqual(2 * Math.sqrt(n) + 1);
      }),
    );
  });

  it('never shrinks when a wire is added, from 1 to 200, including across the table boundary', () => {
    let prev = 0;
    for (let n = 1; n <= 200; n++) {
      const v = bundleDiameter(1, n);
      expect(v, `n = ${n}: ${v} after ${prev}`).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    expect(bundleDiameter(1, 20)).toBeGreaterThanOrEqual(bundleDiameter(1, 19));
  });

  it('beyond the table still fits the wires by area', () => {
    for (let n = 20; n <= 200; n++) expect(bundleDiameter(1, n)).toBeGreaterThanOrEqual(Math.sqrt(n));
  });

  it('scales linearly with the wire diameter', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 200 }), num(0.05, 20), num(0.1, 10), (n, d, k) => {
        expect(close(bundleDiameter(k * d, n), k * bundleDiameter(d, n), 1e-12)).toBe(true);
      }),
    );
  });

  it.each([0, -1, 1.5, NaN, Infinity])('throws for count %s', (n) => {
    expect(() => bundleDiameter(1, n)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------- cableEnvelope

const roundType = (od: number, stat: number, dyn?: number): CableType =>
  CableTypeSchema.parse({
    id: 'w',
    name: 'w',
    family: 'hookup_wire',
    section: { shape: 'round', od_mm: od },
    conductors: 1,
    min_bend_mm: { static: stat, ...(dyn !== undefined ? { dynamic: dyn } : {}) },
    flex: 'flexible',
    confidence: 'generic',
  });
const flatType = (w: number, t: number, stat: number, dyn?: number): CableType =>
  CableTypeSchema.parse({
    id: 'f',
    name: 'f',
    family: 'ffc',
    section: { shape: 'flat', width_mm: w, thickness_mm: t },
    conductors: 5,
    min_bend_mm: { static: stat, ...(dyn !== undefined ? { dynamic: dyn } : {}) },
    flex: 'flexible',
    confidence: 'generic',
  });
const mkBuild = (count: number, twisted = false, lay?: number, sleeve = 0): CableBuild => ({
  count,
  twisted,
  sleeve_wall_mm: sleeve,
  ...(lay !== undefined ? { lay_length_mm: lay } : {}),
});

const roundArb = fc
  .record({ od: num(0.2, 8), stat: num(0.5, 40), extra: fc.option(num(0, 40), { nil: undefined }) })
  .map((r) => roundType(r.od, r.stat, r.extra === undefined ? undefined : r.stat + r.extra));
const flatArb = fc
  .record({ w: num(1, 40), t: num(0.05, 3), stat: num(0.5, 40), extra: fc.option(num(0, 40), { nil: undefined }) })
  .map((r) => flatType(r.w, r.t, r.stat, r.extra === undefined ? undefined : r.stat + r.extra));
const countArb = fc.integer({ min: 1, max: 40 });
const sleeveArb = num(0, 3);

describe('cableEnvelope, round bundles', () => {
  it('is never smaller or tighter than a single cable of the type', () => {
    fc.assert(
      fc.property(roundArb, countArb, sleeveArb, (type, n, sleeve) => {
        const one = cableEnvelope(type, mkBuild(1, false, undefined, sleeve));
        const many = cableEnvelope(type, mkBuild(n, false, undefined, sleeve));
        expect(many.width_mm).toBeGreaterThanOrEqual(one.width_mm - 1e-12);
        expect(many.height_mm).toBeGreaterThanOrEqual(one.height_mm - 1e-12);
        expect(many.bend_static_mm).toBeGreaterThanOrEqual(type.min_bend_mm.static);
        if (type.min_bend_mm.dynamic === undefined) expect(many.bend_dynamic_mm).toBeUndefined();
        else expect(many.bend_dynamic_mm!).toBeGreaterThanOrEqual(type.min_bend_mm.dynamic);
        expect(many.shape).toBe('round');
        expect(many.width_mm).toBe(many.height_mm);
        expect(close(many.area_mm2, (Math.PI * many.width_mm ** 2) / 4, 1e-12)).toBe(true);
      }),
    );
  });

  it('a single cable is the cable: its od, its bend radii, no extra length', () => {
    fc.assert(
      fc.property(roundArb, (type) => {
        const e = cableEnvelope(type, mkBuild(1));
        expect(e.width_mm).toBeCloseTo((type.section as { od_mm: number }).od_mm, 12);
        expect(e.bend_static_mm).toBeCloseTo(type.min_bend_mm.static, 12);
        expect(e.length_factor).toBe(1);
        expect(e.notes).toEqual([]);
      }),
    );
  });

  it('length_factor is exactly 1 unless twisted, and at least 1 always', () => {
    fc.assert(
      fc.property(roundArb, countArb, fc.option(num(2, 500), { nil: undefined }), fc.boolean(), (type, n, lay, twisted) => {
        const e = cableEnvelope(type, mkBuild(n, twisted, lay));
        expect(e.length_factor).toBeGreaterThanOrEqual(1);
        if (!twisted || n === 1) expect(e.length_factor).toBe(1);
        else expect(e.length_factor).toBeGreaterThan(1);
      }),
    );
  });

  it('length_factor decreases as the lay grows and tends to 1', () => {
    fc.assert(
      fc.property(roundArb, fc.integer({ min: 2, max: 40 }), num(5, 500), num(0.01, 5), (type, n, lay, grow) => {
        const a = cableEnvelope(type, mkBuild(n, true, lay)).length_factor;
        const b = cableEnvelope(type, mkBuild(n, true, lay * (1 + grow))).length_factor;
        expect(a).toBeGreaterThan(b);
        expect(cableEnvelope(type, mkBuild(n, true, 1e9)).length_factor - 1).toBeLessThan(1e-6);
      }),
    );
  });

  it('a sleeve adds exactly twice its wall to width and height and changes nothing else', () => {
    fc.assert(
      fc.property(roundArb, countArb, fc.boolean(), sleeveArb, (type, n, twisted, wall) => {
        const lay = 30;
        const bare = cableEnvelope(type, mkBuild(n, twisted, lay, 0));
        const sleeved = cableEnvelope(type, mkBuild(n, twisted, lay, wall));
        expect(close(sleeved.width_mm - bare.width_mm, 2 * wall, 1e-9)).toBe(true);
        expect(close(sleeved.height_mm - bare.height_mm, 2 * wall, 1e-9)).toBe(true);
        expect(sleeved.bend_static_mm).toBeCloseTo(bare.bend_static_mm, 9);
        expect(sleeved.length_factor).toBeCloseTo(bare.length_factor, 12);
      }),
    );
  });

  it('records every assumption it makes in notes', () => {
    fc.assert(
      fc.property(roundArb, fc.integer({ min: 2, max: 40 }), num(5, 500), (type, n, lay) => {
        const assumed = cableEnvelope(type, mkBuild(n, true));
        expect(assumed.notes.some((x) => /assumed/i.test(x))).toBe(true);
        expect(assumed.lay_length_mm).toBeCloseTo(12 * bundleDiameter((type.section as { od_mm: number }).od_mm, n), 9);

        const given = cableEnvelope(type, mkBuild(n, true, lay));
        expect(given.notes).toEqual([]);
        expect(given.lay_length_mm).toBe(lay);

        const single = cableEnvelope(type, mkBuild(1, true, lay));
        expect(single.notes.length).toBeGreaterThan(0);
        expect(single.lay_length_mm).toBeUndefined();

        const plain = cableEnvelope(type, mkBuild(n, false));
        expect(plain.notes).toEqual([]);
        expect(plain.lay_length_mm).toBeUndefined();
      }),
    );
  });

  it('matches a helix sampled numerically, within 1e-6', () => {
    fc.assert(
      fc.property(roundArb, fc.integer({ min: 2, max: 40 }), num(3, 400), (type, n, lay) => {
        const d = (type.section as { od_mm: number }).od_mm;
        // Independent geometry: the outermost wire's centre is at radius (D - d) / 2 from the axis.
        const r = (bundleDiameter(d, n) - d) / 2;
        const steps = 20000;
        let length = 0;
        let prev: V = [r, 0, 0];
        for (let k = 1; k <= steps; k++) {
          const t = (2 * Math.PI * k) / steps;
          const p: V = [r * Math.cos(t), r * Math.sin(t), (lay * t) / (2 * Math.PI)];
          length += Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]);
          prev = p;
        }
        expect(Math.abs(cableEnvelope(type, mkBuild(n, true, lay)).length_factor - length / lay)).toBeLessThan(1e-6);
      }),
      { numRuns: 40 },
    );
  });
});

describe('cableEnvelope, flat cables', () => {
  it('stack in height, keep their width, and ignore twist with a note', () => {
    fc.assert(
      fc.property(flatArb, countArb, sleeveArb, fc.boolean(), (type, n, wall, twisted) => {
        const s = type.section as { width_mm: number; thickness_mm: number };
        const e = cableEnvelope(type, mkBuild(n, twisted, 20, wall));
        expect(e.shape).toBe('flat');
        expect(close(e.height_mm, s.thickness_mm * n + 2 * wall, 1e-12)).toBe(true);
        expect(close(e.width_mm, s.width_mm + 2 * wall, 1e-12)).toBe(true);
        expect(e.length_factor).toBe(1);
        expect(e.lay_length_mm).toBeUndefined();
        expect(e.notes.some((x) => /twist/i.test(x))).toBe(twisted);
        expect(e.notes.some((x) => /stack/i.test(x))).toBe(n > 1);
        expect(e.bend_static_mm).toBeGreaterThanOrEqual(type.min_bend_mm.static);
        if (type.min_bend_mm.dynamic !== undefined) expect(e.bend_dynamic_mm!).toBeGreaterThanOrEqual(type.min_bend_mm.dynamic);
        expect(close(e.area_mm2, e.width_mm * e.height_mm, 1e-12)).toBe(true);
      }),
    );
  });

  it('width does not depend on the count', () => {
    fc.assert(
      fc.property(flatArb, countArb, countArb, (type, a, b) => {
        expect(cableEnvelope(type, mkBuild(a)).width_mm).toBe(cableEnvelope(type, mkBuild(b)).width_mm);
      }),
    );
  });
});

// ---------------------------------------------------------------- own kinematics

interface Rt {
  r: number[]; // row-major 3x3
  t: V;
}
const IDENT: Rt = { r: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
const applyR = (r: number[], v: V): V => [r[0]! * v[0] + r[1]! * v[1] + r[2]! * v[2], r[3]! * v[0] + r[4]! * v[1] + r[5]! * v[2], r[6]! * v[0] + r[7]! * v[1] + r[8]! * v[2]];
const apply = (m: Rt, v: V): V => {
  const x = applyR(m.r, v);
  return [x[0] + m.t[0], x[1] + m.t[1], x[2] + m.t[2]];
};
const mul = (a: Rt, b: Rt): Rt => {
  const r: number[] = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r.push(a.r[3 * i]! * b.r[j]! + a.r[3 * i + 1]! * b.r[3 + j]! + a.r[3 * i + 2]! * b.r[6 + j]!);
  const t = apply(a, b.t);
  return { r, t };
};
const quatR = (q: readonly number[]): number[] => {
  const [x, y, z, w] = q as [number, number, number, number];
  return [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)];
};
const rodrigues = (k: V, a: number): number[] => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  const o = 1 - c;
  return [c + k[0] * k[0] * o, k[0] * k[1] * o - k[2] * s, k[0] * k[2] * o + k[1] * s, k[1] * k[0] * o + k[2] * s, c + k[1] * k[1] * o, k[1] * k[2] * o - k[0] * s, k[2] * k[0] * o - k[1] * s, k[2] * k[1] * o + k[0] * s, c + k[2] * k[2] * o];
};
function motion(j: Joint, v: number): Rt {
  const n = Math.hypot(...j.axis);
  if (j.type === 'fixed' || n === 0) return IDENT;
  const k: V = [j.axis[0] / n, j.axis[1] / n, j.axis[2] / n];
  if (j.type === 'prismatic') return { r: IDENT.r, t: [k[0] * v, k[1] * v, k[2] * v] };
  return { r: rodrigues(k, v), t: [0, 0, 0] };
}
function poseOf(d: Design, link: string, values: Record<string, number>): Rt {
  const parent = d.scene.joints.find((j) => j.child === link);
  if (!parent) return IDENT;
  const origin: Rt = { r: quatR(parent.origin.q), t: parent.origin.p_mm as V };
  return mul(mul(poseOf(d, parent.parent, values), origin), motion(parent, values[parent.id] ?? parent.value));
}
const rootOf = (d: Design, link: string): string => {
  let cur = link;
  for (;;) {
    const p = d.scene.joints.find((j) => j.child === cur);
    if (!p) return cur;
    cur = p.parent;
  }
};
const lifted = (p: V, n: V | undefined, lift: number): V => (n && (n[0] !== 0 || n[1] !== 0 || n[2] !== 0) ? [p[0] + n[0] * lift, p[1] + n[1] * lift, p[2] + n[2] * lift] : [...p]);
const dist = (a: V, b: V) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// ---------------------------------------------------------------- generators for trees with routes

const jointType = fc.constantFrom<Joint['type']>('fixed', 'revolute', 'continuous', 'prismatic');
const treeSpec = fc.record({
  joints: fc.array(
    fc.record({ isRoot: fc.boolean(), parentPick: nat, type: jointType, p: vec3, q: quat, axis: unitVec, lo: num(-3, 0), span: num(0, 6), frac: num(0, 1) }),
    { minLength: 1, maxLength: 7 },
  ),
  segments: fc.array(
    fc.record({
      linkPick: nat,
      pts: fc.array(vec3, { minLength: 1, maxLength: 4 }),
      withNormals: fc.boolean(),
      norms: fc.array(fc.oneof(fc.constant<V>([0, 0, 0]), unitVec), { minLength: 4, maxLength: 4 }),
    }),
    { minLength: 1, maxLength: 4 },
  ),
  lift: num(0, 6),
  values: fc.array(num(-6, 6), { minLength: 8, maxLength: 8 }),
});
type TreeSpec = typeof treeSpec extends fc.Arbitrary<infer T> ? T : never;

function buildTree(spec: TreeSpec, onlyFixed = false): Design {
  const d = DesignSchema.parse({ schema: 1 });
  d.scene.links.push({ id: 'l0', name: 'l0', meshes: [] });
  spec.joints.forEach((s, k) => {
    const i = k + 1;
    d.scene.links.push({ id: `l${i}`, name: `l${i}`, meshes: [] });
    if (s.isRoot) return;
    const type = onlyFixed ? 'fixed' : s.type;
    const limited = type === 'revolute' || type === 'prismatic';
    const scale = type === 'prismatic' ? 50 : 1;
    d.scene.joints.push({
      id: `j${i}`,
      name: `j${i}`,
      type,
      parent: `l${s.parentPick % i}`,
      child: `l${i}`,
      origin: { p_mm: s.p, q: s.q },
      axis: s.axis,
      ...(limited ? { limit: { lower: s.lo * scale, upper: (s.lo + s.span) * scale } } : {}),
      value: limited ? (s.lo + s.frac * s.span) * scale : 0,
    });
  });
  d.cables.push({ id: 'cb0', connections: [], type: 'x', count: 1, twisted: false, sleeve_wall_mm: 0, reasons: [] });
  d.routes.push({
    id: 'rt0',
    cable: 'cb0',
    segments: spec.segments.map((s) => ({
      link: d.scene.links[s.linkPick % d.scene.links.length]!.id,
      points_mm: s.pts.map((p) => [...p] as V),
      ...(s.withNormals ? { normals: s.pts.map((_, i) => [...s.norms[i]!] as V) } : {}),
    })),
    crossings: [],
  });
  return d;
}

const valuesOf = (d: Design, spec: TreeSpec): Record<string, number> => Object.fromEntries(d.scene.joints.map((j, i) => [j.id, spec.values[i % spec.values.length]!]));
const rangeOf = (j: Joint): [number, number] | null => (j.type === 'fixed' ? null : j.type === 'continuous' ? [-Math.PI, Math.PI] : j.limit ? [j.limit.lower, j.limit.upper] : null);

// ---------------------------------------------------------------- centre line

describe('segmentCentreLine and routeCentreLineWorld', () => {
  it('lifts surface points by exactly `lift` along the normal and leaves the others alone', () => {
    fc.assert(
      fc.property(treeSpec, (spec) => {
        const d = buildTree(spec);
        expect(errorsOf(d)).toEqual([]);
        for (const seg of d.routes[0]!.segments) {
          const line = segmentCentreLine(seg, spec.lift);
          expect(line).toHaveLength(seg.points_mm.length);
          seg.points_mm.forEach((p, i) => {
            const n = seg.normals?.[i];
            const q = line[i]!;
            if (!n || (n[0] === 0 && n[1] === 0 && n[2] === 0)) {
              expect(q).toEqual(p);
            } else {
              expect(dist(q as V, p as V)).toBeCloseTo(spec.lift, 9);
              for (let a = 0; a < 3; a++) expect(q[a]).toBeCloseTo(p[a]! + spec.lift * n[a]!, 9);
            }
          });
        }
      }),
    );
  });

  it('does not change a segment when the lift is 0', () => {
    fc.assert(fc.property(treeSpec, (spec) => {
      for (const seg of buildTree(spec).routes[0]!.segments) expect(segmentCentreLine(seg, 0)).toEqual(seg.points_mm);
    }));
  });

  it('world points equal link pose times the lifted point at random joint values', () => {
    fc.assert(
      fc.property(treeSpec, (spec) => {
        const d = buildTree(spec);
        const values = valuesOf(d, spec);
        const route = d.routes[0]!;
        const { points, starts } = routeCentreLineWorld(d, route, spec.lift, values);
        let k = 0;
        route.segments.forEach((seg, si) => {
          expect(starts[si]).toBe(k);
          const pose = poseOf(d, seg.link, values);
          seg.points_mm.forEach((p, i) => {
            const want = apply(pose, lifted(p as V, seg.normals?.[i] as V | undefined, spec.lift));
            const got = points[k++]!;
            for (let a = 0; a < 3; a++) expect(Math.abs(got[a]! - want[a]!)).toBeLessThan(1e-6);
          });
        });
        expect(points).toHaveLength(k);
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------- routeLength

describe('routeLength', () => {
  it('on_links_mm is the sum of the lifted polyline lengths and is the same at every pose', () => {
    fc.assert(
      fc.property(treeSpec, (spec) => {
        const d = buildTree(spec);
        const route = d.routes[0]!;
        const len = routeLength(d, route, spec.lift);
        let own = 0;
        for (const seg of route.segments) {
          const pts = seg.points_mm.map((p, i) => lifted(p as V, seg.normals?.[i] as V | undefined, spec.lift));
          for (let i = 1; i < pts.length; i++) own += dist(pts[i - 1]!, pts[i]!);
        }
        expect(close(len.on_links_mm, own, 1e-9)).toBe(true);

        // Rigid links: the polyline length measured in the world does not depend on the pose.
        const { points, starts } = routeCentreLineWorld(d, route, spec.lift, valuesOf(d, spec));
        let world = 0;
        starts.forEach((s, si) => {
          const end = si + 1 < starts.length ? starts[si + 1]! : points.length;
          world += polylineLength(points.slice(s, end));
        });
        expect(close(world, len.on_links_mm, 1e-9)).toBe(true);
        expect(len.min_mm).toBeLessThanOrEqual(len.max_mm + 1e-9);
        expect(len.crossings).toHaveLength(Math.max(0, route.segments.length - 1));
        for (const c of len.crossings) expect(c.min_mm).toBeLessThanOrEqual(c.max_mm);
      }),
      { numRuns: 200 },
    );
  });

  it('every pose in a dense independent sweep lies within [min - e, max + e]', () => {
    fc.assert(
      fc.property(treeSpec, (spec) => {
        const d = buildTree(spec);
        const route = d.routes[0]!;
        const lift = spec.lift;
        const len = routeLength(d, route, lift);
        const byId = new Map(d.scene.joints.map((j) => [j.id, j]));

        // Bound on how far any point can be from any joint axis point: every position is a sum of origin
        // translations, prismatic travel and a local point, so two of them differ by at most twice the total.
        let wmax = 0;
        for (const j of d.scene.joints) {
          wmax += Math.hypot(...j.origin.p_mm);
          if (j.type === 'prismatic') wmax += Math.max(Math.abs(j.limit!.lower), Math.abs(j.limit!.upper));
        }
        let local = 0;
        for (const seg of route.segments) for (const [i, p] of seg.points_mm.entries()) local = Math.max(local, Math.hypot(...lifted(p as V, seg.normals?.[i] as V | undefined, lift)));
        const reach = 2 * (wmax + local) + 1; // |P - c| bound; a joint moves a point by at most reach * |delta|

        len.crossings.forEach((c, ci) => {
          const from = route.segments[ci]!;
          const to = route.segments[ci + 1]!;
          const end = lifted(from.points_mm.at(-1) as V, from.normals?.at(-1) as V | undefined, lift);
          const start = lifted(to.points_mm[0] as V, to.normals?.[0] as V | undefined, lift);
          const sampled = c.joints.slice(0, 3).map((id) => byId.get(id)!);
          // The function samples 9 values per joint; a continuum point is within half a step of a sample.
          const e = sampled.reduce((s, j) => {
            const [lo, hi] = rangeOf(j)!;
            return s + (reach * (hi - lo)) / 8 / 2;
          }, 1e-6);
          const steps = [0, 200, 41, 17][sampled.length]!;
          const values: Record<string, number> = {};
          let evaluated = 0;
          const visit = (k: number) => {
            if (k === sampled.length) {
              const f = dist(apply(poseOf(d, from.link, values), end), apply(poseOf(d, to.link, values), start));
              evaluated++;
              expect(f, `crossing ${ci} at ${JSON.stringify(values)}`).toBeGreaterThanOrEqual(c.min_mm - e);
              expect(f, `crossing ${ci} at ${JSON.stringify(values)}`).toBeLessThanOrEqual(c.max_mm + e);
              return;
            }
            const [lo, hi] = rangeOf(sampled[k]!)!;
            for (let s = 0; s < steps; s++) {
              values[sampled[k]!.id] = lo + ((hi - lo) * s) / (steps - 1);
              visit(k + 1);
            }
          };
          visit(0);
          expect(evaluated).toBeGreaterThan(0);
        });
      }),
      { numRuns: 60 },
    );
  });

  it('a crossing over fixed joints only (or one link) has min == max', () => {
    fc.assert(
      fc.property(treeSpec, (spec) => {
        const d = buildTree(spec, true);
        const len = routeLength(d, d.routes[0]!, spec.lift);
        for (const c of len.crossings) {
          expect(c.joints).toEqual([]);
          expect(c.min_mm).toBe(c.max_mm);
        }
        expect(len.min_mm).toBeCloseTo(len.max_mm, 9);
      }),
    );
  });

  it('in any tree, a crossing with no moving joints has min == max', () => {
    fc.assert(
      fc.property(treeSpec, (spec) => {
        const d = buildTree(spec);
        for (const c of routeLength(d, d.routes[0]!, spec.lift).crossings) if (c.joints.length === 0) expect(c.min_mm).toBe(c.max_mm);
      }),
    );
  });

  it('reversing the route (segments and points) gives the same lengths', () => {
    fc.assert(
      fc.property(treeSpec, (spec) => {
        const d = buildTree(spec);
        const route = d.routes[0]!;
        const fwd = routeLength(d, route, spec.lift);
        // The function samples only the first three joints of a crossing, counted from its start; skip longer ones.
        fc.pre(fwd.crossings.every((c) => c.joints.length <= 3));
        const reversed: Route = {
          ...route,
          segments: [...route.segments].reverse().map((s) => ({
            link: s.link,
            points_mm: [...s.points_mm].reverse(),
            ...(s.normals ? { normals: [...s.normals].reverse() } : {}),
          })),
        };
        const back = routeLength(d, reversed, spec.lift);
        expect(close(back.on_links_mm, fwd.on_links_mm, 1e-9)).toBe(true);
        expect(close(back.min_mm, fwd.min_mm, 1e-9)).toBe(true);
        expect(close(back.max_mm, fwd.max_mm, 1e-9)).toBe(true);
      }),
      { numRuns: 150 },
    );
  });
});

describe('jointsBetween', () => {
  it('is the reverse of itself with the arguments swapped, and null across disconnected trees', () => {
    fc.assert(
      fc.property(treeSpec, nat, nat, (spec, ai, bi) => {
        const d = buildTree(spec);
        const a = d.scene.links[ai % d.scene.links.length]!.id;
        const b = d.scene.links[bi % d.scene.links.length]!.id;
        const ab = jointsBetween(d.scene, a, b);
        const ba = jointsBetween(d.scene, b, a);
        if (rootOf(d, a) !== rootOf(d, b)) {
          expect(ab).toBeNull();
          expect(ba).toBeNull();
        } else {
          expect(ab).not.toBeNull();
          expect(ba).toEqual([...ab!].reverse());
          if (a === b) expect(ab).toEqual([]);
          // Each joint on the path hangs from or leads to a link on it: consecutive joints share a link.
          expect(new Set(ab).size).toBe(ab!.length);
        }
      }),
      { numRuns: 300 },
    );
  });
});

// ---------------------------------------------------------------- corners

describe('cornerRadii', () => {
  const corner = fc.tuple(vec3, vec3, vec3).filter(([p, q, r]) => {
    const l1 = dist(p, q);
    const l2 = dist(q, r);
    if (l1 < 5 || l2 < 5) return false;
    const u1: V = [(q[0] - p[0]) / l1, (q[1] - p[1]) / l1, (q[2] - p[2]) / l1];
    const u2: V = [(r[0] - q[0]) / l2, (r[1] - q[1]) / l2, (r[2] - q[2]) / l2];
    const turn = Math.atan2(Math.hypot(u1[1] * u2[2] - u1[2] * u2[1], u1[2] * u2[0] - u1[0] * u2[2], u1[0] * u2[1] - u1[1] * u2[0]), u1[0] * u2[0] + u1[1] * u2[1] + u1[2] * u2[2]);
    return turn > 0.05 && turn < Math.PI - 0.05;
  });

  it('returns the radius of a circle tangent to both legs, touching each within its half', () => {
    fc.assert(
      fc.property(corner, ([p, q, r]) => {
        const R = cornerRadii([p, q, r])[0]!;
        expect(Number.isFinite(R)).toBe(true);
        expect(R).toBeGreaterThan(0);
        const l1 = dist(p, q);
        const l2 = dist(q, r);
        const u1: V = [(q[0] - p[0]) / l1, (q[1] - p[1]) / l1, (q[2] - p[2]) / l1];
        const u2: V = [(r[0] - q[0]) / l2, (r[1] - q[1]) / l2, (r[2] - q[2]) / l2];
        const cos = u1[0] * u2[0] + u1[1] * u2[1] + u1[2] * u2[2];
        const sinHalf = Math.sqrt((1 - cos) / 2);
        const cosHalf = Math.sqrt((1 + cos) / 2);
        const t = (R * sinHalf) / cosHalf; // tangent length of a fillet of radius R on a corner that turns by `turn`
        // Circle: centre on the inner bisector at sqrt(R^2 + t^2) from the corner.
        const w: V = [u2[0] - u1[0], u2[1] - u1[1], u2[2] - u1[2]];
        const wl = Math.hypot(...w);
        const centre: V = [q[0] + (w[0] / wl) * Math.hypot(R, t), q[1] + (w[1] / wl) * Math.hypot(R, t), q[2] + (w[2] / wl) * Math.hypot(R, t)];
        const t1: V = [q[0] - u1[0] * t, q[1] - u1[1] * t, q[2] - u1[2] * t];
        const t2: V = [q[0] + u2[0] * t, q[1] + u2[1] * t, q[2] + u2[2] * t];
        const rel = 1e-7;
        expect(close(dist(centre, t1), R, rel)).toBe(true);
        expect(close(dist(centre, t2), R, rel)).toBe(true);
        // tangent: centre - tangent point is perpendicular to the leg
        const c1: V = [centre[0] - t1[0], centre[1] - t1[1], centre[2] - t1[2]];
        const c2: V = [centre[0] - t2[0], centre[1] - t2[1], centre[2] - t2[2]];
        expect(Math.abs(c1[0] * u1[0] + c1[1] * u1[1] + c1[2] * u1[2])).toBeLessThan(1e-6 * (1 + R));
        expect(Math.abs(c2[0] * u2[0] + c2[1] * u2[1] + c2[2] * u2[2])).toBeLessThan(1e-6 * (1 + R));
        // within half of each leg, and exactly half on the shorter one (the largest such radius)
        expect(t).toBeLessThanOrEqual(l1 / 2 + 1e-6);
        expect(t).toBeLessThanOrEqual(l2 / 2 + 1e-6);
        expect(close(t, Math.min(l1, l2) / 2, 1e-7)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it('scales with the polyline', () => {
    fc.assert(
      fc.property(
        fc.array(vec3, { minLength: 3, maxLength: 7 }).filter((pts) => pts.every((p, n) => n === 0 || dist(p, pts[n - 1]!) === 0 || dist(p, pts[n - 1]!) > 1e-6)),
        num(0.01, 50),
        (pts, k) => {
        const a = cornerRadii(pts);
        const b = cornerRadii(pts.map((p) => [p[0] * k, p[1] * k, p[2] * k] as V));
        expect(b).toHaveLength(pts.length - 2);
        a.forEach((x, i) => {
          if (x === Infinity) expect(b[i]).toBe(Infinity);
          else {
            // acos is ill-conditioned near 0 and pi, so a near-straight or near-reversed corner is only accurate to about 1e-8 rad.
            const legs = Math.max(...pts.map((p, n) => (n === 0 ? 0 : dist(p, pts[n - 1]!))));
            expect(Math.abs(b[i]! - x * k)).toBeLessThanOrEqual(1e-6 * (1 + x * k) + 1e-7 * k * legs);
          }
        });
      }),
    );
  });

  it('gives Infinity for collinear points', () => {
    fc.assert(
      fc.property(vec3, unitVec, num(1, 100), num(1, 100), (p, u, a, b) => {
        const at = (s: number): V => [p[0] + u[0] * s, p[1] + u[1] * s, p[2] + u[2] * s];
        expect(cornerRadii([p, at(a), at(a + b)])).toEqual([Infinity]);
      }),
    );
  });

  it('gives 0, not NaN, for repeated points', () => {
    fc.assert(
      fc.property(vec3, vec3, (p, r) => {
        expect(cornerRadii([p, p, r])).toEqual([0]);
        expect(cornerRadii([p, r, r])).toEqual([0]);
        expect(cornerRadii([p, p, p])).toEqual([0]);
      }),
    );
  });

  it('gives no entries for fewer than three points', () => {
    expect(cornerRadii([])).toEqual([]);
    expect(cornerRadii([[0, 0, 0]])).toEqual([]);
    expect(cornerRadii([[0, 0, 0], [1, 0, 0]])).toEqual([]);
  });
});

describe('bendsTighterThan', () => {
  it('lists exactly the corners below the limit, worst first, with segment and point indices', () => {
    fc.assert(
      fc.property(treeSpec, num(0, 4), num(0, 200), (spec, lift, limit) => {
        const route = buildTree(spec).routes[0]!;
        const got = bendsTighterThan(route, lift, limit);
        const want: Array<{ segment: number; point: number; radius_mm: number }> = [];
        route.segments.forEach((seg, s) => cornerRadii(segmentCentreLine(seg, lift)).forEach((r, i) => r < limit && want.push({ segment: s, point: i + 1, radius_mm: r })));
        expect(got).toHaveLength(want.length);
        for (let i = 1; i < got.length; i++) expect(got[i]!.radius_mm).toBeGreaterThanOrEqual(got[i - 1]!.radius_mm);
        const key = (x: { segment: number; point: number }) => `${x.segment}:${x.point}`;
        expect(got.map(key).sort()).toEqual(want.map(key).sort());
        for (const g of got) expect(g.radius_mm).toBeLessThan(limit);
      }),
    );
  });
});

// ---------------------------------------------------------------- schema and validation

describe('route and cable schema', () => {
  const seg = (d: Design) => d.routes[0]!.segments[0]!;

  it('rejects normals of the wrong length', () => {
    const d = fullDesign();
    seg(d).normals = [[0, 0, 1]];
    const e = errorsOf(d);
    expect(e.some((i) => i.path === 'routes[0].segments[0].normals')).toBe(true);
  });

  it('rejects a normal that is neither zero nor unit length, and accepts zero and unit', () => {
    const d = fullDesign();
    seg(d).normals = [[0, 0, 2], [0, 0, 0]];
    expect(errorsOf(d).map((i) => i.path)).toEqual(['routes[0].segments[0].normals[0]']);
    seg(d).normals = [[0, 0, 0], [0, 0, 1]];
    expect(errorsOf(d)).toEqual([]);
    seg(d).normals = [[0, 0, 1 + 0.9e-6], [0, 0, 1 - 0.9e-6]];
    expect(errorsOf(d)).toEqual([]);
    seg(d).normals = [[0, 0, 1 + 1.1e-6], [0, 1e-9, 0]];
    expect(errorsOf(d).map((i) => i.path)).toEqual(['routes[0].segments[0].normals[0]', 'routes[0].segments[0].normals[1]']);
  });

  it('rejects a non-finite point or normal component with a path into the segment', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      const raw = JSON.parse(JSON.stringify(fullDesign())) as Design;
      raw.routes[0]!.segments[0]!.points_mm[0] = [bad, 0, 0];
      const r = parseDesign(raw);
      expect(r.ok, String(bad)).toBe(false);
      expect(r.issues.some((i) => i.path.startsWith('routes[0].segments[0].points_mm[0]')), JSON.stringify(r.issues)).toBe(true);
      const raw2 = JSON.parse(JSON.stringify(fullDesign())) as Design;
      raw2.routes[0]!.segments[0]!.normals = [[bad, 0, 0], [0, 0, 1]];
      const r2 = parseDesign(raw2);
      expect(r2.ok, String(bad)).toBe(false);
      expect(r2.issues.some((i) => i.path.startsWith('routes[0].segments[0].normals[0]')), JSON.stringify(r2.issues)).toBe(true);
    }
  });

  it('accepts a cable with no connections and a segment with one point', () => {
    const d = fullDesign();
    d.cables[0]!.connections = [];
    seg(d).points_mm = [[1, 2, 3]];
    seg(d).normals = [[0, 0, 1]];
    expect(errorsOf(d)).toEqual([]);
    expect(parseDesign(JSON.parse(JSON.stringify(d))).ok).toBe(true);
  });

  it('rejects a segment with no points', () => {
    const raw = JSON.parse(JSON.stringify(fullDesign())) as Design;
    raw.routes[0]!.segments[0]!.points_mm = [];
    expect(parseDesign(raw).ok).toBe(false);
  });

  it('fills the defaults of the new cable fields', () => {
    const c = CableSchema.parse({ id: 'c', type: 't' });
    expect(c).toEqual({ id: 'c', connections: [], type: 't', count: 1, twisted: false, sleeve_wall_mm: 0, reasons: [] });
    expect(c.name).toBeUndefined();
    expect(c.lay_length_mm).toBeUndefined();
  });

  it.each([
    ['count 0', { count: 0 }],
    ['count 1.5', { count: 1.5 }],
    ['negative sleeve', { sleeve_wall_mm: -0.1 }],
    ['zero lay', { lay_length_mm: 0 }],
    ['unknown key', { colour: 'red' }],
  ])('rejects %s', (_n, extra) => {
    expect(CableSchema.safeParse({ id: 'c', type: 't', ...extra }).success).toBe(false);
  });

  it('round-trips cables with the new fields and routes with normals through JSON', () => {
    const d = fullDesign();
    d.cables[0] = { ...d.cables[0]!, name: 'bus', count: 3, twisted: true, lay_length_mm: 25, sleeve_wall_mm: 0.4 };
    seg(d).normals = [[0, 0, 1], [0, 0, 0]];
    const back = DesignSchema.parse(JSON.parse(JSON.stringify(d)));
    expect(back).toEqual(d);
    expect(errorsOf(back)).toEqual([]);
  });
});

// ---------------------------------------------------------------- cable library

describe('parseCableLibrary', () => {
  const entry = (extra: string, id = 'a') =>
    `  - id: ${id}\n    name: N\n    family: hookup_wire\n    section: { shape: round, od_mm: 1 }\n    conductors: 1\n    min_bend_mm: { static: 5 }\n    flex: flexible\n    confidence: generic\n${extra}`;
  const lib = (...entries: string[]) => `version: 1\ncables:\n${entries.join('')}`;

  it('library/cables.yaml parses', () => {
    const l = parseCableLibrary(readText('library/cables.yaml'));
    expect(l.cables.length).toBeGreaterThan(0);
  });

  it('every library cable honours the cross-field rules', () => {
    for (const c of parseCableLibrary(readText('library/cables.yaml')).cables) {
      if (c.min_bend_mm.dynamic !== undefined) expect(c.min_bend_mm.dynamic, c.id).toBeGreaterThanOrEqual(c.min_bend_mm.static);
      if (c.confidence === 'datasheet' || c.confidence === 'derived') expect(c.source, c.id).toBeTruthy();
      if (c.confidence === 'derived') expect(c.note, c.id).toBeTruthy();
    }
  });

  it('accepts a minimal library', () => {
    expect(parseCableLibrary(lib(entry(''))).cables).toHaveLength(1);
    expect(parseCableLibrary('version: 1\ncables: []\n').cables).toEqual([]);
  });

  const bad: Array<[string, string, RegExp]> = [
    ['duplicate ids', lib(entry('', 'a'), entry('', 'a')), /duplicate cable id "a"/],
    ['dynamic below static', lib(entry('').replace('{ static: 5 }', '{ static: 5, dynamic: 4 }')), /dynamic bend radius/],
    ['datasheet without source', lib(entry('').replace('generic', 'datasheet')), /needs a source/],
    ['derived without source', lib(entry('    note: x\n').replace('generic', 'derived')), /needs a source/],
    ['derived without note', lib(entry('    source: https://example.com\n').replace('generic', 'derived')), /note/],
    ['unknown family', lib(entry('').replace('hookup_wire', 'rope')), /./],
    ['zero conductors', lib(entry('').replace('conductors: 1', 'conductors: 0')), /./],
    ['unknown key', lib(entry('    colour: red\n')), /./],
    ['bad version', lib(entry('')).replace('version: 1', 'version: 2'), /./],
  ];
  it.each(bad)('rejects %s', (_n, yaml, message) => {
    expect(() => parseCableLibrary(yaml)).toThrow(message);
  });

  it('accepts dynamic equal to static, and a datasheet entry with a source', () => {
    expect(() => parseCableLibrary(lib(entry('').replace('{ static: 5 }', '{ static: 5, dynamic: 5 }')))).not.toThrow();
    expect(() => parseCableLibrary(lib(entry('    source: https://example.com\n').replace('generic', 'datasheet')))).not.toThrow();
    expect(() => parseCableLibrary(lib(entry('    source: https://example.com\n    note: scaled from x\n').replace('generic', 'derived')))).not.toThrow();
  });
});

