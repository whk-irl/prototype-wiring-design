// Ready-made leads (family harness or jumper) fit only the connector families they have plugs for.
import { describe, expect, it } from 'vitest';
import { cableFit, CableTypeSchema, ConnectorSchema, findConnector, parseCableLibrary, parseConnectorLibrary, findCableType, validateDesign, parseDesign, PartSchema } from '@core';
import { fullDesign, readText } from './helpers';

const conn = (id: string, over: Record<string, unknown> = {}) =>
  ConnectorSchema.parse({
    id,
    name: `Connector ${id}`,
    pitch_mm: 1,
    ways: { min: 2, max: 10 },
    accepts: [{ families: ['harness', 'jumper', 'hookup_wire', 'multicore'], termination: 'per_contact' }],
    confidence: 'generic',
    ...over,
  });
const lead = (family: string, connectors: string[]) =>
  CableTypeSchema.parse({ id: 'l', name: 'l', family, section: { shape: 'round', od_mm: 2 }, conductors: 4, min_bend_mm: { static: 5 }, flex: 'flexible', confidence: 'generic', connectors });

describe('cableFit with a lead that has plugs', () => {
  const sh = conn('jst-sh');
  const gh = conn('jst-gh');

  it.each(['harness', 'jumper'])('%s: a listed connector is judged as before', (family) => {
    const t = lead(family, ['jst-sh']);
    expect(cableFit(sh, 4, t, 1)).toEqual({ fits: true, problems: [], notes: [] });
    expect(cableFit(sh, 2, t, 1).problems).toEqual(['4 conductors for 2 contacts.']);
  });

  it.each(['harness', 'jumper'])('%s: a connector not listed is refused, naming the plugs it has', (family) => {
    const r = cableFit(gh, 4, lead(family, ['jst-sh', 'pin-header-2.54']), 1);
    expect(r.fits).toBe(false);
    expect(r.problems).toEqual(['This lead comes with plugs for jst-sh, pin-header-2.54, not for Connector jst-gh.']);
    expect(r.notes).toEqual([]);
  });

  it.each(['harness', 'jumper'])('%s: an empty list is judged as before', (family) => {
    expect(cableFit(gh, 4, lead(family, []), 1).fits).toBe(true);
  });

  it('is checked before the connector is asked what it takes, even for a connector that records nothing', () => {
    const bare = conn('bare', { accepts: [] });
    expect(cableFit(bare, 4, lead('harness', ['jst-sh']), 1).fits).toBe(false);
    expect(cableFit(bare, 4, lead('harness', ['bare']), 1).fits).toBe(true);
  });

  it.each(['multicore', 'hookup_wire', 'twisted_pair', 'usb', 'ffc'])('%s with a connectors list is unaffected', (family) => {
    const t = lead(family, ['jst-sh']);
    const r = cableFit(gh, 4, t, 1);
    expect(r.problems.join(' ')).not.toMatch(/comes with plugs/);
  });
});

