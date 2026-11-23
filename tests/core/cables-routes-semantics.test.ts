// What the cable and route mathematics mean, against values worked out by hand.
import { describe, expect, it } from 'vitest';
import {
  bendsTighterThan,
  bundleDiameter,
  cableEnvelope,
  cornerRadii,
  cutLength,
  emptyDesign,
  jointsBetween,
  routeLength,
  segmentCentreLine,
  type CableType,
  type Design,
  type Route,
} from '@core';

const wire = (od: number, bend = 5): CableType => ({
  id: 'w',
  name: 'w',
  family: 'hookup_wire',
  section: { shape: 'round', od_mm: od },
  conductors: 1,
  min_bend_mm: { static: bend, dynamic: bend * 2 },
  flex: 'flexible',
  connectors: [],
  interfaces: [],
  confidence: 'generic',
});
const build = (count: number, twisted = false, lay?: number, sleeve = 0) => ({
  count,
  twisted,
  sleeve_wall_mm: sleeve,
  ...(lay ? { lay_length_mm: lay } : {}),
});

describe('bundle size', () => {
  it('matches the geometry of 1, 2, 3, 4 and 7 equal wires', () => {
    expect(bundleDiameter(1.5, 1)).toBeCloseTo(1.5, 10);
    expect(bundleDiameter(1.5, 2)).toBeCloseTo(3.0, 10); // side by side
    expect(bundleDiameter(1.5, 3)).toBeCloseTo(1.5 * (1 + 2 / Math.sqrt(3)), 3); // triangle
    expect(bundleDiameter(1.5, 4)).toBeCloseTo(1.5 * (1 + Math.SQRT2), 3); // square
    expect(bundleDiameter(1.5, 7)).toBeCloseTo(4.5, 10); // one in the middle, six round it
  });

  it('never shrinks when a wire is added', () => {
    for (let n = 1; n < 60; n++) expect(bundleDiameter(1, n + 1)).toBeGreaterThanOrEqual(bundleDiameter(1, n) - 1e-12);
  });

  it('adds the sleeve wall on both sides', () => {
    expect(cableEnvelope(wire(1), build(2, false, undefined, 0.3)).width_mm).toBeCloseTo(2.6, 10);
  });
});

describe('bend radius of a bundle', () => {
  it('is the wire limit for one wire and grows by the offset of the innermost wire', () => {
    expect(cableEnvelope(wire(1, 5), build(1)).bend_static_mm).toBe(5);
    // Two 1 mm wires: bundle 2 mm, wire centres 0.5 mm from the bundle centre.
    const pair = cableEnvelope(wire(1, 5), build(2));
    expect(pair.bend_static_mm).toBeCloseTo(5.5, 10);
    expect(pair.bend_dynamic_mm).toBeCloseTo(10.5, 10);
  });
});

describe('twisting', () => {
  it('lengthens each wire by the helix it follows', () => {
    // Pair of 1 mm wires, one twist every 10 mm: helix radius 0.5 mm.
    const e = cableEnvelope(wire(1), build(2, true, 10));
    expect(e.length_factor).toBeCloseTo(Math.sqrt(1 + (Math.PI / 10) ** 2), 12);
    expect(e.lay_length_mm).toBe(10);
    expect(e.notes).toEqual([]);
  });

  it('says so when it assumes a lay length, and ignores twist on a single wire', () => {
    const assumed = cableEnvelope(wire(1), build(2, true));
    expect(assumed.lay_length_mm).toBeCloseTo(24, 10);
    expect(assumed.notes.join(' ')).toMatch(/assum/i);
    const single = cableEnvelope(wire(1), build(1, true));
    expect(single.length_factor).toBe(1);
    expect(single.notes.join(' ')).toMatch(/single/i);
  });
});

