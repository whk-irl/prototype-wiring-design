# Wiring Design — project plan

Current state: section 10.

## 1. What the project is

An open-source web app, run on the user's own PC, that designs the physical wiring of an engineering prototype.

The user loads a 3D model of the prototype (STEP, GLB/STL, or URDF for articulated machines such as a robot arm), says which boards and sensors to add and marks where they may go, and the tool:

1. places the components on the marked areas,
2. chooses a cable type, connector and wire gauge for each connection from common industrial options (FFC/FPC, JST harness, jumper wire, high-flex round cable, drag chain, slip ring),
3. routes every cable in 3D so it clears the structure and survives the full range of joint motion,
4. generates the mounting hardware: PCB cases, clips and brackets,
5. lets the user select and edit all of it in a three.js view,
6. exports STEP and GLB, plus a bill of materials, a cut-length table and a wiring diagram.

Photos or video of the real prototype are a second input path: to identify what is already on the machine, and to get rough geometry when no CAD exists.

### What the research says about the gap

No tool found, open or commercial, combines interactive 3D placement, cable-type recommendation, motion-aware routing, mount generation and STEP export. Open-source tools are either 2D (WireViz) or manual 3D (FreeCAD Cables workbench). Commercial tools (SolidWorks Routing, Siemens Capital, Zuken E3) are quote-priced and aimed at harness manufacturers. The research on cables across robot joints ("dress packs") shipped no usable code. Details and caveats are in [RESEARCH.md](RESEARCH.md).

### Non-goals for version 1

- Certifying a harness against IPC/WHMA-A-620 or any other standard. The tool gives sourced recommendations, not compliance.
- Schematic capture or PCB layout. Connections are imported or entered as a list.
- Engineering-accuracy geometry from photos. Photo reconstruction is for rough routing and identification only (section 5).

## 2. Design principles

1. **Deterministic core, AI at the edges.** Routing, rule checks and geometry generation are ordinary code with tests. Models only propose things — a component list, a connection list, a scene parse — as schema-validated JSON that the user confirms. The app is fully usable with every AI feature switched off.
2. **One design file.** Everything lives in a versioned `design.json`. Every stage reads and writes it, so stages can be tested and replaced independently.
3. **Every rule has a source and a confidence.** Wiring rules are data (YAML), not code. Each carries a URL, a confidence level (`standard`, `vendor`, `rule_of_thumb`, `unverified`) and can be overridden by a datasheet value or by the user.
4. **The core runs anywhere JavaScript runs.** Schema, rule engine, kinematics and router are a pure TypeScript package with no browser dependencies. The same code runs in a Web Worker for interactive editing and in Node for the headless benchmark.
5. **Permissive licence, nothing bundled that taints it.** Apache-2.0 code. No GPL or AGPL code, no model weights in the repository (section 8).

## 3. Architecture

```
Browser (Vite + TypeScript)                Local backend (Python 3.11+, FastAPI)
┌───────────────────────────────┐          ┌──────────────────────────────────┐
│ UI panels (React)             │          │ /export/step   build123d sweeps, │
│ Viewport (three.js, WebGL2)   │   HTTP   │                cases, clips      │
│  - import worker (occt-import)│ <──────> │ /import/step   OCP tessellation  │
│  - urdf-loader, joint sliders │          │                (fallback)        │
│  - zone painting (mesh-bvh)   │          │ /llm/*         proxy to an       │
│  - part drag, route editing   │          │                OpenAI-compatible │
│ core/ (pure TS, also in Node) │          │                endpoint          │
│  - design.json schema         │          │ /perception/*  optional extra    │
│  - rule engine + rules YAML   │          │ /validate/sim  optional MuJoCo   │
│  - kinematics, SDF, router    │          └──────────────────────────────────┘
└───────────────────────────────┘
```

GLB export happens in the browser. STEP export happens only in the backend, because browser-side CAD kernels are large and fragile on swept tubes.

### Stack, with versions checked on 2026-11-21

