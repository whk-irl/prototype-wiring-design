# Contributing

Thanks for looking. The project is early: the design file, the 3D editor, parts and hand-drawn wires work; automatic routing and STEP or GLB export do not exist yet. [docs/PLAN.md](docs/PLAN.md) says where it is going.

## Getting set up

Node.js 22.13 or newer in the 22 line, 24, or 26 and later.

```
npm install
npm run dev        # the app, on http://localhost:5173
npm test           # unit and property tests
npm run typecheck
npm run lint
npm run build
```

CI runs the last four on every push and pull request. Please run them before you open one.

## How the code is laid out

- `src/core/` is pure TypeScript with no browser or Node dependencies: the design-file schema, validation, kinematics, cable and connector rules, and the solvers for the shape of a wire. Everything in it is unit-tested and most of it is property-tested.
- `src/app/` is the browser app (React, three.js, zustand). It never invents a number: sizes, bend limits and checks come from the core and the libraries.
- `library/` holds the parts, connector and cable libraries as YAML.

Conventions: millimetres, Z up, quaternions as `[x, y, z, w]`, positions stored in the frame of the link they belong to.

## Adding a cable, connector or part to the libraries

Every figure needs to say where it came from.

- Give a `source` link that you opened yourself, and set `confidence` honestly: `datasheet` for the maker's figure, `measured` for one you measured, `derived` for one worked out from a datasheet figure by a rule stated in `note`, `generic` for a typical value.
- Do not copy a bend radius from a search-result snippet. If the maker gives none, use the library rule in [docs/CABLES.md](docs/CABLES.md) and say so in the note.
- 3D models of parts must come from a source whose licence allows redistribution, and the licence goes in `public/parts/NOTICE.md`. Models from sources without a clear licence are not accepted, however convenient.

## Changes to checks and rules

A check that tells someone their wiring is fine has to be right. A change to a bend, fit, length or slack calculation needs a test with expected values worked out by hand (in a comment), not values copied from the code's own output, and a line in the relevant document under `docs/` saying what the rule is and where it comes from.

## Reporting a problem

Open an issue with what you did, what you expected and what happened. A `design.json` that shows the problem helps most; leave out model files you are not free to share.

## Licence

By contributing you agree that your contribution is licensed under the Apache License 2.0, the licence of the project.
