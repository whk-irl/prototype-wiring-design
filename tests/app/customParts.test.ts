/**
 * The user's own parts: the design carries their definitions, the port
 * editor's operations, wire ends that follow their part, and reading part
 * files.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { emptyDesign, parseConnectorLibrary, partProblems, validateDesign, type Design, type Part, type Route } from '@core';
import { encodePartGlb, sha256Hex, type PartMesh } from '../../src/app/parts/glb';
import { syncDesignParts } from '../../src/app/state/designParts';
import { removeComponent } from '../../src/app/state/designOps';
import { runtimeLibrary } from '../../src/app/state/library';
import { useApp } from '../../src/app/state/store';
import { readPartFile } from '../../src/app/userParts/partFile';
import { addPortAt, EXIT_QUATS, exitOf, flipExit, nudgePort, quatForExit, setExit, setPortConnector, waysChoices, type ExitDir } from '../../src/app/userParts/portEdit';
import { followWireEnds, plugLengthAt, portInLink } from '../../src/app/wires/follow';
import { pointsOfRoute, segmentsFromPoints } from '../../src/app/wires/routeEdit';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const connectors = parseConnectorLibrary(readFileSync(resolve(ROOT, 'library/connectors.yaml'), 'utf8'));
const s = () => useApp.getState();

function myPart(id = 'custom-box-1', extra: Partial<Part> = {}): Part {
  return {
    id,
    name: 'My box',
    category: 'other',
    tags: [],
    body: { size_mm: [40, 30, 20] },
    mounting_holes: [],
    ports: [{ id: 'port1', name: 'Port 1', connector: 'jst-sh', ways: 4, pose: { p_mm: [20, 0, 10], q: [0, 0, 0, 1] }, interfaces: ['i2c'] }],
    confidence: 'measured',
    custom: true,
    ...extra,
  };
}

function libPart(id: string): Part {
  return { ...myPart(id), name: `Library ${id}`, custom: undefined, confidence: 'generic' };
}

const scene = { sources: [], links: [{ id: 'L', name: 'L', meshes: [] }], joints: [] };

beforeEach(() => {
  useApp.setState({ notices: [], connectorLibrary: connectors, cableLibrary: null });
});

describe('design.parts bookkeeping', () => {
  it('adds a custom part when it is placed and removes it with its last component', () => {
    const lib = runtimeLibrary({ version: 1, parts: [libPart('lib-a')] }, { parts: [] }, [myPart()])!;
    useApp.setState({ library: lib, design: { ...emptyDesign('p'), scene } });
    const place = (id: string, part: string) =>
      s().commit((d) => ({ ...d, components: [...d.components, { id, name: id, part, link: 'L', pose: { p_mm: [0, 0, 0], q: [0, 0, 0, 1] } }] }));
    place('c1', 'custom-box-1');
    place('c2', 'custom-box-1');
    place('c3', 'lib-a');
    expect(s().design.parts.map((p) => p.id)).toEqual(['custom-box-1']); // library parts are not copied in
    s().commit((d) => removeComponent(d, 'c1'));
    expect(s().design.parts.map((p) => p.id)).toEqual(['custom-box-1']);
    s().commit((d) => removeComponent(d, 'c2'));
    expect(s().design.parts).toEqual([]);
  });

  it('leaves non-custom definitions alone and returns the same design when nothing changes', () => {
    const d: Design = { ...emptyDesign('p'), parts: [libPart('x')] };
    expect(syncDesignParts(d, null)).toBe(d);
  });

  it('a design opened with custom parts this PC does not know puts them in the runtime library', () => {
    const theirs = myPart('custom-theirs-9', { name: 'Their box' });
    const lib = runtimeLibrary({ version: 1, parts: [libPart('lib-a')] }, { parts: [theirs] }, [myPart()])!;
    expect(lib.parts.map((p) => p.id).sort()).toEqual(['custom-box-1', 'custom-theirs-9', 'lib-a']);
    // The design's copy wins over the one kept on this PC.
    const lib2 = runtimeLibrary(null, { parts: [myPart('custom-box-1', { name: 'Edited' })] }, [myPart()])!;
    expect(lib2.parts.find((p) => p.id === 'custom-box-1')!.name).toBe('Edited');
  });
});

describe('the port editor', () => {
  const apply = (q: readonly number[], v: [number, number, number]) => new Vector3(...v).applyQuaternion(new Quaternion(q[0], q[1], q[2], q[3]));
  const close = (a: Vector3, b: [number, number, number]) => expect(a.distanceTo(new Vector3(...b))).toBeLessThan(1e-6);

  it('the six exit buttons turn the cable exit (+X) to that direction and keep the port upright', () => {
    const want: Record<ExitDir, { x: [number, number, number]; y: [number, number, number] }> = {
      '+x': { x: [1, 0, 0], y: [0, 1, 0] },
      '-x': { x: [-1, 0, 0], y: [0, -1, 0] },
      '+y': { x: [0, 1, 0], y: [-1, 0, 0] },
      '-y': { x: [0, -1, 0], y: [1, 0, 0] },
      '+z': { x: [0, 0, 1], y: [0, 1, 0] },
      '-z': { x: [0, 0, -1], y: [0, 1, 0] },
    };
    for (const [dir, { x, y }] of Object.entries(want) as Array<[ExitDir, (typeof want)[ExitDir]]>) {
      const q = EXIT_QUATS[dir];
      close(apply(q, [1, 0, 0]), x);
      close(apply(q, [0, 1, 0]), y);
      expect(Math.hypot(...q)).toBeCloseTo(1, 9);
      const part = setExit(myPart(), 'port1', dir);
      expect(exitOf(part.ports[0]!)).toBe(dir);
    }
  });

  it('adds a port where the user picked, leaving along the surface normal, at the smallest size', () => {
    const { part, port } = addPortAt(myPart(), [3.14159, -15, 7], [0, -1, 0], connectors, 'jst-sh');
    expect(part.ports).toHaveLength(2);
    expect(port.id).toBe('port2');
    expect(port.pose.p_mm).toEqual([3.142, -15, 7]);
    close(apply(port.pose.q, [1, 0, 0]), [0, -1, 0]);
    close(apply(port.pose.q, [0, 0, 1]), [0, 0, 1]); // upright: height along the part's +Z
    const sh = connectors.connectors.find((c) => c.id === 'jst-sh')!;
    expect(port.ways).toBe(sh.ways.min);
    // A slanted normal still gives a proper rotation with +X along it.
    const n: [number, number, number] = [0.6, 0, 0.8];
    close(apply(quatForExit(n), [1, 0, 0]), n);
  });

  it('never writes a port the design check refuses: every connector, at its default and every offered size', () => {
    for (const conn of connectors.connectors) {
      const { part } = addPortAt(myPart(), [0, 0, 0], [1, 0, 0], connectors, conn.id);
      expect(partProblems(part, connectors)).toEqual([]);
      const switched = setPortConnector(myPart(), 'port1', conn.id, connectors);
      expect(partProblems(switched, connectors)).toEqual([]);
      for (const ways of waysChoices(conn)) {
        const sized = { ...switched, ports: switched.ports.map((p) => ({ ...p, ways })) };
        expect(partProblems(sized, connectors)).toEqual([]);
      }
    }
    // The design check sees what the editor guards against.
    const bad = myPart('custom-bad', { ports: [{ ...myPart().ports[0]!, connector: 'no-such-thing' }] });
    const issues = validateDesign({ ...emptyDesign('p'), parts: [bad] }, undefined, connectors);
    expect(issues.some((i) => i.severity === 'error' && i.message.includes('no-such-thing'))).toBe(true);
  });

  it('flip reverses the exit; nudges move by 0.5 mm along part axes', () => {
    const flipped = flipExit(myPart(), 'port1');
    expect(exitOf(flipped.ports[0]!)).toBe('-x');
    const moved = nudgePort(nudgePort(myPart(), 'port1', 2, 0.5), 'port1', 0, -0.5);
    expect(moved.ports[0]!.pose.p_mm).toEqual([19.5, 0, 10.5]);
  });
});

describe('wire ends follow their part', () => {
  function withWire(): Design {
    const part = myPart();
    const route: Route = {
      id: 'r1',
      cable: 'w1',
      crossings: [],
      from: { component: 'c1', port: 'port1' },
      segments: segmentsFromPoints([
        { link: 'L', p: [20, 0, 10], n: [0, 0, 0] },
        { link: 'L', p: [21, 0, 10], n: [0, 0, 0] },
        { link: 'L', p: [80, 0, 0], n: [0, 0, 1] },
      ]),
    };
    return {
      ...emptyDesign('p'),
      scene,
      parts: [part],
      components: [{ id: 'c1', name: 'Box', part: part.id, link: 'L', pose: { p_mm: [0, 0, 0], q: [0, 0, 0, 1] } }],
      cables: [{ id: 'w1', name: 'W', connections: [], type: 'w', count: 4, twisted: false, sleeve_wall_mm: 0, reasons: [] }],
      routes: [route],
    };
  }

  it('after a move and a turn the end sits on the port and the lead-out is at least the plug', () => {
    const d = withWire();
    const lib = runtimeLibrary(null, d);
    const turned = { ...d, components: [{ ...d.components[0]!, pose: { p_mm: [10, 5, 0] as [number, number, number], q: [0, 0, Math.SQRT1_2, Math.SQRT1_2] as [number, number, number, number] } }] };
    const out = followWireEnds(turned, { library: lib, connectors, cables: null });
    const pts = pointsOfRoute(out.routes[0]!);
    const { origin, exit } = portInLink(turned.components[0]!, d.parts[0]!.ports[0]!);
    expect(new Vector3(...pts[0]!.p).distanceTo(origin)).toBeLessThan(1e-6);
    expect(origin.toArray()).toEqual([10, 25, 10].map((v) => expect.closeTo(v, 6)) as never);
    const lead = new Vector3(...pts[1]!.p).sub(origin);
    const plug = plugLengthAt(d.parts[0]!.ports[0]!, connectors);
    expect(plug).toBeGreaterThan(1);
    expect(lead.length()).toBeGreaterThanOrEqual(plug - 1e-9);
    expect(lead.normalize().dot(exit)).toBeCloseTo(1, 9);
    expect(pts[2]!.p).toEqual([80, 0, 0]); // the rest of the leg is kept
    expect(followWireEnds(out, { library: lib, connectors, cables: null })).toBe(out); // already there
  });

  it('a component move through the store carries the wire end with it', () => {
    const d = withWire();
    useApp.setState({ design: d, library: runtimeLibrary(null, d) });
    s().commit((x) => ({ ...x, components: x.components.map((c) => ({ ...c, pose: { ...c.pose, p_mm: [0, 40, 0] as [number, number, number] } })) }));
    expect(pointsOfRoute(s().design.routes[0]!)[0]!.p).toEqual([20, 40, 10]);
  });

  it('an end whose port is gone is left where it is', () => {
    const d = withWire();
    const noPort = { ...d, parts: [{ ...d.parts[0]!, ports: [] }] };
    expect(followWireEnds(noPort, { library: runtimeLibrary(null, noPort), connectors, cables: null })).toBe(noPort);
  });
});

describe('reading a part file', () => {
  const cube: PartMesh = {
    name: 'cube',
    positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10]),
    indices: new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]),
  };

  it('reads a good part file and keeps its model', async () => {
    const sha = await sha256Hex(encodePartGlb([cube]));
    const part = myPart('custom-cube-1', { model: { uri: `custom:${sha}` } });
    const out = (await readPartFile(encodePartGlb([cube], part), connectors))!;
    expect(out.part.id).toBe('custom-cube-1');
    expect(out.part.custom).toBe(true);
    expect(await sha256Hex(out.modelGlb!)).toBe(sha);
  });

  it('a GLB without a definition is a plain model (null)', async () => {
    expect(await readPartFile(encodePartGlb([cube]), connectors)).toBeNull();
  });

  it('refuses a definition that does not pass the schema', async () => {
    const bad = { ...myPart(), category: 'teapot' } as unknown as Part;
    await expect(readPartFile(encodePartGlb([cube], bad), connectors)).rejects.toThrow(/not valid: category/);
    // Passes the schema but not the part checks.
    const flat = { ...myPart(), body: { size_mm: [40, -1, 20] } } as unknown as Part;
    await expect(readPartFile(encodePartGlb([cube], flat), connectors)).rejects.toThrow(/has a problem: the body size must be positive/);
  });

  it('refuses a custom: model uri whose sha does not match the model inside', async () => {
    const part = myPart('custom-cube-1', { model: { uri: `custom:${'0'.repeat(64)}` } });
    await expect(readPartFile(encodePartGlb([cube], part), connectors)).rejects.toThrow(/does not match/);
  });
});
