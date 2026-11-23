// Unit handling, file selection, error handling and the URDF corner cases.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { importModel } from '../../src/app/ingest';
import { boxOf, boxStl, installDomParser, modelBox, readFixture, textFile, toArrayBuffer } from './helpers';

installDomParser();

describe('units of unitless formats', () => {
  const size = async (unitlessAs?: 'mm' | 'cm' | 'm' | 'inch') => {
    const model = await importModel([{ path: 'box.stl', data: boxStl(1, 2, 3) }], { unitlessAs });
    expect(model.sources[0]!.mm_per_unit).toBe({ mm: 1, cm: 10, m: 1000, inch: 25.4, undefined: 1 }[String(unitlessAs) as 'mm']);
    return modelBox(model).getSize(new (await import('three')).Vector3());
  };

  it('scales a 1 x 2 x 3 box by the chosen unit', async () => {
    const mm = await size('mm');
    expect([mm.x, mm.y, mm.z]).toEqual([1, 2, 3]);
    const m = await size('m');
    expect(m.x / mm.x).toBeCloseTo(1000, 6);
    expect(m.z / mm.z).toBeCloseTo(1000, 6);
    const inch = await size('inch');
    expect(inch.y / mm.y).toBeCloseTo(25.4, 6);
    expect(inch.x / m.x).toBeCloseTo(25.4 / 1000, 9);
    const cm = await size('cm');
    expect(cm.x / mm.x).toBeCloseTo(10, 6);
  });

  it('defaults to millimetres and says so', async () => {
    const model = await importModel([{ path: 'box.stl', data: boxStl(1, 2, 3) }]);
    expect(modelBox(model).max.toArray()).toEqual([1, 2, 3]);
    expect(model.warnings.join(' ')).toMatch(/assuming millimetres/);
  });

  it('reads ASCII STL', async () => {
    const stl = `solid t
facet normal 0 0 1
 outer loop
  vertex 0 0 0
  vertex 5 0 0
  vertex 0 5 0
 endloop
endfacet
endsolid t`;
    const model = await importModel([textFile('tri.stl', stl)], { unitlessAs: 'cm' });
    expect(modelBox(model).max.toArray()).toEqual([50, 50, 0]);
  });

  it('reads OBJ with polygons and negative indices', async () => {
    const obj = `o quad\nv 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4\n`;
    const model = await importModel([textFile('quad.obj', obj)], { unitlessAs: 'm' });
    expect(model.meshes).toHaveLength(1);
    expect(model.meshes[0]!.geometry.getIndex()!.count).toBe(6);
    expect(modelBox(model).max.toArray()).toEqual([1000, 1000, 0]);
  });
});

describe('choosing and rejecting files', () => {
  it('rejects when no supported file is present', async () => {
    await expect(importModel([textFile('readme.txt', 'hello')])).rejects.toThrow(/No supported model file/);
    await expect(importModel([])).rejects.toThrow(/No supported model file/);
  });

  it('prefers a URDF over mesh files and says nothing about the meshes it uses', async () => {
    const model = await importModel([readFixture('arm3', 'meshes/gripper_base.stl'), readFixture('arm3', 'arm3.urdf')]);
    expect(model.sources[0]!.kind).toBe('urdf');
    expect(model.warnings).toEqual([]);
  });

  it('warns about extra model files that were not imported', async () => {
    const model = await importModel([{ path: 'a.stl', data: boxStl(1, 1, 1) }, { path: 'b.stl', data: boxStl(2, 2, 2) }]);
    expect(model.sources[0]!.uri).toBe('a.stl');
    expect(model.warnings.join(' ')).toMatch(/b\.stl/);
  });

  it('uses the file name as id prefix, or the option', async () => {
    const stl = boxStl(1, 1, 1);
    expect((await importModel([{ path: 'dir/My part (v2).stl', data: stl }])).links[0]!.id).toBe('My_part_v2_.link');
    expect((await importModel([{ path: 'a.stl', data: stl }], { idPrefix: 'x1' })).meshes[0]!.id).toBe('x1.a');
    expect((await importModel([{ path: '(((.stl', data: stl }])).sources[0]!.id).toBe('model');
  });

  it('records the SHA-256 of the model file', async () => {
    const file = readFixture('chassis', 'chassis.glb');
    const model = await importModel([file]);
    expect(model.sources[0]!.sha256).toBe(createHash('sha256').update(new Uint8Array(file.data)).digest('hex'));
    expect(model.sources[0]).toMatchObject({ kind: 'glb', mm_per_unit: 1000, uri: 'chassis.glb' });
  });

  it('reports progress from 0 to 1', async () => {
    const seen: number[] = [];
    await importModel([readFixture('chassis', 'chassis.glb')], { onProgress: (f) => seen.push(f) });
    expect(seen.at(-1)).toBe(1);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });
});

