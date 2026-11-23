/** Cable types in words, search and grouping (the Wires tab's type list). Pure. */
import type { CableFamily, CableType } from '@core';

export const FAMILY_LABEL: Record<CableFamily, string> = {
  hookup_wire: 'Single wires',
  jumper: 'Jumper wires',
  ribbon: 'Ribbon cable',
  ffc: 'Flat flex (FFC, FPC)',
  multicore: 'Multi-core cable',
  twisted_pair: 'Twisted pair',
  coax: 'Coaxial cable',
  usb: 'USB cable',
  ethernet: 'Ethernet cable',
  harness: 'Ready-made harnesses',
};

/** Types matching every word of `query` (name, id, family, maker, part number, gauge), and one family when given. */
export function searchCableTypes(types: readonly CableType[], query: string, family: CableFamily | '' = ''): CableType[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return types.filter((c) => {
    if (family && c.family !== family) return false;
    const text = `${c.name} ${c.id} ${c.family} ${FAMILY_LABEL[c.family]} ${c.manufacturer ?? ''} ${c.mpn ?? ''} ${c.awg !== undefined ? `${c.awg}awg ${c.awg} awg` : ''}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

/** Types grouped by family, the user's own at the head of their group, then library order; empty groups left out. */
export function groupByFamily(types: readonly CableType[]): Array<{ family: CableFamily; types: CableType[] }> {
  const order = Object.keys(FAMILY_LABEL) as CableFamily[];
  return order
    .map((family) => {
      const inFamily = types.filter((t) => t.family === family);
      return { family, types: [...inFamily.filter((t) => t.custom), ...inFamily.filter((t) => !t.custom)] };
    })
    .filter((g) => g.types.length > 0);
}
