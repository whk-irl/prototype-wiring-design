import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { PartSchema, parseConnectorLibrary, partProblems, type Part, type Port } from '@core';
import { guessFamily, parseKicadPcb, parseSExpr } from '../../src/app/parts/kicadPcb';

/**
 * KiCad 8 style board, 50 x 30 mm from (100, 100) to (150, 130) in KiCad
 * coordinates (y down). Part frame centre: KiCad (125, 115).
 */
const BOARD_A = `(kicad_pcb (version 20240108) (generator "pcbnew") (generator_version "8.0")
  (general (thickness 1.6) (legacy_teardrops no))
  (title_block (title "Test Board A"))
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
  (gr_rect (start 100 100) (end 150 130) (stroke (width 0.05) (type default)) (fill none) (layer "Edge.Cuts") (uuid "e1"))
  (footprint "Connector_USB:USB_C_Receptacle_GCT_USB4105-xx-A_16P_TopMnt_Horizontal" (layer "F.Cu") (uuid "f1") (at 101.5 115 270)
    (property "Reference" "J1" (at 0 -5 270) (layer "F.SilkS"))
    (property "Value" "USB_C" (at 0 5 270) (layer "F.Fab"))
    (pad "A1" smd rect (at -1 0 270) (size 0.6 1.2) (layers "F.Cu"))
    (pad "B1" smd rect (at 1 0 270) (size 0.6 1.2) (layers "F.Cu")))
  (footprint "Connector_PinHeader_2.54mm:PinHeader_1x08_P2.54mm_Vertical" (layer "F.Cu") (at 110 105)
    (property "Reference" "J2" (at 0 -2.33 0) (layer "F.SilkS"))
    (pad "1" thru_hole rect (at 0 0) (size 1.7 1.7) (drill 1) (layers "*.Cu"))
    (pad "2" thru_hole oval (at 0 2.54) (size 1.7 1.7) (drill 1) (layers "*.Cu"))
    (pad "3" thru_hole oval (at 0 5.08) (size 1.7 1.7) (drill 1) (layers "*.Cu"))
    (pad "4" thru_hole oval (at 0 7.62) (size 1.7 1.7) (drill 1) (layers "*.Cu"))
    (pad "5" thru_hole oval (at 0 10.16) (size 1.7 1.7) (drill 1) (layers "*.Cu"))
    (pad "6" thru_hole oval (at 0 12.7) (size 1.7 1.7) (drill 1) (layers "*.Cu"))
    (pad "7" thru_hole oval (at 0 15.24) (size 1.7 1.7) (drill 1) (layers "*.Cu"))
    (pad "8" thru_hole oval (at 0 17.78) (size 1.7 1.7) (drill 1) (layers "*.Cu")))
  (footprint "Connector_JST:JST_SH_SM04B-SRSS-TB_1x04-1MP_P1.00mm_Horizontal" (layer "F.Cu") (at 148 120 90)
    (property "Reference" "J3" (at 0 -3 90) (layer "F.SilkS"))
    (pad "1" smd roundrect (at -1.5 0 90) (size 0.6 1.55) (layers "F.Cu"))
    (pad "2" smd roundrect (at -0.5 0 90) (size 0.6 1.55) (layers "F.Cu"))
    (pad "3" smd roundrect (at 0.5 0 90) (size 0.6 1.55) (layers "F.Cu"))
    (pad "4" smd roundrect (at 1.5 0 90) (size 0.6 1.55) (layers "F.Cu"))
    (pad "MP" smd roundrect (at -2.8 3 90) (size 1.2 1.8) (layers "F.Cu"))
    (pad "MP" smd roundrect (at 2.8 3 90) (size 1.2 1.8) (layers "F.Cu")))
  (footprint "Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical" (layer "F.Cu") (at 120 120 90)
    (property "Reference" "J6" (at 0 0 90) (layer "F.SilkS"))
    (pad "1" thru_hole rect (at 0 0 90) (size 1.7 1.7) (drill 1) (layers "*.Cu"))
    (pad "2" thru_hole oval (at 0 2.54 90) (size 1.7 1.7) (drill 1) (layers "*.Cu")))
  (footprint "Connector_JST:JST_PH_B2B-PH-K_1x02_P2.00mm_Vertical" (layer "B.Cu") (at 130 110)
    (property "Reference" "J7" (at 0 0 0) (layer "B.SilkS"))
    (pad "1" thru_hole rect (at 0 0) (size 1.2 1.7) (drill 0.75) (layers "*.Cu"))
    (pad "2" thru_hole oval (at -2 0) (size 1.2 1.7) (drill 0.75) (layers "*.Cu")))
  (footprint "Connector:Weird_Thing_XYZ" (layer "F.Cu") (at 125 125)
    (property "Reference" "J5" (at 0 0 0) (layer "F.SilkS")))
  (footprint "Resistor_SMD:R_0603_1608Metric" (layer "F.Cu") (at 135 115)
    (property "Reference" "R1" (at 0 0 0) (layer "F.SilkS"))
    (pad "1" smd roundrect (at -0.8 0) (size 0.8 0.95) (layers "F.Cu")))
  (footprint "MountingHole:MountingHole_3.2mm_M3" (layer "F.Cu") (at 103 103)
    (property "Reference" "H1" (at 0 0 0) (layer "F.SilkS"))
    (pad "" np_thru_hole circle (at 0 0) (size 3.2 3.2) (drill 3.2) (layers "*.Cu" "*.Mask")))
  (footprint "MountingHole:MountingHole_3.2mm_M3" (layer "F.Cu") (at 147 103)
    (property "Reference" "H2" (at 0 0 0) (layer "F.SilkS"))
    (pad "" np_thru_hole circle (at 0 0) (size 3.2 3.2) (drill 3.2) (layers "*.Cu" "*.Mask")))
  (footprint "MountingHole:MountingHole_3.2mm_M3" (layer "F.Cu") (at 103 127)
    (property "Reference" "H3" (at 0 0 0) (layer "F.SilkS"))
    (pad "" np_thru_hole circle (at 0 0) (size 3.2 3.2) (drill 3.2) (layers "*.Cu" "*.Mask")))
  (footprint "MountingHole:MountingHole_2.7mm_M2.5" (layer "F.Cu") (at 147 127)
    (property "Reference" "H4" (at 0 0 0) (layer "F.SilkS"))
    (pad "" np_thru_hole circle (at 0 0) (size 2.7 2.7) (drill 2.7) (layers "*.Cu" "*.Mask")))
)`;