| Layer | Choice | Version, licence | Main risk and mitigation |
|---|---|---|---|
| Viewport | three.js, plain (no react-three-fiber in the hot path) | 0.187.0, MIT | Large meshes; build BVH in a worker |
| Spatial queries, painting | three-mesh-bvh | 0.9.18, MIT | — |
| Robot kinematics | urdf-loader | 0.13.1, Apache-2.0 | Our own forward kinematics is cross-checked against it |
| STEP import | occt-import-js in a worker | 0.0.23, LGPL-2.1 | Unmaintained since Dec 2024; backend OCP tessellation as fallback |
| STEP export | build123d on cadquery-ocp | 0.13.0 / 8.0.1.1.0, Apache-2.0 | Sweeps can fail on tight curves; fall back to straight cylinders plus torus elbows |
| Backend | FastAPI | 0.165.0, MIT | Needs Python ≥ 3.11 |
| Motion oracle (optional) | MuJoCo cable model | 4.0.1, Apache-2.0 | URDF to MJCF conversion |
| Mesh utilities | trimesh | 5.2.1, MIT | — |
| LLM access | any OpenAI-compatible endpoint with JSON-schema output (llama.cpp server, Ollama, Hugging Face router) | — | Small models may give poor JSON; constrained decoding plus validation |
| Outputs | GLB, STEP, CSV BOM, WireViz-format YAML | — | WireViz itself is GPL-3.0: write the format, do not bundle the code |

build123d, FastAPI and MuJoCo all need Python 3.11 or newer. The app itself needs no Python today. The only Python in the repository is the sample-scene generators in `tools/fixtures/`, which run in a Python 3.12 virtual environment (see `tools/fixtures/README.md`).

### The design file

```jsonc
{
  "schema": 1,
  "scene":       { "sources": [...], "links": [...], "joints": [{ "id", "type", "parent", "child", "origin", "axis", "limit" }] },
  "zones":       [{ "id", "kind": "mount_allowed | keep_out", "link", "mesh", "triangles": [...] }],
  "components":  [{ "id", "part": "generic-breakout-25x18", "link", "pose" }],
  "connections": [{ "id", "from": { "component", "port" }, "to": { "component", "port" }, "interface": "i2c", "current_a": 0.02 }],
  "cables":      [{ "id", "connections": [...], "type", "length_mm", "reasons": ["rule ids"] }],
  "routes":      [{ "cable", "segments": [{ "link", "points_mm": [...] }], "crossings": [{ "joint", "strategy", "slack_mm" }] }],
  "fixings":     [{ "route", "at_mm", "part" }],
  "mounts":      [{ "component", "kind": "case | bracket | standoffs", "params": {...} }],
  "checks":      [{ "rule", "target", "status", "value", "limit" }]
}
```

The authoritative definition is `src/core/schema.ts`. A connection is one point-to-point link between two ports; a bus with several devices is several connections. Route geometry is stored per link, in that link's own frame, so a route moves with the machine. Only the joint crossings are pose-dependent.

## 4. Pipeline

| Stage | Input | What it does | Deterministic? |
|---|---|---|---|
| 0 Ingest | STEP, GLB, STL, URDF | Meshes, link tree, joint limits | Yes |
| 1 Intent | Part picks, painted zones, optional free text | Fills `components`, `connections`, `zones`. Free text goes through an LLM into a draft the user confirms | LLM proposes |
| 2 Placement | Zones, part footprints | By hand since M1: the part snaps to the surface under the cursor and warns on collisions. Automatic placement that points connector exits toward their route comes with routing (M3) | Yes |
| 3 Cable selection | Connections, estimated length, joints crossed | Picks cable class, connector and gauge from the rule engine, with reasons | Yes |
| 4 Routing | Everything above | Path search per link, joint-crossing strategy, bundling | Yes |
| 5 Fixings and mounts | Routes, parts | Clip positions, clip and case geometry | Yes |
| 6 Review | — | Select, drag, re-route, live rule panel | — |
| 7 Export | — | GLB, STEP, BOM, cut lengths, WireViz YAML, printable STL | Yes |

### Routing approach

- **Within a link:** a signed-distance grid per link, then Theta* search with costs for length, clearance, staying near surfaces (so the cable can be clipped), sharing a path with other cables (bundling) and keeping motor power away from signal lines. The result is smoothed to a spline and relaxed until curvature respects the cable's minimum bend radius.
- **Across a joint:** the router picks a strategy per joint and checks it over the sampled range of motion.