describe('flat cable', () => {
  const ffc: CableType = {
    ...wire(1),
    family: 'ffc',
    section: { shape: 'flat', width_mm: 16, thickness_mm: 0.3 },
    min_bend_mm: { static: 2 },
  };
  it('is wide and thin, stacks in height, and cannot be twisted', () => {
    const one = cableEnvelope(ffc, build(1));
    expect([one.width_mm, one.height_mm]).toEqual([16, 0.3]);
    const two = cableEnvelope(ffc, build(2, true));
    expect(two.height_mm).toBeCloseTo(0.6, 10);
    expect(two.width_mm).toBe(16);
    expect(two.length_factor).toBe(1);
    expect(two.bend_static_mm).toBeCloseTo(2.15, 10);
  });
});

/** A hinge: `arm` turns about the z axis through the origin of `base`. */
function hinge(): Design {
  const d = emptyDesign('hinge');
  d.scene.links.push({ id: 'base', name: 'base', meshes: [] }, { id: 'arm', name: 'arm', meshes: [] }, { id: 'tip', name: 'tip', meshes: [] });
  d.scene.joints.push(
    {
      id: 'j',
      name: 'j',
      type: 'revolute',
      parent: 'base',
      child: 'arm',
      origin: { p_mm: [0, 0, 0], q: [0, 0, 0, 1] },
      axis: [0, 0, 1],
      limit: { lower: 0, upper: Math.PI / 2 },
      value: 0,
    },
    { id: 'k', name: 'k', type: 'fixed', parent: 'arm', child: 'tip', origin: { p_mm: [100, 0, 0], q: [0, 0, 0, 1] }, axis: [0, 0, 0], value: 0 },
  );
  d.cables.push({ id: 'c', connections: [], type: 'w', count: 1, twisted: false, sleeve_wall_mm: 0, reasons: [] });
  return d;
}

describe('route length', () => {
  const up: [number, number, number] = [0, 0, 1];
  const route: Route = {
    id: 'r',
    cable: 'c',
    segments: [
      // On the base: 30 mm ending 10 mm short of the hinge, lying on a surface facing +z.
      { link: 'base', points_mm: [[-40, 0, 0], [-10, 0, 0]], normals: [up, up] },
      // On the arm: starts 10 mm out from the hinge, runs 50 mm.
      { link: 'arm', points_mm: [[10, 0, 0], [60, 0, 0]], normals: [up, up] },
    ],
    crossings: [],
  };

  it('lifts surface points by the given amount and leaves free points alone', () => {
    expect(segmentCentreLine(route.segments[0]!, 1.5)).toEqual([[-40, 0, 1.5], [-10, 0, 1.5]]);
    expect(segmentCentreLine({ link: 'base', points_mm: [[1, 2, 3]], normals: [[0, 0, 0]] }, 9)).toEqual([[1, 2, 3]]);
    expect(segmentCentreLine({ link: 'base', points_mm: [[1, 2, 3]] }, 9)).toEqual([[1, 2, 3]]);
  });

  it('adds the fixed parts to the crossing at its shortest and longest', () => {
    const d = hinge();
    const length = routeLength(d, route, 1);
    expect(length.on_links_mm).toBeCloseTo(80, 10);
    expect(length.crossings).toHaveLength(1);
    expect(length.crossings[0]!.joints).toEqual(['j']);
    // Straight out the two ends are 20 mm apart; at 90 degrees, 10 mm each side of a right angle.
    expect(length.crossings[0]!.max_mm).toBeCloseTo(20, 9);
    expect(length.crossings[0]!.min_mm).toBeCloseTo(Math.hypot(10, 10), 9);
    expect(length.max_mm).toBeCloseTo(100, 9);
    expect(cutLength(length, 1.05, 8)).toBeCloseTo(100 * 1.05 + 16, 9);
  });

  it('does not vary a crossing over a fixed joint, and finds the joints between links', () => {
    const d = hinge();
    expect(jointsBetween(d.scene, 'base', 'tip')).toEqual(['j', 'k']);
    expect(jointsBetween(d.scene, 'tip', 'base')).toEqual(['k', 'j']);
    expect(jointsBetween(d.scene, 'arm', 'arm')).toEqual([]);
    const fixed: Route = {
      id: 'f',
      cable: 'c',
      crossings: [],
      segments: [
        { link: 'arm', points_mm: [[90, 0, 0]] },
        { link: 'tip', points_mm: [[5, 0, 0]] },
      ],
    };
    const length = routeLength(d, fixed, 0);
    expect(length.crossings[0]!.joints).toEqual([]);
    expect(length.crossings[0]!.min_mm).toBeCloseTo(15, 10);
    expect(length.crossings[0]!.max_mm).toBeCloseTo(15, 10);
  });
});

