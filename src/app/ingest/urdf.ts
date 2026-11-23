/**
 * URDF importer. Own parser (DOMParser); urdf-loader is not used here.
 *
 * Units: URDF is metres and radians. Lengths become millimetres, prismatic
 * limits too. `rpy` is fixed-axis roll-pitch-yaw: R = Rz(yaw) * Ry(pitch) * Rx(roll).
 */
import { Matrix4, Quaternion, Vector3, type BufferGeometry } from 'three';
import type { Joint, JointType, Link, MeshRef } from '@core';
import { parseMeshFile } from './meshfiles';
import { bakePart, DEFAULT_COLOR, findByPathSuffix, srgbToLinear, type ParsedPart } from './model';
import { uniqueId } from './ids';
import { boxMesh, cylinderMesh, sphereMesh } from './primitives';
import type { ImportedMesh, ImportedModel, ImportFile } from './types';

const M_TO_MM = 1000;

type Rgb = [number, number, number];

function kids(el: Element, tag: string): Element[] {
  return Array.from(el.children).filter((c) => c.tagName === tag);
}
function kid(el: Element, tag: string): Element | null {
  return kids(el, tag)[0] ?? null;
}

/** Parse "a b c" into `n` finite numbers, or null. */
function numbers(text: string | null, n: number): number[] | null {
  if (text === null) return null;
  const v = text.trim().split(/\s+/).filter((s) => s !== '').map(Number);
  return v.length === n && v.every(Number.isFinite) ? v : null;
}

function rpyQuaternion(roll: number, pitch: number, yaw: number): Quaternion {
  const x = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), roll);
  const y = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), pitch);
  const z = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), yaw);
  return z.multiply(y).multiply(x); // Rz * Ry * Rx
}

interface Origin {
  xyz: [number, number, number];
  q: Quaternion;
}

function readOrigin(el: Element | null, where: string, warnings: string[]): Origin {
  const origin: Origin = { xyz: [0, 0, 0], q: new Quaternion() };
  const o = el ? kid(el, 'origin') : null;
  if (!o) return origin;
  const xyzText = o.getAttribute('xyz');
  const rpyText = o.getAttribute('rpy');
  const xyz = numbers(xyzText, 3);
  const rpy = numbers(rpyText, 3);
  if (xyzText !== null && !xyz) warnings.push(`${where}: could not read origin xyz "${xyzText}"; using 0 0 0.`);
  if (rpyText !== null && !rpy) warnings.push(`${where}: could not read origin rpy "${rpyText}"; using 0 0 0.`);
  if (xyz) origin.xyz = [xyz[0]!, xyz[1]!, xyz[2]!];
  if (rpy) origin.q = rpyQuaternion(rpy[0]!, rpy[1]!, rpy[2]!);
  return origin;
}

function originMatrix(o: Origin): Matrix4 {
  return new Matrix4().compose(new Vector3(...o.xyz), o.q, new Vector3(1, 1, 1));
}

function colorOf(rgba: string | null): Rgb | null {
  const v = numbers(rgba, 4);
  return v ? [srgbToLinear(v[0]!), srgbToLinear(v[1]!), srgbToLinear(v[2]!)] : null;
}

interface VisualDef {
  origin: Origin;
  geometry: Element;
  color: Rgb | null;
}

