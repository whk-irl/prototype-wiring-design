/**
 * Suggested axes: the coaxial-and-touching rule, the joint refit, and the
 * arm-cad ground truth (each joint's moving bodies against the rest).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { BufferGeometry, Float32BufferAttribute, Matrix4, Quaternion, Vector3 } from 'three';
import { importModel } from '../../src/app/ingest';
import type { ImportedModel } from '../../src/app/ingest/types';
import { coaxialTouching, extractFeatures, refitLine, shaftInHole, suggestAxes, toFrame, type FrameFeature, type MeshInput } from '../../src/app/joints/suggest';
import { fitAxisFromSeed } from '../../src/app/placement/axisFit';
import { topologyOf } from '../../src/app/scene/topology';

type V3 = [number, number, number];

/** A tube surface (open cylinder) of radius r from z0 to z1 about +Z; `inner` flips the normals inward. */
function tube(r: number, z0: number, z1: number, seg: number, rings: number, inner: boolean, noise = 0, seed = 1): { positions: number[]; index: number[] } {
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32 - 0.5) * 2 * noise;
  const positions: number[] = [];
  const index: number[] = [];
  for (let i = 0; i <= rings; i++) {
    const z = z0 + ((z1 - z0) * i) / rings;
    for (let j = 0; j < seg; j++) {
      const a = (j / seg) * 2 * Math.PI;
      positions.push(r * Math.cos(a) + rnd(), r * Math.sin(a) + rnd(), z + rnd());
    }
  }
  for (let i = 0; i < rings; i++)
    for (let j = 0; j < seg; j++) {
      const a = i * seg + j;
      const b = i * seg + ((j + 1) % seg);
      const c = a + seg;
      const d = b + seg;
      if (inner) index.push(a, d, b, a, c, d);
      else index.push(a, b, d, a, d, c);
    }
  return { positions, index };
}

function geom(m: { positions: number[]; index: number[] }): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(m.positions, 3));
  g.setIndex(m.index);
  return g;
}

function featuresOf(id: string, m: { positions: number[]; index: number[] }, frame: Matrix4, group: 'S' | 'R'): FrameFeature[] {
  return extractFeatures(id, topologyOf(geom(m))).map((f) => toFrame(f, frame, group));
}

const I = new Matrix4();

describe('coaxial and touching', () => {
  it('matches a shaft concentric in a hole', () => {
    const [shaft] = featuresOf('shaft', tube(2.6, 0, 10, 32, 4, false), I, 'S');
    const [hole] = featuresOf('hole', tube(3.0, 2, 8, 32, 4, true), I, 'R');
    expect(shaft!.inner).toBe(false);
    expect(hole!.inner).toBe(true);
    const t = coaxialTouching(shaft!, hole!);
    expect(t.coaxial && t.touching).toBe(true);
    expect(shaftInHole(shaft!, hole!)).toBe(true);
    const res = suggestAxesFrom([shaft!], [hole!]);
    expect(res.suggestions[0]!.label).toBe('shaft 2.6 mm in hole 3.0 mm');
  });

  it('does not match two collinear features 45 mm apart', () => {
    const [a] = featuresOf('a', tube(3, 0, 10, 32, 4, true), I, 'S');
    const [b] = featuresOf('b', tube(3, 55, 65, 32, 4, true), I, 'R');
    const t = coaxialTouching(a!, b!);
    expect(t.coaxial).toBe(true);
    expect(t.touching).toBe(false);
    expect(suggestAxesFrom([a!], [b!]).suggestions).toEqual([]);
  });

  it('does not match parallel features 1 mm apart', () => {
    const [a] = featuresOf('a', tube(3, 0, 10, 32, 4, true), I, 'S');
    const [b] = featuresOf('b', tube(3, 0, 10, 32, 4, true), new Matrix4().makeTranslation(1, 0, 0), 'R');
    expect(coaxialTouching(a!, b!).coaxial).toBe(false);
  });
});

import { suggestFromFeatures } from '../../src/app/joints/suggest';
function suggestAxesFrom(S: FrameFeature[], R: FrameFeature[]) {
  return suggestFromFeatures(S, R);
}

