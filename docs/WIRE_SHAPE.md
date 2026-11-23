# The shape of a wire

How the app decides where a wire actually runs, what that shape is good for, and what it leaves out. The code is `src/core/rod.ts` (the solver), `src/core/stiffness.ts` (how stiff and heavy a cable is), `src/core/span.ts` and `src/core/slack.ts` (how much cable a joint crossing needs).

## What you draw and what you get

You click points on the model. The app first lays a path over the surface between them (the drape) and stores those points in the design file. That path is a string's path: it follows every facet and turns every edge as sharply as the surface does. A real wire cannot do that, so the path is not what is drawn or checked.

The wire is drawn and checked as a **stiff rod**: an inextensible elastic rod without twist, held at the points you clicked, resting on whatever it touches. It rounds corners, lifts off the surface before an outside edge and comes back after it, bridges an inside corner instead of going into it, and bridges a dip narrower than its stiffness lets it follow. The bend check, the fit check, the length and the cut list all read this shape.

Its shape is the one of least energy, per unit of bending stiffness B:

```
E = 1/2 ∫ κ² ds   +   L / λ²   (laid on a body)   +   (1 / ℓg³) ∫ height ds   (free loop, with gravity)
```

κ is the curvature and L the length. Two lengths describe the cable.

## On a body: laid snug

Between the points you clicked the length is free, and the term L / λ² is the tension that pulls the wire snug. λ, the lay length, is √(B / T): the stiffer the wire or the gentler the pull, the larger the curves.

A rod pulled round a sharp edge through a total turn θ bends there to a radius of λ / (2 sin(θ / 4)) when it runs on a long way either side (from B θ'' = T sin θ, integrated once). Ties nearer the edge tighten that a little: by 6% for a half turn with ties 10 λ away.

Nobody knows the tension a builder used. The app takes **λ = 1.6 × the cable's static bend limit**. A wire doubled back over an edge then bends to 1.13 × its limit, a right-angle turn to about twice its limit, and the wire goes below its limit only where the route forces it to: two clicked points too close for the turn between them. So a bend warning now means the route, not the drawing.

This is a statement about how the wire is laid (a careful builder pulls it snug but not tighter than its bend limit), not a measured property of the wire. A cable whose bend limit is not known is drawn as if its limit were four times its own height, and its note says that this is an assumption. A wire pulled harder than that in the real prototype bends tighter than drawn.

## Over a joint: a loop of one length

Between two clicked points on different bodies the wire hangs free: it is held where you tied it, not where it happens to pass from one body to the next. That stretch has one length, fixed when the cable is cut, while the gap it bridges changes with the joint. `slack.ts` chooses the length: the pose that needs the most, and never less than the way round the model at any sampled pose (a string pulled taut round whatever is between the two holds), plus 2%. A wire from a fixed base to a turret that turns half way round is therefore cut long enough to wrap the turret, and at the middle of the travel that length hangs as a loop: that loop is what the design asks for, and seeing it is the point. At every pose the loop is the rod of that fixed length between its two ends, each end leaving along the direction the wire was running. The loop rests against the model and the placed parts instead of passing through them. If it cannot (the length does not get round the obstacle), the check says where it presses in.

## Gravity

A free loop droops when it is longer than about ℓg = (B / w)^(1/3), w being the weight per length. Neither B nor w is on a hook-up wire datasheet, so the sag length is **estimated from the construction**:

| Figure | Rule | Standing |
|---|---|---|
| Stiffness of a conductor | its strands bending separately: E π d⁴ / 64 / n, copper E = 110 GPa, d from the gauge | the floppy end: friction between strands makes the real figure higher |
| Strands n | 7 for a cable built for a static installation, 19 for one built to flex | the usual constructions; the real count is not in the library |
| Insulation and jacket | a tube from the bare conductors to the outside, E = 10 MPa | flexible PVC is 5 to 25 MPa, silicone lower |
| Weight | the maker's mass where the library has it; else copper 8.96 g/cm³ and 1.3 g/cm³ for the rest | |

