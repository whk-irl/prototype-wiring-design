/**
 * Built-in procedural models: the demo arm and the performance test model.
 * They need no files and no importer. Their source `uri` starts with
 * `builtin:` so a saved design that uses one can be reopened without files.
 */
import { BoxGeometry, BufferGeometry, CylinderGeometry, SphereGeometry } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Joint, Link, Source } from '@core';
import type { ImportedMesh, ImportedModel } from '../ingest/types';

export const DEMO_ARM_URI = 'builtin:demo-arm';
export const PERF_URI_PREFIX = 'builtin:perf-';

const deg = (d: number) => (d * Math.PI) / 180;

/** Keep only position + normal, indexed, no groups (the import contract). */
function clean(g: BufferGeometry): BufferGeometry {
  const out = g.index ? g : g.toNonIndexed();
  for (const name of Object.keys(out.attributes)) if (name !== 'position' && name !== 'normal') out.deleteAttribute(name);
  out.clearGroups();
  return out;
}

function box(sx: number, sy: number, sz: number, cx = 0, cy = 0, cz = 0): BufferGeometry {
  return clean(new BoxGeometry(sx, sy, sz).translate(cx, cy, cz));
}

/** Cylinder along `axis`, centred at (cx, cy, cz). */
function cyl(r: number, h: number, axis: 'x' | 'y' | 'z', cx = 0, cy = 0, cz = 0, seg = 40): BufferGeometry {
  const g = new CylinderGeometry(r, r, h, seg); // along Y
  if (axis === 'z') g.rotateX(Math.PI / 2);
  if (axis === 'x') g.rotateZ(Math.PI / 2);
  return clean(g.translate(cx, cy, cz));
}

function merge(...parts: BufferGeometry[]): BufferGeometry {
  const g = mergeGeometries(parts, false);
  if (!g) throw new Error('could not merge demo geometry');
  return g;
}

const srgb = (hex: number): [number, number, number] => {
  const c = [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255].map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return [c[0]!, c[1]!, c[2]!];
};

class ModelBuilder {
  sources: Source[];
  links: Link[] = [];
  joints: Joint[] = [];
  meshes: ImportedMesh[] = [];
  constructor(private source: Source) {
    this.sources = [source];
  }
  link(id: string, name: string, meshes: Array<{ id: string; geometry: BufferGeometry; color: number }>): void {
    this.links.push({
      id,
      name,
      meshes: meshes.map((m) => ({
        id: m.id,
        source: this.source.id,
        node: m.id,
        tri_count: Math.floor(m.geometry.index!.count / 3),
      })),
    });
    for (const m of meshes) this.meshes.push({ id: m.id, link: id, geometry: m.geometry, color: srgb(m.color) });
  }
  joint(j: Omit<Joint, 'value' | 'axis'> & { axis?: Joint['axis']; value?: number }): void {
    this.joints.push({ axis: [0, 0, 1], value: 0, ...j });
  }
  build(): ImportedModel {
    return { sources: this.sources, links: this.links, joints: this.joints, meshes: this.meshes, warnings: [] };
  }
}

/** A small 3-joint arm on a base, about 600 mm tall. */
export function demoArm(): ImportedModel {
  const b = new ModelBuilder({ id: 'demo', kind: 'builtin', uri: DEMO_ARM_URI, mm_per_unit: 1 });
  const grey = 0x5b6270;
  const light = 0xc9ccd1;
  const accent = 0xd08a2e;
  const blue = 0x3f6fa8;

  b.link('base', 'Base', [
    { id: 'demo.base.plate', geometry: box(260, 200, 12, 0, 0, 6), color: grey },
    { id: 'demo.base.housing', geometry: cyl(80, 40, 'z', 0, 0, 32), color: light },
  ]);
  b.link('turret', 'Turret', [
    { id: 'demo.turret.drum', geometry: cyl(60, 50, 'z', 0, 0, 25), color: blue },
    {
      id: 'demo.turret.yoke',
      geometry: merge(box(30, 20, 70, 0, 45, 75), box(30, 20, 70, 0, -45, 75), box(40, 110, 16, 0, 0, 58)),
      color: blue,
    },
  ]);
  b.link('upper_arm', 'Upper arm', [
    { id: 'demo.upper.hub', geometry: cyl(28, 68, 'y'), color: accent },
    { id: 'demo.upper.beam', geometry: box(46, 40, 220, 0, 0, 110), color: light },
    { id: 'demo.upper.motor', geometry: cyl(22, 40, 'y', 0, -42, 220), color: grey },
  ]);
  b.link('forearm', 'Forearm', [
    { id: 'demo.fore.hub', geometry: cyl(24, 40, 'y'), color: accent },
    { id: 'demo.fore.beam', geometry: box(34, 30, 180, 0, 0, 100), color: light },
  ]);
  b.link('tool', 'Tool flange', [{ id: 'demo.tool.flange', geometry: cyl(26, 14, 'z', 0, 0, 7), color: grey }]);

  b.joint({
    id: 'j1',
    name: 'Base yaw',
    type: 'revolute',
    parent: 'base',
    child: 'turret',
    origin: { p_mm: [0, 0, 52], q: [0, 0, 0, 1] },
    axis: [0, 0, 1],
    limit: { lower: deg(-170), upper: deg(170) },
  });
  b.joint({
    id: 'j2',
    name: 'Shoulder',
    type: 'revolute',
    parent: 'turret',
    child: 'upper_arm',
    origin: { p_mm: [0, 0, 95], q: [0, 0, 0, 1] },
    axis: [0, 1, 0],
    limit: { lower: deg(-90), upper: deg(90) },
    value: deg(20),
  });
  b.joint({
    id: 'j3',
    name: 'Elbow',
    type: 'revolute',
    parent: 'upper_arm',
    child: 'forearm',
    origin: { p_mm: [0, 0, 220], q: [0, 0, 0, 1] },
    axis: [0, 1, 0],
    limit: { lower: deg(-135), upper: deg(135) },
    value: deg(45),
  });
  b.joint({
    id: 'j_tool',
    name: 'Tool mount',
    type: 'fixed',
    parent: 'forearm',
    child: 'tool',
    origin: { p_mm: [0, 0, 190], q: [0, 0, 0, 1] },
  });
  return b.build();
}

