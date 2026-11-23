# Test and evaluation plan

Status: partly in use. Today `.github/workflows/ci.yml` runs type check, lint, the vitest unit and property tests and the production build on every push and pull request; the stage tests marked as planned in section 2, the benchmark, the model evaluations, the physical test and the reviews in sections 3 to 7, and the extra CI jobs in section 10 are plans and do not exist yet. Written 2026-11-21. All numeric targets are initial values. They are recalibrated once, after the first baseline run of each suite, and then frozen for the milestone.

## 1. What is being evaluated

Two different questions, kept separate:

1. **Is each stage correct?** Unit, property and export tests (sections 2–4).
2. **Is the whole pipeline useful?** The benchmark, the model evaluations and the physical test on a real machine (sections 5–7).

The reference low-end machine is the development PC: i7-8700, 32 GB RAM, GTX 1060 3 GB.

## 2. Stage tests

| Stage | Test type | What is asserted | Tooling |
|---|---|---|---|
| Schema | Unit | Valid files accepted, each invalid fixture rejected with the right error; older schema versions migrate | vitest |
| Ingest | Unit, golden | Fixture STEP/GLB/URDF load; part count, bounding box and joint limits match recorded values | vitest (pytest planned) |
| Kinematics | Cross-check | Our link poses match urdf-loader and MuJoCo within 1e-6 m over 1,000 random joint vectors | vitest for urdf-loader; MuJoCo and pytest planned |
| Placement, manual (M1) | Unit | Surface hit and rotation to a pose in the link frame and back; re-parenting keeps the world pose; collision and out-of-zone warnings | vitest |
| Placement, automatic (M3) | Property | Placed part lies inside its zone, does not intersect the model, connector exit is unobstructed | fast-check (planned) |
| Rule engine | Table-driven | One row per rule at, just under and just over its limit; datasheet override beats default; user override beats both | vitest |
| Cable selection | Golden + property | 40 hand-labelled connections give the expected cable class; raising current never selects a thinner wire; adding a joint crossing never downgrades the flex class | vitest |
| Router | Property (section 3) | Route invariants | fast-check (planned) |
| Fixings | Property | Spacing ≤ rule limit; first fixing within the allowed distance of the connector; no fixing spans a joint | fast-check (planned) |
| Export | Round trip (section 4) | Geometry and counts survive export and re-import | pytest (planned) |
| UI | End to end | Load fixture, place, route, edit, export; files exist and validate | Playwright (planned) |

## 3. Route invariants

Checked on every route the router returns, on random scenes and on the benchmark:

1. Both ends sit on their ports, leaving along the connector's exit direction.
2. Clearance from the model ≥ cable radius + margin at every sample, except at fixings.
3. Curvature ≤ 1 / minimum bend radius everywhere.
4. Length ≥ straight-line distance, and ≤ a stated multiple of the shortest collision-free path.
5. For every joint crossed, over the sampled range of motion: the cable is never shorter than the path it must span, bend radius holds at every sample, and twist per metre is within the cable's rating.
6. Same input, same output. The router is deterministic.
7. If the router reports "no route", a brute-force search on a coarser grid also finds none (checked on small scenes).

The same invariants run against routes after the user edits them; a violated invariant becomes a visible rule warning, not a crash.

## 4. Export checks

- **STEP:** re-import with the CAD kernel. Every body is a valid solid. Tube volume is within 2 % of π r² × length. Bounding box matches the route's within 0.1 mm. Number of bodies equals the BOM line count.
- **GLB:** passes the Khronos glTF validator with no errors. Node names match the design ids.
- **BOM and cut lengths:** sum of cut lengths equals the sum of route lengths plus the stated termination allowance.
- **WireViz YAML:** parses with a YAML loader and, in a separate optional CI job that installs WireViz, renders without error.
- **Printable parts:** case and clip meshes are watertight; walls ≥ the configured minimum.

## 5. Pipeline evaluation