describe('corner radii', () => {
  it('gives infinity straight on, half a leg at a right angle, zero at a reversal', () => {
    expect(cornerRadii([[0, 0, 0], [10, 0, 0], [20, 0, 0]])).toEqual([Infinity]);
    expect(cornerRadii([[0, 0, 0], [10, 0, 0], [10, 10, 0]])[0]).toBeCloseTo(5, 10); // 5 / tan(45 deg)
    expect(cornerRadii([[0, 0, 0], [10, 0, 0], [0, 0, 0]])[0]).toBeCloseTo(0, 10);
    // The shorter leg limits it.
    expect(cornerRadii([[0, 0, 0], [10, 0, 0], [10, 4, 0]])[0]).toBeCloseTo(2, 10);
  });

  it('reports the corners a cable cannot make', () => {
    const route: Route = {
      id: 'r',
      cable: 'c',
      crossings: [],
      segments: [{ link: 'base', points_mm: [[0, 0, 0], [10, 0, 0], [10, 10, 0], [40, 10, 0]] }],
    };
    expect(bendsTighterThan(route, 0, 4)).toEqual([]);
    const tight = bendsTighterThan(route, 0, 6);
    expect(tight.map((t) => t.point).sort()).toEqual([1, 2]);
    expect(tight[0]!.radius_mm).toBeCloseTo(5, 10);
  });
});

describe('bend radius source and user override', () => {
  it('reports the library confidence as the source of the limit', () => {
    expect(cableEnvelope(wire(1, 5), build(1)).bend_source).toBe('generic');
    expect(cableEnvelope({ ...wire(1, 5), confidence: 'derived', source: 'https://example.com', note: 'x' }, build(1)).bend_source).toBe('derived');
  });

  it('lets the user replace the wire limit, keeps the bundle offset, and says so', () => {
    const e = cableEnvelope(wire(1, 5), { ...build(2), bend_override_mm: 3 });
    expect(e.bend_source).toBe('user');
    expect(e.bend_static_mm).toBeCloseTo(3.5, 10);
    expect(e.bend_dynamic_mm).toBeCloseTo(3.5, 10);
    expect(e.notes.join(' ')).toMatch(/set by the user/);
  });
});

describe('flat cables and turns within the surface', () => {
  const up: [number, number, number] = [0, 0, 1];
  it('finds a sideways turn on a flat surface and ignores a bend over an edge', async () => {
    const { inPlaneTurns } = await import('@core');
    // Lying on a floor facing +z, the route turns 90 degrees within the floor.
    const sideways: Route = {
      id: 'r',
      cable: 'c',
      crossings: [],
      segments: [{ link: 'base', points_mm: [[0, 0, 0], [20, 0, 0], [20, 20, 0]], normals: [up, up, up] }],
    };
    const turns = inPlaneTurns(sideways, 0.15);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ segment: 0, point: 1 });
    expect(turns[0]!.angle_deg).toBeCloseTo(90, 9);

    // Running along x on the floor, then up a wall: a bend across the ribbon's thickness, which it can make.
    const overEdge: Route = {
      id: 'r',
      cable: 'c',
      crossings: [],
      segments: [{ link: 'base', points_mm: [[0, 0, 0], [20, 0, 0], [20, 0, 20]], normals: [up, [-0.7071067811865476, 0, 0.7071067811865476], [-1, 0, 0]] }],
    };
    expect(inPlaneTurns(overEdge, 0.15)).toEqual([]);
    // A free point in the middle is not judged.
    const free: Route = { ...sideways, segments: [{ ...sideways.segments[0]!, normals: [up, [0, 0, 0], up] }] };
    expect(inPlaneTurns(free, 0.15)).toEqual([]);
  });
});

