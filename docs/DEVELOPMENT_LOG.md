# Development log

This project was built with AI assistance. Claude models worked as an architect, as implementers, as reviewers and as testers, under the direction of a human project owner. This file is the record of how: what was asked, what was built, how it was checked, and what each review found. It was moved out of [PLAN.md](PLAN.md) so that the plan describes the product and this file describes the process.

Entries are kept as they were written at the time, in the order they were written, so they may be out of date. [PLAN.md](PLAN.md) section 10 is the current state. Where a table of what was built or a list of limits that still stand was moved there, a bracketed note says so.

## Model allocation for building it

The app's runtime uses open models (PLAN.md section 5). This section is about which Claude model does which part of the *development* work.

### Rules

1. **Start at the cheapest model that can do the task; escalate on evidence.** Escalate after two failed attempts or a failed gate, not on a hunch.
2. **Fable 5.2 decides and integrates; it does not do bulk reading or bulk typing.** Its context stays small: searching, reading files and web research are delegated, and only conclusions come back.
3. **The reviewer is never the author.** Work written by one model is reviewed by a different one, given the code and the spec but not the author's reasoning.
4. **Parallelise only independent work.** Two writers never touch the same files.
5. **A brief is a contract.** Each delegated task states the files, the interface, the tests that must pass and what done looks like. A task that cannot be briefed that way is not ready to delegate.

### Who does what

| Model | Role | Typical tasks | Target share of tokens |
|---|---|---|---|
| Fable 5.2 | Architect and integrator | `design.json` schema and module interfaces; joint-crossing model and router core; choosing between failed approaches; milestone gate decisions; evaluation design and reading the results | ~15 % |
| Opus 5.5 | Senior implementer and reviewer | Modules with real reasoning but a clear spec: rule engine, three.js editing interactions, build123d sweep and case generator, MuJoCo oracle, perception integration; independent code review and security review at each gate | ~45 % |
| Sonnet 5.5 | High-volume, bounded, parallel work | Web research; component and connector library entries from datasheets; unit tests against a fixed spec; UI panels and forms; fixtures; CI; docs; running the benchmark and tabulating results; browser smoke tests | ~40 % |

The shares are planning targets, to be compared with actual usage after each milestone (see "Evaluating the build process" at the end of this file).

### By milestone

| Milestone | Fable 5.2 | Opus 5.5 | Sonnet 5.5 |
|---|---|---|---|
| M0 | Schema, rule format, interfaces | Review of schema | Scaffold, CI, fixtures |
| M1 | — | Viewport, painting, placement | Import workers, panels, tests |
| M2 | Rule semantics and conflict resolution | Rule engine | Library data entry with sources, table tests |
| M3 | Cost function, search design | Router implementation, route editing | Property tests, GLB export |
| M4 | Joint-crossing model, strategy selection | Implementation, MuJoCo oracle | Benchmark scenes, result tables |
| M5 | — | Sweep, case and clip generators | STEP round-trip tests, BOM, WireViz writer |
| M6 | Prompt and schema design, eval design | LLM adapter | Prompt set labelling, eval runs |
| M7 | Go/no-go on each perception stage | Pipeline integration | Dataset labelling, eval runs |
| M8 | Final integration review | Packaging, security review | Docs, Space config, smoke tests |

### How the harness enforces it

- Project agent definitions in `.claude/agents/` with the model fixed in each file's frontmatter — for example `implementer` (Opus), `reviewer` (Opus), `data-clerk` (Sonnet), `tester` (Sonnet). Created in M0.
- The main session runs on Fable 5.2 and spawns those agents; one-off overrides use the agent tool's `model` parameter.
- Fan-out jobs (library data entry, benchmark runs) could use a multi-agent workflow on request.

### What the planning session did

Research was fanned out to four Sonnet 5.5 agents in parallel. Together they used about 349,000 tokens, and each finished in under 95 seconds. Fable 5.2 wrote the briefs, verified package versions directly against npm and PyPI, and wrote the plan.

[The next subsection of the original, "Optional: Claude at runtime", describes the product rather than the development and is in PLAN.md section 7.]

## Decisions needed from the project owner