### 5.1 Benchmark scenes ("WireBench")

About a dozen fixtures of rising difficulty, each with recorded expected outcomes (feasible or not, expected cable class per connection, length bounds).

| # | Scene | Exercises |
|---|---|---|
| 1 | Open box, two boards | Basic routing |
| 2 | Enclosure with internal obstacles | Clearance, pass-throughs |
| 3 | Chassis with motor driver and sensors | Power and signal separation, bundling |
| 4 | Single hinge, ±90° | FPC across a hinge |
| 5 | Single rotary joint, ±180° | Service loop versus axial routing, twist |
| 6 | Continuous rotation turret | Must recommend a slip ring |
| 7 | Linear axis | Drag chain selection and fill |
| 8 | Pan-tilt camera | CSI FFC length limit across two joints |
| 9 | Two-link planar arm | Multiple crossings on one cable |
| 10 | Open-source 6-axis arm (candidate: a permissively licensed hobby arm; licence to be checked) | Full case |
| 11 | Deliberately infeasible scene | Must report why, not produce a bad route |
| 12 | The reference prototype (a robot hand so far) | Real case study |

Headline metrics, reported per scene and overall:

- **Clean-design rate:** share of scenes that end with zero rule violations and a valid export, with no manual edits.
- **Edits to clean:** number of manual edits needed otherwise.
- **Route quality:** length relative to the best known route; number of fixings; minimum clearance.
- **Runtime:** seconds to route on the reference machine.

Initial targets: clean-design rate ≥ 70 % at M4 and ≥ 85 % at M8; scene 11 always reported infeasible; ten connections on scene 10 routed in under 10 s.

### 5.2 Independent motion oracle

The router and its own checker share assumptions, so agreement between them proves little. For scenes 4–10 the final design is rebuilt in MuJoCo with its cable model and the joints are swept through their range.

- No cable–structure penetration beyond tolerance.
- No pose where the simulated cable is taut between anchors.
- Simulated minimum bend radius within 20 % of the router's prediction.

