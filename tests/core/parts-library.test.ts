import { describe, expect, it } from 'vitest';
import {
  findPart,
  mergeLibrary,
  parseConnectorLibrary,
  parseLibrary,
  partProblems,
  PartSchema,
  resolvePart,
  type Library,
  type Part,
} from '@core';

const part = (over: Record<string, unknown> = {}): Part =>
  PartSchema.parse({
    id: 'p',
    name: 'Part',
    category: 'sensor',
    body: { size_mm: [20, 10, 5] },
    confidence: 'generic',
    ...over,
  });
const port = (over: Record<string, unknown> = {}) => ({
  id: 'a',
  connector: 'jst-sh',
  ways: 4,
  pose: { p_mm: [0, 0, 1], q: [0, 0, 0, 1] },
  interfaces: ['i2c'],
  ...over,
});
const connectors = parseConnectorLibrary(
  'version: 1\nconnectors:\n  - { id: jst-sh, name: JST SH, ways: { min: 2, max: 8 }, confidence: generic }\n  - { id: usb-c, name: USB-C, ways: { min: 24, max: 24 }, confidence: generic }\n',
);

describe('partProblems', () => {
  it('is empty for a sound part', () => {
    expect(partProblems(part({ ports: [port()], mounting_holes: [{ p_mm: [8, 4], d_mm: 2 }] }))).toEqual([]);
  });

  it('the body must be positive in all three directions', () => {
    for (const size of [[0, 10, 5], [20, 0, 5], [20, 10, 0], [-1, 10, 5]]) {
      expect(partProblems(part({ body: { size_mm: size } }))).toContain('the body size must be positive in all three directions');
    }
  });

  it('duplicate port ids', () => {
    expect(partProblems(part({ ports: [port(), port()] }))).toEqual(['duplicate port id "a"']);
  });

  it('a port may overhang the envelope by 6 mm, no more', () => {
    const at = (p: number[]) => partProblems(part({ ports: [port({ pose: { p_mm: p, q: [0, 0, 0, 1] } })] }));
    expect(at([16, 0, 1])).toEqual([]); // 20/2 + 6
    expect(at([16.01, 0, 1])).toEqual(['port "a" lies outside the part']);
    expect(at([-16.01, 0, 1])).toEqual(['port "a" lies outside the part']);
    expect(at([0, 11, 1])).toEqual([]); // 10/2 + 6
    expect(at([0, 11.01, 1])).toEqual(['port "a" lies outside the part']);
    expect(at([0, 0, -6])).toEqual([]);
    expect(at([0, 0, -6.01])).toEqual(['port "a" lies outside the part']);
    expect(at([0, 0, 11])).toEqual([]); // 5 + 6
    expect(at([0, 0, 11.01])).toEqual(['port "a" lies outside the part']);
  });

  it('the rotation of a port must be a unit quaternion within 1e-3', () => {
    const q = (n: number) => partProblems(part({ ports: [port({ pose: { p_mm: [0, 0, 1], q: [0, 0, 0, n] } })] }));
    expect(q(1.0005)).toEqual([]);
    expect(q(1.002)).toEqual(['port "a": the rotation is not a unit quaternion']);
    expect(q(0.5)).toEqual(['port "a": the rotation is not a unit quaternion']);
  });

  it('mounting holes inside the footprint, numbered from 1', () => {
    expect(partProblems(part({ mounting_holes: [{ p_mm: [10, 5], d_mm: 2 }] }))).toEqual([]);
    expect(partProblems(part({ mounting_holes: [{ p_mm: [0, 0], d_mm: 2 }, { p_mm: [10.1, 0], d_mm: 2 }] }))).toEqual(['mounting hole 2 lies outside the part']);
    expect(partProblems(part({ mounting_holes: [{ p_mm: [0, 5.1], d_mm: 2 }] }))).toEqual(['mounting hole 1 lies outside the part']);
  });

  it('the board must lie inside the envelope', () => {
    const board = (z: number, t: number) => partProblems(part({ body: { size_mm: [20, 10, 5], board: { z_mm: z, thickness_mm: t } } }));
    expect(board(3.4, 1.6)).toEqual([]);
    expect(board(3.5, 1.6)).toEqual(['the board lies above the top of the part']);
  });

  it('checks connectors only when a connector library is given', () => {
    const p = part({ ports: [port({ connector: 'nope' }), port({ id: 'b', ways: 12 }), port({ id: 'c', connector: 'usb-c', ways: undefined })] });
    expect(partProblems(p)).toEqual([]);
    expect(partProblems(p, connectors)).toEqual([
      'port "a": connector "nope" is not in the connector library',
      'port "b": connector "jst-sh" comes in 2 to 8 ways, not 12',
    ]);
  });
});

