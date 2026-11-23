/**
 * This round's app logic: the runtime parts library (bundled + the design's
 * own parts, several part files), part search and port summaries, wires
 * attached to ports (bookkeeping, plug length, fit), and the keep-clear wire
 * check.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { BoxGeometry, Vector3 } from 'three';
import { connectorLabel, emptyDesign, encodeTriangles, findConnector, parseConnectorLibrary, type CableType, type Design, type Part, type Route } from '@core';
import { registry } from '../../src/app/scene/registry';
import '../../src/app/scene/bvh';
import { removeComponent } from '../../src/app/state/designOps';
import { mergePartFiles, runtimeLibrary } from '../../src/app/state/library';
import { useApp } from '../../src/app/state/store';
import { connectorText, portLabel, portSummary, searchParts } from '../../src/app/ui/partText';
import { searchCableTypes } from '../../src/app/ui/cableText';
import { keepClearHits } from '../../src/app/wires/areas';
import { commitWireEdit } from '../../src/app/wires/editing';
import { detachEnd, endChecks, plugLength, portInfo } from '../../src/app/wires/ports';
import { segmentsFromPoints } from '../../src/app/wires/routeEdit';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const connectors = parseConnectorLibrary(readFileSync(resolve(ROOT, 'library/connectors.yaml'), 'utf8'));
const s = () => useApp.getState();
const UP: [number, number, number] = [0, 0, 1];

function board(id: string, extra: Partial<Part> = {}): Part {
  return {
    id,
    name: `Board ${id}`,
    category: 'controller',
    tags: ['dev board'],
    body: { size_mm: [60, 40, 10], board: { z_mm: 2, thickness_mm: 1.6 } },
    mounting_holes: [],
    ports: [
      { id: 'usb', name: 'USB', connector: 'usb-c', pose: { p_mm: [30, 0, 4], q: [0, 0, 0, 1] }, interfaces: ['usb2'] },
      { id: 'i2c0', name: 'I2C', connector: 'jst-sh', ways: 4, pose: { p_mm: [-30, 10, 4], q: [0, 0, 1, 0] }, interfaces: ['i2c'] },
      { id: 'i2c1', name: 'I2C 2', connector: 'jst-sh', ways: 4, pose: { p_mm: [-30, -10, 4], q: [0, 0, 1, 0] }, interfaces: ['i2c'] },
    ],
    confidence: 'generic',
    ...extra,
  };
}

function wire(od: number, awg: number, extra: Partial<CableType> = {}): CableType {
  return { id: `w${awg}`, name: `${awg} AWG`, family: 'hookup_wire', section: { shape: 'round', od_mm: od }, conductors: 1, awg, min_bend_mm: { static: 5 }, flex: 'flexible', connectors: [], interfaces: [], confidence: 'generic', ...extra };
}

beforeEach(() => {
  registry.replace([]);
  useApp.setState({ notices: [], connectorLibrary: connectors });
});

describe('the runtime parts library', () => {
  it("puts the design's own parts on top of the bundled ones", () => {
    const base = { version: 1 as const, parts: [board('a'), board('b')] };
    const mine = board('b', { name: 'My B' });
    const lib = runtimeLibrary(base, { parts: [mine, board('c')] })!;
    expect(lib.parts.map((p) => p.id).sort()).toEqual(['a', 'b', 'c']);
    expect(lib.parts.find((p) => p.id === 'b')!.name).toBe('My B');
    expect(runtimeLibrary(null, { parts: [] })).toBeNull();
  });

  it('merges several part files; a duplicate id names both files; a bad file does not stop the others', () => {
    const yaml = (ids: string[]) =>
      `version: 1\nparts:\n${ids.map((id) => `  - { id: ${id}, name: ${id}, category: sensor, body: { size_mm: [10, 10, 5] }, confidence: generic }`).join('\n')}\n`;
    const { library, problems } = mergePartFiles([
      ['parts.yaml', yaml(['x', 'y'])],
      ['parts-bad.yaml', 'version: 1\nparts: [ { id: 1 } ]\n'],
      ['parts-more.yaml', yaml(['y', 'z'])],
    ]);
    expect(library.parts.map((p) => p.id)).toEqual(['x', 'y', 'z']);
    expect(problems.some((p) => p.file === 'parts-bad.yaml')).toBe(true);
    const dup = problems.find((p) => p.file === 'parts-more.yaml')!;
    expect(dup.message).toContain('"y"');
    expect(dup.message).toContain('parts.yaml');
  });
});

describe('parts in words and search', () => {
  it('summarises ports by connector with counts, and labels a port with its connector', () => {
    const p = board('a');
    const sh = findConnector(connectors, 'jst-sh')!;
    const usb = findConnector(connectors, 'usb-c')!;
    // Short library labels, equal ones counted, joined with a middle dot.
    expect(portSummary(p, connectors)).toBe(`${connectorLabel(usb, undefined)} · 2 x ${connectorLabel(sh, 4)}`);
    expect(portSummary(p, connectors)).toBe('USB-C · 2 x JST SH 4-way');
    expect(portLabel(p.ports[1]!, connectors)).toBe('I2C: JST SH 4-way');
    // The detail view keeps the full name and aliases.
    expect(connectorText(p.ports[1]!, connectors)).toBe(`${sh.name} 4-way (${sh.aliases.join(', ')})`);
    expect(portSummary({ ports: [] }, connectors)).toBe('no ports');
  });

  it("finds parts by name, tag, category and their connectors' aliases", () => {
    const parts = [board('a'), board('b', { name: 'Servo', category: 'actuator', tags: [], ports: [] })];
    expect(searchParts(parts, 'qwiic', connectors).map((p) => p.id)).toEqual(['a']);
    expect(searchParts(parts, 'dev board', connectors).map((p) => p.id)).toEqual(['a']);
    expect(searchParts(parts, 'servo', connectors).map((p) => p.id)).toEqual(['b']);
    expect(searchParts(parts, '', connectors, 'actuator').map((p) => p.id)).toEqual(['b']);
  });

  it('finds cable types by gauge', () => {
    expect(searchCableTypes([wire(1.3, 26), wire(1.4, 24)], '24 awg').map((t) => t.id)).toEqual(['w24']);
  });
});

/** A design with board "a" placed on link L, and a route from its I2C port. */
function attached(): { d: Design; route: Route } {
  const base = emptyDesign('p');
  const d: Design = {
    ...base,
    parts: [board('a')],
    scene: { sources: [], links: [{ id: 'L', name: 'L', meshes: [] }], joints: [] },
    components: [{ id: 'c1', name: 'Controller', part: 'a', link: 'L', pose: { p_mm: [0, 0, 0], q: [0, 0, 0, 1] } }],
    cables: [{ id: 'w1', name: 'W', connections: [], type: 'w', count: 4, twisted: false, sleeve_wall_mm: 0, reasons: [] }],
  };
  const route: Route = {
    id: 'r1',
    cable: 'w1',
    crossings: [],
    from: { component: 'c1', port: 'i2c0' },
    segments: segmentsFromPoints([
      { link: 'L', p: [-30, 10, 4], n: [0, 0, 0] },
      { link: 'L', p: [-40, 10, 4], n: [0, 0, 0] },
      { link: 'L', p: [-80, 10, 0], n: UP },
    ]),
  };
  return { d: { ...d, routes: [route] }, route };
}

