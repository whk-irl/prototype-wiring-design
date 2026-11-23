import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { Box3, Matrix4, Vector3, type BufferGeometry } from 'three';
import { expect } from 'vitest';
import { computeLinkPoses } from '@core';
import type { ImportedModel, ImportFile } from '../../src/app/ingest';

/** Vitest runs from the repository root. (`import.meta.url` is not a file URL under jsdom.) */
export const FIXTURE_DIR = resolve(process.cwd(), 'public', 'fixtures').replaceAll('\\', '/') + '/';

/** Node has no DOMParser; the URDF importer needs one. Tests that run under jsdom have it already. */
export function installDomParser(): void {
  (globalThis as { DOMParser?: unknown }).DOMParser ??= new JSDOM('').window.DOMParser;
}

export function toArrayBuffer(buf: Uint8Array): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

export function readFixture(scene: string, path: string): ImportFile {
  return { path, data: toArrayBuffer(readFileSync(`${FIXTURE_DIR}${scene}/${path}`)) };
}

export function textFile(path: string, text: string): ImportFile {
  return { path, data: toArrayBuffer(new TextEncoder().encode(text)) };
}

/** Recursive comparison: numbers within `tol`, everything else strictly equal. */
export function expectClose(actual: unknown, expected: unknown, tol: number, path = '$'): void {
  if (typeof expected === 'number') {
    expect(typeof actual, path).toBe('number');
    expect(Math.abs((actual as number) - expected), `${path}: ${actual} vs ${expected}`).toBeLessThanOrEqual(tol);
  } else if (Array.isArray(expected)) {
    expect(Array.isArray(actual), path).toBe(true);
    expect((actual as unknown[]).length, `${path} length`).toBe(expected.length);
    expected.forEach((e, i) => expectClose((actual as unknown[])[i], e, tol, `${path}[${i}]`));
  } else if (expected && typeof expected === 'object') {
    expect(actual && typeof actual === 'object', path).toBeTruthy();
    expect(Object.keys(actual as object).sort(), `${path} keys`).toEqual(Object.keys(expected).sort());
    for (const k of Object.keys(expected)) expectClose((actual as Record<string, unknown>)[k], (expected as Record<string, unknown>)[k], tol, `${path}.${k}`);
  } else {
    expect(actual, path).toEqual(expected);
  }
}

export function triCount(g: BufferGeometry): number {
  return (g.getIndex()?.count ?? 0) / 3;
}

export function boxOf(geometry: BufferGeometry, matrix?: Matrix4): Box3 {
  const box = new Box3();
  const pos = geometry.getAttribute('position');
  const v = new Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    if (matrix) v.applyMatrix4(matrix);
    box.expandByPoint(v);
  }
  return box;
}

/** Box of the whole model at the pose given by `values` (zero pose by default). */
export function modelBox(model: ImportedModel, values: Record<string, number> = {}): Box3 {
  const poses = computeLinkPoses({ sources: model.sources, links: model.links, joints: model.joints }, values);
  const box = new Box3();
  for (const mesh of model.meshes) box.union(boxOf(mesh.geometry, poses.get(mesh.link)));
  return box;
}

/** Signed volume of a closed triangle mesh; positive when the triangles face outward. */
export function signedVolume(g: BufferGeometry): number {
  const p = g.getAttribute('position');
  const idx = g.getIndex()!;
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  let vol = 0;
  for (let i = 0; i < idx.count; i += 3) {
    a.fromBufferAttribute(p, idx.getX(i));
    b.fromBufferAttribute(p, idx.getX(i + 1));
    c.fromBufferAttribute(p, idx.getX(i + 2));
    vol += a.dot(b.clone().cross(c)) / 6;
  }
  return vol;
}

/** Binary STL of an axis-aligned box [0,sx] x [0,sy] x [0,sz]. */
export function boxStl(sx: number, sy: number, sz: number): ArrayBuffer {
  const v = (i: number): [number, number, number] => [i & 1 ? sx : 0, i & 2 ? sy : 0, i & 4 ? sz : 0];
  // outward CCW quads, corner index = x + 2y + 4z
  const quads = [
    [0, 2, 3, 1], // -z
    [4, 5, 7, 6], // +z
    [0, 1, 5, 4], // -y
    [2, 6, 7, 3], // +y
    [0, 4, 6, 2], // -x
    [1, 3, 7, 5], // +x
  ];
  const tris = quads.flatMap((q) => [[q[0], q[1], q[2]], [q[0], q[2], q[3]]] as number[][]);
  const buf = new ArrayBuffer(84 + 50 * tris.length);
  const dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  tris.forEach((t, i) => {
    let o = 84 + 50 * i + 12; // normal left zero
    for (const k of t) for (const x of v(k!)) { dv.setFloat32(o, x, true); o += 4; }
  });
  return buf;
}
