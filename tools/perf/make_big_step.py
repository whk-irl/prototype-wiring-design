"""Generate a large STEP assembly for the import performance budget
(docs/TEST_PLAN.md section 9). The output goes to tools/out/, which is not
committed.

    .venv/Scripts/python tools/perf/make_big_step.py 1500 tools/out/big.step
"""
import sys
import time

from build123d import Box, Compound, Cylinder, Pos, export_step, fillet


def bracket(i: int):
    w, d, h = 40 + (i % 7) * 3, 30 + (i % 5) * 2, 10 + (i % 3) * 2
    body = fillet(Box(w, d, h).edges(), 2)
    for k in range(4):
        body -= Pos((k - 1.5) * 8, 0, 0) * Cylinder(2 + 0.1 * (i % 4), h * 2)
    return body


def main() -> None:
    count = int(sys.argv[1])
    out = sys.argv[2]
    start = time.time()
    parts = []
    for i in range(count):
        part = Pos((i % 40) * 70, (i // 40) * 60, 0) * bracket(i)
        part.label = f"bracket_{i}"
        parts.append(part)
    export_step(Compound(label="big", children=parts), out)
    print(f"{count} parts in {time.time() - start:.1f} s -> {out}")


if __name__ == "__main__":
    main()