describe('wires attached to ports', () => {
  it('the lead-out clears the plug: plug length from the connector library', () => {
    const sh = findConnector(connectors, 'jst-sh')!;
    expect(plugLength(sh, 4)).toBe(sh.plug!.length_mm);
    expect(plugLength(undefined, 4)).toBe(0);
  });

  it('checks the cable against the connector: gauge and contact count', () => {
    const { d, route } = attached();
    const lib = runtimeLibrary(null, d);
    const end = { first: new Vector3(-30, 10, 4), last: new Vector3(-80, 10, 0) };
    const thin = endChecks(d, lib, connectors, route, wire(0.6, 30), 4, {}, end)[0]!;
    expect(thin.problems).toEqual([]);
    expect(thin.detached).toBe(false);
    expect(thin.label).toContain('Controller / I2C');
    const thick = endChecks(d, lib, connectors, route, wire(1.4, 24), 4, {}, end)[0]!;
    expect(thick.problems.some((p) => p.includes('24 AWG is thicker'))).toBe(true);
    const many = endChecks(d, lib, connectors, route, wire(0.6, 30), 5, {}, end)[0]!;
    expect(many.problems.some((p) => p.includes('5 conductors for 4 contacts'))).toBe(true);
    // the part moved away from the wire's end: detached
    const moved = { ...d, components: [{ ...d.components[0]!, pose: { p_mm: [5, 0, 0] as [number, number, number], q: [0, 0, 0, 1] as [number, number, number, number] } }] };
    expect(endChecks(moved, lib, connectors, route, wire(0.6, 30), 4, {}, end)[0]!.detached).toBe(true);
  });

  it('deleting the component detaches the end and keeps the hand-drawn wire', () => {
    const { d } = attached();
    const next = removeComponent(d, 'c1');
    expect(next.cables.map((c) => c.id)).toEqual(['w1']);
    expect(next.routes[0]!.from).toBeUndefined();
    expect(portInfo(next, runtimeLibrary(null, next), connectors, d.routes[0]!.from)).toBeNull();
  });

  it('moving the first point off the port detaches that end (one undo step)', () => {
    const { d } = attached();
    s().replaceDesign(d);
    useApp.setState({ cableLibrary: { version: 1, cables: [] } as never, wireSettings: { ...s().wireSettings, drape: false } });
    expect(s().design.routes[0]!.from).toEqual({ component: 'c1', port: 'i2c0' });
    commitWireEdit('w1', { kind: 'move', index: 0, point: { link: 'L', p: [-50, 0, 0], n: UP } });
    expect(s().design.routes[0]!.from).toBeUndefined();
    s().undo();
    expect(s().design.routes[0]!.from).toEqual({ component: 'c1', port: 'i2c0' });
    expect(detachEnd(d.routes[0]!, 'to')).toBe(d.routes[0]);
  });
});