/** KiCad 6 style: (fp_text reference ...), lines plus one rounded corner, no thickness given. 60 x 40 mm at (0, 0). */
const BOARD_B = `(kicad_pcb (version 20211014) (generator pcbnew)
  (general)
  (gr_line (start 0 0) (end 55 0) (layer "Edge.Cuts") (width 0.1))
  (gr_arc (start 55 0) (mid 58.535534 1.464466) (end 60 5) (layer "Edge.Cuts") (width 0.1))
  (gr_line (start 60 5) (end 60 40) (layer "Edge.Cuts") (width 0.1))
  (gr_line (start 60 40) (end 0 40) (layer "Edge.Cuts") (width 0.1))
  (gr_line (start 0 40) (end 0 0) (layer "Edge.Cuts") (width 0.1))
  (footprint "Connector_USB:USB_Micro-B_Molex-105017-0001" (layer "F.Cu") (at 30 1)
    (fp_text reference "J1" (at 0 -3) (layer "F.SilkS"))
    (fp_text value "USB_B_Micro" (at 0 3) (layer "F.Fab"))
    (pad "1" smd rect (at -1.3 0) (size 0.4 1.35) (layers "F.Cu"))
    (pad "5" smd rect (at 1.3 0) (size 0.4 1.35) (layers "F.Cu")))
  (footprint "Connector_FFC-FPC:Hirose_FH12-15S-0.5SH_1x15-1MP_P0.50mm_Horizontal" (layer "F.Cu") (at 30 39 180)
    (fp_text reference "J2" (at 0 0) (layer "F.SilkS")))
  (footprint "TerminalBlock_Phoenix:TerminalBlock_Phoenix_MKDS-1,5-2-5.08_1x02_P5.08mm_Horizontal" (layer "F.Cu") (at 58 20 90)
    (fp_text reference "J3" (at 0 0) (layer "F.SilkS"))
    (pad "1" thru_hole rect (at 0 0 90) (size 2 2) (drill 1.3) (layers "*.Cu"))
    (pad "2" thru_hole circle (at 5.08 0 90) (size 2 2) (drill 1.3) (layers "*.Cu")))
)`;

