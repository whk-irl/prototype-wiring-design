/**
 * Loading and checking design files. `DesignSchema` checks shape; the checks
 * here are the ones a schema cannot express: references that must resolve, the
 * joint tree being a tree, and numeric sanity.
 */
import { cableTypeProblems } from './cables';
import type { ConnectorLibrary } from './connectors';
import { partProblems, resolvePart, findPart, type Library } from './library';
import { DesignSchema, SCHEMA_VERSION, type Design } from './schema';
import { trianglesProblem } from './triangles';

export interface Issue {
  severity: 'error' | 'warning';
  /** Where in the file, for example `scene.joints[2].child`. */
  path: string;
  message: string;
}

export type ParseResult = { ok: true; design: Design; issues: Issue[] } | { ok: false; issues: Issue[] };

/**
 * Parse an untrusted value (for example the result of `JSON.parse`) into a
 * design. `ok` is false if the shape is wrong or any issue is an error;
 * warnings alone do not fail the parse.
 */
export function parseDesign(raw: unknown, library?: Library, connectors?: ConnectorLibrary): ParseResult {
  const version = (raw as { schema?: unknown } | null)?.schema;
  if (typeof version === 'number' && version > SCHEMA_VERSION) {
    return {
      ok: false,
      issues: [
        {
          severity: 'error',
          path: 'schema',
          message: `this file uses schema version ${version}; this build reads up to version ${SCHEMA_VERSION}`,
        },
      ],
    };
  }
  const parsed = DesignSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({
        severity: 'error' as const,
        path: formatPath(i.path),
        message: i.message,
      })),
    };
  }
  const issues = validateDesign(parsed.data, library, connectors);
  if (issues.some((i) => i.severity === 'error')) return { ok: false, issues };
  return { ok: true, design: parsed.data, issues };
}

function formatPath(path: ReadonlyArray<PropertyKey>): string {
  let out = '';
  for (const key of path) {
    if (typeof key === 'number') out += `[${key}]`;
    else out += out ? `.${String(key)}` : String(key);
  }
  return out;
}

const QUAT_TOLERANCE = 1e-6;

/**
 * Semantic checks on a shape-valid design. With a `library`, part and port
 * references are checked too; without one they are skipped. With a connector
 * library, the ports of the design's own parts are checked against it: a
 * connector it does not know, or a size the connector does not come in, is an
 * error.
 */