/** About `triangles` triangles split over 50 sphere meshes on one link. */
export function perfModel(requested: number): ImportedModel {
  const triangles = clampTriangles(requested);
  const count = 50;
  const per = Math.max(80, triangles / count);
  // SphereGeometry(w, h) has about 2*w*(h-1) triangles; use h = w/2.
  const w = Math.max(8, Math.round(Math.sqrt(per)));
  const h = Math.max(4, Math.round(per / (2 * w)) + 1);
  const b = new ModelBuilder({ id: 'perf', kind: 'builtin', uri: `${PERF_URI_PREFIX}${Math.round(triangles)}`, mm_per_unit: 1 });
  const meshes: Array<{ id: string; geometry: BufferGeometry; color: number }> = [];
  const palette = [0xc9ccd1, 0x3f6fa8, 0xd08a2e, 0x5b6270, 0x7a9a5a];
  for (let i = 0; i < count; i++) {
    const x = (i % 10) - 4.5;
    const y = Math.floor(i / 10) - 2;
    const g = clean(new SphereGeometry(45, w, h).translate(x * 110, y * 110, 50));
    meshes.push({ id: `perf.m${i}`, geometry: g, color: palette[i % palette.length]! });
  }
  b.link('perf', 'Performance test', meshes);
  return b.build();
}

/** Largest performance model the app will build, from a URL or a design file. */
export const MAX_BUILTIN_TRIANGLES = 5_000_000;

export type BuiltinSpec = { kind: 'demo-arm' } | { kind: 'perf'; triangles: number };

/** Clamp a requested triangle count to 1 .. MAX_BUILTIN_TRIANGLES. */
export function clampTriangles(n: number): number {
  return Math.max(1, Math.min(MAX_BUILTIN_TRIANGLES, Math.round(n)));
}

/**
 * Parse a `builtin:` uri. Returns null for a uri that is not built in, and
 * throws a readable Error for a `builtin:` uri this build does not know.
 */
export function parseBuiltinUri(uri: string): BuiltinSpec | null {
  if (!uri.startsWith('builtin:')) return null;
  if (uri === DEMO_ARM_URI) return { kind: 'demo-arm' };
  if (uri.startsWith(PERF_URI_PREFIX)) {
    const text = uri.slice(PERF_URI_PREFIX.length);
    const n = /^[0-9]{1,12}$/.test(text) ? Number(text) : Number.NaN;
    if (Number.isFinite(n) && n > 0) return { kind: 'perf', triangles: clampTriangles(n) };
  }
  throw new Error(`"${uri.slice(0, 80)}" is not a built-in model this version knows (expected ${DEMO_ARM_URI} or ${PERF_URI_PREFIX}<triangles>).`);
}

/** Rebuild a built-in model from its source uri, or null if the uri is not built in. Throws for a malformed `builtin:` uri. */
export function builtinModel(uri: string): ImportedModel | null {
  const spec = parseBuiltinUri(uri);
  if (!spec) return null;
  if (spec.kind === 'demo-arm') return demoArm();
  // Keep the requested uri so mesh ids and the source match the design.
  const m = perfModel(spec.triangles);
  return m;
}
