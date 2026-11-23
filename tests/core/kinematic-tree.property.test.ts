import fc from 'fast-check';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { computeLinkPoses, DesignSchema, validateDesign, type Design, type Joint } from '@core';
import { mkLink } from './helpers';

fc.configureGlobal({ seed: 20261121 });

const coord = fc.double({ min: -1000, max: 1000, noNaN: true, noDefaultInfinity: true });
const unit = (v: [number, number, number, number]): [number, number, number, number] => {
  const n = Math.hypot(...v);
  return [v[0] / n, v[1] / n, v[2] / n, v[3] / n];
};
const rawVec4 = fc.tuple(...Array(4).fill(fc.double({ min: -1, max: 1, noNaN: true })) as [fc.Arbitrary<number>, fc.Arbitrary<number>, fc.Arbitrary<number>, fc.Arbitrary<number>]).filter((v) => Math.hypot(...v) > 0.1);
const rawVec3 = fc.tuple(fc.double({ min: -1, max: 1, noNaN: true }), fc.double({ min: -1, max: 1, noNaN: true }), fc.double({ min: -1, max: 1, noNaN: true })).filter((v) => Math.hypot(...v) > 0.1);

interface JointSpec {
  parentPick: number;
  type: Joint['type'];
  p: [number, number, number];
  q: [number, number, number, number];
  axis: [number, number, number];
  lower: number;
  span: number;
  frac: number;
}

const jointSpec: fc.Arbitrary<JointSpec> = fc.record({
  parentPick: fc.nat(1_000_000),
  type: fc.constantFrom<Joint['type']>('fixed', 'revolute', 'continuous', 'prismatic'),
  p: fc.tuple(coord, coord, coord),
  q: rawVec4.map(unit),
  axis: rawVec3.map(([x, y, z]) => {
    const n = Math.hypot(x, y, z);
    return [x / n, y / n, z / n] as [number, number, number];
  }),
  lower: fc.double({ min: -3, max: 0, noNaN: true }),
  span: fc.double({ min: 0, max: 6, noNaN: true }),
  frac: fc.double({ min: 0, max: 1, noNaN: true }),
});

/** A tree of 1..9 links; link i (i >= 1) has a parent among links 0..i-1. */
const treeArb = fc.array(jointSpec, { minLength: 0, maxLength: 8 }).map((specs) => {
  const links = Array.from({ length: specs.length + 1 }, (_, i) => mkLink(`l${i}`));
  const joints: Joint[] = specs.map((s, i) => {
    const hasLimit = s.type === 'revolute' || s.type === 'prismatic';
    const lower = s.lower;
    const upper = s.lower + s.span;
    const value = s.type === 'continuous' ? (s.frac - 0.5) * 40 : hasLimit ? lower + s.frac * s.span : 0;
    return {
      id: `j${i}`,
      name: `j${i}`,
      type: s.type,
      parent: `l${s.parentPick % (i + 1)}`,
      child: `l${i + 1}`,
      origin: { p_mm: s.p, q: s.q },
      axis: s.axis,
      ...(hasLimit ? { limit: { lower, upper } } : {}),
      value,
    };
  });
  const d: Design = DesignSchema.parse({ schema: 1 });
  d.scene.links = links;
  d.scene.joints = joints;
  return d;
});

const close = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol * (1 + Math.abs(a) + Math.abs(b));

/** Independent expected motion matrix, built from quaternions and translations rather than three's matrix helpers. */
function expectedChild(parent: Matrix4, j: Joint): Matrix4 {
  const origin = new Matrix4().compose(new Vector3(...j.origin.p_mm), new Quaternion(...j.origin.q), new Vector3(1, 1, 1));
  const axis = new Vector3(...j.axis).normalize();
  const motion = new Matrix4();
  if (j.type === 'revolute' || j.type === 'continuous') {
    motion.compose(new Vector3(), new Quaternion().setFromAxisAngle(axis, j.value), new Vector3(1, 1, 1));
  } else if (j.type === 'prismatic') {
    motion.compose(axis.clone().multiplyScalar(j.value), new Quaternion(), new Vector3(1, 1, 1));
  }
  return parent.clone().multiply(origin).multiply(motion);
}

function det3(e: number[]): number {
  // column-major 4x4: columns at 0..2, 4..6, 8..10
  const [a, b, c, d, f, g, h, i, k] = [e[0]!, e[4]!, e[8]!, e[1]!, e[5]!, e[9]!, e[2]!, e[6]!, e[10]!];
  return a * (f * k - g * i) - b * (d * k - g * h) + c * (d * i - f * h);
}

