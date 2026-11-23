/**
 * Regressions from the review of the user's own cables: writes that fail are
 * reported (and change nothing), a blocked or old database, the parameters a
 * type carries (Keep then Edit), fields the form cannot show, a design copy
 * that differs from the stored one, number parsing, and thumbnails.
 */
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Box3, Vector3 } from 'three';
import { cableTypeFromSpec, emptyDesign, parseCableLibrary, type CableType, type Design } from '@core';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listCustomCables, listCustomParts, onDbStatus, readCableRecord, saveCustomCable, saveCustomPart, StoreError } from '../../src/app/parts/store';
import { watchRuntimeLibrary } from '../../src/app/state/library';
import { useApp } from '../../src/app/state/store';
import {
  applyStoredCableInDesign,
  deleteUserCable,
  designCableDiffers,
  keepDesignCableTypes,
  keepDesignCableVersion,
  saveUserCable,
  specForEditing,
} from '../../src/app/userCables/actions';
import { emptyCommon, evaluateForm, formFromSpec, parseNumber, specFromForm } from '../../src/app/userCables/form';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const base = parseCableLibrary(readFileSync(resolve(ROOT, 'library/cables.yaml'), 'utf8'));
const s = () => useApp.getState();
const scene = { sources: [], links: [{ id: 'L', name: 'L', meshes: [] }], joints: [] };
const g = globalThis as { indexedDB?: unknown };

let unwatch: (() => void) | null = null;
beforeEach(() => {
  g.indexedDB = new IDBFactory();
  unwatch?.();
  useApp.setState({ notices: [], baseCableLibrary: base, customCables: [], cableLibrary: base });
  s().replaceDesign({ ...emptyDesign('t'), scene });
  unwatch = watchRuntimeLibrary();
});
afterEach(() => {
  delete g.indexedDB;
});

/** A design whose wire uses `type`, carried in `design.cable_types` (as a design from another PC). */
function designWith(type: CableType): Design {
  return { ...emptyDesign('o'), scene, cable_types: [type], cables: [{ id: 'w1', name: 'Wire 1', connections: [], type: type.id, count: 1, twisted: false, sleeve_wall_mm: 0, reasons: [] }] };
}

/** Reopen a stored type in the form and save it unchanged: what the form gives back. */
function roundTrip(type: CableType): { again: CableType; form: ReturnType<typeof formFromSpec> } {
  const { spec, withoutParameters } = specForEditing(type);
  expect(withoutParameters).toBe(false);
  const form = formFromSpec(spec);
  const again = cableTypeFromSpec(specFromForm(form.kind, form.values, form.common, form.hidden), type.id).type;
  return { again, form };
}

describe('1. a write that fails is reported and changes nothing', () => {
  const t = cableTypeFromSpec({ kind: 'wire', awg: 24 }, 'custom-w-1').type;

  it('no IndexedDB: saving and deleting reject; the cable is not listed as kept', async () => {
    delete g.indexedDB;
    await expect(saveCustomCable({ type: t })).rejects.toBeInstanceOf(StoreError);
    await expect(saveUserCable({ kind: 'wire', awg: 24 })).rejects.toThrow(/does not let the app keep anything/);
    expect(s().customCables).toEqual([]);
    await expect(deleteUserCable('custom-w-1')).rejects.toBeInstanceOf(StoreError);
    // Parts too.
    await expect(saveCustomPart({ id: 'custom-p-1', name: 'P', category: 'other', tags: [], body: { size_mm: [1, 1, 1] }, mounting_holes: [], ports: [], confidence: 'measured', custom: true })).rejects.toBeInstanceOf(
      StoreError,
    );
  });

  it('an aborted transaction rejects, and the design copy is not changed', async () => {
    const stored = await saveUserCable({ kind: 'wire', awg: 24 });
    s().replaceDesign(designWith(stored));
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<typeof put>) {
      const r = put.apply(this, args);
      this.transaction.abort();
      return r;
    };
    try {
      await expect(saveUserCable({ kind: 'wire', awg: 20 }, { id: stored.id, updateDesign: true })).rejects.toBeInstanceOf(StoreError);
    } finally {
      IDBObjectStore.prototype.put = put;
    }
    expect(s().customCables.map((c) => c.type.awg)).toEqual([24]);
    expect(s().design.cable_types[0]!.awg).toBe(24);
    expect((await listCustomCables()).map((c) => c.type.awg)).toEqual([24]);
  });
});