const port = (part: Part, id: string): Port => {
  const p = part.ports.find((x) => x.id === id);
  if (!p) throw new Error(`no port ${id}`);
  return p;
};

/** A port's axis in the part frame. */
const axis = (p: Port, a: 'x' | 'y' | 'z'): number[] => {
  const v = new Vector3(a === 'x' ? 1 : 0, a === 'y' ? 1 : 0, a === 'z' ? 1 : 0).applyQuaternion(new Quaternion(...p.pose.q));
  return [v.x, v.y, v.z].map((c) => Math.round(c * 1e6) / 1e6 + 0);
};

const close = (actual: readonly number[], expected: readonly number[]) => expected.forEach((v, i) => expect(actual[i]).toBeCloseTo(v, 3));

describe('parseKicadPcb, KiCad 8 board', () => {
  const { part, warnings } = parseKicadPcb(BOARD_A);

  it('is a valid custom part with the outline as the envelope', () => {
    expect(PartSchema.parse(part)).toEqual(part);
    expect(partProblems(part)).toEqual([]);
    expect(part.name).toBe('Test Board A');
    expect(part.id).toMatch(/^custom-test-board-a-[0-9a-f]{8}$/);
    expect(part.custom).toBe(true);
    expect(part.confidence).toBe('measured');
    expect(part.body.size_mm.slice(0, 2)).toEqual([50, 30]);
    // Through-hole pins and a 6 mm JST PH on the back: 6 mm of room under the board.
    expect(part.body.board).toEqual({ z_mm: 6, thickness_mm: 1.6 });
    // 6 + 1.6 + 8 (nothing on top is taller than 8.5 mm: the header's 2.5 + 6 mm pins).
    expect(part.body.size_mm[2]).toBeCloseTo(6 + 1.6 + 8.5, 6);
    expect(warnings.some((w) => /height .* is a guess/.test(w))).toBe(true);
    expect(warnings.some((w) => /not a plain rectangle/.test(w))).toBe(false);
  });

  it('reads the mounting holes, KiCad y down turned into part y up', () => {
    expect(part.mounting_holes).toEqual([
      { p_mm: [-22, 12], d_mm: 3.2 },
      { p_mm: [22, 12], d_mm: 3.2 },
      { p_mm: [-22, -12], d_mm: 3.2 },
      { p_mm: [22, -12], d_mm: 2.7 },
    ]);
  });

  it('puts the USB-C on the left edge, exiting -X', () => {
    const p = port(part, 'J1');
    expect(p.connector).toBe('usb-c');
    expect(p.ways).toBeUndefined();
    expect(p.interfaces).toEqual(['usb2']);
    expect(p.name).toBe('USB_C');
    close(p.pose.p_mm, [-25, 0, 6 + 1.6 + 1.6]);
    expect(axis(p, 'x')).toEqual([-1, 0, 0]);
    expect(axis(p, 'z')).toEqual([0, 0, 1]);
    close(p.pose.q, [0, 0, 1, 0]);
  });

  it('points a vertical header up, +Y along the pins from pin 1 to pin 8', () => {
    const p = port(part, 'J2');
    expect(p.connector).toBe('pin-header-2.54');
    expect(p.ways).toBe(8);
    // Pad centre: KiCad (110, 113.89) -> part (-15, 1.11); mouth on top of the 2.5 mm plastic.
    close(p.pose.p_mm, [-15, 1.11, 7.6 + 2.5]);
    expect(axis(p, 'x')).toEqual([0, 0, 1]);
    // Pin 1 is at KiCad y 105 (part +10), pin 8 further down the screen: part -Y.
    expect(axis(p, 'y')).toEqual([0, -1, 0]);
  });

  it('gets the rotation handedness right: a header turned 90 deg runs along +X', () => {
    // KiCad turns counter-clockwise on screen: local +v (down) becomes screen right.
    const p = port(part, 'J6');
    close(p.pose.p_mm, [-3.73, -5, 10.1]);
    expect(axis(p, 'y')).toEqual([1, 0, 0]);
    expect(axis(p, 'x')).toEqual([0, 0, 1]);
  });

  it('puts the rotated JST SH on the right edge, exiting +X', () => {
    const p = port(part, 'J3');
    expect(p.connector).toBe('jst-sh');
    expect(p.ways).toBe(4);
    // Pad centre local (0, 1) at 90 deg -> KiCad (149, 120) -> part (24, -5); mouth moved to the edge.
    close(p.pose.p_mm, [25, -5, 7.6 + 2.95 / 2]);
    expect(axis(p, 'x')).toEqual([1, 0, 0]);
    close(p.pose.q, [0, 0, 0, 1]);
  });

  it('places a back-side connector on the underside, exiting -Z, and says so', () => {
    const p = port(part, 'J7');
    expect(p.connector).toBe('jst-ph');
    expect(p.ways).toBe(2);
    close(p.pose.p_mm, [4, 5, 0]);
    expect(axis(p, 'x')).toEqual([0, 0, -1]);
    expect(p.note).toMatch(/back of the board/);
    expect(warnings.some((w) => /back of the board.*J7/.test(w))).toBe(true);
  });

  it('keeps an unknown connector footprint as "other" with a warning naming it', () => {
    const p = port(part, 'J5');
    expect(p.connector).toBe('other');
    expect(p.interfaces).toEqual(['other']);
    expect(axis(p, 'x')).toEqual([0, 0, 1]);
    close(p.pose.p_mm.slice(0, 2), [0, -10]);
    expect(warnings.some((w) => w.includes('Connector:Weird_Thing_XYZ'))).toBe(true);
  });

  it('ignores footprints that are not connectors', () => {
    expect(part.ports.map((p) => p.id).sort()).toEqual(['J1', 'J2', 'J3', 'J5', 'J6', 'J7']);
  });

  it('checks connector ids against a library when one is given', () => {
    const lib = parseConnectorLibrary(`version: 1
connectors:
  - { id: usb-c, name: USB-C, ways: { min: 24, max: 24 }, confidence: generic }
  - { id: pin-header-2.54, name: Header, pitch_mm: 2.54, ways: { min: 1, max: 40 }, confidence: generic }
`);
    const { part: p, warnings: w } = parseKicadPcb(BOARD_A, { name: 'Named', connectors: lib });
    expect(p.name).toBe('Named');
    expect(w.some((x) => /"jst-sh".*not in the connector library/.test(x))).toBe(true);
    expect(w.some((x) => /"usb-c".*not in the connector library/.test(x))).toBe(false);
    expect(port(p, 'J3').connector).toBe('jst-sh');
  });
});