Disagreements are triaged as router bug, oracle limitation (MuJoCo's cable torque model has known inaccuracies), or modelling gap. The triage log is part of the M4 gate.

### 5.3 Text-to-design extraction

A set of about 50 free-text requests, each with a hand-written expected `components` and `connections` list. Run against each candidate model with schema-constrained output.

| Metric | Target for the default model |
|---|---|
| Schema-valid output | ≥ 99 % |
| Component F1 | ≥ 0.90 |
| Connection F1 | ≥ 0.85 |
| Invented parts not in the library | ≤ 2 % |
| Latency on the reference machine | reported, no target |

Run across sizes (4B, 8–9B, a hosted 27B-class model) so the README can say honestly what each hardware tier gets.

### 5.4 Photo input

- **Identification:** about 30 photos of benches and machines, labelled with the boards, connectors and cables visible. Report precision and recall per class. Target for exposing the feature: precision ≥ 0.85, so suggestions are rarely wrong, with recall reported.
- **Reconstruction:** objects with known CAD, filmed with an AprilTag in view. After tag-based scaling and alignment: scale error ≤ 2 %; 90th-percentile surface error ≤ 5 mm on a 300 mm object. If the gate fails, reconstructed geometry is offered only as a visual backdrop, not as a routing obstacle.
- **End to end:** route on the reconstructed mesh, then check that route against the true CAD. Report how often it stays collision-free.

### 5.5 Error attribution

Every benchmark failure is tagged with the first stage that went wrong (ingest, intent, placement, selection, routing, fixing, export). The tally decides where the next milestone's effort goes.

## 6. Physical validation

Simulation cannot settle whether a harness works. On the reference prototype (a robot hand so far), at M8 and in a reduced form at M4:

1. Build the harness exactly as the tool specifies: cable types, cut lengths, clip positions, printed cases.
2. Measure:

| Measure | Target |
|---|---|
| Cut-length error (specified versus actually needed) | within ±10 % or ±15 mm, whichever is larger |
| Printed cases and clips that fit first time | ≥ 80 % |
| Full range-of-motion cycles without snag, connector pull or visible over-bend | 100 cycles |
| Electrical function after cycling | all buses error-free |
| Design time against doing it by hand | reported |

3. Record every deviation between the tool's design and what had to be built. Each becomes a benchmark regression case or a rule change.

## 7. Expert and user review

- **Expert rubric.** Two or three engineers who wire hardware score the tool's design and a manual design of the same scene, blind where practical, 1–5 on: cable choice, strain relief, behaviour across motion, serviceability, power/signal separation. Target: the tool's mean within 0.5 of the manual design.
- **Rule audit.** One engineer reviews the rules file line by line; every rule marked `unverified` is either sourced, downgraded to an editable default, or removed before release.
- **Usability.** Five first-time users complete "add two sensors to the sample arm and export" unaided. Report completion rate, time and a System Usability Scale score. Target: 4 of 5 complete it; SUS ≥ 68.

## 8. Evaluating the build process

The project was built with AI assistance; how that process is measured is described in the section "Evaluating the build process" of [DEVELOPMENT_LOG.md](DEVELOPMENT_LOG.md#evaluating-the-build-process).

## 9. Performance budgets

On the reference machine:

| Operation | Budget | Measured at M1 (2026-11-21) |
|---|---|---|
| Load a 50 MB STEP assembly | < 30 s, UI stays responsive | **Missed: 54.5 s** in the browser for a 53 MB, 600-body, 636,000-triangle assembly. UI stayed responsive (longest main-thread stall 128 ms) |
| Orbit a 1-million-triangle model | ≥ 30 fps | 60 fps, the display cap, at 1.0 and 4.0 million triangles in the app's preview pane |
| Re-route one cable after a drag | < 500 ms | — |
| Route ten connections on the 6-axis scene | < 10 s | — |
| STEP export of that scene | < 60 s | — |
| App start, no AI features | < 5 s | not measured |

Notes on the STEP result. About 50 of the 55 seconds are inside the third-party STEP reader (occt-import-js, WebAssembly, single thread); our own mesh processing is about 5 s. Tessellation settings made no difference, so parsing dominates. The native kernel in Python took about 36 s on the same file in a naive single-threaded test, so a backend fallback alone does not meet the budget either. The test file is dense (every body unique and filleted); the 150 KB enclosure sample imports in under 0.4 s. Options: accept roughly 1 s per MB as the browser budget, or add a native import path with parallel meshing at M5. The generator and timing scripts are in `tools/perf/`.

## 10. Continuous integration

In place today: on every push and pull request, `.github/workflows/ci.yml` runs type check, lint, the vitest unit and property tests and the production build. There are no Python tests, no end-to-end tests and no benchmark jobs yet. The rest of this section is planned.

- Planned, every push: unit and property tests (TypeScript and Python), schema checks, lint.
- Planned, every pull request: benchmark scenes 1–9, export round trips, Playwright smoke test.
- Planned, nightly or on demand: full benchmark including the MuJoCo oracle; model evaluations (they need a model server, so they run locally and commit a results file).
- Planned: benchmark results are stored as a JSON file per run, so regressions show up as a diff.

## 11. Milestone gates

| Milestone | Must pass |
|---|---|
| M0 | Section 2 schema rows |
| M1 | Ingest and kinematics rows; load and orbit budgets |
| M2 | Rule engine and cable selection rows; expert spot-check of 20 selections |
| M3 | Route invariants 1–4, 6, 7 on scenes 1–3; GLB export checks |
| M4 | All route invariants on scenes 4–10; oracle triage log; reduced physical test |
| M5 | All export checks |
| M6 | Section 5.3 targets on the default model |
| M7 | Section 5.4 identification gate; reconstruction gate decides how geometry is exposed |
| M8 | Clean-design rate ≥ 85 %; physical validation; rule audit; usability test |