These were the questions put to the project owner at the planning stage (2026-11-21), recorded as asked. Where the record shows what was decided: the reference hardware became the LEAP Hand, a robot hand; the licence is Apache-2.0; work proceeded in the order given (CAD and URDF first, photo input later).

Defaults are stated; the plan proceeds on them unless you say otherwise.

1. **Order of work.** Default: CAD/URDF-first (M0–M5), photo input later. The alternative is to prototype photo input first, accepting that it needs a bigger GPU or a hosted service.
2. **Your robot arm.** Which arm is it, and does it have a STEP model or URDF? It becomes the reference case study and the physical validation target. [The reference hardware turned out to be the LEAP Hand, a robot hand, not an arm; see PLAN.md section 10.]
3. **Licence.** Default Apache-2.0.
4. **Runtime AI.** Default: local open models, with a hosted fallback the user configures. No AI needed for M0–M5.

## Build record

What follows is the original "Status" section of the plan, in order, without the tables of what was built and the lists of what was not right yet. Those are in PLAN.md section 10.

### Milestone status and checks

[The status table (M0, M1 and the joint editor) and the trial on the LEAP Hand (2026-11-21) are in PLAN.md section 10. The checks paragraph begins there too; its last two sentences are here.]

Three independent reviews found 1 blocker and 27 further issues; all but one accepted minor are fixed with regression tests. The last round of fixes (suggested axes stored in the parent frame and seven smaller items) has not itself been independently reviewed.

### Wiring: real wires at true size (2026-11-21)

Built after the project owner restated the purpose: put real wire types into the prototype at their physical size and choose between them given the space.

[The table of what was built, the LEAP Hand result and three of the limits are in PLAN.md section 10.]

Known limits of the wiring slice:

- **Joint crossings were a straight-span lower bound** when this slice was built. That is now replaced by the slack model in the next section.
- The last two rounds of fixes to this slice were reviewed with the slack model (next section); the review found the draping could climb a wall and the inside test miscounted overlapping shells.

### Slack across joints (2026-11-22)

[The paragraph describing the slack model, its table and the LEAP Hand finger result are in PLAN.md section 10.]

Checked against shapes with exact answers at 20 pieces: circular arcs, the classic bent rod (elastica) at three end angles, and small buckles, all within 1.5 %, with the error shrinking as pieces are added.

How it was checked. An independent test agent wrote 103 tests for the two core files from their doc comments and found two defects (a zero-length cable produced invalid points; the automatic length came out about 1 % short in 1 of 16 layouts). An independent review then found no blockers and seven things to fix, all fixed with regression tests:

- the solver could stop at a flat shape that is only balanced, not stable, and report a tighter bend than the true one (8.4 mm against 12.9 mm), with the answer depending on how the model was turned;
- a ribbon passing from the top of one plate to the underside of the next was reported as twisted by 180 degrees;
- joints that turn without limit were swept over one turn with nothing said;
- the pose of the shortest straight distance was not among those solved;
- from the earlier wiring rounds: the draping climbed over a wall when a click was closer to it than the cable's radius; changing a wire's type did not re-lay it for the new thickness; the inside test miscounted a mesh made of overlapping shells; and a moving crossing on a type with no flexing bend figure was passed against its installed figure.

The fixes to those last four (in the app) have tests but have not themselves been reviewed.

What the model leaves out, and says so in the app:

- **Contact.** The loop does not know the model is there. The app tests the solved loop against the model and warns where it would press into a part; it does not push the loop out of the way.

[The rest of this list and the "Not done" list that followed are in PLAN.md section 10.]

### Real parts, connectors and the user's own parts (2026-11-22)

After trying the demo the project owner asked for real boards and sensors in place of the five stand-ins, placed precisely enough "to know where to mount with the cable", for thumbnails in the parts list, for a way to bring their own parts, and said the Zones tab made no sense to them.

[The table of what was built is in PLAN.md section 10.]

How it was checked. Tests went from 680 to 1,076. Every bundled part is tested individually: its model file exists and matches its recorded checksum, every port's rotation is a unit quaternion whose exit direction lies along an axis, header rows fit on their boards, mounting holes lie inside the envelope. Known facts about four boards (Uno R3, Pi 4 B, Pico, a Feather) are tested as data. An independent review recomputed ten boards by hand against what it knew of them and found the data sound; it found one blocker and five things to fix elsewhere:

- `cableFit` passed a ready-made lead at connectors its plugs do not fit (a Qwiic cable on a JST GH port or a pin header), because it judged only the wires. Fixed in the core.
- Plug sizes were those of the bare metal shell, not the moulded plug, which made every clearance check optimistic. Replaced, USB-C from a maker's drawing and the rest from typical figures marked as such.
- A 40-way ribbon was refused on a two-row header; a design's own parts were not checked against the connector library; a broken model file could exhaust memory or the stack; no licence text shipped with the models. All fixed.

The first real use of the converter also showed it dropping a thin plate (the top of the Uno R4's power jack) and writing files twice the size they needed to be; both fixed, with the models rebuilt. One orientation value in the instructions given to the data agents was wrong (it turned a header's exit sideways instead of up); the first agent to use it caught it by multiplying it out, and the per-part test now guards it.

[The "What is not right yet" list that followed is in PLAN.md section 10.]

A second independent review then read the app work of this round (parts list, port editor, the user's own parts, wires tied to ports) and found two blockers and five things to fix, all fixed with tests:

- a wire tied to ports at both ends with fewer than four points ran away on every edit: each move of the part pushed its middle point further off (100.9, then 223.5, then 344.9 mm), because both ends claimed the same point as their lead-out. Each end now owns its own lead, and a property test checks that following a part twice changes nothing;
- an imported part file kept whatever id it carried, so one carrying a bundled board's id replaced that board for every design, and one matching another stored part overwrote it silently. Imports now get a new id or ask;
- deleting a port left its wire naming a port that no longer existed, after which the design could not be saved; opening an older design overwrote a newer stored copy of a part; deleting a part silently stranded the models of designs saved on disk; the plug-room check sampled the plug's box at three depths and missed a thin wall in front of a connector (it now tests the box against the model's triangles exactly); thumbnails went stale after a port edit.

The review confirmed the rest by running it: a wire end lands exactly on its port after the part is moved or turned, each end is judged against its own connector, and the port editor's directions and nudges are in the part's own frame. A random sequence of 300 edits (placing, moving, deleting, editing ports, drawing wires, undo, redo) now ends every time in a design that saves.

### Cable pictures and the user's own cables (2026-11-23)

After the parts round the project owner asked that "wires also show the thumbnail" and that the user "should be able to upload the new cable they're using and the system should generate based on the parameters, like FPC flexible cable".

[The table of what was built is in PLAN.md section 10.]