describe('keep-clear areas and wires', () => {
  it('warns when the wire lies on a keep-clear area, naming it', async () => {
    // A floor plate; its top face (+z) is BoxGeometry's group 4 (triangles 8 and 9).
    const g = new BoxGeometry(100, 40, 2).translate(50, 0, -1);
    registry.replace([{ id: 'floor', link: 'L', geometry: g, color: [1, 1, 1] }]);
    for (let i = 0; i < 300 && s().bvhPending > 0; i++) await new Promise((r) => setTimeout(r, 10));
    const d: Design = {
      ...emptyDesign('z'),
      scene: { sources: [{ id: 's', kind: 'builtin', uri: 'builtin:demo-arm', mm_per_unit: 1 }], links: [{ id: 'L', name: 'L', meshes: [{ id: 'floor', source: 's', node: 'floor', tri_count: 12 }] }], joints: [] },
      zones: [{ id: 'z1', name: 'Fan grille', kind: 'keep_out', link: 'L', mesh: 'floor', triangles: encodeTriangles([8, 9]) }],
    };
    const on: Route = { id: 'r', cable: 'c', crossings: [], segments: segmentsFromPoints([{ link: 'L', p: [10, 0, 0], n: UP }, { link: 'L', p: [90, 0, 0], n: UP }]) };
    expect(keepClearHits(d, on)).toEqual(['Fan grille']);
    // the same route in the air (free points) is not lying on it
    const air: Route = { ...on, segments: segmentsFromPoints([{ link: 'L', p: [10, 0, 5], n: [0, 0, 0] }, { link: 'L', p: [90, 0, 5], n: [0, 0, 0] }]) };
    expect(keepClearHits(d, air)).toEqual([]);
    // a parts-may-go-here area is no warning
    expect(keepClearHits({ ...d, zones: [{ ...d.zones[0]!, kind: 'mount_allowed' }] }, on)).toEqual([]);
  });
});