describe('crossings over many joints', () => {
  it('names the joints it did not sweep', () => {
    const d = emptyDesign('chain');
    const ids = ['l0', 'l1', 'l2', 'l3', 'l4'];
    for (const id of ids) d.scene.links.push({ id, name: id, meshes: [] });
    for (let i = 1; i < ids.length; i++) {
      d.scene.joints.push({
        id: `j${i}`,
        name: `j${i}`,
        type: 'revolute',
        parent: ids[i - 1]!,
        child: ids[i]!,
        origin: { p_mm: [10, 0, 0], q: [0, 0, 0, 1] },
        axis: [0, 0, 1],
        limit: { lower: -1, upper: 1 },
        value: 0,
      });
    }
    const route: Route = {
      id: 'r',
      cable: 'c',
      crossings: [],
      segments: [
        { link: 'l0', points_mm: [[0, 0, 0]] },
        { link: 'l4', points_mm: [[5, 0, 0]] },
      ],
    };
    const length = routeLength(d, route, 0, 3);
    expect(length.crossings[0]!.joints).toEqual(['j1', 'j2', 'j3', 'j4']);
    expect(length.crossings[0]!.unsampled).toEqual(['j4']);
  });
});

describe('a cable pulled tight over a profile', () => {
  it('rests on the high points and bridges the hollows', async () => {
    const { tautOverProfile } = await import('@core');
    // Two bumps with a hollow between and after.
    expect(tautOverProfile([[0, 0], [1, 2], [2, 0], [3, 3], [4, 0]])).toEqual([0, 1, 3, 4]);
    // A flat run keeps only its ends; so does a hollow.
    expect(tautOverProfile([[0, 1], [1, 1], [2, 1], [3, 1]])).toEqual([0, 3]);
    expect(tautOverProfile([[0, 0], [1, -5], [2, -1], [3, 0]])).toEqual([0, 3]);
    // A step up: the string leaves the low ground and touches the top corner.
    expect(tautOverProfile([[0, 0], [5, 0], [5.01, 4], [10, 4]])).toEqual([0, 2, 3]);
    // A smooth hump is kept point by point.
    const hump = Array.from({ length: 9 }, (_, i) => [i, Math.sin((i / 8) * Math.PI)] as [number, number]);
    expect(tautOverProfile(hump)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(tautOverProfile([])).toEqual([]);
    expect(tautOverProfile([[0, 0]])).toEqual([0]);
  });

  it('never lets the string pass below the surface', async () => {
    const { tautOverProfile } = await import('@core');
    // Deterministic pseudo-random profile.
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let trial = 0; trial < 200; trial++) {
      const profile = Array.from({ length: 40 }, (_, i) => [i + rnd() * 0.5, rnd() * 10] as [number, number]);
      const kept = tautOverProfile(profile);
      expect(kept[0]).toBe(0);
      expect(kept[kept.length - 1]).toBe(39);
      for (let k = 1; k < kept.length; k++) {
        const [ax, ay] = profile[kept[k - 1]!]!;
        const [bx, by] = profile[kept[k]!]!;
        for (let i = kept[k - 1]! + 1; i < kept[k]!; i++) {
          const [x, y] = profile[i]!;
          const onString = ay + ((by - ay) * (x - ax)) / (bx - ax);
          expect(y).toBeLessThanOrEqual(onString + 1e-9);
        }
      }
    }
  });
});