describe('damaged input', () => {
  it('rejects a truncated STEP file with a readable message', async () => {
    const file = readFixture('enclosure', 'enclosure.step');
    const half = { path: file.path, data: file.data.slice(0, Math.floor(file.data.byteLength / 2)) };
    await expect(importModel([half])).rejects.toThrow(/STEP file could not be read/);
  });

  it('rejects text that is not STEP', async () => {
    await expect(importModel([textFile('x.step', 'this is not a step file')])).rejects.toThrow(/STEP file could not be read/);
  });

  it('rejects an empty STL', async () => {
    await expect(importModel([{ path: 'e.stl', data: toArrayBuffer(new Uint8Array(84)) }])).rejects.toThrow(/no usable geometry/);
  });
});

describe('URDF corner cases', () => {
  it('warns about a missing mesh and keeps the rest of the robot', async () => {
    const urdf = `<robot name="r">
      <link name="base"><visual><geometry><box size="0.1 0.1 0.1"/></geometry></visual>
        <visual><geometry><mesh filename="package://r/meshes/gone.stl"/></geometry></visual></link></robot>`;
    const model = await importModel([textFile('r.urdf', urdf)]);
    expect(model.links[0]!.meshes).toHaveLength(1);
    expect(model.meshes).toHaveLength(1);
    expect(model.warnings.join(' ')).toMatch(/gone\.stl.*not found/);
    expect(modelBox(model).max.toArray().map((x) => Math.round(x))).toEqual([50, 50, 50]);
  });

  it('matches meshes by longest path suffix and applies scale (in metres)', async () => {
    const urdf = `<robot name="r"><link name="l"><visual><geometry><mesh filename="../meshes/part.stl" scale="0.5 2 1"/></geometry></visual></link></robot>`;
    const model = await importModel([
      textFile('robot/r.urdf', urdf),
      { path: 'other/part.stl', data: boxStl(9, 9, 9) },
      { path: 'robot/meshes/part.stl', data: boxStl(0.1, 0.1, 0.1) }, // metres
    ]);
    expect(model.warnings).toEqual([]);
    const size = boxOf(model.meshes[0]!.geometry).getSize(new (await import('three')).Vector3());
    expect(size.toArray().map((x) => Math.round(x * 1e6) / 1e6)).toEqual([50, 200, 100]);
  });

  it('treats floating and planar joints as fixed with a warning, and checks the tree', async () => {
    const urdf = (type: string) => `<robot name="r"><link name="a"/><link name="b"/>
      <joint name="j" type="${type}"><parent link="a"/><child link="b"/></joint></robot>`;
    const model = await importModel([textFile('r.urdf', urdf('floating'))]);
    expect(model.joints[0]!.type).toBe('fixed');
    expect(model.warnings.join(' ')).toMatch(/floating/);
    const bad = `<robot name="r"><link name="a"/><joint name="j" type="fixed"><parent link="a"/><child link="nope"/></joint></robot>`;
    await expect(importModel([textFile('r.urdf', bad)])).rejects.toThrow(/unknown child link "nope"/);
    await expect(importModel([textFile('r.urdf', '<robot><link name="a"></robot>')])).rejects.toThrow(/not valid XML/);
  });

  it('defaults the axis to x, as URDF does, and converts prismatic limits to mm', async () => {
    const urdf = `<robot name="r"><link name="a"/><link name="b"/>
      <joint name="j" type="prismatic"><parent link="a"/><child link="b"/><limit lower="-0.01" upper="0.02"/></joint></robot>`;
    const model = await importModel([textFile('r.urdf', urdf)]);
    expect(model.joints[0]).toMatchObject({ axis: [1, 0, 0], limit: { lower: -10, upper: 20 } });
  });
});
