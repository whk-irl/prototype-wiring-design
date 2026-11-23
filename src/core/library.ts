/**
 * The parts library: boards, sensors and other things that get mounted and
 * wired. Library files are YAML (`library/parts*.yaml`, merged by the app). The shape of a part
 * and of a port is in `schema.ts` (`PartSchema`, `PortSchema`), because a
 * design file carries the user's own parts in the same form.
 *
 * Part frame: origin at the centre of the mounting face, +Z pointing away from
 * the surface the part is mounted on. A part's envelope occupies
 * x in [-sx/2, sx/2], y in [-sy/2, sy/2], z in [0, sz].
 *
 * Port frame: origin at the mouth of the connector, +X pointing along the
 * direction the cable leaves.
 */
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { findConnector, portProblem, type ConnectorLibrary } from './connectors';
import { PartSchema, type Design, type Part } from './schema';

export const LibrarySchema = z.strictObject({
  version: z.literal(1),
  parts: z.array(PartSchema),
});

export type Library = z.infer<typeof LibrarySchema>;

/**
 * What is wrong with one part beyond its shape, one sentence each: duplicate
 * port ids, ports or holes outside the envelope, a board outside the
 * envelope and, when a connector library is given, connectors it does not
 * know or sizes they do not come in.
 */
export function partProblems(part: Part, connectors?: ConnectorLibrary): string[] {
  const out: string[] = [];
  const [sx, sy, sz] = part.body.size_mm;
  if (!(sx > 0 && sy > 0 && sz > 0)) out.push('the body size must be positive in all three directions');
  const ports = new Set<string>();
  // A port sits at the mouth of its connector, which may overhang the edge of
  // a board by a few millimetres; anything further out is a mistake.
  const slack = 6;
  for (const port of part.ports) {
    if (ports.has(port.id)) out.push(`duplicate port id "${port.id}"`);
    ports.add(port.id);
    const [x, y, z0] = port.pose.p_mm;
    if (Math.abs(x) > sx / 2 + slack || Math.abs(y) > sy / 2 + slack || z0 < -slack || z0 > sz + slack) {
      out.push(`port "${port.id}" lies outside the part`);
    }
    const q = port.pose.q;
    if (Math.abs(Math.hypot(q[0], q[1], q[2], q[3]) - 1) > 1e-3) out.push(`port "${port.id}": the rotation is not a unit quaternion`);
    if (connectors) {
      const problem = portProblem(findConnector(connectors, port.connector), port);
      if (problem) out.push(`port "${port.id}": ${problem}`);
    }
  }
  for (const [i, hole] of part.mounting_holes.entries()) {
    if (Math.abs(hole.p_mm[0]) > sx / 2 || Math.abs(hole.p_mm[1]) > sy / 2) out.push(`mounting hole ${i + 1} lies outside the part`);
  }
  const board = part.body.board;
  if (board && board.z_mm + board.thickness_mm > sz + 1e-6) out.push('the board lies above the top of the part');
  return out;
}

/**
 * Parse a parts library YAML file. Throws a ZodError or YAML error with the
 * location, or an Error naming the part.
 *
 * A bundled part must say where its figures come from unless it is a generic
 * stand-in, and a bundled model must carry its licence, credit and origin.
 */
export function parseLibrary(yamlText: string, connectors?: ConnectorLibrary): Library {
  const lib = LibrarySchema.parse(parseYaml(yamlText));
  const seen = new Set<string>();
  for (const part of lib.parts) {
    if (seen.has(part.id)) throw new Error(`duplicate part id "${part.id}"`);
    seen.add(part.id);
    const problems = partProblems(part, connectors);
    if (problems.length > 0) throw new Error(`part "${part.id}": ${problems[0]}`);
    if (part.confidence !== 'generic' && !part.source) throw new Error(`part "${part.id}": confidence "${part.confidence}" needs a source`);
    if (part.model) {
      if (part.model.uri.startsWith('custom:')) throw new Error(`part "${part.id}": a bundled part cannot use a custom model`);
      if (!part.model.license || !part.model.attribution || !part.model.source) {
        throw new Error(`part "${part.id}": a bundled model needs its license, attribution and source`);
      }
    }
  }
  return lib;
}

export function findPart(lib: Library, id: string): Part | undefined {
  return lib.parts.find((p) => p.id === id);
}

/**
 * A library with `parts` added. A part with the id of one already there
 * replaces it, so a design's own parts win over the bundled ones.
 */
export function mergeLibrary(base: Library, parts: readonly Part[]): Library {
  if (parts.length === 0) return base;
  const ids = new Set(parts.map((p) => p.id));
  return { version: 1, parts: [...base.parts.filter((p) => !ids.has(p.id)), ...parts] };
}

/** The part a component refers to: the design's own first, then the library's. */
export function resolvePart(design: Pick<Design, 'parts'>, library: Library | undefined, id: string): Part | undefined {
  return design.parts.find((p) => p.id === id) ?? (library ? findPart(library, id) : undefined);
}
