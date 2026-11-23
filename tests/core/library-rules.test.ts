import { describe, expect, it } from 'vitest';
import { findPart, parseLibrary, parseRules, ruleApplies, ruleSatisfied, RuleSchema, type Rule } from '@core';
import { loadLibrary, loadRules } from './helpers';

const partYaml = (body: string) => `version: 1\nparts:\n${body}`;
const part = (id: string, ports = '') =>
  `  - id: ${id}\n    name: P\n    category: other\n    body: { size_mm: [10, 10, 5] }\n    confidence: generic\n${ports}`;
const port = (id: string) =>
  `      - id: ${id}\n        connector: jst-sh-4\n        pose: { p_mm: [0, 0, 0], q: [0, 0, 0, 1] }\n        interfaces: [i2c]\n`;

describe('library', () => {
  const lib = loadLibrary();

  it('parses library/parts.yaml', () => {
    expect(lib.parts.length).toBeGreaterThan(0);
    expect(findPart(lib, lib.parts[0]!.id)).toBe(lib.parts[0]);
    expect(findPart(lib, 'nope')).toBeUndefined();
  });

  it('every port lies on or inside the body box expanded by 1 mm', () => {
    for (const p of lib.parts) {
      const [sx, sy, sz] = p.body.size_mm;
      for (const port of p.ports) {
        const [x, y, z] = port.pose.p_mm;
        const where = `${p.id}/${port.id}`;
        expect(Math.abs(x), `${where} x`).toBeLessThanOrEqual(sx / 2 + 1);
        expect(Math.abs(y), `${where} y`).toBeLessThanOrEqual(sy / 2 + 1);
        expect(z, `${where} z`).toBeGreaterThanOrEqual(-1);
        expect(z, `${where} z`).toBeLessThanOrEqual(sz + 1);
      }
    }
  });

  it('every port quaternion is unit length within 1e-6', () => {
    for (const p of lib.parts) {
      for (const port of p.ports) {
        const n = Math.hypot(...port.pose.q);
        expect(Math.abs(n - 1), `${p.id}/${port.id}`).toBeLessThanOrEqual(1e-6);
      }
    }
  });

  it('mounting holes lie inside the body footprint', () => {
    for (const p of lib.parts) {
      for (const h of p.mounting_holes) {
        expect(Math.abs(h.p_mm[0]), p.id).toBeLessThanOrEqual(p.body.size_mm[0] / 2);
        expect(Math.abs(h.p_mm[1]), p.id).toBeLessThanOrEqual(p.body.size_mm[1] / 2);
      }
    }
  });

  it('rejects duplicate part ids', () => {
    expect(() => parseLibrary(partYaml(part('a') + part('a')))).toThrow(/duplicate part id "a"/);
  });

  it('rejects duplicate port ids within a part but allows the same port id on different parts', () => {
    expect(() => parseLibrary(partYaml(part('a', '    ports:\n' + port('p') + port('p'))))).toThrow(/duplicate port id "p"/);
    expect(() => parseLibrary(partYaml(part('a', '    ports:\n' + port('p')) + part('b', '    ports:\n' + port('p'))))).not.toThrow();
  });

  it('rejects unknown keys, a bad version and a part with no name', () => {
    expect(() => parseLibrary(partYaml(part('a') + '    extra: 1\n'))).toThrow();
    expect(() => parseLibrary('version: 2\nparts: []\n')).toThrow();
    expect(() => parseLibrary(partYaml(part('a').replace('name: P', 'name: ""')))).toThrow();
  });

  it('accepts an empty parts list', () => {
    expect(parseLibrary('version: 1\nparts: []\n').parts).toEqual([]);
  });
});

