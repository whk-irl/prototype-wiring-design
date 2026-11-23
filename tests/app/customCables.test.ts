/**
 * The user's own cable types: the form, the merged library, the design's own
 * copies (`design.cable_types`) and the store rules, and the thumbnail drawing.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IDBFactory } from 'fake-indexeddb';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Box3, Vector3 } from 'three';
import { awgDiameterMm, cableTypeFromSpec, emptyDesign, findCableType, parseCableLibrary, type CableType, type Design } from '@core';
import { serializeForSave } from '../../src/app/io/saveGuard';
import { listCustomCables } from '../../src/app/parts/store';
import { syncDesignCableTypes } from '../../src/app/state/designParts';
import { runtimeCableLibrary, watchRuntimeLibrary } from '../../src/app/state/library';
import { useApp } from '../../src/app/state/store';
import { FAMILY_LABEL, groupByFamily } from '../../src/app/ui/cableText';
import { deleteUserCable, designOnlyCableTypes, keepDesignCableTypes, saveUserCable } from '../../src/app/userCables/actions';
import { emptyCommon, evaluateForm, formFromSpec, specFromForm } from '../../src/app/userCables/form';
import { cableThumbKey, cableThumbObject } from '../../src/app/viewport/cableThumb';
import { addWire, removeWire } from '../../src/app/wires/routeEdit';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const base = parseCableLibrary(readFileSync(resolve(ROOT, 'library/cables.yaml'), 'utf8'));
const s = () => useApp.getState();
const scene = { sources: [], links: [{ id: 'L', name: 'L', meshes: [] }], joints: [] };
const FPC = { ways: '12', pitch_mm: '0.5', thickness_mm: '0.12' };

let unwatch: (() => void) | null = null;
beforeEach(() => {
  (globalThis as { indexedDB?: unknown }).indexedDB = new IDBFactory();
  unwatch?.();
  useApp.setState({ notices: [], baseCableLibrary: base, customCables: [], cableLibrary: base });
  s().replaceDesign({ ...emptyDesign('t'), scene });
  unwatch = watchRuntimeLibrary();
});
afterAll(() => {
  unwatch?.();
  delete (globalThis as { indexedDB?: unknown }).indexedDB;
});

function drawWith(typeId: string): string {
  let id = '';
  s().commit((d) => {
    const r = addWire(d, { type: typeId, count: 1, twisted: false, sleeve_wall_mm: 0 }, [
      { link: 'L', p: [0, 0, 0], n: [0, 0, 1] },
      { link: 'L', p: [50, 0, 0], n: [0, 0, 1] },
    ]);
    id = r.cableId;
    return r.design;
  });
  return id;
}

describe('the form', () => {
  it('an FPC from ways, pitch and thickness: the cable and the figures worked out, as the core builds them', () => {
    const r = evaluateForm('fpc', FPC, { ...emptyCommon(), flexing: true });
    expect(r.problems).toEqual([]);
    const core = cableTypeFromSpec({ kind: 'flat_flex', construction: 'fpc', ways: 12, pitch_mm: 0.5, thickness_mm: 0.12, flexing: true }, 'custom-preview');
    expect(r.type).toEqual(core.type);
    expect(r.derived).toEqual(core.derived);
    expect(r.type!.section).toMatchObject({ shape: 'flat', thickness_mm: 0.12 });
    expect(r.type!.family).toBe('ffc');
    expect(FAMILY_LABEL.ffc).toBe('Flat flex (FFC, FPC)');
  });

  it('problems are plain sentences naming the field, and there is no cable until they are fixed', () => {
    const noThickness = evaluateForm('fpc', { ways: '12', pitch_mm: '0.5' }, emptyCommon());
    expect(noThickness.type).toBeUndefined();
    expect(noThickness.problems[0]!.message).toMatch(/thickness/i);
    expect(evaluateForm('wire', { awg: 'twenty' }, emptyCommon()).problems).toEqual([
      { field: 'awg', message: 'Gauge must be a plain number such as 0.5 (digits, with one decimal point or comma).' },
    ]);
    expect(evaluateForm('wire', {}, emptyCommon()).problems).toEqual([{ field: 'awg', message: 'Gauge is needed.' }]);
    expect(evaluateForm('ffc', { ways: '2.5', pitch_mm: '0' }, emptyCommon()).problems).toEqual([
      { field: 'ways', message: 'Ways must be a whole number.' },
      { field: 'pitch_mm', message: 'Pitch must be at least 0.1 mm.' },
    ]);
    // The new upper bounds, in plain words with the unit.
    expect(evaluateForm('round_cable', { conductors: '4', od_mm: '150' }, emptyCommon()).problems).toEqual([{ field: 'od_mm', message: 'Outer diameter must be at most 100 mm.' }]);
    expect(evaluateForm('ffc', { ways: '300', pitch_mm: '0.5' }, emptyCommon()).problems).toEqual([{ field: 'ways', message: 'Ways must be at most 200.' }]);
    expect(evaluateForm('ffc', { ways: '10', pitch_mm: '30' }, emptyCommon()).problems).toEqual([{ field: 'pitch_mm', message: 'Pitch must be at most 25 mm.' }]);
    expect(evaluateForm('wire', { awg: '24' }, { ...emptyCommon(), bend_static_mm: '6000' }).problems).toEqual([
      { field: 'bend_static_mm', message: 'Bend radius, installed must be at most 5000 mm.' },
    ]);
    // A gauge outside the estimate's range needs a diameter or a wall: said in words, no cable.
    const fine = evaluateForm('wire', { awg: '40' }, emptyCommon());
    expect(fine.type).toBeUndefined();
    expect(fine.problems[0]!.message).toMatch(/outer diameter/);
    expect(evaluateForm('wire', { awg: '24' }, { ...emptyCommon(), source: 'datasheet.pdf' }).problems[0]!.message).toBe('Datasheet link must be a web address starting with https://.');
  });

  it('a stored spec re-opens the same form', () => {
    const common = { ...emptyCommon(), name: 'Camera FPC', flexing: true, basis: 'datasheet' as const, bend_static_mm: '2' };
    const spec = specFromForm('fpc', { ...FPC, layers: '2' }, common);
    const back = formFromSpec(spec);
    expect(back.kind).toBe('fpc');
    expect(specFromForm(back.kind, back.values, back.common)).toEqual(spec);
  });
});

describe('the merged cable library', () => {
  const mine = cableTypeFromSpec({ kind: 'wire', awg: 24 }, 'custom-wire-1').type;
  it("bundled + stored + the design's own; a stored type never takes a bundled one's place; the design's wins", () => {
    const fake = { ...mine, id: base.cables[0]!.id, name: 'Fake' };
    const lib = runtimeCableLibrary(base, { cable_types: [] }, [mine, fake])!;
    expect(findCableType(lib, base.cables[0]!.id)!.name).toBe(base.cables[0]!.name);
    expect(findCableType(lib, 'custom-wire-1')).toEqual(mine);
    const own = { ...mine, name: 'Design version' };
    expect(findCableType(runtimeCableLibrary(base, { cable_types: [own] }, [mine])!, 'custom-wire-1')!.name).toBe('Design version');
  });

  it("the user's own types head their family group", () => {
    const g = groupByFamily([...base.cables, mine]).find((x) => x.family === 'hookup_wire')!;
    expect(g.types[0]!.id).toBe('custom-wire-1');
  });
});

describe("a design's own cable types", () => {
  it('a wire using a custom type copies it into the design; it leaves with the last wire; undo keeps them together', async () => {
    const type = await saveUserCable(specFromForm('fpc', FPC, emptyCommon()));
    expect(type.id.startsWith('custom-')).toBe(true);
    const w = drawWith(type.id);
    expect(s().design.cable_types.map((t) => t.id)).toEqual([type.id]);
    s().commit((d) => removeWire(d, w));
    expect(s().design.cable_types).toEqual([]);
    s().undo();
    expect(s().design.cable_types.map((t) => t.id)).toEqual([type.id]);
    expect(serializeForSave(s().design, null).ok).toBe(true);
  });

  it('keeps working when the stored copy is deleted, and is offered to be kept again', async () => {
    const type = await saveUserCable(specFromForm('wire', { awg: '26' }, emptyCommon()));
    drawWith(type.id);
    const message = await deleteUserCable(type.id);
    expect(message).toMatch(/keeps its own copy/);
    expect(await listCustomCables()).toEqual([]);
    expect(findCableType(s().cableLibrary!, type.id)).toEqual(type);
    expect(designOnlyCableTypes(s().design, s().customCables).map((t) => t.id)).toEqual([type.id]);
    expect(await keepDesignCableTypes()).toEqual({ kept: [type.name], failed: [] });
    expect((await listCustomCables()).map((c) => c.type)).toEqual([type]);
  });

  it("editing a type the design uses changes the design's copy only when asked", async () => {
    const type = await saveUserCable(specFromForm('wire', { awg: '26' }, emptyCommon()));
    drawWith(type.id);
    await saveUserCable(specFromForm('wire', { awg: '20' }, emptyCommon()), { id: type.id, updateDesign: false });
    expect(s().design.cable_types[0]!.awg).toBe(26);
    expect(s().customCables[0]!.type.awg).toBe(20);
    await saveUserCable(specFromForm('wire', { awg: '22' }, emptyCommon()), { id: type.id, updateDesign: true });
    expect(s().design.cable_types[0]!.awg).toBe(22);
    s().undo();
    expect(s().design.cable_types[0]!.awg).toBe(26);
  });

  it('opening a design never writes the store; a stored cable is never given a bundled id', async () => {
    const theirs = cableTypeFromSpec({ kind: 'wire', awg: 30 }, 'custom-theirs-1').type;
    const d: Design = { ...emptyDesign('o'), scene, cable_types: [theirs], cables: [{ id: 'w1', name: 'W', connections: [], type: theirs.id, count: 1, twisted: false, sleeve_wall_mm: 0, reasons: [] }] };
    s().replaceDesign(d);
    expect(await listCustomCables()).toEqual([]);
    expect(findCableType(s().cableLibrary!, theirs.id)).toEqual(theirs);
    await expect(saveUserCable({ kind: 'wire', awg: 24 }, { id: base.cables[0]!.id })).rejects.toThrow(/not an id/);
  });

  it('sync leaves bundled types in design.cable_types alone', () => {
    const d: Design = { ...emptyDesign('o'), cable_types: [base.cables[0]!] };
    expect(syncDesignCableTypes(d, base)).toBe(d);
  });

});

describe('cable thumbnails', () => {
  const size = (t: CableType) => new Box3().setFromObject(cableThumbObject(t)).getSize(new Vector3());
  it('drawn at the real proportions: a wide thin FFC, a wire as a wire, a ribbon at its pitch', () => {
    const ffc = cableTypeFromSpec({ kind: 'flat_flex', construction: 'ffc', ways: 15, pitch_mm: 1, width_mm: 16, thickness_mm: 0.3 }, 'custom-a').type;
    const f = size(ffc);
    expect(f.y).toBeCloseTo(16, 6);
    expect(f.z).toBeGreaterThanOrEqual(0.3);
    expect(f.z).toBeLessThan(0.3 * 1.5); // strip plus the fingers on top
    const wire = cableTypeFromSpec({ kind: 'wire', awg: 24, od_mm: 1.3 }, 'custom-b').type;
    const w = size(wire);
    expect(w.y).toBeCloseTo(1.3, 6);
    expect(w.z).toBeCloseTo(1.3, 6);
    const ribbon = cableTypeFromSpec({ kind: 'ribbon', ways: 10, pitch_mm: 1.27 }, 'custom-c').type;
    expect(size(ribbon).y).toBeCloseTo(9 * 1.27 + Math.min(1.27, ribbon.section.shape === 'flat' ? ribbon.section.thickness_mm : 0), 6);
  });

  it('a single wire shows its conductor at the gauge size; the key follows the figures', () => {
    const wire = cableTypeFromSpec({ kind: 'wire', awg: 20, od_mm: 2 }, 'custom-b').type;
    const meshes: Array<{ r: number }> = [];
    cableThumbObject(wire).traverse((o) => {
      const g = (o as { geometry?: { parameters?: { radiusTop?: number } } }).geometry;
      if (g?.parameters?.radiusTop !== undefined) meshes.push({ r: g.parameters.radiusTop });
    });
    const radii = meshes.map((m) => m.r);
    expect(radii).toContain(1); // the jacket, at the real 2 mm outer diameter
    expect(radii).toContain(awgDiameterMm(20) / 2); // the conductor, at the gauge's size
    expect(cableThumbKey(wire)).toBe(cableThumbKey({ ...wire, name: 'renamed', id: 'other' }));
    expect(cableThumbKey(wire)).not.toBe(cableThumbKey({ ...wire, section: { shape: 'round', od_mm: 2.1 } }));
  });
});