describe('parseKicadPcb, KiCad 6 board', () => {
  const { part, warnings } = parseKicadPcb(BOARD_B, { name: 'Board B' });

  it('uses the bounding box of a non-rectangular outline and says so', () => {
    expect(PartSchema.parse(part)).toEqual(part);
    expect(partProblems(part)).toEqual([]);
    close(part.body.size_mm.slice(0, 2), [60, 40]);
    expect(warnings.some((w) => /not a plain rectangle.*bounding box/.test(w))).toBe(true);
    expect(warnings.some((w) => /thickness; assuming 1.6/.test(w))).toBe(true);
    expect(part.body.board).toEqual({ z_mm: 2, thickness_mm: 1.6 });
    // The 10 mm terminal block sets the height above the board.
    expect(part.body.size_mm[2]).toBeCloseTo(2 + 1.6 + 10, 6);
  });

  it('reads fp_text references and exits across the top and bottom edges', () => {
    const usb = port(part, 'J1');
    expect(usb.connector).toBe('usb-micro-b');
    expect(usb.name).toBe('USB_B_Micro');
    close(usb.pose.p_mm, [0, 20, 3.6 + 1.4]);
    expect(axis(usb, 'x')).toEqual([0, 1, 0]);
    close(usb.pose.q, [0, 0, Math.SQRT1_2, Math.SQRT1_2]);

    const ffc = port(part, 'J2');
    expect(ffc.connector).toBe('ffc-0.5');
    expect(ffc.ways).toBe(15);
    close(ffc.pose.p_mm.slice(0, 2), [0, -20]);
    expect(axis(ffc, 'x')).toEqual([0, -1, 0]);

    const tb = port(part, 'J3');
    expect(tb.connector).toBe('screw-terminal-5.08');
    expect(tb.ways).toBe(2);
    // Pads at KiCad (58, 20) and (58, 14.92): centre part (28, 2.54), moved to the right edge.
    close(tb.pose.p_mm.slice(0, 2), [30, 2.54]);
    expect(axis(tb, 'x')).toEqual([1, 0, 0]);
  });
});

