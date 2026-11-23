// The arm-cad truth file (axes.json) checked against the imported mesh vertices only, not against the generator.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Triangle, Vector3, type BufferGeometry } from 'three';
import { importModel } from '../../src/app/ingest';
import { FIXTURE_DIR, readFixture } from './helpers';

interface Pick { body: string; feature: 'shaft' | 'hole' | 'face'; edge: 'sharp' | 'fillet' | 'chamfer' | 'keyway'; surface_point_mm: number[]; radius_mm: number }
interface Joint { name: string; type: string; point_mm: number[]; dir: number[]; moving_bodies: string[]; pick: Pick[] }
interface NotAxis { body: string; kind: 'flat_rectangle' | 'fillet' | 'flat_side_of_bar'; surface_point_mm: number[] }
const truth = JSON.parse(readFileSync(`${FIXTURE_DIR}arm-cad/axes.json`, 'utf8')) as { units: string; joints: Joint[]; not_axes: NotAxis[] };

const v3 = (a: number[]) => new Vector3(a[0], a[1], a[2]);
/** Distance from point p to the line through `point` along unit `dir`. */
const lineDistance = (p: Vector3, point: Vector3, dir: Vector3) => p.clone().sub(point).cross(dir).length();

describe('arm-cad axes.json matches the imported model', async () => {
  const model = await importModel([readFixture('arm-cad', 'arm-cad.step')]);
  const mesh = (body: string) => model.meshes.find((m) => m.id === `arm-cad.${body}`);

  it('has the named bodies, and the names survive as mesh ids and nodes', () => {
    const bodies = ['base_plate', 'pedestal', 'turret', 'shoulder_pin', 'upper_arm', 'elbow_pin', 'forearm', 'tool_plate', 'screw_1', 'screw_2', 'screw_3', 'screw_4'];
    for (const b of bodies) {
      expect(mesh(b), b).toBeDefined();
      expect(model.links[0]!.meshes.find((r) => r.id === `arm-cad.${b}`)!.node.split('/').pop()).toBe(b);
    }
    expect(model.meshes).toHaveLength(bodies.length);
    expect(model.joints).toEqual([]);
    expect(new Set(model.meshes.map((m) => m.color.map((c) => c.toFixed(3)).join())).size).toBeGreaterThanOrEqual(8);
  });

  it('has three joints with unit directions and existing moving bodies', () => {
    expect(truth.units).toBe('mm');
    expect(truth.joints.map((j) => j.name)).toEqual(['base_yaw', 'shoulder', 'elbow']);
    for (const j of truth.joints) {
      expect(v3(j.dir).length()).toBeCloseTo(1, 12);
      expect(j.moving_bodies.length).toBeGreaterThan(0);
      for (const b of j.moving_bodies) expect(mesh(b), `${j.name}: ${b}`).toBeDefined();
      expect(j.pick.length).toBeGreaterThanOrEqual(2);
      expect(j.pick.some((p) => p.feature === 'hole')).toBe(true);
      expect(j.pick.some((p) => p.feature === 'shaft' || p.feature === 'face')).toBe(true);
    }
    expect(truth.joints[1]!.pick.some((p) => p.feature === 'face')).toBe(true);
    // the three axes are not all along a principal axis, and shoulder/elbow are parallel
    expect(Math.abs(truth.joints[1]!.dir[0]!)).toBeGreaterThan(0.1);
    expect(v3(truth.joints[1]!.dir).distanceTo(v3(truth.joints[2]!.dir))).toBeLessThan(1e-12);
  });

  for (const joint of truth.joints) {
    describe(joint.name, () => {
      const point = v3(joint.point_mm);
      const dir = v3(joint.dir);

      for (const pick of joint.pick) {
        it(`${pick.body} ${pick.feature} at (${pick.surface_point_mm.map((x) => x.toFixed(1)).join(', ')})`, () => {
          const q = v3(pick.surface_point_mm);
          const r = pick.radius_mm;
          // the stated point is on the cylinder (or on the axis for a face centre) ...
          expect(Math.abs(lineDistance(q, point, dir) - (pick.feature === 'face' ? 0 : r))).toBeLessThan(1e-6);
          // ... and the imported body really has surface vertices on that cylinder near it.
          const pos = mesh(pick.body)!.geometry.getAttribute('position');
          const near: Vector3[] = [];
          for (let i = 0; i < pos.count; i++) {
            const p = new Vector3().fromBufferAttribute(pos, i);
            if (p.distanceTo(q) <= 30 && Math.abs(lineDistance(p, point, dir) - r) < 0.05) near.push(p);
          }
          expect(near.length, 'vertices on the cylinder near the point').toBeGreaterThanOrEqual(3);
          if (pick.feature === 'face') {
            // the circle of a flat end face lies in a plane perpendicular to the axis through the stated centre
            const planeOffset = (p: Vector3) => p.clone().sub(q).dot(dir);
            const onPlane = near.filter((p) => Math.abs(planeOffset(p)) < 0.05);
            expect(onPlane.length).toBeGreaterThanOrEqual(3);
          }
        });
      }

      it('every vertex of a pin lies at or inside its radius around the axis, so the axis passes through it', () => {
        for (const pick of joint.pick.filter((p) => p.feature === 'shaft' && p.body.endsWith('_pin'))) {
          const pos = mesh(pick.body)!.geometry.getAttribute('position');
          for (let i = 0; i < pos.count; i++) {
            expect(lineDistance(new Vector3().fromBufferAttribute(pos, i), point, dir)).toBeLessThanOrEqual(pick.radius_mm + 0.05);
          }
        }
      });
    });
  }

  it('records, for every pick, what bounds its surface, with every edge kind present', () => {
    const edges = new Set(truth.joints.flatMap((j) => j.pick.map((p) => p.edge)));
    expect([...edges].sort()).toEqual(['chamfer', 'fillet', 'keyway', 'sharp']);
    for (const j of truth.joints) for (const p of j.pick) expect(['sharp', 'fillet', 'chamfer', 'keyway']).toContain(p.edge);
  });

  describe('not_axes', () => {
    const tris = (g: BufferGeometry) => {
      const pos = g.getAttribute('position');
      const idx = g.getIndex()!;
      return Array.from({ length: idx.count / 3 }, (_, t) => {
        const ids = [0, 1, 2].map((k) => idx.getX(3 * t + k));
        const tri = new Triangle(...ids.map((i) => new Vector3().fromBufferAttribute(pos, i)) as [Vector3, Vector3, Vector3]);
        return { ids, tri, n: tri.getNormal(new Vector3()) };
      });
    };
    const nearest = (g: BufferGeometry, q: Vector3) => {
      const all = tris(g);
      let best = 0;
      let bestD = Infinity;
      const c = new Vector3();
      all.forEach((t, i) => {
        const d = t.tri.closestPointToPoint(q, c).distanceTo(q);
        if (d < bestD) [best, bestD] = [i, d];
      });
      return { all, best, dist: bestD };
    };
    /** Radius of the flat patch around q: distance to the nearest boundary edge of the connected coplanar triangles. */
    const flatRadius = (g: BufferGeometry, q: Vector3) => {
      const { all, best } = nearest(g, q);
      const n0 = all[best]!.n;
      const byEdge = new Map<string, number[]>();
      const key = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
      all.forEach((t, i) => t.ids.forEach((v, k) => {
        const e = key(v, t.ids[(k + 1) % 3]!);
        byEdge.set(e, [...(byEdge.get(e) ?? []), i]);
      }));
      const patch = new Set([best]);
      const stack = [best];
      while (stack.length) {
        const t = all[stack.pop()!]!;
        t.ids.forEach((v, k) => {
          for (const o of byEdge.get(key(v, t.ids[(k + 1) % 3]!)) ?? []) {
            if (!patch.has(o) && all[o]!.n.dot(n0) > 0.9999) {
              patch.add(o);
              stack.push(o);
            }
          }
        });
      }
      const pos = g.getAttribute('position');
      let min = Infinity;
      const line = new (Vector3 as unknown as { new (): Vector3 })();
      void line;
      for (const i of patch) {
        const t = all[i]!;
        t.ids.forEach((v, k) => {
          const e = key(v, t.ids[(k + 1) % 3]!);
          if ((byEdge.get(e) ?? []).filter((o) => patch.has(o)).length === 1) {
            const a = new Vector3().fromBufferAttribute(pos, v);
            const b = new Vector3().fromBufferAttribute(pos, t.ids[(k + 1) % 3]!);
            const ab = b.clone().sub(a);
            const u = Math.min(1, Math.max(0, q.clone().sub(a).dot(ab) / ab.lengthSq()));
            min = Math.min(min, a.add(ab.multiplyScalar(u)).distanceTo(q));
          }
        });
      }
      return min;
    };

    for (const w of truth.not_axes) {
      it(`${w.kind} on ${w.body} at (${w.surface_point_mm.map((x) => x.toFixed(1)).join(', ')})`, () => {
        const g = mesh(w.body)!.geometry;
        const q = v3(w.surface_point_mm);
        expect(nearest(g, q).dist).toBeLessThan(0.05);
        if (w.kind === 'flat_rectangle' || w.kind === 'flat_side_of_bar') {
          expect(flatRadius(g, q)).toBeGreaterThanOrEqual(10);
        } else {
          // curved blend: the vertex normals of the nearest triangle differ, and no flat patch of 1 mm radius surrounds the point
          const { all, best } = nearest(g, q);
          const nrm = g.getAttribute('normal');
          const ns = all[best]!.ids.map((i) => new Vector3().fromBufferAttribute(nrm, i));
          const spread = Math.max(...ns.map((a) => Math.max(...ns.map((b) => Math.acos(Math.min(1, a.dot(b)))))));
          expect(spread).toBeGreaterThan(0.01);
          expect(flatRadius(g, q)).toBeLessThan(1);
        }
      });
    }
  });

  it('reports the tessellation facet angles (largest angle between neighbouring triangles) on fillets and cylinders', () => {
    const maxDihedral = (body: string, keep: (p: Vector3) => boolean) => {
      const g = mesh(body)!.geometry;
      const pos = g.getAttribute('position');
      const idx = g.getIndex()!;
      const ns: Vector3[] = [];
      const edge = new Map<string, number[]>();
      for (let t = 0; t < idx.count / 3; t++) {
        const ids = [0, 1, 2].map((k) => idx.getX(3 * t + k));
        const ps = ids.map((i) => new Vector3().fromBufferAttribute(pos, i));
        ns.push(new Triangle(ps[0], ps[1], ps[2]).getNormal(new Vector3()));
        ids.forEach((v, k) => {
          const o = ids[(k + 1) % 3]!;
          if (!keep(ps[k]!) || !keep(ps[(k + 1) % 3]!)) return;
          const key = v < o ? `${v},${o}` : `${o},${v}`;
          edge.set(key, [...(edge.get(key) ?? []), t]);
        });
      }
      let max = 0;
      for (const [, ts] of edge) if (ts.length === 2) max = Math.max(max, (Math.acos(Math.min(1, ns[ts[0]!]!.dot(ns[ts[1]!]!))) * 180) / Math.PI);
      return max;
    };
    // Shoulder pin is along the shoulder axis: use distance from the axis to separate cylinder side (5) from blend.
    const j = truth.joints[1]!;
    const dist = (p: Vector3) => lineDistance(p, v3(j.point_mm), v3(j.dir));
    const cylinder = maxDihedral('shoulder_pin', (p) => dist(p) > 4.99);
    const blend = maxDihedral('shoulder_pin', (p) => dist(p) < 4.99);
    const screw = maxDihedral('screw_1', () => true);
    console.log(`facet angles (deg): shoulder_pin cylinder side ${cylinder.toFixed(1)}, shoulder_pin fillet+flat ends ${blend.toFixed(1)}, screw (cylinder+flat) ${screw.toFixed(1)}`);
    expect(cylinder).toBeGreaterThan(0);
  });
});