describe('cableFit with the real libraries', () => {
  const connectors = parseConnectorLibrary(readText('library/connectors.yaml'));
  const cables = parseCableLibrary(readText('library/cables.yaml'));
  const c = (id: string) => {
    const x = findConnector(connectors, id);
    if (!x) throw new Error(`connector ${id} is not in library/connectors.yaml`);
    return x;
  };
  const t = (id: string) => {
    const x = findCableType(cables, id);
    if (!x) throw new Error(`cable ${id} is not in library/cables.yaml`);
    return x;
  };

  it('the Qwiic cable fits jst-sh at 4 ways', () => {
    const r = cableFit(c('jst-sh'), 4, t('qwiic-cable-4x28awg'), 1);
    expect(r.problems).toEqual([]);
    expect(r.fits).toBe(true);
  });

  it.each([
    ['jst-gh', 4],
    ['jst-ph', 4],
    ['pin-header-2.54', 4],
    ['pin-socket-2.54', 4],
    ['jst-sh', 2],
  ])('the Qwiic cable is refused at %s with %d ways', (id, ways) => {
    const r = cableFit(c(id), ways, t('qwiic-cable-4x28awg'), 1);
    expect(r.fits).toBe(false);
    expect(r.problems.length).toBeGreaterThan(0);
  });

  it('the servo lead fits servo-3pin and is refused at jst-xh', () => {
    expect(cableFit(c('servo-3pin'), 3, t('servo-lead-3x22awg'), 1).fits).toBe(true);
    const r = cableFit(c('jst-xh'), 3, t('servo-lead-3x22awg'), 1);
    expect(r.fits).toBe(false);
    expect(r.problems[0]).toMatch(/comes with plugs for servo-3pin, pin-header-2\.54, not for/);
  });

  it('a Dupont jumper fits pin-header-2.54', () => {
    const r = cableFit(c('pin-header-2.54'), 4, t('dupont-jumper-28awg'), 1);
    expect(r.problems).toEqual([]);
    expect(r.fits).toBe(true);
  });

  it('every ready-made lead in the library fits each connector it lists, when it has contacts to spare', () => {
    for (const cable of cables.cables.filter((x) => (x.family === 'harness' || x.family === 'jumper') && x.connectors.length > 0)) {
      for (const id of cable.connectors) {
        const connector = findConnector(connectors, id)!;
        const ways = Math.max(connector.ways.min, cable.conductors);
        if (ways > connector.ways.max) continue;
        const r = cableFit(connector, ways - (ways % connector.rows), cable, 1);
        expect(r.problems.join(' '), `${cable.id} in ${id}`).not.toMatch(/comes with plugs/);
      }
    }
  });
});

describe('validateDesign and parseDesign with a connector library', () => {
  const connectors = parseConnectorLibrary(readText('library/connectors.yaml'));
  const own = (connector: string, ways?: number) =>
    PartSchema.parse({
      id: 'mine',
      name: 'Mine',
      category: 'sensor',
      body: { size_mm: [30, 20, 6] },
      ports: [{ id: 'p', connector, ...(ways !== undefined ? { ways } : {}), pose: { p_mm: [0, 0, 1], q: [0, 0, 0, 1] }, interfaces: ['i2c'] }],
      confidence: 'generic',
      custom: true,
    });
  const design = (connector: string, ways?: number) => {
    const d = fullDesign();
    d.parts.push(own(connector, ways));
    return d;
  };
  const errors = (d: ReturnType<typeof design>, withConnectors: boolean) => validateDesign(d, undefined, withConnectors ? connectors : undefined).filter((i) => i.severity === 'error');

  it('a sound part passes with the connector library', () => {
    expect(errors(design('jst-sh', 4), true)).toEqual([]);
  });

  it('an unknown connector family is an error at parts[i], and only with the connector library', () => {
    const d = design('no-such-connector', 4);
    const e = errors(d, true);
    expect(e).toHaveLength(1);
    expect(e[0]!.path).toBe('parts[0]');
    expect(e[0]!.message).toMatch(/connector "no-such-connector" is not in the connector library/);
    expect(errors(d, false)).toEqual([]);
  });

  it.each([
    ['a size the family does not come in', 'jst-sh', 99, /comes in 2 to 20 ways, not 99/],
    ['no size for a family with several', 'jst-sh', undefined, /must say how many/],
    ['a wrong size for a single-size family', 'usb-c', 5, /has 24 ways, not 5/],
  ])('%s is an error at parts[i]', (_n, connector, ways, message) => {
    const d = design(connector, ways);
    const e = errors(d, true);
    expect(e.some((i) => i.path === 'parts[0]' && message.test(i.message)), JSON.stringify(e)).toBe(true);
    expect(errors(d, false)).toEqual([]);
  });

  it('parseDesign passes the connector library through', () => {
    const raw = JSON.parse(JSON.stringify(design('no-such-connector', 4)));
    expect(parseDesign(raw).ok).toBe(true);
    const r = parseDesign(raw, undefined, connectors);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.path === 'parts[0]')).toBe(true);
  });
});