| Joint | Candidate strategies | Checks across the range |
|---|---|---|
| Revolute, limited range | Service loop beside the joint; along the axis through a hollow shaft; FPC "clock spring" | Slack needed (longest minus shortest path between the two anchor clips), bend radius at every sample, twist per metre against the cable rating |
| Revolute, continuous | Slip ring | — |
| Hinge, low cycle count | FPC across the hinge | Dynamic bend radius, no stiffener in the bend zone |
| Prismatic | Drag chain; rolling-loop FFC | Chain fill ≤ 60 %, chain radius from the largest cable |

Phase 1 uses a quasi-static geometric cable model (a relaxed rod between anchors at each sampled pose). Phase 2 validates the result in MuJoCo's cable simulation as an independent oracle. This joint-crossing model is the technically hardest part of the project and its main differentiator.

## 5. Photo and video input

The honest position, given the research and the hardware:

- **Identification works on modest hardware.** A local vision-language model reading photos and returning "these boards, these connectors, these existing cables" as JSON is feasible. Candidates with Apache-2.0 weights: Qwen3-VL, Qwen3.5, Gemma 4.
- **Geometry from photos is rough.** Feed-forward reconstruction (MapAnything, Apache-2.0 weight variant) gives a mesh, but expect errors of a few percent or worse on tabletop objects. True scale should come from a printed AprilTag or a dimension the user types in, not from the model.
- **A reconstruction is one rigid mesh.** It has no joints. The user must mark joint axes and ranges in the UI, or supply a URDF.
- **Single-image 3D generators are not usable for geometry.** They invent plausible shapes. At most they provide stand-in meshes for parts with no CAD.

So photos are used in three ways, in increasing difficulty:

1. Annotate an existing CAD or URDF model: "what is already mounted, and where".
2. Suggest parts and connections for the intent stage.
3. Rough obstacle mesh when no CAD exists, scaled by AprilTag, with user-marked joints.

### Hardware tiers

| Tier | Reconstruction | Segmentation | Vision-language model |
|---|---|---|---|
| CPU or small GPU (the dev PC: GTX 1060 3 GB, 32 GB RAM) | COLMAP on 15–30 frames, slow; or skip | SAM 2.1 | 4B-class model, quantised, on CPU — tens of seconds per request |
| 8–12 GB GPU | MapAnything (Apache variant) | SAM 3 (user accepts its licence on download) or SAM 2.1 | Qwen3-VL-8B or Qwen3.5-9B |
| 24 GB GPU | Same, optionally refined with COLMAP | SAM 3 | 27B-class model |
| Hosted fallback | A user-run Hugging Face Space or Colab | — | Hugging Face Inference Providers |

VRAM figures are estimates from the research, not measured. Vision plus structured output on the hosted router is unconfirmed for these models.

## 6. Milestones

Each milestone ends at a gate from [TEST_PLAN.md](TEST_PLAN.md). A milestone is not done until its gate passes.

| # | Milestone | Delivers | Gate | State |
|---|---|---|---|---|
| M0 | Foundations | Repo, `design.json` schema, rules YAML format, three fixture scenes, CI | Schema tests green | Built. CI runs type check, lint, the tests and the build on every push and pull request (`.github/workflows/ci.yml`) |
| M1 | Viewer and ingest | Load STEP/GLB/URDF, joint sliders, zone painting, manual part placement by dragging over surfaces | Loads all fixtures; performance budget met | Built; one budget missed (50 MB STEP load: 54.5 s against 30 s). A joint editor was added that was not in the original plan |
| M2 | Rules and cable selection | Rule engine, ~30-part component library, selection with reasons | Rule table tests; expert spot-check of 20 selections | Not built; related work built so far is in section 10 |
| M3 | Static routing | Router within rigid bodies, route editing, GLB export | Route invariants hold on static benchmark scenes | Not built; wires are drawn by hand and there is no automatic router (section 10) |
| M4 | Joint-aware routing | Crossing strategies, slack, bend and twist checks across motion | Invariants on articulated scenes; agreement with MuJoCo oracle | Not built; the slack model for joint crossings is built (section 10) |
| M5 | Mounts and export | Clips, PCB case generator, STEP export, BOM, WireViz YAML | STEP round-trip checks | Not built |
| M6 | Text intent | Free text to a design draft through a local model | Extraction scores on the prompt set | Not built |
| M7 | Photo input | Identification first, then scaled rough mesh | Detection and reconstruction scores | Not built |
| M8 | Release | `uvx` one-line launch, Hugging Face Space (Docker), docs, the reference-prototype case study | Physical validation on the reference prototype (a robot hand so far) | Not built |