export async function importUrdf(
  file: ImportFile,
  all: ImportFile[],
  prefix: string,
  sha256: string,
  warnings: string[],
  progress: (fraction: number, label: string) => void,
): Promise<ImportedModel> {
  if (typeof DOMParser === 'undefined') throw new Error('URDF import needs DOMParser, which is not available here.');
  const doc = new DOMParser().parseFromString(new TextDecoder().decode(file.data), 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) throw new Error(`"${file.path}" is not valid XML, so it cannot be read as a URDF.`);
  const robot = doc.documentElement;
  if (!robot || robot.tagName !== 'robot') throw new Error(`"${file.path}" is not a URDF file (no <robot> element).`);

  // ---- named materials
  const materials = new Map<string, Rgb>();
  for (const m of kids(robot, 'material')) {
    const c = colorOf(kid(m, 'color')?.getAttribute('rgba') ?? null);
    const name = m.getAttribute('name');
    if (name && c) materials.set(name, c);
  }

  // ---- links
  const linkEls = kids(robot, 'link');
  if (linkEls.length === 0) throw new Error(`"${file.path}" has no <link> elements.`);
  const usedLinkIds = new Set<string>();
  const usedMeshIds = new Set<string>();
  const linkIdByName = new Map<string, string>();
  const links: Link[] = [];
  const visualsOf: VisualDef[][] = [];
  for (const el of linkEls) {
    const raw = el.getAttribute('name');
    if (!raw) throw new Error('A <link> in the URDF has no name.');
    if (linkIdByName.has(raw)) {
      warnings.push(`Link name "${raw}" is used twice; the second one is renamed.`);
    }
    const id = uniqueId(usedLinkIds, prefix, raw);
    if (!linkIdByName.has(raw)) linkIdByName.set(raw, id);
    links.push({ id, name: raw, meshes: [] });
    const visuals: VisualDef[] = [];
    for (const v of kids(el, 'visual')) {
      const geometry = kid(v, 'geometry');
      if (!geometry) continue;
      const mat = kid(v, 'material');
      let color: Rgb | null = null;
      if (mat) {
        color = colorOf(kid(mat, 'color')?.getAttribute('rgba') ?? null);
        if (!color) {
          const ref = mat.getAttribute('name');
          if (ref && materials.has(ref)) color = materials.get(ref)!;
        }
      }
      visuals.push({ origin: readOrigin(v, `Link "${raw}" visual`, warnings), geometry, color });
    }
    visualsOf.push(visuals);
  }

  // ---- joints
  const usedJointIds = new Set<string>();
  const joints: Joint[] = [];
  const parentOf = new Set<string>();
  for (const el of kids(robot, 'joint')) {
    const rawName = el.getAttribute('name');
    if (!rawName) throw new Error('A <joint> in the URDF has no name.');
    const parentName = kid(el, 'parent')?.getAttribute('link') ?? '';
    const childName = kid(el, 'child')?.getAttribute('link') ?? '';
    const parent = linkIdByName.get(parentName);
    const child = linkIdByName.get(childName);
    if (!parent) throw new Error(`Joint "${rawName}" refers to the unknown parent link "${parentName}".`);
    if (!child) throw new Error(`Joint "${rawName}" refers to the unknown child link "${childName}".`);
    if (parentOf.has(child)) throw new Error(`Link "${childName}" is the child of more than one joint, which is not a tree.`);
    parentOf.add(child);

    let type = (el.getAttribute('type') ?? '') as string;
    if (!['fixed', 'revolute', 'continuous', 'prismatic'].includes(type)) {
      if (type === 'floating' || type === 'planar') warnings.push(`Joint "${rawName}" is ${type}, which is not supported; it is imported as fixed.`);
      else warnings.push(`Joint "${rawName}" has unknown type "${type}"; it is imported as fixed.`);
      type = 'fixed';
    }

    const axisText = kid(el, 'axis')?.getAttribute('xyz') ?? null;
    let axis = numbers(axisText, 3) ?? [1, 0, 0]; // URDF default axis is x
    if (axisText !== null && !numbers(axisText, 3)) warnings.push(`Joint "${rawName}": could not read axis "${axisText}"; using 1 0 0.`);
    const len = Math.hypot(...(axis as [number, number, number]));
    if (len < 1e-9) {
      warnings.push(`Joint "${rawName}" has a zero-length axis; using 1 0 0.`);
      axis = [1, 0, 0];
    } else axis = axis.map((a) => a / len);

    const limitEl = kid(el, 'limit');
    const lowerRaw = Number(limitEl?.getAttribute('lower') ?? 0);
    const upperRaw = Number(limitEl?.getAttribute('upper') ?? 0);
    let limit: { lower: number; upper: number } | undefined;
    if (type === 'revolute' || type === 'prismatic') {
      if (!limitEl || !Number.isFinite(lowerRaw) || !Number.isFinite(upperRaw)) {
        if (type === 'revolute') {
          warnings.push(`Revolute joint "${rawName}" has no usable <limit>; it is imported as continuous.`);
          type = 'continuous';
        } else {
          warnings.push(`Prismatic joint "${rawName}" has no usable <limit>; it is imported as fixed.`);
          type = 'fixed';
        }
      } else {
        const k = type === 'prismatic' ? M_TO_MM : 1;
        limit = { lower: lowerRaw * k, upper: upperRaw * k };
        if (limit.lower > limit.upper) throw new Error(`Joint "${rawName}" has a lower limit above its upper limit.`);
      }
    }
    if (kid(el, 'mimic')) warnings.push(`Joint "${rawName}" has a <mimic>, which is ignored; it moves independently.`);

    const origin = readOrigin(el, `Joint "${rawName}"`, warnings);
    const q = origin.q.normalize();
    const joint: Joint = {
      id: uniqueId(usedJointIds, prefix, rawName),
      name: rawName,
      type: type as JointType,
      parent,
      child,
      origin: { p_mm: [origin.xyz[0] * M_TO_MM, origin.xyz[1] * M_TO_MM, origin.xyz[2] * M_TO_MM], q: [q.x, q.y, q.z, q.w] },
      axis: type === 'fixed' ? [0, 0, 1] : [axis[0]!, axis[1]!, axis[2]!],
      value: 0,
    };
    if (limit) joint.limit = limit;
    joints.push(joint);
  }

  // ---- geometry
  const meshFileCache = new Map<string, Promise<ParsedPart[] | null>>();
  const loadMeshFile = (target: ImportFile) => {
    let p = meshFileCache.get(target.path);
    if (!p) {
      p = parseMeshFile(target, all).catch((e: unknown) => {
        warnings.push(`Could not read "${target.path}": ${e instanceof Error ? e.message : String(e)}`);
        return null;
      });
      meshFileCache.set(target.path, p);
    }
    return p;
  };

  const meshes: ImportedMesh[] = [];
  for (let li = 0; li < links.length; li++) {
    const link = links[li]!;
    const refs: MeshRef[] = link.meshes;
    const visuals = visualsOf[li]!;
    progress(0.2 + (0.75 * li) / links.length, `Reading link ${link.name}`);
    for (let vi = 0; vi < visuals.length; vi++) {
      const vis = visuals[vi]!;
      const where = `Link "${link.name}" visual ${vi}`;
      const frame = originMatrix(vis.origin);
      const baked: { part: ParsedPart; geometry: BufferGeometry }[] = [];

      const shape = vis.geometry.firstElementChild;
      if (!shape) continue;
      const mmPerUnit = M_TO_MM;
      const primitive = (raw: ParsedPart['raw'], what: string) => {
        const part: ParsedPart = { name: what, node: `${link.name}/visual${vi}`, color: DEFAULT_COLOR, raw };
        const geometry = bakePart(part, mmPerUnit, frame, where, warnings, true);
        if (geometry) baked.push({ part, geometry });
      };
      switch (shape.tagName) {
        case 'box': {
          const s = numbers(shape.getAttribute('size'), 3);
          if (s) primitive(boxMesh(s[0]!, s[1]!, s[2]!), 'box');
          else warnings.push(`${where}: box has no readable size.`);
          break;
        }
        case 'cylinder': {
          const r = Number(shape.getAttribute('radius'));
          const l = Number(shape.getAttribute('length'));
          if (Number.isFinite(r) && Number.isFinite(l)) primitive(cylinderMesh(r, l), 'cylinder');
          else warnings.push(`${where}: cylinder has no readable radius and length.`);
          break;
        }
        case 'sphere': {
          const r = Number(shape.getAttribute('radius'));
          if (Number.isFinite(r)) primitive(sphereMesh(r), 'sphere');
          else warnings.push(`${where}: sphere has no readable radius.`);
          break;
        }
        case 'mesh': {
          const filename = shape.getAttribute('filename') ?? '';
          const target = findByPathSuffix(filename, all.filter((f) => f !== file));
          if (!target) {
            warnings.push(`${where}: mesh "${filename}" was not found among the supplied files; that visual is left out.`);
            break;
          }
          const parts = await loadMeshFile(target);
          if (parts === null) {
            const message = `${where}: mesh "${filename}" could not be used (unsupported format or unreadable); that visual is left out.`;
            if (!warnings.includes(message)) warnings.push(message);
            break;
          }
          const sc = numbers(shape.getAttribute('scale'), 3) ?? (numbers(shape.getAttribute('scale'), 1) ? Array(3).fill(Number(shape.getAttribute('scale'))) : [1, 1, 1]);
          const withScale = frame.clone().multiply(new Matrix4().makeScale(sc[0]!, sc[1]!, sc[2]!));
          for (const part of parts) {
            const geometry = bakePart(part, mmPerUnit, withScale, `${where} (${target.path})`, warnings);
            if (geometry) baked.push({ part, geometry });
          }
          break;
        }
        default:
          warnings.push(`${where}: geometry <${shape.tagName}> is not supported and is left out.`);
      }

      baked.forEach(({ part, geometry }, k) => {
        const id = uniqueId(usedMeshIds, link.id, `v${vi}`, ...(baked.length > 1 ? [`p${k}`] : []));
        meshes.push({ id, link: link.id, geometry, color: vis.color ?? part.color });
        refs.push({
          id,
          source: prefix,
          node: baked.length > 1 ? `${link.name}/visual${vi}/${part.node}` : `${link.name}/visual${vi}`,
          tri_count: (geometry.getIndex()?.count ?? 0) / 3,
        });
      });
    }
  }

  return {
    sources: [{ id: prefix, kind: 'urdf', uri: file.path, mm_per_unit: M_TO_MM, sha256 }],
    links,
    joints,
    meshes,
    warnings,
  };
}