describe('2. the database: an older version, and another tab holding it', () => {
  function openV1(idb: IDBFactory, put: (db: IDBDatabase) => void): Promise<IDBDatabase> {
    return new Promise((res, rej) => {
      const r = idb.open('wiring-design', 1);
      r.onupgradeneeded = () => {
        for (const n of ['parts', 'models', 'cache']) r.result.createObjectStore(n);
      };
      r.onsuccess = () => {
        put(r.result);
        res(r.result);
      };
      r.onerror = () => rej(r.error);
    });
  }
  const part = { id: 'custom-old-1', name: 'Old part', category: 'other', tags: [], body: { size_mm: [10, 10, 3] }, mounting_holes: [], ports: [], confidence: 'measured', custom: true };

  it('the upgrade from version 1 keeps the stored parts', async () => {
    const idb = new IDBFactory();
    const v1 = await openV1(idb, (db) => db.transaction('parts', 'readwrite').objectStore('parts').put(part, part.id));
    await new Promise((r) => setTimeout(r, 10));
    v1.close();
    expect((await listCustomParts(idb)).map((p) => p.id)).toEqual(['custom-old-1']);
    await saveCustomCable({ type: cableTypeFromSpec({ kind: 'wire', awg: 24 }, 'custom-w-1').type }, idb);
    expect((await listCustomCables(idb)).map((c) => c.type.id)).toEqual(['custom-w-1']);
  });

  it('blocked by another tab: says so, a write is refused at once, and the list arrives when the tab lets go (not empty)', async () => {
    const idb = new IDBFactory();
    const v1 = await openV1(idb, (db) => db.transaction('parts', 'readwrite').objectStore('parts').put(part, part.id));
    // The other tab does not close on request (an old version of the app would).
    v1.onversionchange = null;
    const said: string[] = [];
    const off = onDbStatus((status) => said.push(status));
    const list = listCustomParts(idb);
    for (let i = 0; i < 50 && !said.includes('blocked'); i++) await new Promise((r) => setTimeout(r, 5));
    expect(said).toContain('blocked');
    await expect(saveCustomCable({ type: cableTypeFromSpec({ kind: 'wire', awg: 24 }, 'custom-w-1').type }, idb)).rejects.toThrow(/Close that tab/);
    v1.close();
    expect((await list).map((p) => p.id)).toEqual(['custom-old-1']);
    expect(said.at(-1)).toBe('open');
    off();
  });
});

describe('3. Keep then Edit gives the same cable back', () => {
  it('a two-layer FPC that flexes: same type, same confidence, nothing worked out shown as entered', async () => {
    const t = cableTypeFromSpec({ kind: 'flat_flex', construction: 'fpc', ways: 12, pitch_mm: 0.5, thickness_mm: 0.15, layers: 2, flexing: true }, 'custom-fpc-1').type;
    s().replaceDesign(designWith(t));
    expect(await keepDesignCableTypes()).toEqual({ kept: [t.name], failed: [] });
    const stored = s().customCables[0]!.type;
    const { again, form } = roundTrip(stored);
    expect(again).toEqual(t);
    expect(form.kind).toBe('fpc');
    expect(form.values).toEqual({ ways: '12', pitch_mm: '0.5', thickness_mm: '0.15', layers: '2' });
    expect(form.common.bend_static_mm).toBe('');
    expect(form.common.bend_dynamic_mm).toBe('');
  });

  it("an FPC with a name of the user's own (no \"FPC\" in it) stays an FPC", async () => {
    const t = cableTypeFromSpec({ kind: 'flat_flex', construction: 'fpc', ways: 8, pitch_mm: 1, thickness_mm: 0.1, width_mm: 9, name: 'Camera tail' }, 'custom-fpc-2').type;
    s().replaceDesign(designWith(t));
    await keepDesignCableTypes();
    const { again, form } = roundTrip(s().customCables[0]!.type);
    expect(form.kind).toBe('fpc');
    expect(again).toEqual(t);
    expect(again.confidence).toBe(t.confidence);
  });

  it('fields the form does not show survive an edit', () => {
    const t = cableTypeFromSpec(
      { kind: 'wire', awg: 22, od_mm: 1.6, max_current_a: 3, mass_g_per_m: 7.5, connectors: ['jst-ph'], interfaces: ['power'], note: 'Red for 5 V.' },
      'custom-w-2',
    ).type;
    const form = formFromSpec(specForEditing(t).spec);
    const renamed = cableTypeFromSpec(specFromForm(form.kind, form.values, { ...form.common, name: 'Red 22' }, form.hidden), t.id).type;
    expect(renamed.name).toBe('Red 22');
    expect(renamed.max_current_a).toBe(3);
    expect(renamed.mass_g_per_m).toBe(7.5);
    expect(renamed.connectors).toEqual(['jst-ph']);
    expect(renamed.interfaces).toEqual(['power']);
    expect(renamed.spec!.note).toBe('Red for 5 V.');
  });

  it('a type without parameters is kept as it is, and editing says so', async () => {
    const hand: CableType = { id: 'custom-hand-1', name: 'Hand made', family: 'ribbon', section: { shape: 'flat', width_mm: 10, thickness_mm: 1 }, conductors: 8, pitch_mm: 1.27, min_bend_mm: { static: 9 }, flex: 'static', connectors: [], interfaces: [], confidence: 'measured', custom: true };
    s().replaceDesign(designWith(hand));
    await keepDesignCableTypes();
    expect(s().customCables[0]!.type).toEqual(hand);
    const edit = specForEditing(hand);
    expect(edit.withoutParameters).toBe(true);
    expect(edit.spec).toMatchObject({ kind: 'ribbon', ways: 8, pitch_mm: 1.27, thickness_mm: 1, bend_static_mm: 9 });
  });

  it('an older stored record ({ type, spec } side by side) is read forward without losing anything', () => {
    const t = cableTypeFromSpec({ kind: 'wire', awg: 24 }, 'custom-w-3').type;
    const { spec, ...noSpec } = t;
    expect(readCableRecord({ type: noSpec, spec })!.type).toEqual(t);
    // A spec that no longer passes the schema: the type is kept (without it).
    expect(readCableRecord({ type: noSpec, spec: { kind: 'wire', awg: 99 } })!.type).toEqual(noSpec);
    expect(readCableRecord({ type: { id: 'bad id' } })).toBeUndefined();
  });
});

