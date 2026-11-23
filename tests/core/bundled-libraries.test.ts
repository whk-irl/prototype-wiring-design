// The bundled libraries must agree with each other and with the files they point to.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findConnector, parseCableLibrary, parseConnectorLibrary, parseLibrary, type Connector, type Part } from '@core';
import { readText, ROOT } from './helpers';

const partFiles = existsSync(resolve(ROOT, 'library'))
  ? readdirSync(resolve(ROOT, 'library'))
      .filter((f) => /^parts.*\.yaml$/.test(f))
      .sort()
  : [];
const hasConnectors = existsSync(resolve(ROOT, 'library/connectors.yaml'));
const connectors = hasConnectors ? parseConnectorLibrary(readText('library/connectors.yaml')) : undefined;
const loaded = connectors ? partFiles.map((f) => ({ file: f, parts: parseLibrary(readText(`library/${f}`), connectors).parts })) : [];
const allParts: Array<{ file: string; part: Part }> = loaded.flatMap((l) => l.parts.map((part) => ({ file: l.file, part })));

describe('bundled libraries', () => {
  it('library/connectors.yaml exists', () => {
    expect(hasConnectors, 'library/connectors.yaml is missing').toBe(true);
  });

  it('parts, cables and connectors parse together, and every port is a size its connector comes in', () => {
    expect(connectors!.connectors.length).toBeGreaterThan(0);
    expect(partFiles.length).toBeGreaterThan(0);
    expect(allParts.length).toBeGreaterThan(0);
    expect(parseCableLibrary(readText('library/cables.yaml')).cables.length).toBeGreaterThan(0);
  });

  it('every connector id listed on a cable type is in the connector library', () => {
    for (const cable of parseCableLibrary(readText('library/cables.yaml')).cables) {
      for (const id of cable.connectors) expect(findConnector(connectors!, id), `cable "${cable.id}" lists connector "${id}"`).toBeDefined();
    }
  });

  it('part ids are unique across all library/parts*.yaml files', () => {
    const where = new Map<string, string>();
    const clashes: string[] = [];
    for (const { file, part } of allParts) {
      const first = where.get(part.id);
      if (first) clashes.push(`"${part.id}" is in ${first} and ${file}`);
      else where.set(part.id, file);
    }
    expect(clashes).toEqual([]);
  });
});

describe('bundled 3D models', () => {
  const dir = resolve(ROOT, 'public/parts');
  const glbs = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.glb')) : [];
  const withModel = allParts.filter(({ part }) => part.model);

  it.each(withModel.map(({ part }) => [part.id, part] as const))('%s: its model file exists, matches its hash and is small', (_id, part) => {
    const model = part.model!;
    const path = resolve(dir, model.uri);
    expect(existsSync(path), `public/parts/${model.uri} is missing`).toBe(true);
    const bytes = readFileSync(path);
    expect(model.sha256, `part "${part.id}" has no model.sha256`).toBeDefined();
    expect(createHash('sha256').update(bytes).digest('hex'), `sha256 of ${model.uri}`).toBe(model.sha256);
    expect(bytes.length, `size of ${model.uri}`).toBeLessThan(450 * 1024);
  });

  it('the models together are under 12 MB', () => {
    const total = glbs.reduce((s, f) => s + statSync(resolve(dir, f)).size, 0);
    expect(total).toBeLessThan(12 * 1024 * 1024);
  });

  it('every GLB in public/parts is used by a part', () => {
    const used = new Set(withModel.map(({ part }) => part.model!.uri));
    expect(glbs.filter((f) => !used.has(f))).toEqual([]);
  });
});

// ---------------------------------------------------------------- geometry of every part

type V3 = [number, number, number];
/** Rotate v by the quaternion q = [x, y, z, w]. */
function rotate(q: readonly number[], v: V3): V3 {
  const [x, y, z, w] = q as [number, number, number, number];
  const t: V3 = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])];
  return [v[0] + w * t[0] + (y * t[2] - z * t[1]), v[1] + w * t[1] + (z * t[0] - x * t[2]), v[2] + w * t[2] + (x * t[1] - y * t[0])];
}
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const isHeader = (c: Connector) => /^pin-(header|socket)/.test(c.id);

function geometryProblems(part: Part): string[] {
  const out: string[] = [];
  const [sx, sy, sz] = part.body.size_mm;
  for (const port of part.ports) {
    const who = `${part.id} port "${port.id}"`;
    const norm = Math.hypot(...port.pose.q);
    if (Math.abs(norm - 1) > 1e-3) out.push(`${who}: quaternion has length ${norm}`);
    const exit = rotate(port.pose.q, [1, 0, 0]);
    const row = rotate(port.pose.q, [0, 1, 0]);
    const nearest = Math.max(Math.abs(exit[0]), Math.abs(exit[1]), Math.abs(exit[2]));
    const off = Math.hypot(...exit.map((v) => Math.abs(v)).map((v) => (v === nearest ? v - Math.round(v) : v)));
    if (nearest < 1 - 1e-3 || off > 1e-3) out.push(`${who}: exit direction ${exit.map((v) => v.toFixed(4))} is not along an axis`);
    if (Math.abs(dot(exit, row)) > 1e-3) out.push(`${who}: row direction ${row.map((v) => v.toFixed(4))} is not perpendicular to the exit`);

    const connector = findConnector(connectors!, port.connector);
    if (connector && isHeader(connector)) {
      if (port.ways === undefined) {
        out.push(`${who}: a header port has no ways`);
        continue;
      }
      const length = (port.ways / connector.rows - 1) * connector.pitch_mm!;
      const axis = [0, 1, 2].reduce((best, i) => (Math.abs(row[i]!) > Math.abs(row[best]!) ? i : best), 0);
      const extent = [sx, sy, sz][axis]!;
      if (length > extent + 1) out.push(`${who}: its row is ${length.toFixed(2)} mm long but the part is ${extent} mm along axis ${'xyz'[axis]}`);
    }
  }
  for (const [i, h] of part.mounting_holes.entries()) {
    if (Math.abs(h.p_mm[0]) > sx / 2 || Math.abs(h.p_mm[1]) > sy / 2) out.push(`${part.id}: mounting hole ${i + 1} lies outside the envelope`);
  }
  return out;
}

describe('every bundled part', () => {
  it.each(allParts.map(({ file, part }) => [`${part.id} (${file})`, part] as const))('%s: ports and holes are well formed', (_n, part) => {
    expect(geometryProblems(part)).toEqual([]);
  });
});

describe('licence notice', () => {
  it('public/parts/NOTICE.md is up to date with the YAML (tools/parts-notice.ts --check)', () => {
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'tools/parts-notice.ts', '--check'], { cwd: ROOT, encoding: 'utf8' });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });
});
