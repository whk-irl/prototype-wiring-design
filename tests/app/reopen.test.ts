import { beforeEach, describe, expect, it } from 'vitest';
import { parseDesign, type Design } from '@core';
import { parseBuiltinUri, MAX_BUILTIN_TRIANGLES } from '../../src/app/demo/builtin';
import { openProject } from '../../src/app/io/load';
import { serializeForSave } from '../../src/app/io/saveGuard';
import { isDirty, useApp } from '../../src/app/state/store';
import { armDesignWithZones, designFile, fileOf, loadLibrary, SHA_B, stubImporter, type StubCall } from './helpers';

const library = loadLibrary();
const s = () => useApp.getState();
const noticeText = () => s().notices.map((n) => `${n.title} ${n.details.join(' ')}`).join('\n');

beforeEach(() => {
  useApp.setState({ library, notices: [], hiddenZones: {}, componentWarnings: {} });
  s().replaceDesign(armDesignWithZones());
});

describe('reopen', () => {
  it('keeps zones and components when the model file is missing, and leaves the design clean', async () => {
    const d = armDesignWithZones();
    await openProject(designFile(d), [], stubImporter());
    expect(s().design.zones.map((z) => z.id)).toEqual(['mount-1', 'mount-2']);
    expect(s().design.components[0]!.zone).toBe('mount-1');
    expect(isDirty(s())).toBe(false);
    expect(noticeText()).toMatch(/arm\.glb/);
    expect(noticeText()).toMatch(/kept/i);
  });

  it('passes every supplied file to the importer, with the stored id prefix and unit', async () => {
    const calls: StubCall[] = [];
    const d = armDesignWithZones();
    await openProject(designFile(d), [fileOf('arm.glb'), fileOf('arm.bin'), fileOf('tex.png')], stubImporter(undefined, calls));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.paths).toEqual(['arm.glb', 'arm.bin', 'tex.png']);
    expect(calls[0]!.options?.idPrefix).toBe('demo');
    expect(calls[0]!.options?.unitlessAs).toBe('m');
    expect(isDirty(s())).toBe(false);
    expect(s().design.zones).toHaveLength(2);
  });

  it('warns when the model file hash changed', async () => {
    await openProject(designFile(armDesignWithZones()), [fileOf('arm.glb')], stubImporter(SHA_B));
    expect(noticeText()).toMatch(/changed/i);
    expect(noticeText()).toMatch(/same faces/i);
    expect(s().design.zones).toHaveLength(2);
  });

  it('drops only the zones of a mesh whose triangle count changed, as an undoable change', async () => {
    const d = armDesignWithZones();
    const bad: Design = {
      ...d,
      scene: {
        ...d.scene,
        links: d.scene.links.map((l) => ({ ...l, meshes: l.meshes.map((m) => (m.id === 'demo.base.plate' ? { ...m, tri_count: 999 } : m)) })),
      },
    };
    await openProject(designFile(bad), [fileOf('arm.glb')], stubImporter());
    expect(s().design.zones.map((z) => z.id)).toEqual(['mount-2']);
    expect(s().design.components[0]!.zone).toBeUndefined();
    expect(s().design.scene.links[0]!.meshes.find((m) => m.id === 'demo.base.plate')!.tri_count).toBe(12);
    expect(isDirty(s())).toBe(true);
    expect(noticeText()).toMatch(/Plate top/);
    s().undo();
    expect(s().design.zones.map((z) => z.id)).toEqual(['mount-1', 'mount-2']);
    expect(isDirty(s())).toBe(false);
  });
});

describe('save guard', () => {
  it('accepts a good design and the bytes reopen', () => {
    const r = serializeForSave(armDesignWithZones(), library);
    expect(r.ok).toBe(true);
    if (r.ok) expect(parseDesign(JSON.parse(r.text), library).ok).toBe(true);
  });

  it('refuses bytes that would not reopen', () => {
    const d = armDesignWithZones();
    const broken: Design = { ...d, components: [{ ...d.components[0]!, pose: { p_mm: [Number.NaN, 0, 0], q: [0, 0, 0, 1] } }] };
    const r = serializeForSave(broken, library);
    expect(r.ok).toBe(false);
  });
});

describe('built-in model uris', () => {
  it('caps the triangle count', () => {
    expect(parseBuiltinUri('builtin:perf-1000000000')).toEqual({ kind: 'perf', triangles: MAX_BUILTIN_TRIANGLES });
    expect(MAX_BUILTIN_TRIANGLES).toBe(5_000_000);
  });
  it('rejects malformed built-in uris with a readable error', () => {
    expect(() => parseBuiltinUri('builtin:perf-abc')).toThrow(/built-in/);
    expect(() => parseBuiltinUri('builtin:nope')).toThrow(/built-in/);
    expect(parseBuiltinUri('arm.glb')).toBeNull();
    expect(parseBuiltinUri('builtin:demo-arm')).toEqual({ kind: 'demo-arm' });
  });
});