describe('random valid kinematic trees', () => {
  it('validate cleanly, and every link gets a rigid pose equal to parent x origin x motion', () => {
    fc.assert(
      fc.property(treeArb, (d) => {
        const issues = validateDesign(d);
        expect(issues.filter((i) => i.severity === 'error')).toEqual([]);

        const poses = computeLinkPoses(d.scene);
        expect(poses.size).toBe(d.scene.links.length);
        for (const l of d.scene.links) expect(poses.has(l.id), l.id).toBe(true);

        for (const j of d.scene.joints) {
          const got = poses.get(j.child)!;
          const want = expectedChild(poses.get(j.parent)!, j);
          for (let k = 0; k < 16; k++) expect(close(got.elements[k]!, want.elements[k]!, 1e-9), `${j.id} element ${k}: ${got.elements[k]} vs ${want.elements[k]}`).toBe(true);
        }

        for (const [id, m] of poses) {
          const e = m.elements;
          const cols = [new Vector3(e[0], e[1], e[2]), new Vector3(e[4], e[5], e[6]), new Vector3(e[8], e[9], e[10])];
          for (let a = 0; a < 3; a++) {
            expect(Math.abs(cols[a]!.length() - 1), `${id} column ${a} length`).toBeLessThan(1e-9);
            for (let b = a + 1; b < 3; b++) expect(Math.abs(cols[a]!.dot(cols[b]!)), `${id} columns ${a},${b}`).toBeLessThan(1e-9);
          }
          expect(Math.abs(det3(e) - 1), `${id} determinant`).toBeLessThan(1e-9);
          expect([e[3], e[7], e[11], e[15]]).toEqual([0, 0, 0, 1]);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('prismatic joints also give rigid transforms (all-prismatic chains)', () => {
    fc.assert(
      fc.property(
        treeArb.map((d) => {
          for (const j of d.scene.joints) {
            if (j.type !== 'prismatic') {
              j.type = 'prismatic';
              j.limit = { lower: -100, upper: 100 };
              j.value = 37;
            }
          }
          return d;
        }),
        (d) => {
          const poses = computeLinkPoses(d.scene);
          for (const m of poses.values()) expect(Math.abs(det3(m.elements) - 1)).toBeLessThan(1e-9);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('adding one bad joint to a valid tree', () => {
  const extra = (d: Design, parent: string, child: string): Design => {
    const copy = structuredClone(d);
    copy.scene.joints.push({
      id: 'extra',
      name: 'extra',
      type: 'fixed',
      parent,
      child,
      origin: { p_mm: [0, 0, 0], q: [0, 0, 0, 1] },
      axis: [0, 0, 1],
      value: 0,
    });
    return copy;
  };
  const hasError = (d: Design) => validateDesign(d).some((i) => i.severity === 'error');

  it('a joint into the root from any other link (closing a cycle) is always an error', () => {
    fc.assert(
      fc.property(
        treeArb.filter((d) => d.scene.links.length >= 2),
        fc.nat(1000),
        (d, pick) => {
          const n = d.scene.links.length;
          const from = d.scene.links[1 + (pick % (n - 1))]!.id;
          expect(hasError(extra(d, from, 'l0'))).toBe(true);
        },
      ),
    );
  });

  it('a joint into an ancestor of its parent (closing a cycle) is always an error', () => {
    fc.assert(
      fc.property(
        treeArb.filter((d) => d.scene.links.length >= 2),
        fc.nat(1000),
        (d, pick) => {
          const n = d.scene.links.length;
          const leaf = d.scene.links[1 + (pick % (n - 1))]!.id;
          // walk up to the topmost ancestor below the root, then close the loop onto that link's parent chain start
          let cur = leaf;
          const parentOf = new Map(d.scene.joints.map((j) => [j.child, j.parent]));
          while (parentOf.get(cur) !== 'l0') cur = parentOf.get(cur)!;
          expect(hasError(extra(d, leaf, cur))).toBe(true);
        },
      ),
    );
  });

  it('giving a link a second parent is always an error', () => {
    fc.assert(
      fc.property(
        treeArb.filter((d) => d.scene.links.length >= 3),
        fc.nat(1000),
        fc.nat(1000),
        (d, a, b) => {
          const n = d.scene.links.length;
          const child = d.scene.links[1 + (a % (n - 1))]!.id;
          const others = d.scene.links.filter((l) => l.id !== child);
          const parent = others[b % others.length]!.id;
          expect(hasError(extra(d, parent, child))).toBe(true);
        },
      ),
    );
  });
});