M0–M5 is the minimum useful product and needs no GPU and no AI model. Photo input is deliberately late: it is the highest-risk stage, the least accurate, and it cannot run well on the development PC. This ordering is a recommendation, not a constraint.

## 7. Optional: Claude at runtime

The default runtime models are open-weight. A bring-your-own-key Claude adapter can sit behind the same interface: Sonnet 5.5 for text-to-design extraction, Opus 5.5 for an optional design critique. It is not on the critical path.

## 8. Licensing

| Item | Finding | Decision |
|---|---|---|
| Project code | — | Apache-2.0 |
| WireViz | GPL-3.0 | Emit its YAML format only |
| Chili3D | AGPL-3.0 | Ideas only |
| occt-import-js | LGPL-2.1 | Load as a separate WASM module, unmodified; its notice is in `public/THIRD_PARTY_NOTICES.md`, which ships with the built app (the `NOTICE` file at the repository root points to it) |
| KiCad 3D models | CC-BY-SA 4.0 with an exception for use in designs; some files GPL | Fetch on demand; do not redistribute the collection |
| Adafruit CAD parts | MIT | 42 models are bundled, converted to GLB in `public/parts/`; licence text and credits in `public/parts/NOTICE.md` |
| Arduino CAD files | CC BY-SA 4.0 | 3 models are bundled (Nano ESP32, UNO R4 Minima, UNO R4 WiFi), converted to GLB; listed with their licence in `public/parts/NOTICE.md`. Adaptations stay CC BY-SA 4.0 |
| MapAnything | Default weights CC-BY-NC; `-apache` variant Apache-2.0 | Default to the Apache variant |
| Depth Anything 3 | Small, base and metric-large weights Apache-2.0; large and giant non-commercial | Only the Apache weights |
| VGGT, VGGT-Omega, DUSt3R/MASt3R | Non-commercial or gated | Not defaults |
| SAM 3 | Custom licence, gated, not OSI-open | Optional, user accepts on download |
| Hunyuan3D 2.1 | Excludes EU, UK, South Korea | Do not use |
| Ultralytics / YOLO-World | AGPL (unverified) | Avoid |

No weights are stored in the repository. Each is downloaded on first use.

## 9. Risks

| Risk | Why it matters | Mitigation |
|---|---|---|
| Joint-crossing cable model is wrong | It is the core claim of the tool | Independent MuJoCo oracle; physical cycling test on the reference prototype (a robot hand so far); conservative defaults |
| Rule values are not standard-backed | IPC and NASA texts are paywalled; vendors disagree (for example FPC dynamic bend: 20× to 100× thickness) | Confidence label on every rule; datasheet override; state plainly that it is not a compliance tool |
| STEP sweep failures | Export is a headline feature | Segmented fallback geometry; round-trip tests in CI |
| occt-import-js is unmaintained | STEP import is the main entry point | Backend tessellation fallback behind the same interface |
| Photo geometry too inaccurate | A clip placed 10 mm off is useless | Photo path optional; AprilTag scale; measured accuracy gate before it is exposed as geometry |
| Scope | Nine milestones | M0–M5 is shippable on its own |
| Research gaps | Much of the research is marked unverified | Follow-up list in RESEARCH.md; verify before each milestone that depends on it |

## 10. Where it stands

Updated 2026-11-21. Later items carry their own dates.

### Milestones

| Milestone | State | Notes |
|---|---|---|
| M0 Foundations | Built | Schema, validation, kinematics, parts-library and rule formats, sample scenes, CI workflow. CI runs type check, lint, the tests and the build on every push and pull request (`.github/workflows/ci.yml`) |
| M1 Viewer and ingest | Built, one budget missed | STEP, glTF, STL, OBJ and URDF import; joint sliders; zone painting; manual part placement; save and reopen. The 50 MB STEP load budget is missed (54.5 s against 30 s; see TEST_PLAN section 9) |
| M1 addition: joint editor | Built | Turns a CAD model with no joints into links and joints: select the bodies that move, adopt a suggested axis (a line the selection shares with the rest, found by fitting cylinders where the two meet) or click a pin, shaft, hole or round face, try it, create. Added because the reference hardware has only CAD files. Not in the original plan |

