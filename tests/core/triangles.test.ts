import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { countTriangles, decodeTriangles, encodeTriangles, trianglesProblem } from '@core';

fc.configureGlobal({ seed: 20261121 });

describe('triangles', () => {
  it.each([
    [[], []],
    [[5], [5, 1]],
    [[0, 1, 2], [0, 3]],
    [[3, 1, 2, 0], [0, 4]],
    [[0, 1, 3, 4, 5, 9], [0, 2, 3, 3, 9, 1]],
    [[7, 7, 7], [7, 1]],
  ])('encodes %j as %j', (input, runs) => {
    expect(encodeTriangles(input)).toEqual(runs);
    expect(decodeTriangles(runs)).toEqual([...new Set(input)].sort((a, b) => a - b));
  });

  it('accepts any iterable', () => {
    expect(encodeTriangles(new Set([2, 1, 0]))).toEqual([0, 3]);
  });

  it.each([[-1], [1.5], [NaN], [Infinity]])('encode throws RangeError for %j', (bad) => {
    expect(() => encodeTriangles([0, bad])).toThrow(RangeError);
  });

  it('decodes ignoring a trailing odd entry', () => {
    expect(decodeTriangles([2, 2, 9])).toEqual([2, 3]);
  });

  it('countTriangles sums run lengths', () => {
    expect(countTriangles([])).toBe(0);
    expect(countTriangles([0, 3, 10, 4])).toBe(7);
  });

  describe('trianglesProblem', () => {
    it('accepts well-formed lists', () => {
      expect(trianglesProblem([])).toBeNull();
      expect(trianglesProblem([0, 3, 5, 1])).toBeNull();
      expect(trianglesProblem([0, 3, 5, 1], 6)).toBeNull();
    });
    it('rejects an odd number of entries', () => {
      expect(trianglesProblem([0, 3, 5])).toMatch(/odd/);
    });
    it.each([[[-1, 2]], [[0.5, 2]], [[0, 1.5]], [[NaN, 1]]])('rejects non-integer or negative entry %j', (runs) => {
      expect(trianglesProblem(runs)).toMatch(/non-negative integers/);
    });
    it('rejects a zero or negative count', () => {
      expect(trianglesProblem([0, 0])).toMatch(/count/);
      expect(trianglesProblem([0, -2])).toMatch(/count/);
    });
    it('rejects overlapping, touching and unordered runs', () => {
      expect(trianglesProblem([0, 5, 3, 2])).not.toBeNull();
      expect(trianglesProblem([10, 2, 0, 2])).not.toBeNull();
      expect(trianglesProblem([4, 1, 4, 1])).not.toBeNull();
    });
    it('rejects adjacent runs, which the encoder would have merged', () => {
      expect(trianglesProblem([0, 3, 3, 2])).not.toBeNull();
    });
    it('checks the mesh size', () => {
      expect(trianglesProblem([0, 5], 5)).toBeNull();
      expect(trianglesProblem([0, 5], 4)).toMatch(/outside the mesh/);
      expect(trianglesProblem([0, 5, 9, 1], 9)).toMatch(/outside the mesh/);
      expect(trianglesProblem([], 0)).toBeNull();
    });
  });

  describe('properties', () => {
    const indices = fc.array(fc.integer({ min: 0, max: 500 }), { maxLength: 120 });
    const sortedUnique = (xs: number[]) => [...new Set(xs)].sort((a, b) => a - b);

    it('decode(encode(xs)) is the sorted unique xs', () => {
      fc.assert(fc.property(indices, (xs) => {
        expect(decodeTriangles(encodeTriangles(xs))).toEqual(sortedUnique(xs));
      }));
    });
    it('the encoding is always well formed', () => {
      fc.assert(fc.property(indices, (xs) => {
        expect(trianglesProblem(encodeTriangles(xs))).toBeNull();
      }));
    });
    it('countTriangles equals the unique count', () => {
      fc.assert(fc.property(indices, (xs) => {
        expect(countTriangles(encodeTriangles(xs))).toBe(new Set(xs).size);
      }));
    });
    it('the encoding fits a mesh just large enough and not one smaller', () => {
      fc.assert(
        fc.property(
          indices.filter((xs) => xs.length > 0),
          (xs) => {
            const max = Math.max(...xs);
            expect(trianglesProblem(encodeTriangles(xs), max + 1)).toBeNull();
            expect(trianglesProblem(encodeTriangles(xs), max)).not.toBeNull();
          },
        ),
      );
    });
  });
});