describe('rules', () => {
  const file = loadRules();
  const rule = (extra: string) =>
    `version: 1\nrules:\n  - id: r1\n    title: T\n    quantity: length_m\n    op: '<='\n    value: 1\n    severity: warn\n    confidence: vendor\n    source: https://example.com\n${extra}`;
  const dup = (id1: string, id2: string) => {
    const one = (id: string) => `  - id: ${id}\n    title: T\n    quantity: length_m\n    op: '<='\n    value: 1\n    severity: warn\n    confidence: vendor\n    source: https://example.com\n`;
    return `version: 1\nrules:\n${one(id1)}${one(id2)}`;
  };

  it('parses rules/wiring.yaml', () => {
    expect(file.rules.length).toBeGreaterThan(0);
  });

  it('every rule in the shipped file satisfies the cross-field constraints', () => {
    for (const r of file.rules) {
      if (r.confidence === 'unverified') expect(r.severity, r.id).not.toBe('fail');
      else expect(r.source, r.id).toBeTruthy();
    }
  });

  it('rejects duplicate rule ids', () => {
    expect(() => parseRules(dup('a', 'a'))).toThrow(/duplicate rule id "a"/);
    expect(() => parseRules(dup('a', 'b'))).not.toThrow();
  });

  it('rejects an unverified rule with severity fail', () => {
    const y = rule('').replace('severity: warn', 'severity: fail').replace('confidence: vendor', 'confidence: unverified');
    expect(() => parseRules(y)).toThrow(/unverified/);
  });

  it('accepts an unverified rule with severity warn or info and no source', () => {
    for (const sev of ['warn', 'info']) {
      const y = rule('').replace('severity: warn', `severity: ${sev}`).replace('confidence: vendor', 'confidence: unverified').replace('    source: https://example.com\n', '');
      expect(parseRules(y).rules[0]!.confidence).toBe('unverified');
    }
  });

  it.each(['standard', 'vendor', 'rule_of_thumb'])('rejects a %s rule without a source', (confidence) => {
    const y = rule('').replace('confidence: vendor', `confidence: ${confidence}`).replace('    source: https://example.com\n', '');
    expect(() => parseRules(y)).toThrow(/needs a source/);
  });

  it('rejects unknown quantity, op, severity and keys; applies defaults', () => {
    expect(() => parseRules(rule('').replace('length_m', 'weight_kg'))).toThrow();
    expect(() => parseRules(rule('').replace("'<='", "'<'"))).toThrow();
    expect(() => parseRules(rule('').replace('severity: warn', 'severity: error'))).toThrow();
    expect(() => parseRules(rule('    extra: 1\n'))).toThrow();
    const r = parseRules(rule('')).rules[0]!;
    expect(r.when).toEqual({});
    expect(r.overridable_by).toEqual(['datasheet', 'user']);
  });

  describe('ruleApplies', () => {
    const mk = (when: Rule['when']): Rule => RuleSchema.parse({ id: 'x', title: 'x', when, quantity: 'length_m', op: '<=', value: 1, severity: 'warn', confidence: 'unverified' });

    it.each([
      ['empty when applies everywhere', {}, {}, true],
      ['empty when ignores context', {}, { a: 'b' }, true],
      ['value in the list', { a: ['x', 'y'] }, { a: 'y' }, true],
      ['value not in the list', { a: ['x', 'y'] }, { a: 'z' }, false],
      ['key missing from context', { a: ['x'] }, {}, false],
      ['key present but undefined', { a: ['x'] }, { a: undefined }, false],
      ['all keys match', { a: ['x'], b: ['1', '2'] }, { a: 'x', b: '2', c: 'extra' }, true],
      ['one of two keys fails', { a: ['x'], b: ['1'] }, { a: 'x', b: '2' }, false],
      ['matching is case sensitive', { a: ['x'] }, { a: 'X' }, false],
    ] as Array<[string, Rule['when'], Record<string, string | undefined>, boolean]>)('%s', (_n, when, ctx, expected) => {
      expect(ruleApplies(mk(when), ctx)).toBe(expected);
    });

    it('works with a shipped rule', () => {
      const r = file.rules.find((x) => x.id === 'bend.fpc.static.single-layer')!;
      expect(ruleApplies(r, { cable_class: 'fpc', motion: 'static', layers: '1' })).toBe(true);
      expect(ruleApplies(r, { cable_class: 'fpc', motion: 'static', layers: '2' })).toBe(false);
    });
  });

  describe('ruleSatisfied', () => {
    const mk = (op: '>=' | '<=', value: number): Rule => RuleSchema.parse({ id: 'x', title: 'x', quantity: 'length_m', op, value, severity: 'warn', confidence: 'unverified' });

    it.each([
      ['>=', 6, 6, true],
      ['>=', 6, 6 - 1e-9, false],
      ['>=', 6, 5.999, false],
      ['>=', 6, 6.001, true],
      ['<=', 6, 6, true],
      ['<=', 6, 6 + 1e-9, false],
      ['<=', 6, 6.001, false],
      ['<=', 6, 5.999, true],
    ] as Array<['>=' | '<=', number, number, boolean]>)('op %s limit %d measured %d -> %s', (op, value, measured, expected) => {
      expect(ruleSatisfied(mk(op, value), measured)).toBe(expected);
    });

    it('an override limit replaces the rule value', () => {
      expect(ruleSatisfied(mk('>=', 6), 5, 4)).toBe(true);
      expect(ruleSatisfied(mk('>=', 6), 5, 5)).toBe(true);
      expect(ruleSatisfied(mk('>=', 6), 5, 5.001)).toBe(false);
      expect(ruleSatisfied(mk('<=', 6), 7, 8)).toBe(true);
      expect(ruleSatisfied(mk('<=', 6), 7, 6.999)).toBe(false);
    });

    it('a limit of 0 is an override, not a missing value', () => {
      expect(ruleSatisfied(mk('>=', 6), 0, 0)).toBe(true);
    });
  });
});
