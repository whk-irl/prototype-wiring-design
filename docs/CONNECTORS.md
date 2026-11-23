# Connector library

`library/connectors.yaml` holds 33 connector families: for each, the sizes it comes in, the room the part-side housing and the mating plug need, and which cable types can be terminated in it (checked by `cableFit` in `src/core/connectors.ts`). It is not a catalogue and not an approval of any pairing.

## How the numbers were made

- Every figure was read from a page or datasheet that was opened; the `source` of each entry is that page. Where a figure is a sum or an allowance, the entry's `note` says so and the confidence is `derived`.
- **Box rule.** Housing = the body on the part (for a header, the top-entry body: depth along the mating axis, thickness across it, width along the row). Plug = the mating half plus the stiff length behind it. Width = `per_way` x contacts in one row + `plus`.
- **Crimp plug allowance.** For the six JST families the plug length is the JST housing's insertion height plus **3.0 mm** for the crimp barrel and the straight wire run. The 3 mm is an assumption of this library, not a JST figure. The same 3 mm is added behind the 2.54 mm pin-header and pin-socket plugs (female Dupont housing over the 6.0 mm of pin; male end 2.54 mm).
- **USB, HDMI, RJ45, barrel jack.** The only dimension tables opened were Wikipedia's (secondary), so these are `generic`. Receptacle size is used as the housing; the plug uses the metal-shell size. The overmould-plus-boot length of 15 mm (USB, HDMI) is an assumption; no maker figure for a cable plug was opened. RJ45 uses Wikipedia's single 22.48 x 11.68 x 8.00 mm figure as the plug.
- **Wire limits** (`awg`, `od_max_mm`) are the contact's, as printed in each JST sheet. JST gives AWG ranges for the contact, not for the housing.

## Families