describe('KiCad helpers', () => {
  it('guesses connector families from footprint names', () => {
    const g = (name: string) => {
      const f = guessFamily(name);
      return f && { connector: f.connector, ways: f.ways, interfaces: f.interfaces };
    };
    expect(g('Connector_PinHeader_2.54mm:PinHeader_2x20_P2.54mm_Vertical')).toEqual({ connector: 'pin-header-2.54-2row', ways: 40, interfaces: ['other'] });
    expect(g('PinSocket_1x06_P2.54mm_Vertical')).toEqual({ connector: 'pin-socket-2.54', ways: 6, interfaces: ['other'] });
    expect(g('JST_GH_SM06B-GHS-TB_1x06-1MP_P1.25mm_Horizontal')?.connector).toBe('jst-gh');
    expect(g('JST_XH_B3B-XH-A_1x03_P2.50mm_Vertical')).toEqual({ connector: 'jst-xh', ways: 3, interfaces: ['other'] });
    expect(g('JST_ZH_B5B-ZR_1x05_P1.50mm_Vertical')?.ways).toBe(5);
    expect(g('JST_EH_B2B-EH-A_1x02_P2.50mm_Vertical')?.connector).toBe('jst-eh');
    expect(g('USB_A_Molex_67643_Horizontal')?.connector).toBe('usb-a');
    expect(g('RJ45_Amphenol_RJHSE538X')).toEqual({ connector: 'rj45', ways: undefined, interfaces: ['ethernet'] });
    expect(g('BarrelJack_Horizontal')).toEqual({ connector: 'barrel-jack-5.5x2.1', ways: undefined, interfaces: ['power'] });
    expect(g('TE_FFC_1-84953-4_1x04-1MP_P1.0mm_Horizontal')).toEqual({ connector: 'ffc-1.0', ways: 4, interfaces: ['other'] });
    expect(g('SOIC-8_3.9x4.9mm_P1.27mm')).toBeUndefined();
  });

  it('parses S-expressions with quoted strings and escapes', () => {
    expect(parseSExpr('(a "b c" (d 1.5) "e \\"q\\"")')).toEqual([['a', 'b c', ['d', '1.5'], 'e "q"']]);
    expect(() => parseSExpr('(a (b)')).toThrow(/truncated/);
  });

  it('refuses files that are not boards or have no outline', () => {
    expect(() => parseKicadPcb('(kicad_sch (version 1))')).toThrow(/not a KiCad board/);
    expect(() => parseKicadPcb('(kicad_pcb (version 20240108))')).toThrow(/no outline/);
  });
});
