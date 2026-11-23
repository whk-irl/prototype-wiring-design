# Cable library

`library/cables.yaml` holds 39 cable types for the wire-fitting checks: the outside size of the finished cable, the smallest bend radius, and where each number came from. It is a set of products and standard constructions a prototype builder reaches for, not a catalogue.

## What it is and is not

- It is: outside dimensions and bend limits for sizing space and routes, each with the page or datasheet that was opened to get them.
- It is not: a current-rating tool (`max_current_a` is entered only where a table states it, and then it is the maker's figure for that cable), a statement that a cable is suitable for a joint, or a substitute for the maker's current datasheet. Outer diameters are nominal unless a note says maximum. Tolerances are in the notes.
- Bend radii are the centre line of the cable. `static` is for a cable installed and left; `dynamic` is left out wherever the maker gives no dynamic figure.
- Source labels follow `docs/RESEARCH.md`. Every source below was opened (checked). Nothing is entered from memory.

## Bend radius rules

`confidence: datasheet` means the maker states the radius in millimetres (or as a figure that converts directly). `derived` means the outer size is the maker's but the radius is a multiple, as follows. The `note` of each entry says which.

1. **Maker's own multiple.** Where the maker states a multiple of diameter for that product, it is used with the nominal (or stated maximum) diameter. Used for igus (CF9.UL: 3x fixed, 5x moving; CF211: 4x fixed, 7.5x moving), Lapp RG178 (6x fixed, 10x occasional flexing) and the L-com USB cables (10x OD, one value only).
2. **Library rule, round wire and cable with no maker value.** Static = 8 x outer diameter, dynamic = 12 x outer diameter. Source: [L-com, bending radius guidance](https://www.l-com.com/resources/blog/proper-bending-radius-flex-life-continuous-motion-applications), which gives 6 to 8 x diameter for fixed installation and 10 to 12 x for dynamic use; the upper end of each range is taken as the more conservative. The igus wiki rule of thumb of [10 x diameter](https://www.igus.eu/flexible-cable/wiki/structure-and-shielding/bend-radius) falls inside these ranges and was used as a cross-check. Dynamic is entered only for the silicone wire, which the maker sells as ultra-flexible; plain PVC wire has no dynamic value.
3. **Library rule, flat cable with no maker value.** Static = 8 x thickness, applied to the thickest stated thickness, with no dynamic value. This extends the L-com multiple (given for round cable) to the bend across a flat cable's thickness. A teledyne FLIR page was found in search results that gives 10 x thickness for flex cable, but it returned 404 when opened, so it is not used.

4. **Flexible printed circuit (FPC), entered by the user.** Static = 10 x thickness for one copper layer, 12 x for two, 24 x for three or more; dynamic (flexing in use) = 100 x for one layer, 150 x for two, and no figure for three or more. Flex-circuit makers' guides disagree, and the larger figure of each is used: [JLCPCB's design guide](https://jlcpcb.com/blog/flex-pcb-design-guide) and [Sierra Circuits](https://www.protoexpress.com/blog/flex-pcb-design-guidelines-for-manufacturing/) give 6, 12 and 24 static and 100 dynamic; a [design-for-manufacture article on iConnect007](https://iconnect007.com/article/137774/designers-notebook-dfm-principles-for-flexible-circuits/137777/design) gives 10, 10 and 20 static, 100 and 150 dynamic, and advises against flexing a multilayer circuit in use. The first two attribute their ratios to IPC-2223; the standard itself was not read, so these are secondhand. The thickness is the flexing part's, from the fab's stack-up, without stiffeners.

## Cables the user enters

The app builds a cable type from the user's parameters (`cableTypeFromSpec` in `src/core/cables.ts`). Figures the user does not enter are worked out, and each is listed in the type's note:

| Figure | Rule | Source |
|---|---|---|
| Bend radius, round | rule 2 (dynamic only when the user says it flexes in use) | as rule 2 |
| Bend radius, ribbon and FFC | rule 3. When the thickness itself is assumed (below), the rule is applied to the thickest such a cable may be: 0.35 mm for an FFC, 1.0 mm for 1.27 mm ribbon | as rule 3; the tolerances are those of the thickness rows below |
| Bend radius, FPC | rule 4 | as rule 4 |
| Width, ribbon | ways x pitch (a worked-out figure: the type is `derived` at best) | agrees with the three Wurth ribbon entries above |
| Width, FFC | (ways + 1) x pitch (a worked-out figure: the type is `derived` at best) | [GCT FFC drawing](https://store.comet.bg/download-file.php?id=31859) (tolerance 0.08 mm at 0.5 mm pitch, 0.10 mm at 1.0 mm); agrees with all six FFC entries above |
| Width, FPC, when not entered | (ways + 1) x pitch, the width of a standard tail. This is an assumption, since a flexible circuit is made to the user's own outline, so the type is `generic` until the width is entered | as the row above |
| Thickness, FFC, when not entered | 0.3 mm, the end thickness the connectors are made for | [Hirose FH12 catalogue](https://static6.arrow.com/aropdfconversion/828a0576ffed726bf5f01a4f46aeeda3447b1192/fh12catalogd31648en.pdf) (0.3 +/- 0.05 mm, read from extracted text); GCT drawing (0.3 +/- 0.03 mm) |
| Thickness, 1.27 mm ribbon, when not entered | 0.9 mm, only when the gauge is 28 AWG or not given; any other gauge or pitch needs the thickness entered | the Wurth ribbon entries above (0.9 +/- 0.10 mm) |
| Thickness, FPC | never assumed; the user must enter it | for orientation, [JLCPCB](https://jlcpcb.com/capabilities/flex-pcb-capabilities) offers 0.07 to 0.12 mm for one layer and 0.11 to 0.2 mm for two, without stiffeners |
| Outer diameter of a single wire, when not entered | 1.15 x the solid conductor's diameter for its gauge, plus a 0.41 mm wall each side. Only for 30 to 16 AWG, the range the wall is stated for; outside it the diameter (or the wall) must be entered | wall: [Alpha Wire catalogue](https://docs.rs-online.com/b306/A700000014530807.pdf), 0.016 in for UL 1007 from 30 to 16 AWG. The 1.15 for stranding is fitted to the six UL 1007 entries above, which the estimate reproduces within 0.05 mm; it is not a maker's figure |

A bend radius worked out by a rule is rounded up to 0.1 mm, never down, and the note gives the exact product when rounding changed it. The bundled entries above follow the same rounding (8 x 1.78 mm = 14.24 mm is entered as 14.3 mm). If the user enters an installed radius larger than the rule's flexing radius, the flexing radius is the installed one, and the note says so. A ribbon or FFC said to flex in use gets no flexing radius from a rule (there is none); the note says so.

A type with an assumed size is marked `generic`; one whose sizes are the user's but where a bend radius, or the width of a ribbon or FFC, came from a rule is `derived`; one where the user entered sizes and bend radii carries the user's own label (`datasheet` or `measured`). A round cable of several conductors is never estimated: its outer diameter must be entered.

A type is refused when its figures cannot describe a cable: a conductor of the stated gauge that does not fit the thickness or pitch of a flat cable, a ribbon thicker than its pitch, a round cable too thin for its conductors packed together, a flexing radius below the installed one.

Two constructions are worth knowing about because they bend tighter than the rule: Molex Premo-Flex jumpers are tested folded 180 degrees round a 4.00 mm radius, 20 cycles min (Molex data sheet 987650-6631), and Wurth's FFC sheets state a 180 degree flex test, 20 times min. Neither is a minimum radius, so neither was used.

## Entries

All radii in mm. Flat cables bend across the thickness only. `datasheet` entries: the radius is stated by the maker. `derived`: see the rules above.

| id | outer size | static bend | dynamic bend | confidence | source |
|---|---|---|---|---|---|
| `ul1007-28awg` | round 1.17 mm | 9.4 | - | derived | [source](https://www.remingtonindustries.com/content/UL1007%20Hook%20Up%20Wire%20Data%20Sheet.pdf) |
| `ul1007-26awg` | round 1.27 mm | 10.2 | - | derived | [source](https://www.remingtonindustries.com/content/UL1007%20Hook%20Up%20Wire%20Data%20Sheet.pdf) |
| `ul1007-24awg` | round 1.42 mm | 11.4 | - | derived | [source](https://www.remingtonindustries.com/content/UL1007%20Hook%20Up%20Wire%20Data%20Sheet.pdf) |
| `ul1007-22awg` | round 1.57 mm | 12.6 | - | derived | [source](https://www.remingtonindustries.com/content/UL1007%20Hook%20Up%20Wire%20Data%20Sheet.pdf) |
| `ul1007-20awg` | round 1.78 mm | 14.3 | - | derived | [source](https://www.remingtonindustries.com/content/UL1007%20Hook%20Up%20Wire%20Data%20Sheet.pdf) |
| `ul1007-18awg` | round 2.03 mm | 16.3 | - | derived | [source](https://www.remingtonindustries.com/content/UL1007%20Hook%20Up%20Wire%20Data%20Sheet.pdf) |
| `silicone-30awg` | round 1.1 mm | 8.8 | 13.2 | derived | [source](https://www.daburn.com/2615-Ultra-Flexible-Silicone-Rubber-Wire-UL-3132.aspx) |
| `silicone-28awg` | round 1.18 mm | 9.5 | 14.2 | derived | [source](https://www.daburn.com/2615-Ultra-Flexible-Silicone-Rubber-Wire-UL-3132.aspx) |
| `silicone-26awg` | round 1.28 mm | 10.3 | 15.4 | derived | [source](https://www.daburn.com/2615-Ultra-Flexible-Silicone-Rubber-Wire-UL-3132.aspx) |
| `silicone-24awg` | round 1.41 mm | 11.3 | 17.0 | derived | [source](https://www.daburn.com/2615-Ultra-Flexible-Silicone-Rubber-Wire-UL-3132.aspx) |
| `silicone-22awg` | round 1.56 mm | 12.5 | 18.8 | derived | [source](https://www.daburn.com/2615-Ultra-Flexible-Silicone-Rubber-Wire-UL-3132.aspx) |
| `silicone-20awg` | round 1.75 mm | 14.0 | 21.0 | derived | [source](https://www.daburn.com/2615-Ultra-Flexible-Silicone-Rubber-Wire-UL-3132.aspx) |
| `silicone-18awg` | round 1.98 mm | 15.9 | 23.8 | derived | [source](https://www.daburn.com/2615-Ultra-Flexible-Silicone-Rubber-Wire-UL-3132.aspx) |
| `silicone-16awg` | round 2.3 mm | 18.4 | 27.6 | derived | [source](https://www.daburn.com/2615-Ultra-Flexible-Silicone-Rubber-Wire-UL-3132.aspx) |
| `ffc-6way-0.5mm` | flat 3.5 x 0.34 mm | 2.8 | - | derived | [source](https://www.we-online.com/components/products/datasheet/687706050002.pdf) |
| `ffc-10way-0.5mm` | flat 5.5 x 0.34 mm | 2.8 | - | derived | [source](https://www.we-online.com/components/products/datasheet/687710100002.pdf) |
| `ffc-22way-0.5mm` | flat 11.5 x 0.34 mm | 2.8 | - | derived | [source](https://www.we-online.com/components/products/datasheet/687722100002.pdf) |
| `ffc-32way-0.5mm` | flat 16.5 x 0.34 mm | 2.8 | - | derived | [source](https://www.we-online.com/components/products/datasheet/687732100002.pdf) |
| `ffc-12way-1.0mm` | flat 13.0 x 0.34 mm | 2.8 | - | derived | [source](https://we-online.com/catalog/datasheet/686612119001.pdf) |
| `ffc-15way-1.0mm` | flat 16.0 x 0.309 mm | 2.5 | - | derived | [source](https://pip-assets.raspberrypi.com/categories/652-raspberry-pi-camera-module-2/documents/RP-008146-DS-1-standard-camera-cable-200mm-reference-drawing.pdf) |
| `ribbon-10way-1.27mm` | flat 12.7 x 0.9 mm | 7.2 | - | derived | [source](https://www.we-online.com/components/products/datasheet/63911015521CAB.pdf) |
| `ribbon-20way-1.27mm` | flat 25.4 x 0.9 mm | 7.2 | - | derived | [source](https://www.we-online.com/components/products/datasheet/63912015521CAB.pdf) |
| `ribbon-40way-1.27mm` | flat 50.8 x 0.9 mm | 7.2 | - | derived | [source](https://www.we-online.com/components/products/datasheet/63914015521CAB.pdf) |
| `usb2-28awg-3.3mm` | round 3.3 mm | 33.0 | - | derived | [source](https://l-com.com/images/downloadables/2D/CBL-USB2-2828-100_2D.pdf) |
| `usb2-28-24awg-highflex-4.5mm` | round 4.5 mm | 45.0 | - | derived | [source](https://www.l-com.com/Images/Downloadables/2D/BU2HF-2824BK-500F_2D.pdf) |
| `cat6-28awg-slim` | round 3.8 mm | 29.0 | - | datasheet | [source](https://img-en.fs.com//file/datasheet/cat6-28awg-slim-patch-cables.pdf) |
| `belden-9842-rs485` | round 8.64 mm | 89.0 | - | datasheet | [source](https://catalog.belden.com/techdata/EN/9842_techdata.pdf) |
| `rg174-belden-8216` | round 2.79 mm | 25.4 | - | datasheet | [source](https://media.e-sonic.com/productfiles/mf-bl/8216_techdata.pdf) |
| `rg178-lapp-2170002` | round 1.81 mm | 10.9 | 18.1 | derived | [source](https://media.lappcdn.com/6/633/63339/e8ca584bae7c492c84394e4e2ff520c5.pdf) |
| `microcoax-1.13mm` | round 1.13 mm | 5.0 | - | datasheet | [source](https://docs.rs-online.com/d3d1/A700000015827780.pdf) |
| `igus-cf9-ul-02-02` | round 5.0 mm | 15.0 | 25.0 | derived | [source](https://mm.digikey.com/Volume0/opasdata/d220001/medias/docus/4905/CF9.UL.pdf) |
| `igus-cf211-1pair` | round 5.0 mm | 20.0 | 37.5 | derived | [source](https://www.cableorganizer.com/cdn/shop/files/chainflex_CF211_USen.pdf) |
| `thin-wire-28awg` | round 0.8 mm | 6.4 | - | generic | [source](https://www.pololu.com/product/5523) |
| `thin-wire-30awg` | round 0.8 mm | 6.4 | - | generic | [source](https://www.jst-mfg.com/product/pdf/eng/eSH.pdf) |
| `thin-wire-26awg` | round 1.0 mm | 8.0 | - | generic | [source](https://www.jst-mfg.com/product/pdf/eng/eGH.pdf) |
| `dupont-jumper-28awg` | round 1.2 mm | 9.6 | - | generic | [source](https://www.adafruit.com/products/825) |
| `dupont-jumper-26awg` | round 1.27 mm | 10.2 | - | generic | [source](https://www.pololu.com/product/1710/specs) |
| `qwiic-cable-4x28awg` | round 1.93 mm | 15.5 | - | generic | [source](https://www.pololu.com/product/5523) |
| `servo-lead-3x22awg` | flat 4.71 x 1.57 mm | 12.6 | - | generic | [source](https://www.pololu.com/product/2185/specs) |

## Looked for and not sourced

- **ROBOTIS DYNAMIXEL X-series 3-pin cable (Robot Cable-X3P) and the 4-pin X4P.** No outer dimension could be found, so neither entry exists. Confirmed from opened pages: the connector is JST EHR-03 (EHR-04 for RS-485), wire gauge 21 AWG, crimp terminal JST SEH-001T-P0.6 ([XL330-M288 e-manual](https://emanual.robotis.com/docs/en/dxl/x/xl330-m288/), connector information section; [XM430-W350 e-manual](https://emanual.robotis.com/docs/en/dxl/x/xm430-w350/) for EHR-04). An ichome listing for part 903-0249-000 describes the cable as "Black, Individual (Round)", which suggests three loose round wires rather than a bonded flat cable, but no wire OD, width or thickness was published and the ROBOTIS shop pages returned HTTP 429. The e-manual page for the cable itself returned 404. Measuring one cable with calipers is the way to fill this.
- **Insulation OD of thin-wall (UL1571-class) wire, Dupont jumpers, Qwiic cable and servo lead.** No page that was opened states them; only gauges were found (Adafruit 825: 28 AWG 7/36; Pololu 5523: 4 x 28 AWG UL 1571; Pololu 2185: 3 x 22 AWG, 60 strands). These entries are `generic` and each note says which typical value stands in: the JST contact's stated maximum insulation OD for the thin wire, Pololu's 28 AWG spool OD (1.2 mm) for the Dupont 28 AWG lead, the library's own UL1007 ODs for the 26 and 22 AWG leads. Misumi and Buerklin UL1571 pages returned 403; search snippets (not opened) gave 0.85 to 0.88 mm for 28 AWG, above JST SH's 0.8 mm limit, so the generic 0.8 mm may be a little thin. JST-GH and JST-PH battery leads were not added.
- **Modelling of leads.** The Qwiic cable is ONE harness of 4 conductors; `cableFit` counts conductors against the ways and checks the AWG for harness cables, so the JST connectors accept `harness` as `per_contact`. A `whole` termination would skip the way and gauge checks for a round cable.
- **FFC at 1.0 mm pitch in 6 and 10 way, and 0.5 mm pitch 15 way.** Only the sizes in the table have a datasheet that was opened. Molex Premo-Flex gives thickness (0.12, 0.22, 0.27 mm) but no widths.
- **Standard Cat5e or Cat6 patch cable (24 AWG, about 6 mm).** No datasheet with OD and bend radius was opened; only the 28 AWG slim cord is entered.
- **Standard USB 2.0 cable with moulded plugs.** Only bulk cable datasheets were found. Retail cable assemblies list no diameter.
- **Belden 8216 current page.** Not fetched (403); see the disagreement below.
- **Torsion-rated robot cable (igus CFROBOT, Lapp).** Not entered; the two igus entries are control and data cables rated for chain use, with only a modest torsion figure on CF9.UL.
- **Current ratings** for hook-up wire: no opened table gave them, so none are entered.

## Where sources disagreed

- **Belden 8216 (RG174) bend radius.** The opened sheet says 1 in (25.4 mm); a search snippet of Belden's current product page says 1.1 in (28 mm). The 25.4 mm is entered because it was the one opened, and the entry's note says to check the live page.
- **1.13 mm micro-coax bend radius.** Siretta's datasheet (opened) says 5.0 mm. Search snippets only: Delock 4.5 mm, Samtec assembly 6.8 mm. Siretta's is entered.
- **RG178 bend radius.** Lapp gives multiples (6x fixed, 10x occasional flexing, giving 10.9 and 18.1 mm); Pasternack and L-com RG178 sheets give 10.16 mm for repeated bending (search snippets only, not opened). Lapp is entered.
- **Wire OD, UL1007.** Remington's sheet (opened) and a dual-rated UL1007 sheet from a distributor (search snippet) agree within 0.001 in at 24, 22, 20 and 18 AWG. Remington corrected its 26 AWG wire diameter in a January 2025 revision; the corrected sheet is the one used.
- **Wurth FFC thickness.** The drawing does not state a single overall thickness; see each note. The thickest reading is used.
- **Cat6 slim cord.** Datasheet gives 2.7 +/-0.2 cm; the C2G slim cord's own sheet says R15.2 mm (search snippet only). FS.com is entered, at the upper tolerance.