describe("5. the design's copy differs from the stored one", () => {
  it('is detected, and neither is changed until the user chooses', async () => {
    const stored = await saveUserCable({ kind: 'wire', awg: 24, name: 'Mine' });
    const theirs = cableTypeFromSpec({ kind: 'wire', awg: 26, name: 'Theirs' }, stored.id).type;
    s().replaceDesign(designWith(theirs));
    expect(designCableDiffers(s().design, s().customCables, stored.id)).toBe(true);
    expect(s().design.cable_types[0]).toEqual(theirs);
    expect(s().customCables[0]!.type).toEqual(stored);
    // Choice one: this PC's version into the design (undoable).
    applyStoredCableInDesign(stored.id);
    expect(s().design.cable_types[0]).toEqual(stored);
    s().undo();
    expect(s().design.cable_types[0]).toEqual(theirs);
    // Choice two: the design's version kept on this PC.
    await keepDesignCableVersion(stored.id);
    expect(s().customCables[0]!.type).toEqual(theirs);
    expect((await listCustomCables())[0]!.type).toEqual(theirs);
    expect(designCableDiffers(s().design, s().customCables, stored.id)).toBe(false);
  });
});

describe('8. reading numbers', () => {
  it('only plain decimals, with one point or comma', () => {
    expect(parseNumber('0.5')).toBe(0.5);
    expect(parseNumber('0,5')).toBe(0.5);
    expect(parseNumber(' 12 ')).toBe(12);
    expect(parseNumber('.5')).toBe(0.5);
    expect(parseNumber('')).toBeUndefined();
    for (const bad of ['1,000', '1.000,5', '0x10', '1e3', 'Infinity', '12 mm', '1..2', '-', 'NaN']) expect(parseNumber(bad), bad).toBeNaN();
    expect(evaluateForm('ffc', { ways: '0x10', pitch_mm: '0.5' }, emptyCommon()).problems).toEqual([
      { field: 'ways', message: 'Ways must be a plain number such as 0.5 (digits, with one decimal point or comma).' },
    ]);
  });

  it('warns, without refusing, about flat flex thicker than 1 mm', () => {
    const r = evaluateForm('fpc', { ways: '12', pitch_mm: '0.5', thickness_mm: '1.2', width_mm: '6.5' }, emptyCommon());
    expect(r.warnings).toEqual([{ field: 'thickness_mm', message: '1.2 mm is thick for flat flex: its thickness is tenths of a millimetre. Did you enter microns?' }]);
    expect(evaluateForm('fpc', { ways: '12', pitch_mm: '0.5', thickness_mm: '0.12' }, emptyCommon()).warnings).toEqual([]);
  });
});

describe('9. thumbnails of very thin cables', () => {
  it('a 0.3 mm wire is framed by its own size, not as if it were 2 mm across', async () => {
    const { cableThumbScene } = await import('../../src/app/viewport/cableThumb');
    const { frameRadius } = await import('../../src/app/viewport/thumbnails');
    const t = cableTypeFromSpec({ kind: 'wire', awg: 36, od_mm: 0.3 }, 'custom-thin').type;
    const box = new Box3().setFromObject(cableThumbScene(t));
    const r = frameRadius(box);
    expect(r).toBeLessThan(1);
    expect(r).toBeCloseTo(box.getSize(new Vector3()).length() / 2, 9);
    expect(frameRadius(new Box3())).toBe(1); // an empty picture still gets a camera
  });
});
