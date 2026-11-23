import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Vector3 } from 'three';
import { expect } from 'vitest';
import { computeLinkPoses, DesignSchema, meshPoseMatrix, parseLibrary, parseRules, type Design, type Joint, type Library, type Link } from '@core';

export const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');

export function readText(rel: string): string {
  return readFileSync(resolve(ROOT, rel), 'utf8');
}

export function loadLibrary(): Library {
  return parseLibrary(readText('library/parts.yaml'));
}

export function loadRules() {
  return parseRules(readText('rules/wiring.yaml'));
}

/** A fresh copy of the fully populated valid fixture, with defaults applied. */
export function fullDesign(): Design {
  return DesignSchema.parse(JSON.parse(readText('tests/core/fixtures/valid/full.json')));
}

export const IDQ: [number, number, number, number] = [0, 0, 0, 1];

export function mkLink(id: string): Link {
  return { id, name: id, meshes: [] };
}

export function mkJoint(id: string, parent: string, child: string, extra: Partial<Joint> = {}): Joint {
  return {
    id,
    name: id,
    type: 'fixed',
    parent,
    child,
    origin: { p_mm: [0, 0, 0], q: IDQ },
    axis: [0, 0, 1],
    value: 0,
    ...extra,
  };
}

/** An empty design whose scene is replaced by the given links and joints. */
export function sceneDesign(links: Link[], joints: Joint[]): Design {
  const d = DesignSchema.parse({ schema: 1 });
  d.scene.links = links;
  d.scene.joints = joints;
  return d;
}

export type V = [number, number, number];

export const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a: V, s: number): V => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const unit = (a: V): V => scale(a, 1 / Math.hypot(...a));

/** Rodrigues: rotate point `x` by `angle` about the line through `c` along `d`. */
export function rotateAbout(x: V, c: V, d: V, angle: number): V {
  const k = unit(d);
  const v = sub(x, c);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const r = add(add(scale(v, cos), scale(cross(k, v), sin)), scale(k, dot(k, v) * (1 - cos)));
  return add(r, c);
}

/** Where an imported vertex `x` of mesh `meshId` is in the world at the given joint values. */
export function worldPoint(design: Design, meshId: string, x: V, values: Record<string, number> = {}): V {
  const zeros: Record<string, number> = {};
  for (const j of design.scene.joints) zeros[j.id] = 0;
  const link = design.scene.links.find((l) => l.meshes.some((m) => m.id === meshId))!;
  const mesh = link.meshes.find((m) => m.id === meshId)!;
  const linkPose = computeLinkPoses(design.scene, { ...zeros, ...values }).get(link.id)!;
  const p = new Vector3(...x).applyMatrix4(meshPoseMatrix(mesh)).applyMatrix4(linkPose);
  return [p.x, p.y, p.z];
}

export function expectClose(actual: V, expected: V, tolerance = 1e-9) {
  for (let i = 0; i < 3; i++) expect(Math.abs(actual[i]! - expected[i]!), `component ${i}: ${actual} vs ${expected}`).toBeLessThan(tolerance);
}


/** Complete elliptic integrals K(k) and E(k) (modulus k, 0 <= k < 1) by the arithmetic-geometric mean. */
export function ellipticKE(k: number): { K: number; E: number } {
  let a = 1;
  let b = Math.sqrt(1 - k * k);
  let c = k;
  let sum = 0.5 * c * c; // 2^(n-1) c_n^2 for n = 0
  let pow = 0.5;
  for (let n = 0; n < 40 && Math.abs(c) > 1e-17; n++) {
    const an = (a + b) / 2;
    c = (a - b) / 2;
    b = Math.sqrt(a * b);
    a = an;
    pow *= 2;
    sum += pow * c * c;
  }
  const K = Math.PI / (2 * a);
  return { K, E: K * (1 - sum) };
}
