/**
 * Zones store triangle indices run-length encoded as
 * `[start, count, start, count, ...]`, ascending and non-overlapping, with
 * adjacent runs merged. A painted patch is mostly contiguous index ranges, so
 * this keeps design files small.
 */

/** Encode a set of triangle indices. Input may be unsorted and contain duplicates. */
export function encodeTriangles(indices: Iterable<number>): number[] {
  const sorted = Array.from(new Set(indices)).sort((a, b) => a - b);
  const out: number[] = [];
  let start = -1;
  let count = 0;
  for (const i of sorted) {
    if (!Number.isInteger(i) || i < 0) throw new RangeError(`invalid triangle index ${i}`);
    if (count > 0 && i === start + count) {
      count++;
    } else {
      if (count > 0) out.push(start, count);
      start = i;
      count = 1;
    }
  }
  if (count > 0) out.push(start, count);
  return out;
}

/** Decode to an ascending list of triangle indices. */
export function decodeTriangles(runs: readonly number[]): number[] {
  const out: number[] = [];
  for (let k = 0; k + 1 < runs.length; k += 2) {
    const start = runs[k]!;
    const count = runs[k + 1]!;
    for (let i = 0; i < count; i++) out.push(start + i);
  }
  return out;
}

/** Number of triangles in an encoded list. */
export function countTriangles(runs: readonly number[]): number {
  let n = 0;
  for (let k = 1; k < runs.length; k += 2) n += runs[k]!;
  return n;
}

/**
 * Why an encoded list is malformed, or null if it is well formed.
 * `triCount`, when given, is the size of the mesh the list indexes.
 */
export function trianglesProblem(runs: readonly number[], triCount?: number): string | null {
  if (runs.length % 2 !== 0) return 'odd number of entries; expected [start, count] pairs';
  // Last index of the previous run. -2 so that a first run starting at 0 is
  // not mistaken for one that touches a previous run.
  let prevEnd = -2;
  for (let k = 0; k < runs.length; k += 2) {
    const start = runs[k]!;
    const count = runs[k + 1]!;
    if (!Number.isInteger(start) || !Number.isInteger(count) || start < 0) return `run ${k / 2} is not a pair of non-negative integers`;
    if (count < 1) return `run ${k / 2} has count ${count}`;
    // `prevEnd + 1` also rejects adjacent runs, which the encoder would have merged
    if (start <= prevEnd + 1) return `run ${k / 2} overlaps, touches or precedes the previous run`;
    prevEnd = start + count - 1;
  }
  if (triCount !== undefined && prevEnd >= triCount) return `index ${prevEnd} is outside the mesh (${triCount} triangles)`;
  return null;
}