For the library's wires ℓg comes out between about 50 mm (30 AWG silicone) and 200 mm (18 AWG PVC). The cube root is forgiving: stiffness wrong by a factor of 3 moves ℓg by 44%. Read a sag as "this loop droops about this much", not as a dimension.

On a body there is no gravity term: with the wire pulled snug the sag between ties is a fraction of a millimetre.

## What the model leaves out

- **Twist.** A wire that is twisted as a joint turns stores energy the model does not see. A joint that rolls a cable about its own axis needs a different crossing (a coil or a slip ring), and the app does not judge that yet.
- **Friction.** The wire slides freely on what it touches. A real wire held by friction can sit in a shape the model would relax.
- **Flat cables bend one way only.** A ribbon or flat flex cable is solved as the same rod, with its face kept to the surface it touches. That is right where it bends across its thickness and wrong where the route asks it to turn in its own plane; those turns are found separately and reported as folds. A flat cable gets no sag estimate.
- **Other shapes.** A long loop can sit in more than one way. The solver returns a true resting shape (it checks that no small movement lowers the energy, so a loop never ends balanced upright against gravity), but the one nearest where it started, not necessarily the lowest of all. It does not search for the others.
- **The wire against itself and against other wires.** Other wires are checked for overlap after the shape is found; they do not push each other aside.
- **Surfaces are felt at the solver's nodes** (0.5 to 3 mm apart). A piece between two clear nodes can cut a corner sharper than the spacing, a wall thinner than about half the spacing can be missed, and an inside corner tighter than the spacing is seen one wall at a time. A bend tighter than the spacing is not resolved: the reported radius then bottoms out near a third of the spacing.
- **A hold inside a body stays there.** The wire is let out of the body gradually along its length from that point, and the report says how deep it is.
- **The tension is assumed**, as above, and the stiffness behind the sag is an estimate.
- **The floor is not there.** Only the model and the placed parts are obstacles, so a long loop can hang below the base.
- **The way round from a connector or a point in free space** goes straight to the nearest surface (within 80 mm) and then over the model, so it can be longer than the true shortest path. Where nothing is that near, or no path exists, the length comes from straight distances only and the report says so.
- **Where bodies fold onto each other** (an elbow closed past the point where its two beams meet) there is no way round for a wire held on those faces; the report says the wire is crushed there, which it would be.
- **A loop with a lot of spare length, at the ends of a joint's range, sometimes does not settle in the time allowed** (0.4 s per loop; 2 to 2.5 s for a stretch on a body). It is then drawn as far as it got, marked approximate, and nothing on it is graded as passing.
- **A flat cable is solved as its centre line.** Where it crosses an edge at an angle its own edges dip below the line, and the fit check, which tests the full width, can report up to a millimetre or so of overlap there.
- **Holds in older files are worked out, not read.** A design saved before holds were stored has them inferred from the path until the wire is next edited.

## How it is checked

Against closed-form physics, in `tests/core/rod.test.ts` and, written independently of the solver's author, `tests/core/rod.independent.test.ts`. The tolerances are the ones the tests enforce: a free loop against the existing elastica solver (radius and bulge within 1%); a wire laid over a 90 degree edge and round a plate edge against the exact value for ties a finite distance away (within 3%); round a large cylinder (radius within 1e-4); across an inside corner; a heavy floppy loop against the catenary (sag and bottom radius within 1e-4); a loop that starts standing up against gravity ends hanging; the settled shape has no more energy than the same shape turned about its ends or other shapes of the same length; a turned and moved copy of a problem gives the turned and moved answer (the one exception: a perfectly straight start with nothing to say which side it should bow to); a loop that starts inside overlapping bodies ends outside them; the reported depth of a loop that cannot get clear equals the true depth. An independent review ran 300 random cases against its own distance functions: no converged shape was nearer than its radius to a surface, no held point moved, and no cut length was off. In the app (`tests/app/wireShape.test.ts`, `wireHolds.test.ts`, `wireDetour.test.ts`): a wire over the edge of a box bends no tighter than its limit; a wire held on a fixed body and on one that swings half way round a cylinder is cut at least as long as the wrapped path worked out by hand.