| id | ways | pitch mm | boxes | confidence | source |
|---|---|---|---|---|---|
| `jst-sh` | 2 to 20 | 1.0 | housing + plug | derived | [source](https://www.jst-mfg.com/product/pdf/eng/eSH.pdf) |
| `jst-gh` | 2 to 15 | 1.25 | housing + plug | derived | [source](https://www.jst-mfg.com/product/pdf/eng/eGH.pdf) |
| `jst-ph` | 2 to 16 | 2.0 | housing + plug | derived | [source](https://www.jst-mfg.com/product/pdf/eng/ePH.pdf) |
| `jst-xh` | 2 to 20 | 2.5 | housing + plug | derived | [source](https://www.jst-mfg.com/product/pdf/eng/eXH.pdf) |
| `jst-zh` | 2 to 13 | 1.5 | housing + plug | derived | [source](https://www.jst-mfg.com/product/pdf/eng/eZH.pdf) |
| `jst-eh` | 2 to 15 | 2.5 | housing + plug | derived | [source](https://www.jst-mfg.com/product/pdf/eng/eEH.pdf) |
| `picoblade` | 2 to 15 | 1.25 | none | generic | [source](https://assets.testequity.com/te1/Documents/pdf/Molex/Molex_51021-1500_Header-and-Wire-Housing_Datasheet.pdf) |
| `kk-254` | 2 to 12 | 2.54 | none | generic | none opened |
| `pin-header-2.54` | 1 to 40 | 2.54 | housing + plug | derived | [source](https://www.we-online.com/components/products/datasheet/61300411121.pdf) |
| `pin-header-2.54-2row` | 2 to 80 | 2.54 | housing + plug | derived | [source](https://www.we-online.com/components/products/datasheet/61300421121.pdf) |
| `pin-socket-2.54` | 1 to 40 | 2.54 | housing + plug | derived | [source](https://www.we-online.com/components/products/datasheet/61300411821.pdf) |
| `pin-socket-2.54-2row` | 4 to 80 | 2.54 | housing + plug | generic | [source](https://www.we-online.com/components/products/datasheet/61300411821.pdf) |
| `audio-jack-3.5` | 3 to 4 | - | none | generic | none opened |
| `idc-2.54-2row` | 6 to 64 | 2.54 | none | generic | none opened |
| `servo-3pin` | 3 to 3 | 2.54 | housing | generic | [source](https://www.we-online.com/components/products/datasheet/61300411121.pdf) |
| `usb-a` | 4 to 4 | - | housing + plug | generic | [source](https://en.wikipedia.org/wiki/USB_hardware) |
| `usb-b` | 4 to 4 | - | housing + plug | generic | [source](https://en.wikipedia.org/wiki/USB_hardware) |
| `usb-mini-b` | 5 to 5 | - | housing + plug | generic | [source](https://en.wikipedia.org/wiki/USB_hardware) |
| `usb-micro-b` | 5 to 5 | - | housing + plug | generic | [source](https://en.wikipedia.org/wiki/USB_hardware) |
| `usb-c` | 24 to 24 | - | housing + plug | derived | [source](https://www.assmann-wsw.com/uploads/datasheets/ASS_10363_CA.pdf) |
| `rj45` | 8 to 8 | - | plug | generic | [source](https://en.wikipedia.org/wiki/Modular_connector) |
| `hdmi` | 19 to 19 | - | plug | generic | [source](https://en.wikipedia.org/wiki/HDMI) |
| `hdmi-mini` | 19 to 19 | - | plug | generic | [source](https://en.wikipedia.org/wiki/HDMI) |
| `hdmi-micro` | 19 to 19 | - | plug | generic | [source](https://en.wikipedia.org/wiki/HDMI) |
| `barrel-jack-5.5x2.1` | 2 to 2 | - | plug | generic | [source](https://en.wikipedia.org/wiki/DC_connector) |
| `ffc-0.5` | 6 to 60 | 0.5 | housing + plug | derived | [source](https://www.physics.utoronto.ca/~astummer/Archives/2014%20Micro%203D%20Magnetometer/Docs/Hirose%20FH12-16S-1SV(55),%20FFC%20connector,%20SMT%201mm%2016-pos.pdf) |
| `ffc-1.0` | 4 to 26 | 1.0 | housing + plug | derived | [source](https://www.physics.utoronto.ca/~astummer/Archives/2014%20Micro%203D%20Magnetometer/Docs/Hirose%20FH12-16S-1SV(55),%20FFC%20connector,%20SMT%201mm%2016-pos.pdf) |
| `screw-terminal-3.5` | 2 to 24 | 3.5 | plug | derived | [source](https://www.we-online.com/components/products/datasheet/691361100002.pdf) |
| `screw-terminal-5.08` | 2 to 12 | 5.08 | housing | derived | [source](https://www.we-online.com/components/products/datasheet/691311500002.pdf) |
| `xt30` | 2 to 2 | 5.0 | none | generic | [source](https://store.comet.bg/download-file.php?id=30571) |
| `xt60` | 2 to 2 | 7.2 | plug | derived | [source](https://mrsdprojects.ri.cmu.edu/2025teamb/wp-content/uploads/sites/84/2025/05/xt60.pdf) |
| `u.fl` | 1 to 1 | - | none | generic | [source](https://docs.rs-online.com/d3d1/A700000015827780.pdf) |
| `sma` | 1 to 1 | - | none | generic | none opened |

## What differs from what was asked, and why

- **JST EH and DYNAMIXEL.** The ROBOTIS e-manual (XL330-M288, XM430-W350, connector information) lists housing JST EHR-03 (EHR-04 for RS-485), header B3B-EH-A and 21 AWG wire. `jst-eh` was added with the dimensions from JST's EH sheet. JST states 22 to 32 AWG for the EH contact, so the 21 AWG DYNAMIXEL lead is thicker than the contact range; the two sources disagree and both are in the note. The XL430 / JST GH question was not checked.
- **Molex PicoBlade and KK 254.** No dimensions: molex.com did not answer, and the Molex sheet and distributor pages that were opened carry none. The entries exist (pitch from the family name, way range unverified) so ports can name them, with no boxes.
- **XT30.** The Amass sheet was opened but its callouts could not be assigned to length, width and height with confidence, so there are no boxes. **XT60** has the plug (female) from the Amass drawing: 20.2 x 15.5 x 8.1 mm.
- **U.FL and SMA.** Only the 1.13 mm micro-coax use was confirmed (Siretta MHF I datasheet). The 1.32 and 1.37 mm sizes in `od_max_mm: 1.37` were given in the task and not verified; no connector dimensions.
- **Screw terminals.** 3.5 mm: the Wurth WR-TBL 3611 plug (26 to 16 AWG stated); which of its 15.8 and 11.1 mm sizes is the mating axis is uncertain. 5.08 mm: the Wurth WR-TBL 311 header; the matching plug sheet returned 404, so there is no plug box and no wire range. `terminal-2.54` was not added.
- **Box header (`idc-2.54-2row`).** Wurth WR-BHD sheets returned 404; no boxes. It accepts 1.27 mm ribbon through `cable_pitch_mm: 1.27`.
- **Servo 3-pin.** Housing from the 2.54 mm header; no source for a servo plug's dimensions.
- **FFC.** Hirose FH12 catalogue (2010.9 copy hosted at utoronto.ca): 0.5 mm 6 to 60 contacts, 1.0 mm 4 to 26. The plug box uses the 6.3 mm stiffener length of the Raspberry Pi 15-way cable drawing and the Wurth cable width.
- **Second-source attempts (not found):** Assmann ASS 9367 CO (opened) is a PCB-mount USB-C plug drawing with no cable overmould, so the 15 mm USB plug length stays an assumption; Amass XT30U mated pair 20.1 x 10.2 mm from the Rotorama manual (opened) is in the XT30 note, still no boxes; PicoBlade, box-header boxes and the 5.08 mm screw terminal wire range were not found (Molex, Hirose, Digi-Key and Wurth pages returned 403 or 404).
- **Not added:** jst-rcy and deans.

## Fit table surprises

With the generic thin-wall wires and the Qwiic cable added (see docs/CABLES.md), JST SH, GH and ZH now each have fitting cable types (SH: thin 28 and 30 AWG, Qwiic cable; GH and ZH also thin 26 AWG). Until then nothing fitted them. A 22 AWG servo lead is correctly refused by SH. Pin headers and sockets take the two Dupont jumper leads, `servo-3pin` takes the servo lead. Still no fitting cable: `idc-2.54-2row` below 10 ways, `ffc-1.0` at 4 ways, HDMI, barrel jack (nothing recorded to check). Connectors with no `accepts` for a family the library lacks (HDMI) fit every cable with a "not checked" note.
