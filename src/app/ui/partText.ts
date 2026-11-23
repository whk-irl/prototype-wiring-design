/**
 * Parts and ports in words, and part search. Pure: used by the Parts tab, the
 * port tooltip, part details and the tests.
 */
import { connectorLabel, findConnector, portWays, type ConnectorLibrary, type Part, type PartCategory, type Port } from '@core';

/**
 * The connector's full name with its size and aliases, for the detail view:
 * "JST SH 1.0 mm wire-to-board 4-way (Qwiic, STEMMA QT)".
 */
export function connectorText(port: Pick<Port, 'connector' | 'ways'>, connectors: ConnectorLibrary | null | undefined): string {
  const conn = connectors ? findConnector(connectors, port.connector) : undefined;
  if (!conn) return port.ways ? `${port.connector} ${port.ways}-way` : port.connector;
  const ways = portWays(conn, port);
  const single = conn.ways.min === conn.ways.max;
  const alias = conn.aliases.length ? ` (${conn.aliases.join(', ')})` : '';
  return `${conn.name}${!single && ways ? ` ${ways}-way` : ''}${alias}`;
}

/**
 * The connector's short label (`connectorLabel` from the library's `short`
 * names): "USB-C", "JST SH 4-way", "Pin header 2x20". For lists, tooltips,
 * the cut list and check sentences.
 */
export function connectorShort(port: Pick<Port, 'connector' | 'ways'>, connectors: ConnectorLibrary | null | undefined): string {
  const conn = connectors ? findConnector(connectors, port.connector) : undefined;
  if (!conn) return port.ways ? `${port.connector} ${port.ways}-way` : port.connector;
  return connectorLabel(conn, portWays(conn, port));
}

/** "I2C: JST SH 4-way". */
export function portLabel(port: Port, connectors: ConnectorLibrary | null | undefined): string {
  return `${port.name ?? port.id}: ${connectorShort(port, connectors)}`;
}

/** Separator between items of a summary. */
export const SUMMARY_SEP = ' · ';

/** "USB-C · 2 x JST SH 4-way · Pin header 16-way": every kind of port once (short labels), with a count when repeated. */
export function portSummary(part: Pick<Part, 'ports'>, connectors: ConnectorLibrary | null | undefined): string {
  if (part.ports.length === 0) return 'no ports';
  const counts = new Map<string, number>();
  for (const p of part.ports) {
    const text = connectorShort(p, connectors);
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  return [...counts].map(([t, n]) => (n > 1 ? `${n} x ${t}` : t)).join(SUMMARY_SEP);
}

/** Everything a search may match: name, id, tags, maker, part number, category, and the port connectors' names and aliases. */
export function partSearchText(part: Part, connectors: ConnectorLibrary | null | undefined): string {
  const words = [part.name, part.id, ...part.tags, part.manufacturer ?? '', part.mpn ?? '', part.category, part.description ?? ''];
  for (const p of part.ports) {
    words.push(p.connector, p.name ?? '', ...p.interfaces);
    const conn = connectors ? findConnector(connectors, p.connector) : undefined;
    if (conn) words.push(conn.name, ...conn.aliases);
  }
  return words.join(' ').toLowerCase();
}

const tokens = (text: string) => text.toLowerCase().split(/[^a-z0-9.+#]+/).filter(Boolean);

/**
 * Does a query word match these words? A word of three letters or more
 * matches the start of a word ("qwi" finds "qwiic"); a shorter one, or a
 * number, only a whole word ("pi 4" does not find "pin 40").
 */
function wordMatches(w: string, words: readonly string[]): boolean {
  const whole = w.length < 3 || /^\d+(\.\d+)?$/.test(w);
  return words.some((t) => (whole ? t === w : t.startsWith(w)));
}

/**
 * Parts matching every word of `query` (case-insensitive, whole words or the
 * start of one) and, when given, one category. Parts whose name holds every
 * word come first.
 */
export function searchParts(parts: readonly Part[], query: string, connectors: ConnectorLibrary | null | undefined, category?: PartCategory | ''): Part[] {
  const q = tokens(query);
  const hits = parts.filter((p) => (!category || p.category === category) && (q.length === 0 || q.every((w) => wordMatches(w, tokens(partSearchText(p, connectors))))));
  if (q.length === 0) return hits;
  const inName = (p: Part) => q.every((w) => wordMatches(w, tokens(p.name)));
  return [...hits.filter(inName), ...hits.filter((p) => !inName(p))];
}

export const CATEGORY_LABEL: Record<PartCategory, string> = {
  controller: 'Controllers',
  sensor: 'Sensors',
  driver: 'Motor drivers',
  actuator: 'Motors and servos',
  power: 'Power',
  camera: 'Cameras',
  display: 'Displays',
  other: 'Other',
};

/** Parts grouped by category, in a fixed order, empty groups left out. */
export function groupByCategory(parts: readonly Part[]): Array<{ category: PartCategory; parts: Part[] }> {
  const order = Object.keys(CATEGORY_LABEL) as PartCategory[];
  return order.map((category) => ({ category, parts: parts.filter((p) => p.category === category) })).filter((g) => g.parts.length > 0);
}