export function validateDesign(design: Design, library?: Library, connectors?: ConnectorLibrary): Issue[] {
  const issues: Issue[] = [];
  const error = (path: string, message: string) => issues.push({ severity: 'error', path, message });
  const warning = (path: string, message: string) => issues.push({ severity: 'warning', path, message });

  const uniqueIds = (items: ReadonlyArray<{ id: string }>, path: string): Set<string> => {
    const seen = new Set<string>();
    items.forEach((item, i) => {
      if (seen.has(item.id)) error(`${path}[${i}].id`, `duplicate id "${item.id}"`);
      seen.add(item.id);
    });
    return seen;
  };
  const checkQuat = (q: readonly number[], path: string) => {
    const n = Math.hypot(q[0]!, q[1]!, q[2]!, q[3]!);
    // Written so that NaN fails: any comparison with NaN is false.
    if (!(Math.abs(n - 1) <= QUAT_TOLERANCE)) {
      error(path, Number.isFinite(n) ? `quaternion is not unit length (norm ${n.toFixed(6)})` : 'quaternion has a non-finite component');
    }
  };
  const checkFinite = (v: readonly number[], path: string) => {
    if (!v.every(Number.isFinite)) error(path, 'has a non-finite component');
  };

  // ---- scene
  const { sources, links, joints } = design.scene;
  const sourceIds = uniqueIds(sources, 'scene.sources');
  const linkIds = uniqueIds(links, 'scene.links');
  uniqueIds(joints, 'scene.joints');

  /** mesh id -> owning link id and triangle count */
  const meshes = new Map<string, { link: string; triCount: number }>();
  links.forEach((link, li) => {
    link.meshes.forEach((mesh, mi) => {
      const path = `scene.links[${li}].meshes[${mi}]`;
      if (meshes.has(mesh.id)) error(`${path}.id`, `duplicate mesh id "${mesh.id}"`);
      meshes.set(mesh.id, { link: link.id, triCount: mesh.tri_count });
      if (!sourceIds.has(mesh.source)) error(`${path}.source`, `unknown source "${mesh.source}"`);
      if (mesh.pose) {
        checkQuat(mesh.pose.q, `${path}.pose.q`);
        checkFinite(mesh.pose.p_mm, `${path}.pose.p_mm`);
      } else if (link.user_defined) {
        error(`${path}.pose`, `mesh "${mesh.id}" is on user-defined link "${link.id}" and needs a pose`);
      }
    });
  });

  const parentJointOf = new Map<string, string>();
  joints.forEach((joint, i) => {
    const path = `scene.joints[${i}]`;
    if (!linkIds.has(joint.parent)) error(`${path}.parent`, `unknown link "${joint.parent}"`);
    if (!linkIds.has(joint.child)) error(`${path}.child`, `unknown link "${joint.child}"`);
    if (joint.parent === joint.child) error(`${path}.child`, 'a joint cannot connect a link to itself');
    const other = parentJointOf.get(joint.child);
    if (other !== undefined) error(`${path}.child`, `link "${joint.child}" is already the child of joint "${other}"`);
    else parentJointOf.set(joint.child, joint.id);

    checkQuat(joint.origin.q, `${path}.origin.q`);
    checkFinite(joint.origin.p_mm, `${path}.origin.p_mm`);
    checkFinite(joint.axis, `${path}.axis`);
    if (!Number.isFinite(joint.value)) error(`${path}.value`, 'is not a finite number');
    if (joint.type !== 'fixed' && Math.hypot(...joint.axis) < 1e-9) error(`${path}.axis`, 'axis has zero length');
    if (joint.type === 'revolute' || joint.type === 'prismatic') {
      if (!joint.limit) error(`${path}.limit`, `a ${joint.type} joint needs a limit`);
    }
    if (joint.limit) {
      if (joint.limit.lower > joint.limit.upper) error(`${path}.limit`, 'lower is greater than upper');
      else if (joint.type !== 'continuous' && (joint.value < joint.limit.lower || joint.value > joint.limit.upper)) {
        warning(`${path}.value`, 'saved value is outside the joint limit');
      }
    }
  });

  // The joint graph must be a forest: every link reachable from a link with no parent joint.
  if (links.length > 0) {
    const childrenOf = new Map<string, string[]>();
    for (const j of joints) {
      const list = childrenOf.get(j.parent);
      if (list) list.push(j.child);
      else childrenOf.set(j.parent, [j.child]);
    }
    const reached = new Set<string>();
    const stack = links.filter((l) => !parentJointOf.has(l.id)).map((l) => l.id);
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (reached.has(id)) continue;
      reached.add(id);
      for (const child of childrenOf.get(id) ?? []) stack.push(child);
    }
    links.forEach((link, i) => {
      if (!reached.has(link.id)) error(`scene.links[${i}]`, `link "${link.id}" is part of a joint cycle`);
    });
  }

  // ---- zones
  uniqueIds(design.zones, 'zones');
  const zonesById = new Map(design.zones.map((z) => [z.id, z]));
  design.zones.forEach((zone, i) => {
    const path = `zones[${i}]`;
    if (!linkIds.has(zone.link)) error(`${path}.link`, `unknown link "${zone.link}"`);
    const mesh = meshes.get(zone.mesh);
    if (!mesh) {
      error(`${path}.mesh`, `unknown mesh "${zone.mesh}"`);
    } else if (mesh.link !== zone.link) {
      error(`${path}.mesh`, `mesh "${zone.mesh}" belongs to link "${mesh.link}", not "${zone.link}"`);
    }
    const problem = trianglesProblem(zone.triangles, mesh?.triCount);
    if (problem) error(`${path}.triangles`, problem);
  });

  // ---- the design's own parts
  uniqueIds(design.parts, 'parts');
  design.parts.forEach((part, i) => {
    for (const problem of partProblems(part, connectors)) error(`parts[${i}]`, problem);
    if (library && findPart(library, part.id)) {
      warning(`parts[${i}].id`, `part "${part.id}" has the id of a library part and is used in its place`);
    }
  });
  const hasPart = (id: string): boolean => !!resolvePart(design, library, id);

  // ---- components
  const componentIds = uniqueIds(design.components, 'components');
  const partOf = new Map<string, string>();
  design.components.forEach((component, i) => {
    const path = `components[${i}]`;
    partOf.set(component.id, component.part);
    if (!linkIds.has(component.link)) error(`${path}.link`, `unknown link "${component.link}"`);
    if (component.zone !== undefined) {
      const zone = zonesById.get(component.zone);
      if (!zone) error(`${path}.zone`, `unknown zone "${component.zone}"`);
      else if (zone.link !== component.link) {
        error(`${path}.zone`, `zone "${zone.id}" is on link "${zone.link}", but the component is on "${component.link}"`);
      } else if (zone.kind === 'keep_out') {
        warning(`${path}.zone`, `zone "${zone.id}" is a keep-out zone`);
      }
    }
    checkQuat(component.pose.q, `${path}.pose.q`);
    checkFinite(component.pose.p_mm, `${path}.pose.p_mm`);
    if (library && !hasPart(component.part)) error(`${path}.part`, `part "${component.part}" is not in the library or in this design's own parts`);
  });

  // ---- connections
  const connectionIds = uniqueIds(design.connections, 'connections');
  design.connections.forEach((connection, i) => {
    const path = `connections[${i}]`;
    for (const end of ['from', 'to'] as const) {
      const ref = connection[end];
      if (!componentIds.has(ref.component)) {
        error(`${path}.${end}.component`, `unknown component "${ref.component}"`);
        continue;
      }
      const part = resolvePart(design, library, partOf.get(ref.component)!);
      const port = part?.ports.find((p) => p.id === ref.port);
      if (part && !port) error(`${path}.${end}.port`, `part "${part.id}" has no port "${ref.port}"`);
      else if (port && !port.interfaces.includes(connection.interface)) {
        warning(`${path}.${end}.port`, `port "${ref.port}" does not list interface "${connection.interface}"`);
      }
    }
    if (connection.from.component === connection.to.component && connection.from.port === connection.to.port) {
      error(`${path}.to`, 'a connection cannot join a port to itself');
    }
  });

  // ---- the design's own cable types
  uniqueIds(design.cable_types, 'cable_types');
  design.cable_types.forEach((type, i) => {
    for (const problem of cableTypeProblems(type)) error(`cable_types[${i}]`, problem);
    if (type.confidence === 'derived' && !type.note) error(`cable_types[${i}].note`, 'a derived value needs a note saying how it was derived');
    if (!type.custom) {
      warning(`cable_types[${i}].id`, `cable type "${type.id}" is not marked as the user's own: in this design it is used in place of any library cable with the same id`);
    }
  });
  // The user's own cable types exist only where they were entered, so a design
  // must carry the definition of each one its cables use.
  const ownCableTypes = new Set(design.cable_types.map((t) => t.id));
  design.cables.forEach((cable, i) => {
    if (cable.type.startsWith('custom-') && !ownCableTypes.has(cable.type)) {
      error(`cables[${i}].type`, `cable type "${cable.type}" is one of the user's own, and the design does not carry its definition`);
    }
  });

  // ---- cables, routes, fixings, mounts
  const cableIds = uniqueIds(design.cables, 'cables');
  design.cables.forEach((cable, i) => {
    cable.connections.forEach((id, k) => {
      if (!connectionIds.has(id)) error(`cables[${i}].connections[${k}]`, `unknown connection "${id}"`);
    });
  });

  const jointIds = new Set(joints.map((j) => j.id));
  const routeIds = uniqueIds(design.routes, 'routes');
  design.routes.forEach((route, i) => {
    if (!cableIds.has(route.cable)) error(`routes[${i}].cable`, `unknown cable "${route.cable}"`);
    for (const end of ['from', 'to'] as const) {
      const ref = route[end];
      if (!ref) continue;
      if (!componentIds.has(ref.component)) {
        error(`routes[${i}].${end}.component`, `unknown component "${ref.component}"`);
        continue;
      }
      const part = resolvePart(design, library, partOf.get(ref.component)!);
      if (part && !part.ports.some((p) => p.id === ref.port)) error(`routes[${i}].${end}.port`, `part "${part.id}" has no port "${ref.port}"`);
    }
    route.segments.forEach((segment, k) => {
      const path = `routes[${i}].segments[${k}]`;
      if (!linkIds.has(segment.link)) error(`${path}.link`, `unknown link "${segment.link}"`);
      segment.points_mm.forEach((p, n) => checkFinite(p, `${path}.points_mm[${n}]`));
      if (segment.ties && segment.ties.length !== segment.points_mm.length) {
        error(`${path}.ties`, `has ${segment.ties.length} entries for ${segment.points_mm.length} points`);
      }
      if (segment.normals) {
        if (segment.normals.length !== segment.points_mm.length) {
          error(`${path}.normals`, `has ${segment.normals.length} entries for ${segment.points_mm.length} points`);
        }
        segment.normals.forEach((v, n) => {
          const length = Math.hypot(v[0], v[1], v[2]);
          // Zero means "no surface here"; anything else must be a unit vector.
          if (!(length === 0 || Math.abs(length - 1) <= 1e-6)) error(`${path}.normals[${n}]`, 'is neither zero nor unit length');
        });
      }
    });
    route.crossings.forEach((crossing, k) => {
      if (!jointIds.has(crossing.joint)) error(`routes[${i}].crossings[${k}].joint`, `unknown joint "${crossing.joint}"`);
    });
  });

  uniqueIds(design.fixings, 'fixings');
  design.fixings.forEach((fixing, i) => {
    if (!routeIds.has(fixing.route)) error(`fixings[${i}].route`, `unknown route "${fixing.route}"`);
  });

  uniqueIds(design.mounts, 'mounts');
  design.mounts.forEach((mount, i) => {
    if (!componentIds.has(mount.component)) error(`mounts[${i}].component`, `unknown component "${mount.component}"`);
  });

  return issues;
}
