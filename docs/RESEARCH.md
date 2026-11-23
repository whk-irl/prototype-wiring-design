# Research notes

Collected 2026-11-21 by web research, then condensed. Package versions were checked directly against npm and PyPI the same day.

**How far to trust this.** Much of the web research came from search snippets rather than full pages. Items are labelled:

- **checked** — read on the source repo, model card, registry or datasheet at the time of writing
- **snippet** — seen in a search summary only
- **unverified** — from general knowledge, not confirmed online

Verify anything not marked *checked* before a milestone depends on it.

## 1. Prior art

### Open source

| Tool | What it does | Limits | Licence | Status |
|---|---|---|---|---|
| [WireViz](https://github.com/wireviz/WireViz) | YAML to 2D harness drawing and BOM | No 3D, no routing, no recommendations | GPL-3.0 | checked; PyPI 0.4.1 dated 2024-07 |
| [FreeCAD Cables workbench](https://github.com/sargo-devel/Cables) | Static 3D cables, conduits, connectors | User draws every path; no motion, no rules | not confirmed | snippet |
| [kicad-pinout-generator](https://www.github.com/CGrassin/kicad-pinout-generator) | KiCad pinouts in WireViz format | Not a harness tool | MIT | snippet |
| [Harnice](https://pypi.org/project/harnice/) | "Electrical system CAD" | Repo and licence not found | unknown | unverified |
| [HarnessDesigner](https://github.com/HarnessDesigner/HarnessDesigner) | Not examined | — | unknown | unverified |
| [Splice](https://splice-cad.com) | Web harness tool, KiCad import, 2D | Closed source | — | snippet |

No three.js or web-based 3D cable-routing project was found on GitHub or Hugging Face Spaces. That is "nothing found", not proof of absence.

### Commercial

SolidWorks Electrical/Routing, Siemens Capital and NX Routing, Zuken E3.series: 3D harness routing and manufacturing output, quote-based pricing (snippet). Siemens Kineo Flexible Cables simulates cable deformation on robots as a component library. Onshape and Inventor have shortest-path wire routing (unverified). AI entrants in 2026: [Cadonix AI](https://www.prnewswire.com/news-releases/cadonix-launches-cadonix-ai-to-transform-wire-harness-design-to-manufacturing-workflows-302762368.html) and Cableteque, both enterprise. None was found to place parts on user-marked areas, recommend hobby-to-industrial cable families, or generate clips and cases.

### Research worth implementing

| Work | Idea | Use for us |
|---|---|---|
| Iwamura et al., ["Cable-Path Optimization Method for Industrial Robot Arms"](https://repository.kulib.kyoto-u.ac.jp/dspace/bitstream/2433/269531/1/j.rcim.2021.102245.pdf), 2022, with 2022–2023 follow-ups | Mass-spring cable model; optimise guide (clip) positions; reduce to critical poses | Closest match to joint-aware routing. No code found |
| Karlsson et al., ["Automatic cable harness layout routing in a customizable 3D environment"](https://arxiv.org/abs/2311.09061), 2024 | Multi-objective routing with bundling, Lagrangian relaxation | Bundling formulation |
| Hermansson et al. 2021; [Carlson et al. 2016](https://research.chalmers.se/en/publication/?id=247353) | Quasi-static dress-pack simulation | Validation approach |
| Kabul, Gayle, Lin, ["Cable Route Planning in Complex Environments Using Constrained Sampling"](https://gamma.cs.unc.edu/CABLE_PLAN/paper.pdf), 2007 | Roadmap plus forward dynamics | Alternative search |
| [Adapted discrete elastic rod for MuJoCo](https://arxiv.org/abs/2310.00911) ([code](https://github.com/qj25/adapteddlo_muj)) | Says MuJoCo's native cable torque is not physically consistent; offers a fix | Caveat for the motion oracle |

### Photos to wiring

Only hackathon projects that go from a photo to a netlist or breadboard feedback ([Circuit Sync](https://devpost.com/software/circuit-sync-924t85), [CIRIS](https://lablab.ai/submissions/q3f6ktace1lkavbdezyxb8l5)). Nothing found from photos to physical cable routing.

## 2. Web CAD and routing stack

Versions below are **checked** against the registries.

| Package | Version | Last publish | Licence | Note |
|---|---|---|---|---|
| three | 0.187.0 | 2026-10-30 | MIT | |
| three-mesh-bvh | 0.9.18 | 2026-11-03 | MIT | Raycast, distance, shapecast, face painting |
| urdf-loader | 0.13.1 | 2026-07-08 | Apache-2.0 | |
| occt-import-js | 0.0.23 | 2024-12-03 | LGPL-2.1 | Stale |
| opencascade.js | 1.1.1 | 2023-03-23 | LGPL-2.1 | Stale; forks exist |
| replicad | 1.2.1 | 2026-11-06 | MIT | Active; browser STEP export possible |
| @mujoco/mujoco | 4.0.1 | 2026-11-11 | Apache-2.0 | Official WASM build |
| build123d | 0.13.0 | 2026-09-21 | Apache-2.0 | Python ≥ 3.11 |
| cadquery-ocp | 8.0.1.1.0 | 2026-10-05 | — | Windows wheels available |
| mujoco (Python) | 4.0.1 | 2026-11-11 | Apache-2.0 | Python ≥ 3.11 |
| trimesh | 5.2.1 | 2026-11-12 | MIT | Python ≥ 3.10 |
| python-fcl | 0.7.0.11 | 2026-04-08 | — | Windows wheels available |
| fastapi | 0.165.0 | 2026-11-18 | MIT | Python ≥ 3.11 |

Other findings:

- [Chili3D](https://github.com/xiangechen/chili3d) is a full browser CAD on OCCT-WASM with STEP import and export, but AGPL-3.0 (snippet).
- No ready-made JavaScript library was found for 3D cable routing, bundling, or geodesic paths on meshes. The router is custom code.
- Position-based or Cosserat rod libraries in JS/WASM, and PyElastica, were not confirmed either way.
- Packaging pattern that exists in the wild: a Vite build served by FastAPI, shipped as a wheel and as a [Docker Space](https://huggingface.co/spaces/Wauplin/docker-space-fastapi-react) (snippet).

## 3. Perception and local models

### Multi-view or video to 3D

| Model | Licence | Metric scale | Note |
|---|---|---|---|
| [MapAnything](https://github.com/facebookresearch/map-anything) | Code Apache-2.0; weights CC-BY-NC or an Apache-2.0 variant | Yes, regressed directly | checked. VRAM not published |
| [Depth Anything 3](https://github.com/ByteDance-Seed/Depth-Anything-3) | Small, base, metric-large Apache-2.0; large, giant, nested non-commercial | Metric-large only among the Apache weights | checked |
| [VGGT](https://github.com/facebookresearch/vggt) | Non-commercial; a gated commercial checkpoint exists | No | checked |
| [VGGT-Omega](https://vggt-omega.github.io/) | Non-commercial research, gated | — | checked |
| DUSt3R / MASt3R | CC-BY-NC | — | unverified |
| COLMAP / GLOMAP | BSD | No | unverified |

Scale, most to least reliable: a printed AprilTag or known-size object; a dimension typed by the user; a metric model as a sanity check only.

### Single image to 3D

[TRELLIS.2](https://github.com/microsoft/TRELLIS.2) (MIT, ≥ 24 GB VRAM, Linux only) and Hunyuan3D 2.1 (licence excludes EU, UK, South Korea) — checked. Both generate plausible shapes without dimensional fidelity. Not usable for engineering geometry.

### Segmentation and detection

- [SAM 3](https://huggingface.co/facebook/sam3): text-prompted segmentation, gated, custom SAM licence that permits commercial use but is not OSI-open (checked).
- SAM 2.1 (Apache-2.0), Florence-2 (MIT), Grounding DINO (Apache-2.0): unverified at the time of writing.
- Electronics data: FICS-PCB (8,685 images, licence unknown), a small MIT [PCB detection set](https://huggingface.co/datasets/Arshia82sbn/pcb-object-detection-dataset) with a connector class. No dedicated connector or cable segmentation model was found.

### Vision-language models that run locally

| Family | Licence | Sizes |
|---|---|---|
| Qwen3-VL | Apache-2.0 (8B card checked) | 4B ≈ 3.3 GB, 8B ≈ 6 GB in Ollama |
| Qwen3.5 | Apache-2.0 (9B card checked) | 0.8B to 27B, natively multimodal |
| Gemma 4 | Apache-2.0 (checked) | E2B, E4B, 12B, 26B-A4B, 31B |

No benchmark of JSON-schema reliability was found for these. We measure it ourselves (TEST_PLAN section 5).

### Runtimes

- llama.cpp `llama-server`: OpenAI-compatible, image input, JSON-schema constrained output (checked).
- Ollama: OpenAI-compatible, structured output via a schema (checked; exact request syntax not confirmed).
- Hugging Face Inference Providers: OpenAI-compatible router, `json_schema` with `strict` works for text (checked); vision support depends on provider.
- Browser calls to a local model server may hit CORS limits, so the backend proxies them.

## 4. Wiring rules

These seed the rule engine. Standards texts (IPC-2223, IPC/WHMA-A-620, NASA-STD-8739.4) are paywalled or were unreachable; no clause numbers were verified.

### Bend radius

| Case | Limit | Confidence | Source |
|---|---|---|---|
| FPC static, single layer | ≥ 6× thickness | vendor quoting IPC-2223 | [Sierra](https://www.protoexpress.com/blog/ipc-2223-standards-and-design-violations-rigid-flex-boards/), [JLCPCB](https://jlcpcb.com/blog/flex-pcb-bend-radius-calculation-minimum-radius-design-guidelines) |
| FPC static, double layer | ≥ 10–12× thickness | vendors disagree | same |
| FPC dynamic | 20–40× (vendors) to 100× (IPC excerpt), max two layers | conflicting; use 100× by default | same |
| Round cable, datasheet factor known | factor × outer diameter; datasheet wins | vendor | [igus](https://www.igus.eu/info/unharnessed-cables-bend-radius) |
| Round cable, no datasheet | 10× outer diameter | rule of thumb | igus |
| igus chainflex ranges | fixed ≈ 4×, flexible ≈ 6×, in chain ≈ 7.5× | product-specific | [igus](https://toolbox.igus.com/?p=4050) |
| Hook-up wire, jumpers, ribbon, USB, Ethernet | 4–10× | unverified defaults, user-editable | — |

### Moving joints

- Rotating joint: use torsion-rated cable. Example rating: igus CFROBOT8 at ±180°/m for 5 million cycles, falling to ±60°/m at 10 million ([datasheet](https://www.mouser.com/datasheet/2/1505/EU_Data_sheet_chainflex_CFROBOT8-3317322.pdf), checked).
- Drag chain: fill ≤ 60 % of the cross-section; chain radius from the largest cable plus 10 %; leave 10–30× diameter between the bend and the fixed clamp ([Lapp](https://e.lapp.com/us/cable-carrier-design-guidelines), [igus](https://igus.co.uk/info/energy-chains-filling-cables-and-hoses), snippet).
- Continuous rotation: slip ring. Limited-angle hinge with low cycles: FPC, no vias or stiffeners in the bend (rule of thumb).
- Route on or near the joint axis; do not tie across a joint; keep a service loop (unverified rules of thumb).

### Fixing

- First fixing 10–30× diameter after a connector (igus guidance for the gap before a fixed point).
- Tie or clamp every 50–100 mm on static runs; grommet at any sheet-metal pass-through; printed pass-through hole ≥ cable diameter + 1 mm with rounded edges (unverified defaults).

### Electrical

| Topic | Value | Confidence | Source |
|---|---|---|---|
| Ampacity, single wire in free air | 22 AWG 8 A, 24 AWG 5 A, 26 AWG 4 A, 28 AWG 3 A | vendor table | [Remington](https://www.remingtonindustries.com/resources/hook-up-wire-ampacity/) |
| Bundle derating | No factor found | gap; configurable factor | — |
| I2C | Bus capacitance ≤ 400 pF; about 1.2 m practical for Qwiic chains | standard / rule of thumb | [NXP UM10204](https://www.nxp.com/docs/en/user-guide/UM10204.pdf), [SparkFun](https://news.sparkfun.com/2366) |
| CAN | ≈ 20–30 m at 1 Mbit/s, ≈ 100 m at 500 kbit/s | vendor | [Schneider](https://www.se.com/ie/en/faqs/FA339840/) |
| RS-485 | ≈ 1200 m at low rates; 10 Mbit/s only to ≈ 12 m | vendor | [Analog Devices](https://www.analog.com/en/resources/technical-articles/full-guide-to-serial-communication-protocol-and-our-rs485.html) |
| USB 2 ≤ 5 m, USB 3 ≤ 3 m, Ethernet 100 m, SPI/UART ≈ 1 m, MIPI CSI FFC ≈ 20–30 cm | — | unverified defaults | — |
| Motor power and signal | Separate bundles or ≥ 10 mm apart; cross at 90° | unverified rule of thumb | — |

### Connectors

| Family | Pitch | Current | Note |
|---|---|---|---|
| JST SH (Qwiic, STEMMA QT) | 1.0 mm | ≈ 1 A | Not for frequent mating |
| JST GH | 1.25 mm | not found | Locking |
| JST PH | 2.0 mm | 2 A | |
| JST XH | 2.5 mm | 3 A | |
| Molex PicoBlade | 1.25 mm | ≈ 1–1.5 A | |
| Molex Micro-Fit 3.0 | 3.0 mm | up to 10.5 A | [Molex](https://www.molex.com/en-us/products/connectors/wire-to-board-connectors/micro-fit-connectors) |
| Dupont | 2.54 mm | ≈ 1–3 A | Friction fit, unsuitable under vibration (unverified) |
| XT30 / XT60, M8 / M12, FFC ZIF 0.5 / 1.0 mm, Grove | — | — | unverified; needs datasheet values |

All connector figures came from search summaries. Each needs its datasheet before it enters the library.

### Enclosures

FDM wall ≥ 2 mm recommended, 0.8 mm absolute floor ([Hubs](https://www.hubs.com/knowledge-base/enclosure-design-3d-printing-step-step-guide/), [PCBWay](https://www.pcbway.com/blog/PCB_Design_Layout/PCB_Enclosure_Design_Guide_Materials_IP_Ratings_and_DFM_Considerations_3349fb77.html)). Heat-set insert pilot sizes, standoff conventions and connector clearance are unverified defaults.

## 5. Open data

| Source | Content | Licence |
|---|---|---|
| [KiCad packages3D](https://www.kicad.org/libraries/license/) | STEP models of connectors and packages | CC-BY-SA 4.0 with a design-use exception; some files GPL — check per file |
| [Adafruit_CAD_Parts](https://github.com/adafruit/Adafruit_CAD_Parts) | STEP by product number | MIT |
| SparkFun, Raspberry Pi, Arduino | STEP files and mechanical drawings | not confirmed |
| [YAPP_Box](https://github.com/mrWheel/YAPP_Box) | Parametric PCB case generator in OpenSCAD | MIT; a model to imitate in build123d |

No open parametric database of connectors and cables was found. We build our own table from datasheets.

## 6. Follow-up research

1. Connector datasheet table: pitch, current, mating cycles, locking, for every family above.
2. Bend-radius factors from manufacturers for ribbon, silicone wire, coax and FFC.
3. Licences of candidate benchmark robot models (URDF) and of the Raspberry Pi, Arduino and SparkFun CAD files.
4. A look at Harnice and HarnessDesigner before building anything similar.
5. Rod or cable simulation options in JS/WASM.
6. Measured VRAM and speed of the chosen perception models.
7. Whether the Hugging Face router supports vision plus structured output for the chosen models.