describe('parseLibrary', () => {
  const lib = (body: string) => `version: 1\nparts:\n  - id: p\n    name: P\n    category: sensor\n    body: { size_mm: [20, 10, 5] }\n${body}`;
  const generic = lib('    confidence: generic\n');

  it('accepts a minimal generic part with defaults', () => {
    const l = parseLibrary(generic);
    expect(l.parts[0]).toMatchObject({ tags: [], ports: [], mounting_holes: [] });
  });

  it('rejects duplicate part ids', () => {
    expect(() => parseLibrary(generic + generic.split('parts:\n')[1])).toThrow(/duplicate part id "p"/);
  });

  it('names the part and gives the first problem', () => {
    expect(() => parseLibrary(lib('    confidence: generic\n    ports:\n      - { id: a, connector: x, pose: { p_mm: [90, 0, 0], q: [0, 0, 0, 1] }, interfaces: [i2c] }\n'))).toThrow(/part "p": port "a" lies outside the part/);
  });

  it.each(['datasheet', 'measured'])('a %s part needs a source', (c) => {
    expect(() => parseLibrary(lib(`    confidence: ${c}\n`))).toThrow(new RegExp(`part "p": confidence "${c}" needs a source`));
    expect(() => parseLibrary(lib(`    confidence: ${c}\n    source: https://example.com/p\n`))).not.toThrow();
  });

  describe('models', () => {
    const model = (fields: string) => lib(`    confidence: generic\n    model:\n      uri: p.glb\n${fields}`);
    const full = '      license: CC-BY-4.0\n      attribution: Someone\n      source: https://example.com/p.glb\n';

    it('a bundled model needs licence, attribution and source', () => {
      expect(() => parseLibrary(model(full))).not.toThrow();
      for (const drop of ['license', 'attribution', 'source']) {
        const text = full
          .split('\n')
          .filter((l) => !l.includes(`${drop}:`))
          .join('\n');
        expect(() => parseLibrary(model(text)), drop).toThrow(/needs its license, attribution and source/);
      }
      expect(() => parseLibrary(model(''))).toThrow(/needs its license, attribution and source/);
    });

    it('a custom model is refused in a bundled library', () => {
      const text = lib('    confidence: generic\n    model:\n      uri: "custom:' + 'a'.repeat(64) + '"\n' + full);
      expect(() => parseLibrary(text)).toThrow(/a bundled part cannot use a custom model/);
    });
  });

  it('checks connectors only when a connector library is passed', () => {
    const text = lib('    confidence: generic\n    ports:\n      - { id: a, connector: nope, ways: 4, pose: { p_mm: [0, 0, 1], q: [0, 0, 0, 1] }, interfaces: [i2c] }\n');
    expect(() => parseLibrary(text)).not.toThrow();
    expect(() => parseLibrary(text, connectors)).toThrow(/part "p": port "a": connector "nope" is not in the connector library/);
    const ok = text.replace('nope', 'jst-sh');
    expect(() => parseLibrary(ok, connectors)).not.toThrow();
    expect(() => parseLibrary(ok.replace('ways: 4', 'ways: 40'), connectors)).toThrow(/comes in 2 to 8 ways, not 40/);
  });

  it('rejects unknown keys and a wrong version', () => {
    expect(() => parseLibrary(generic + '    colour: red\n')).toThrow();
    expect(() => parseLibrary(generic.replace('version: 1', 'version: 2'))).toThrow();
  });
});

describe('mergeLibrary and resolvePart', () => {
  const base: Library = { version: 1, parts: [part({ id: 'a', name: 'A' }), part({ id: 'b', name: 'B' }), part({ id: 'c', name: 'C' })] };

  it('returns the base itself when there is nothing to add', () => {
    expect(mergeLibrary(base, [])).toBe(base);
  });

  it('adds new parts after the base parts', () => {
    const merged = mergeLibrary(base, [part({ id: 'x' }), part({ id: 'y' })]);
    expect(merged.parts.map((p) => p.id)).toEqual(['a', 'b', 'c', 'x', 'y']);
    expect(merged.version).toBe(1);
  });

  it('a part with the id of a library one replaces it', () => {
    const merged = mergeLibrary(base, [part({ id: 'b', name: 'mine' })]);
    expect(merged.parts.map((p) => p.id)).toEqual(['a', 'c', 'b']);
    expect(findPart(merged, 'b')!.name).toBe('mine');
    expect(merged.parts).toHaveLength(3);
  });

  it('does not change its inputs', () => {
    const own = [part({ id: 'b', name: 'mine' })];
    mergeLibrary(base, own);
    expect(base.parts.map((p) => p.name)).toEqual(['A', 'B', 'C']);
    expect(own).toHaveLength(1);
  });

  it('resolvePart: the design own parts first, then the library, else undefined', () => {
    const design = { parts: [part({ id: 'b', name: 'own b' }), part({ id: 'z', name: 'own z' })] };
    expect(resolvePart(design, base, 'b')!.name).toBe('own b');
    expect(resolvePart(design, base, 'a')!.name).toBe('A');
    expect(resolvePart(design, base, 'z')!.name).toBe('own z');
    expect(resolvePart(design, base, 'nope')).toBeUndefined();
    expect(resolvePart(design, undefined, 'a')).toBeUndefined();
    expect(resolvePart(design, undefined, 'z')!.name).toBe('own z');
    expect(resolvePart({ parts: [] }, base, 'c')!.name).toBe('C');
  });
});
