/**
 * Wiring rules are data (`rules/*.yaml`), not code. Each rule is one limit on
 * one measured quantity, with the conditions under which it applies, a source
 * and a confidence level. The rule engine that measures designs and picks
 * cables is milestone M2; this file fixes the format it will consume.
 */
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { IdSchema } from './schema';

/**
 * How far a value can be trusted.
 * - `standard`: stated by a standard we could read.
 * - `vendor`: manufacturer datasheet or application note.
 * - `rule_of_thumb`: common practice with a citable source.
 * - `unverified`: a default nobody has sourced yet. Must not ship as a `fail`.
 */
export const ConfidenceSchema = z.enum(['standard', 'vendor', 'rule_of_thumb', 'unverified']);

/** What a rule limits. Extended as the rule engine grows. */
export const QuantitySchema = z.enum([
  'bend_radius_over_diameter',
  'bend_radius_over_thickness',
  'twist_deg_per_m',
  'length_m',
  'bus_capacitance_pf',
  'current_a',
  'fill_ratio',
  'fixing_spacing_mm',
  'first_fixing_over_diameter',
  'separation_mm',
  'wall_thickness_mm',
]);

export const RuleSchema = z.strictObject({
  id: IdSchema,
  title: z.string().min(1),
  /**
   * Conditions. Every key must match; a key matches when the context value is
   * one of the listed alternatives. An empty `when` applies everywhere.
   * Example: `{ cable_class: [fpc], motion: [dynamic] }`.
   */
  when: z.record(z.string(), z.array(z.string()).min(1)).default({}),
  quantity: QuantitySchema,
  /** The measured quantity must satisfy `measured <op> value`. */
  op: z.enum(['>=', '<=']),
  value: z.number(),
  severity: z.enum(['fail', 'warn', 'info']),
  confidence: ConfidenceSchema,
  source: z.url().optional(),
  note: z.string().optional(),
  /** Who may replace `value`: a part datasheet, the user, both or neither. */
  overridable_by: z.array(z.enum(['datasheet', 'user'])).default(['datasheet', 'user']),
});

export const RuleFileSchema = z.strictObject({
  version: z.literal(1),
  rules: z.array(RuleSchema),
});

export type Confidence = z.infer<typeof ConfidenceSchema>;
export type Quantity = z.infer<typeof QuantitySchema>;
export type Rule = z.infer<typeof RuleSchema>;
export type RuleFile = z.infer<typeof RuleFileSchema>;

/** Parse a rules YAML file and enforce the cross-field constraints. */
export function parseRules(yamlText: string): RuleFile {
  const file = RuleFileSchema.parse(parseYaml(yamlText));
  const seen = new Set<string>();
  for (const rule of file.rules) {
    if (seen.has(rule.id)) throw new Error(`duplicate rule id "${rule.id}"`);
    seen.add(rule.id);
    if (rule.confidence === 'unverified' && rule.severity === 'fail') {
      throw new Error(`rule "${rule.id}": an unverified rule cannot have severity "fail"`);
    }
    if (rule.confidence !== 'unverified' && !rule.source) {
      throw new Error(`rule "${rule.id}": confidence "${rule.confidence}" needs a source`);
    }
  }
  return file;
}

/** Whether a rule's conditions hold for a context such as `{ cable_class: 'fpc', motion: 'dynamic' }`. */
export function ruleApplies(rule: Rule, context: Readonly<Record<string, string | undefined>>): boolean {
  for (const [key, allowed] of Object.entries(rule.when)) {
    const actual = context[key];
    if (actual === undefined || !allowed.includes(actual)) return false;
  }
  return true;
}

/** Whether a measured value satisfies a rule. `limit` replaces `rule.value` when overridden. */
export function ruleSatisfied(rule: Rule, measured: number, limit = rule.value): boolean {
  return rule.op === '>=' ? measured >= limit : measured <= limit;
}
