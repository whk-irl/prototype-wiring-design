// Real-world facts about well-known boards, checked against the bundled library.
// body.size_mm is the envelope with connector overhang, so the envelope is checked
// as "at least the board, at most the board plus 8 mm"; holes and row spacing are exact.
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findConnector, parseConnectorLibrary, parseLibrary, type Part } from '@core';
import { readText, ROOT } from './helpers';

const connectors = parseConnectorLibrary(readText('library/connectors.yaml'));
const parts = readdirSync(resolve(ROOT, 'library'))
  .filter((f) => /^parts.*\.yaml$/.test(f))
  .flatMap((f) => parseLibrary(readText(`library/${f}`), connectors).parts);
const get = (id: string): Part => {
  const p = parts.find((x) => x.id === id);
  if (!p) throw new Error(`part "${id}" is not in the library`);
  return p;
};

const envelope = (p: Part, board: [number, number], tolerance = 0.5) => {
  expect(p.body.size_mm[0], `${p.id} length`).toBeGreaterThanOrEqual(board[0] - tolerance);
  expect(p.body.size_mm[0], `${p.id} length`).toBeLessThanOrEqual(board[0] + 8);
  expect(p.body.size_mm[1], `${p.id} width`).toBeGreaterThanOrEqual(board[1] - tolerance);
  expect(p.body.size_mm[1], `${p.id} width`).toBeLessThanOrEqual(board[1] + 8);
};
const spread = (p: Part, axis: 0 | 1) => {
  const v = p.mounting_holes.map((h) => h.p_mm[axis]);
  return Math.max(...v) - Math.min(...v);
};
const portsOf = (p: Part, connector: string) => p.ports.filter((x) => x.connector === connector);

describe('Arduino Uno R3', () => {
  const p = get('arduino-uno-r3');
  it('envelope covers the 68.6 x 53.4 mm board', () => envelope(p, [68.6, 53.4]));
  it('has four mounting holes', () => expect(p.mounting_holes).toHaveLength(4));
  it('has header rows of 10, 8, 8 and 6 contacts', () => {
    const rows = p.ports.filter((x) => /^pin-(header|socket)-2\.54$/.test(x.connector) && x.id.startsWith('hdr')).map((x) => x.ways!);
    expect(rows.sort((a, b) => a - b)).toEqual([6, 8, 8, 10]);
  });
});

describe('Raspberry Pi 4 Model B', () => {
  const p = get('raspberry-pi-4b');
  it('envelope covers the 85 x 56 mm board', () => envelope(p, [85, 56]));
  it('holes lie on a 58 x 49 mm rectangle', () => {
    expect(p.mounting_holes).toHaveLength(4);
    expect(spread(p, 0)).toBeCloseTo(58, 6);
    expect(spread(p, 1)).toBeCloseTo(49, 6);
    const xs = new Set(p.mounting_holes.map((h) => h.p_mm[0]));
    const ys = new Set(p.mounting_holes.map((h) => h.p_mm[1]));
    expect([xs.size, ys.size]).toEqual([2, 2]);
  });
  it('has a 40-way two-row GPIO header', () => {
    const gpio = portsOf(p, 'pin-header-2.54-2row');
    expect(gpio.map((x) => x.ways)).toEqual([40]);
    expect(findConnector(connectors, 'pin-header-2.54-2row')!.rows).toBe(2);
  });
  it('has two FFC ports of 15 ways at 1.0 mm', () => {
    const ffc = portsOf(p, 'ffc-1.0');
    expect(ffc.map((x) => x.ways)).toEqual([15, 15]);
    expect(findConnector(connectors, 'ffc-1.0')!.pitch_mm).toBe(1);
  });
});

describe('Raspberry Pi Pico', () => {
  const p = get('raspberry-pi-pico');
  it('envelope covers the 51 x 21 mm board', () => envelope(p, [51, 21]));
  it('has two 20-way rows 17.78 mm apart', () => {
    const rows = portsOf(p, 'pin-header-2.54');
    expect(rows.map((x) => x.ways)).toEqual([20, 20]);
    expect(Math.abs(rows[0]!.pose.p_mm[1] - rows[1]!.pose.p_mm[1])).toBeCloseTo(17.78, 2);
  });
  it('has four holes 11.4 mm apart across the board', () => {
    expect(p.mounting_holes).toHaveLength(4);
    expect(spread(p, 1)).toBeCloseTo(11.4, 6);
  });
});

describe('a Feather-shaped Adafruit board', () => {
  const p = get('adafruit-3857-feather-m4-express');
  it('envelope covers the 50.8 x 22.86 mm board', () => envelope(p, [50.8, 22.86]));
  it('has rows of 16 and 12 ways on the two long edges', () => {
    const rows = portsOf(p, 'pin-header-2.54');
    expect(rows.map((x) => x.ways).sort((a, b) => a! - b!)).toEqual([12, 16]);
    expect(Math.abs(rows[0]!.pose.p_mm[1] - rows[1]!.pose.p_mm[1])).toBeCloseTo(20.32, 2);
  });
  it('has four holes 17.78 mm apart across the board', () => {
    expect(p.mounting_holes).toHaveLength(4);
    expect(spread(p, 1)).toBeCloseTo(17.78, 6);
  });
});