How it was checked. Tests went from 1,076 to 1,140: 51 on the core rules (among them: the widths agree with the library's own FFC and ribbon entries; the gauge estimate reproduces all six UL 1007 entries within 0.05 mm; 400 random parameter sets always give a valid type whose note lists every worked-out figure; a generated FPC is accepted at a flat-flex connector of its ways and pitch and refused at another) and 13 on the app, with the random-edits test extended to add, use, edit and delete custom cables. The flat-flex figures were looked up by a research agent on pages it opened; where makers' guides disagree (6, 12, 24 against 10, 10, 20 times the thickness) the larger is used.

[The "What is not right yet" list that followed is in PLAN.md section 10.]

#### Independent review of this round (2026-11-23)

Two reviewers were given the files and what the code claims to do, not the authors' reasoning: one for the core rules, one for the app. Both ran real inputs. Tests went from 1,140 to 1,217.

| Finding | What was done |
|---|---|
| A rule bend radius was rounded to the nearest 0.1 mm, so it could come out below the rule (12 x 0.11 mm gave 1.3 mm, not 1.32), and the tests could not see it because they used the same rounding | Rounded up, never down; the note gives the exact product. Test expectations are now literals worked out by hand, with a property that every rule radius is at least the exact product |
| The note stated a false rule when the installed radius entered was above the rule's flexing radius | The note says the installed radius is used and what the rule gave |
| Confidence overstated: a worked-out width still gave `datasheet` | A worked-out ribbon or FFC width gives `derived` at best; an FPC with no width entered is `generic`, since a standard tail is a guess at a custom outline |
| An assumed FFC thickness (0.3 mm) gave a tighter bend than the library's measured FFCs | An assumed thickness is bent by the thickest such a cable may be (0.35 mm FFC, 1.0 mm ribbon) |
| Nonsense accepted: conductors that do not fit the cable, a gauge that does not fit the pitch, a wire diameter estimated far outside 30 to 16 AWG, sizes off by orders of magnitude | Refused in plain words; upper bounds on every size |
| A design cable naming one of the user's own types whose definition is missing passed validation | An error |
| A cable looked saved when the browser stored nothing (private window, full disk, another tab holding the old store) | A write that stored nothing is refused with a message, for cables and parts; a blocked store says to close the other tab and loads when it can |
| "Keep on this PC" then Edit rebuilt the parameters by guessing (layers lost, FPC told from its name), showing worked-out bend radii as entered | A generated type carries the parameters it was built from (`spec`); the form starts from them. A type without them is kept as it is and says so when edited |
| The stored cable and the design's copy could differ silently, and a rename overwrote the design's copy | The list shows the version the design uses, says the two differ, and asks which way to bring them together; nothing is overwritten by default |
| Preview scenes never disposed; "1,000" read as 1; thin wires drawn small in their picture; a stored cable dropped if its parameters no longer parsed | Fixed |

Afterwards the bundled library was brought into line: thirteen entries whose bend radius comes from the 8 x or 12 x rule had been rounded down by up to 0.04 mm (8 x 1.78 mm is 14.24, entered as 14.2) and now round up, the five Wurth flat flex cables among them (2.7 to 2.8 mm). Figures quoted from earlier runs in this file and in PLAN.md section 10, such as the 2.7 mm limit in the LEAP Hand note, are as they were at the time.

Found correct by the reviewers: no store selector that could loop the screen again; ids; merge order; commit, undo and redo of the design's copies; opening a design does not write the stored cables; the upgrade of the stored-parts database keeps the parts.

Still open after the review:

- **The fixes themselves were not reviewed again.**

[The other three items of this list are in PLAN.md section 10.]

### Wire shape and the interface (2026-11-23)

After testing the build the project owner said that "some wire physics is not realistic and the UI is not professional", and that the project is meant to be public on GitHub.

**What was wrong with the wires.** On a body a wire was the path first laid over the surface: glued to every facet and wrapped round every edge at the wire's own radius (a 1.56 mm wire on the demo arm reported nine corners below its limit, the tightest 0.4 mm). The loop over a joint ignored gravity and the model.

[The table of what was built is in PLAN.md section 10.]

How it was checked. Tests went from 1,217 to 1,388. The solver is tested against closed-form physics by its author (52 tests) and independently (66 tests, which found a pin returned one rounding step off; fixed). Three passes in the app, each looked at on the demo arm: the first showed the wire still pinned where it changed body (a 9 mm stretch forced to a 1.3 mm bend, loops starting inside the model); the second held it at the user's points and showed loops cut too short to go round the turret (202 mm where the wrapped path is 310 mm); the third gave the length the way round. One formula in the solver's brief was wrong for the set-up it described (the bend round an edge with ties a finite distance away) and the solver's author derived the correction.

[The "What is not right yet" list that followed is in PLAN.md section 10.]

### Build process so far

| Model | Work | Tokens |
|---|---|---|
| Sonnet 5.5 | Research (4 agents); core tests, CI and repo files (one agent, continued twice); importer, fixtures and the ground-truth sample arm (one agent, continued three times) | about 349,000 + 210,000 + 259,000 |
| Opus 5.5 | App shell, viewport, zone and placement tools, joint editor, suggested axes and four rounds of fixes (one agent, continued seven times); three independent reviews (one agent, continued twice) | about 815,000 + 409,000 |
| Fable 5.2 | Plan, schema and core contract, joint-editing operations, briefs, profiling, gate checks, core fixes | not recorded |

What the split caught:

- The Sonnet test agent found three bugs in the Fable-written core (a triangle-list check, a component left pointing at a zone on another link, and a rename that shifted a saved pose).
- The Opus reviewer found 28 issues across three reviews that passing tests had missed, including axis fitting that failed on filleted pins and a suggested axis that came out 40 degrees wrong after a slider move.
- A trial on real hardware found what neither tests nor review could: the feature worked as specified and was still impractical to use.
- Fable found a bug in its own schema while writing regression tests, and the missed STEP budget by profiling.
- On the slack model, Fable wrote the solver and checked it against exact shapes; the Sonnet test agent still found two defects in it and the Opus reviewer a third kind (a balanced but unstable shape) that no reference shape exercised, because every reference shape is one the solver's starting guess already resembles.
- A ground-truth fixture that is too ideal hides bugs: the first sample arm had only sharp-edged pins and scored a perfect fit. The lesson for later milestones is to build fixtures with the awkward features real parts have.

No task had to be re-run on a stronger model. Continuing one agent across related tasks, rather than starting a fresh one, avoided re-reading the code each time.

### Evaluation before publishing (2026-11-23)

The project owner asked for the platform to be polished, evaluated and made ready to publish. Three evaluators were given the tree without the authors' reasoning.

| Evaluator | Found | Outcome |
|---|---|---|
| Core review (ran adversarial inputs and a 300-case random sweep against its own distance functions) | The solver could report a loop as settled while balanced standing up against gravity (a saddle, not a minimum); the reported depth of a loop pressed into the model was too small by 2 to 15 times when it had not converged; solve time ran away with many held points (44 s for 201) and ignored its time budget; coincident holds hid a kink; comments that said things the code did not do; test tolerances far looser than the document claimed | All fixed by the solver's author. Converged now means a checked minimum; 201 holds take 0.25 s; the document quotes the tolerances the tests enforce. Solves take about twice as long |
| App review | A loop's cut length stayed short when a body's pick index arrived late; a wire solved before the parts library loaded was cached and drawn through a part; one failing job stopped the work queue for good; several places showed "fits" or "All wires pass" for shapes still being worked out; a double-click on a port left a hairpin; a stale selected point deleted a point of the wrong wire; shortcuts acted behind open dialogs; GPU resources not released | All fixed, with regression tests for those that can run without a browser |
| First-time user, in the browser | The header's Open and Save menus were clipped, so samples were unreachable once a model was loaded; the wire vanished for 4 to 5 s whenever a joint moved; check headlines hid the worst news (an 18 mm collision under "tightest 3.2 mm"); amber warnings without a reason; large loops with no explanation; comparing cable types took 93 s; a placeholder for the repository link in Help; the README disagreed with the app in three places | Fixed. A loop from a connector now gets a way round the model. What remains is in PLAN.md, "Known limits" |

Tests went from 1,388 to 1,415 (one more runs only where the owner's reference model is present). The internal build history was moved out of PLAN.md into this file. `control.md` (launch commands with a local path) and the LEAP Hand test (figures measured from the owner's model) are kept out of the repository. The unused end-to-end test dependency was removed.

## Evaluating the build process

This section was moved from section 8 of [TEST_PLAN.md](TEST_PLAN.md), together with the third of the three questions in its section 1: **Is the way we build it efficient?** Whether the Fable / Opus / Sonnet split is paying off.

Whether the model allocation above is efficient is a measurable question. After each milestone, record:

| Measure | What it shows | Act when |
|---|---|---|
| Tokens by model, against the 15 / 45 / 40 target | Whether expensive capacity is spent on decisions or on bulk work | Fable share above 25 %: more is being done in the main session than should be |
| First-pass gate rate per model and task type | Whether tasks are assigned at the right level | A task type fails first pass more than a third of the time: move it up a tier or tighten the brief |
| Review findings per delegated task, by severity | Quality of delegated work | Repeated serious findings on a task type: move it up a tier |
| Escalations (task re-run on a stronger model) | Cost of under-assignment | Escalations exceed 1 in 5: the starting tier is too low |
| Rework: lines changed within a week of merging | Hidden cost of fast, cheap work | Rising trend |
| Brief-to-merge wall time | Whether parallelism is real | Parallel agents blocked on each other: split is wrong |

Also keep a short log of delegated tasks that came back wrong but confident. Those are the cases the split is most likely to hide.