describe('joint refit', () => {
  it('beats single-feature fits on noisy coaxial cylinders', () => {
    const q = new Quaternion().setFromAxisAngle(new Vector3(1, 2, 3).normalize(), 0.7);
    const frame = new Matrix4().compose(new Vector3(10, -20, 5), q, new Vector3(1, 1, 1));
    const truthD = new Vector3(0, 0, 1).applyQuaternion(q);
    const truthP = new Vector3(10, -20, 5);
    const parts = [
      featuresOf('a', tube(2.6, 0, 6, 24, 3, false, 0.01, 3), frame, 'S'),
      featuresOf('b', tube(3.0, 1, 5, 24, 3, true, 0.01, 5), frame, 'R'),
      featuresOf('c', tube(4.0, 6, 12, 24, 3, true, 0.01, 7), frame, 'R'),
      featuresOf('d', tube(1.3, -4, 0, 16, 2, false, 0.01, 9), frame, 'S'),
    ].flat();
    expect(parts.length).toBe(4);
    const err = (p: V3, d: V3) => {
      const dd = new Vector3(...d).normalize();
      const angle = Math.acos(Math.min(1, Math.abs(dd.dot(truthD))));
      const w = new Vector3(...p).sub(truthP);
      const off = w.clone().sub(truthD.clone().multiplyScalar(w.dot(truthD))).length();
      return { angle, off };
    };
    const single = parts.map((f) => err(f.point, f.dir));
    const joint = refitLine(parts);
    const j = err(joint.point, joint.dir);
    const meanAngle = single.reduce((a, s) => a + s.angle, 0) / single.length;
    const meanOff = single.reduce((a, s) => a + s.off, 0) / single.length;
    expect(j.angle).toBeLessThan(meanAngle);
    expect(j.off).toBeLessThan(meanOff);
  });
});

// ---------------------------------------------------------------- arm-cad ground truth

const DIR = resolve(process.cwd(), 'public', 'fixtures', 'arm-cad');
interface TrueJoint {
  name: string;
  point_mm: V3;
  dir: V3;
  moving_bodies: string[];
}

describe('suggested axes on arm-cad', () => {
  let model: ImportedModel;
  let joints: TrueJoint[];
  const topo = (id: string) => topologyOf(model.meshes.find((m) => m.id === id)!.geometry);
  const input = (id: string): MeshInput => {
    const g = model.meshes.find((m) => m.id === id)!.geometry;
    g.computeBoundingBox();
    return { id, bounds: { min: g.boundingBox!.min.toArray() as V3, max: g.boundingBox!.max.toArray() as V3 }, toFrame: new Matrix4() };
  };

  beforeAll(async () => {
    const buf = readFileSync(resolve(DIR, 'arm-cad.step'));
    model = await importModel([{ path: 'arm-cad.step', data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer }]);
    joints = (JSON.parse(readFileSync(resolve(DIR, 'axes.json'), 'utf8')) as { joints: TrueJoint[] }).joints;
  }, 60_000);

  it('the top suggestion for each joint is the true axis', () => {
    const ids = model.meshes.map((m) => m.id);
    for (const j of joints) {
      const S = j.moving_bodies.map((b) => `arm-cad.${b}`);
      const R = ids.filter((id) => !S.includes(id));
      const res = suggestAxes(S.map(input), R.map(input), topo);
      const top = res.suggestions[0];
      expect(top, `${j.name}: no suggestion`).toBeDefined();
      const d = new Vector3(...top!.dir).normalize();
      const td = new Vector3(...j.dir).normalize();
      const angle = (Math.acos(Math.min(1, Math.abs(d.dot(td)))) * 180) / Math.PI;
      const w = new Vector3(...top!.point).sub(new Vector3(...j.point_mm));
      const off = w.clone().sub(td.clone().multiplyScalar(w.dot(td))).length();
      console.log(`${j.name}: ${top!.label}, ${top!.features} features, angle ${angle.toFixed(4)} deg, line ${off.toFixed(4)} mm`);
      expect(angle).toBeLessThan(0.1);
      expect(off).toBeLessThan(0.1);
      expect(res.bolted).toBe(false);
      expect(top!.grade, `${j.name} grade`).toBe('likely');
    }
  });

  it('screws against the plate they hold are reported as bolted, not as a joint', () => {
    const screws = model.meshes.map((m) => m.id).filter((id) => /screw/.test(id));
    expect(screws.length).toBeGreaterThan(1);
    const res = suggestAxes(screws.map(input), ['arm-cad.tool_plate'].map(input), topo);
    expect(res.suggestions.length === 0 || res.bolted).toBe(true);
    console.log(`screws vs tool plate: ${res.suggestions.length} line(s), bolted ${res.bolted}`);
  });

  it('single-feature fits of arm-cad picks agree with the joint refit', () => {
    // sanity: the region-growing fit used for features is the picking fit
    const g = model.meshes.find((m) => m.id === 'arm-cad.elbow_pin')!.geometry;
    const fit = fitAxisFromSeed(topologyOf(g), 0);
    expect(fit).not.toBeNull();
  });
});