### Checks

Checks at this point: type check, lint and production build clean; 1,415 automated tests passing (one more runs only where the owner's reference model is present); kinematics agree with urdf-loader on 1,000 random poses; joint-editing operations checked against rotation formulas written independently of the code and by random operation sequences; axis fitting checked against a sample arm whose true axes are known (15 picks on filleted, chamfered, keyed and sharp-edged features, all exact; six points that are not axes all flagged).

### Trial on real hardware: the LEAP Hand (2026-11-21)

The reference model is the project owner's LEAP Hand, a 16-joint robot hand available as STEP only. Its files are not in this repository.

| Measure | Result |
|---|---|
| Import of the 25 MB right-hand assembly in the browser | 29 s; 17 bodies, 481,480 triangles; longest interface stall 267 ms; no validation issues |
| Picking a joint axis by clicking | Not practical: the defining features are servo horns of 1.3-2.6 mm radius hidden inside brackets or behind the next finger. A click on the visible surface over a joint fitted a partial outer arc about 14 mm from the true axis; the editor flagged it as a guess but offered no better route |
| Suggested axes | One finger (four joints, base outward) built from the top suggestion each time, 0.3-1.5 s per suggestion. Axes agree with an independent survey of the model within 0.11 degrees and 0.09 mm. Two of the four were adopted while other joints were posed, then created at the zero pose, and came out right |
| Whole hand | The survey found all 16 joints as lines shared by adjacent bodies. Only one finger and the thumb have been built through the app |

What the trial changed: suggested axes were built because of it; scene-tree labels now tell repeated parts apart; `tools/perf/inspect-model.ts` and `tools/perf/find-axes.ts` describe an unfamiliar CAD export before it is opened in the app.

### Wiring: real wires at true size (2026-11-21)

| Piece | State |
|---|---|
| Wire library | 39 types with sources (`library/cables.yaml`, `docs/CABLES.md`). Outer sizes are the makers' where a data sheet was read. 4 have a maker's bend radius (confidence `datasheet`); 28 use a stated rule (8 x outer diameter static, 12 x dynamic) and are labelled `derived`; 7 are `generic`: thin-wall wire, jumper leads, a Qwiic cable and a servo lead, whose sizes are typical figures |
| Size model | Round or flat cross-section; bundle diameter for several wires run together; sleeve; twist with its extra wire length; bend limit of a bundle from its innermost wire |
| Drawing | Click points on the model; each leg is draped as a string pulled tight over the surface between them; the wire is drawn as a true-size tube or ribbon and follows the joints |
| Checks | Bend against the type's limit (a broken rule-derived limit warns, a maker's or user's figure fails); fit, with a true inside test and the real cross-section; in-plane turns of flat cables; length on links plus each joint crossing's shortest and longest span |
| Choosing | A table of every library type on the same route: size, bend, clearance, cut length, notes, source; cut-list CSV |

On the LEAP Hand, five clicks along one finger give a wire of 158.6 mm on the links with three bend warnings. It fails the fit check because two of those clicks landed in recesses narrower than the 3.4 mm bundle, which is the tool reporting a real space limit. With the points on the body tops the on-link length is 86.8 mm.

### Slack across joints (2026-11-22)

A wire that crosses a joint has a real length, not a straight span of unknown length. Between its last tie-down point on one link and its first on the next it is modelled as a thin elastic rod of one fixed length, and the app shows what that length does over the joint's range.

| Piece | State |
|---|---|
| Shape solver (`src/core/span.ts`) | The least-bending shape of a cable of given length between two points, each end held along the route's direction where the route gives one. A chain of 20 equal pieces; the one constraint (the far end is where it belongs) is held by the method of multipliers. About 0.1 to 0.4 ms per shape (may be out of date: the app now draws the loop from the stiff-wire solver, see "Wire shape and the interface") |
| Crossing analysis (`src/core/slack.ts`) | One length per crossing: the shortest that keeps the cable within its bend limit at the pose that needs the most, or the gentlest when none does, plus 2 %. Then reach, tightest radius and how far the loop stands out at 9 poses per joint (5 each for two joints, 3 each for three) plus the poses of longest and shortest straight distance. The straight distance itself is swept 8 times more finely. About 3 to 6 ms per crossing |
| Stated slack | `route.crossings[].slack_mm` overrides the automatic length for the crossing over that joint |
| Flat cables | Reports the twist and the sideways shift a crossing would ask of a ribbon, neither of which the loop model includes |
| In the app | The loop is drawn at true size and re-solved as the joints move; per crossing the panel shows straight distance, free length, slack, tightest bend with its pose, and bulge, with a control for the slack and a button that moves the joints to the tightest pose; cut lengths, the comparison table and the CSV all use these lengths |

On the LEAP Hand's largest-y finger, with a route laid by script along the finger (two points per body, not a carefully placed route) and joints at plus or minus 90 degrees: all but one of about forty poses settled (that one is flagged as approximate), and the loop drawn at each of ten poses of one joint measured the same 54.27 mm. Three 22 AWG hook-up wires run together bend to between 8 and 12 mm at three of the four joints against their 13.5 mm rule-derived limit; a 10-way flat flex cable holds its 2.7 mm limit at all four. A route takes about 0.1 s to analyse. That is the kind of answer the tool is for: on a finger-sized hinge, round hook-up wire tied down either side of the joint is bent harder than the usual rule allows, and a flat cable is not.

### Wire shape and the interface (2026-11-23)

| Piece | State |
|---|---|
| Stiff-wire solver | `settleRod` in `src/core/rod.ts`: an inextensible elastic rod without twist, held at pins, kept its own radius away from surfaces, laid snug (length free, tension) or cut to a fixed length, with optional gravity. Newton on the full constrained system with exact piece lengths; a 600 mm wire settles in 50 to 90 ms |
| Stiffness and weight | `src/core/stiffness.ts`: the lay length (1.6 x the static bend limit) and an estimated sag length per cable |
| Holds | A route records which of its points the user fixed (`segments[].ties`). The wire is held there and nowhere else; the path between is only where the solver starts |
| In the app | On a body: laid snug between holds, resting on the body and the parts on it. Between holds on different bodies: a loop of one cut length, hanging under gravity, resting against the model at each pose. Bend, fit, length and the cut list read this shape |
| Loop length | The cut length is at least the way round the model at every sampled pose (`detour_mm` in `slack.ts`), so a loop that must wrap a turret is long enough to |
| Interface | Redesigned: a header with a tool group and one Open menu; resizable, collapsible panels; the design's wires before the cable library; each check as one result row with its explanation folded away; light and dark themes; a lit 3D view with feature edges, a ground shadow and view presets; a welcome panel; a logo. No new dependency |
| For the public repository | README rewritten, `CONTRIBUTING.md`, issue and pull-request templates, `docs/WIRE_SHAPE.md` |

### Real parts, connectors and the user's own parts (2026-11-22)

| Piece | State |
|---|---|
| Parts library | 69 parts in four files (`library/parts*.yaml`): 19 boards drawn from their makers' drawings or board files (Arduino Uno R3, Mega 2560, Nano, Nano 33 IoT, Micro, MKR WiFi 1010; Raspberry Pi 4 B, 5, Zero 2 W, Pico, Pico W; ESP32-DevKitC V4, ESP32-S3-DevKitC-1; Nucleo-64, WeAct Black Pill; Teensy 4.0 and 4.1; Seeed XIAO ESP32-S3; WeMos D1 mini); 14 boards with real models (Adafruit Feather, QT Py, ItsyBitsy and Metro boards, two FeatherWings, Arduino Uno R4 Minima and WiFi, Nano ESP32); 31 Adafruit sensors, drivers, displays, power boards, servos and motors with real models; and the five generic stand-ins, now listed last and labelled |
| Models | 45 GLB files in `public/parts/`, 6.8 MB in all, the largest 231 KB. Converted from the makers' STEP files by `tools/build-part.ts`, which simplifies each to a triangle budget while keeping every body's bounding box. Adafruit's are MIT, Arduino's CC BY-SA 4.0; `public/parts/NOTICE.md` (generated by `tools/parts-notice.ts`) carries the licence texts, credits, origins and changes, and the app shows the credit with every model |
| Ports | 285 places a cable attaches, each with a position, the direction the cable leaves, a connector family and its number of ways. On parts with models they are read from the model's own geometry (connector housings, header pad holes); on the drawn boards from the maker's drawing or board file |
| Connector library | `library/connectors.yaml`: 33 families (JST SH, GH, PH, XH, ZH, EH; 2.54 mm headers and sockets in one and two rows; flat flex at 0.5 and 1.0 mm; USB A, B, mini-B, micro-B and C; RJ45; HDMI; screw terminals; servo lead; XT30, XT60; U.FL, SMA and others), each with the size of its housing, the room its plug needs and the cables its contacts take. Sources and what was derived are in `docs/CONNECTORS.md` |
| Cable fit | `cableFit` in `src/core/connectors.ts`: can this cable be terminated in this connector? Wire count against contacts, gauge and insulation against the contact's range, a flat cable's ways and pitch, and a ready-made lead only where its plugs go. Seven cable types were added so that every common connector has something that fits it (thin-wall wire for the small JST families, jumper leads, a Qwiic cable, a servo lead); the cable library is now 39 types |
| In the app | Parts tab with search, category filter and a rendered thumbnail per part; real models in the viewport; boards without a model drawn as a board with a housing at every port. A wire started or ended on a port is tied to it, leaves it by at least the plug's length, follows the part when it moves, and is checked for fit and for room for the plug. The wire-type list, the comparison table and the cut list show which types fit the ports |
| The user's own parts | From a 3D model (STEP, GLB, STL, OBJ), a KiCad board file (`.kicad_pcb`, ports found from its connector footprints) or a part file exported from the app (a GLB with the definition inside). A port editor places ports by clicking on the model. Parts are kept in the browser's storage on this PC; a design file carries the definitions of the ones it uses |
| Zones | Renamed Areas, with an explanation; the two kinds read "Parts may go here" and "Keep clear"; a wire lying on a keep-clear area now gets a warning, so areas affect wiring as well as placement |

### Cable pictures and the user's own cables (2026-11-23)

| Piece | State |
|---|---|
| Cable pictures | Every cable type has a thumbnail drawn from its own figures: a short piece with a cut end. Round cables show the jacket at its real diameter with copper cores in the cut face (sized from the gauge where known), ribbon shows its wires at the pitch, flat flex a strip with one contact finger per way. Shown in the type list, the wire list and a wire's properties |
| A cable from parameters | `cableTypeFromSpec` in `src/core/cables.ts`. Five kinds: single wire, round cable, ribbon, flat flex cable (FFC), flexible printed circuit (FPC). The user enters what they know; the rest is worked out by a stated rule (width from ways and pitch, bend radius from thickness or diameter, a wire's diameter from its gauge), and every worked-out figure is listed in the dialog and written into the type's note. An FPC's thickness is never assumed. Rules and sources: `docs/CABLES.md`, "Cables the user enters" |
| In the app | "Add your own cable" in the Wires tab, with a live picture, the resulting size and bend radii, and the worked-out sentences. The user's cables are kept on this PC, head their group in the list, and can be edited and deleted. A design file carries the definitions of the ones its wires use (`cable_types`), so it opens on another PC |

### Known limits

**Wires and routing**

- **No automatic routing.** The user clicks the path. Points clicked blind can land in recesses.
- **Between holds the wire is free.** Each clicked point is a hold, and a loop between two bodies may pass over a link it is not held on. Holding the wire nearer the joint on both sides gives shorter, tidier loops.
- **A wire takes 1 to 4 s to settle** after it is drawn or edited. Meanwhile it reads "Checking", its length is marked approximate, and its loops are drawn from their last shape.
- **Several wires slow the view.** Dragging a joint with three wires runs at about 10 frames a second, with pauses of up to about 200 ms. Comparing cable types takes about 24 s for the 21 likely types and pauses the view for up to about 440 ms per type; "Show all" is slower.
- **Some loops press into the model or do not settle**: at the ends of a joint's range, where bodies fold onto each other with no room between them, or where a loop has hundreds of millimetres of spare cable to coil. They are reported in the check's headline, not fixed.
- **The length of a loop is the way round the model at sampled poses.** That way round is a path laid over the surface: it can be too long round folded bodies, and it is unknown where nothing is within 80 mm of a free end or no path exists (the report says so). From a connector it goes straight to the nearest surface first, so it can be longer than the true shortest path.
- **Large joint ranges ask a lot of a wire.** A base that turns 340 degrees needs 300 to 400 mm of cable from plate to turret, which hangs as a large loop at mid travel. That is a true statement about the design, but the app does not yet suggest the usual answer (a coil or a cable carrier).
- **Joint limits default to plus or minus 90 degrees**, so range-of-motion results overstate until real limits are entered.
- **Most library cables have no flexing bend radius**, so every loop over a moving joint warns that no flexing limit is known and judges the loop against the installed limit.

**Wire shape and slack model** (the model's own limits are in [WIRE_SHAPE.md](WIRE_SHAPE.md))

- **Twist and friction are not modelled**, and sag is an estimate from the cable's construction.
- **A flat cable is modelled by its centre line.** Its edges can dip into an edge it crosses at an angle, so the fit check can fail there by a millimetre or so.
- **Other stable shapes.** A long loop can sit more than one way; one is shown.
- **Between poses.** Shapes are solved at sampled poses; a problem between two samples can be missed.
- **Joints that turn without limit** are swept over one turn and flagged: a cable winds up on them.
- **Slack is stated per joint**, so a route crossing the same joint twice gets one figure for both, and a loop over two joints takes the first slack stated on its path.
- **Holds in older files are worked out, not read.** A design saved before holds were stored has them inferred from the path until the wire is next edited.

**Parts and connectors**

- **Placed parts are boxes to a wire.** A wire leaving a port often touches its own board just beyond the lead-out and fails the fit check by under a millimetre.
- **Some messages still show a body's internal name** (placement warnings and the plug-room check).
- **The DYNAMIXEL servo cable is not in the library** (no outer dimension could be sourced); a trio of 22 AWG hook-up wires stands in.
- **Sources that could not be used.** Pololu, Seeed, DFRobot and ROBOTIS publish models with no licence, so none are bundled; Raspberry Pi's own models are not bundled because their licence page does not name the STEP files (the Pico's datasheet does, so the Pico can get a model). ST's site refused every download, so the Nucleo-64 and Discovery boards are drawn from their dimensions.
- **Figures that are assumed, each flagged in its entry.** Connector heights on most drawn boards (the drawings give positions but not heights), board thickness on several, the Raspberry Pi ribbon connectors' directions (deduced from the installation instructions, which do not state them), plug lengths other than USB-C.
- **Ports left out** where neither a model nor a drawing shows them: the NEMA-17 leads, the PowerBoost's USB-A output, the SWD header on the Metro M4, several small Raspberry Pi 5 connectors. The 16 outputs of the servo driver are numbered by position because the channel order could not be read.
- **A header row is one port.** The library does not name individual pins; `contactOffsets` gives their positions, and pin-level wiring is the next step.
- **Blue Pill and BeagleBone Black** were skipped: no dimensioned drawing could be read reliably.
- **Cancelling a large STEP import** closes the dialog and keeps the app responsive, but the conversion runs to its end in the background and its result is thrown away.
- **KiCad import** handles rectangular boards and KiCad 6 and later; back-side connectors' pin order is unverified.

**Cables**

- **The FPC bend figures are secondhand.** The guides attribute them to IPC-2223; the standard itself was not read.
- **An FPC is a strip.** It has one width and one thickness along its whole length; a shaped outline, a stiffened tail thicker than the flexing part, and branches are not modelled. The connector check compares ways and pitch, not thickness.
- **A round cable of several conductors is never estimated**: its outer diameter must be entered. Ready-made leads with plugs cannot be entered yet.
- **Core positions in a round cable's picture are illustrative**, and wires of different gauges look alike because each picture is scaled to fill its frame.
- **A cable stored by an earlier version keeps its old figures** until it is opened with Edit and saved again.
- **`validateDesign` cannot tell whether a library cable id exists**: it is not given the cable library. Only the user's own types are checked.

**Import, performance and the interface**

- **No test renders the interface.** The shell, dialogs and banners are checked by hand in a browser, not by automated tests, and there are no end-to-end tests.
- **Opening files through the file pickers** was not part of the last hand check (the demo arm and the four samples were).
- **Detecting all joints of a model in one step** is not there: the app asks for each joint's moving bodies.
- **Only one real assembly has been tried.** Its bodies arrive already grouped per link, which will not be true of every export.
- **Picking a body hidden behind others** needs "Hide selected" first; there is no section view.
- **Large STEP files** are converted in the browser; there is no native import path.
- **The app is one script** of about 2.1 MB (not split by feature).
