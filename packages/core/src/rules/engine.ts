/**
 * The architecture rule engine.
 *
 * Two properties are non-negotiable here:
 *
 *  1. Determinism. Given the same model, the same violations come out in the
 *     same order, every time, on every machine. A non-deterministic linter
 *     cannot gate a pull request.
 *  2. Explainability. Every violation says which rule fired, which selector
 *     matched, and where in the source to go and look. "Architecture is wrong"
 *     is not a useful CI failure.
 */

import type { ArchModel } from '../model/model.ts';
import type {
  Assertion,
  Element,
  RuleDef,
  Severity,
  SourceLoc,
} from '../model/types.ts';
import { SEVERITY_ORDER } from '../model/types.ts';
import { matches, parseSelector, type Selector } from '../selector/selector.ts';
import { compareIds, sortBy } from '../util/canonical.ts';

export interface Violation {
  readonly ruleId: string;
  readonly ruleTitle?: string;
  readonly severity: Severity;
  /** Stable machine code, e.g. `rule/forbidden-dependency`. */
  readonly code: string;
  readonly message: string;
  readonly elementId?: string;
  readonly relationId?: string;
  /** Source position of the offending declaration, not of the rule. */
  readonly loc?: SourceLoc;
  /** Human-readable explanation of why the rule matched. */
  readonly detail?: string;
}

export interface CheckResult {
  readonly violations: readonly Violation[];
  readonly summary: {
    readonly rulesEvaluated: number;
    readonly elements: number;
    readonly relations: number;
    readonly errors: number;
    readonly warnings: number;
    readonly infos: number;
  };
  /** Problems with the rules themselves, e.g. a malformed selector. */
  readonly ruleErrors: readonly string[];
}

export function check(model: ArchModel, extraRules: readonly RuleDef[] = []): CheckResult {
  const rules = sortBy([...model.rules, ...extraRules], (rule) => rule.id);
  const violations: Violation[] = [];
  const ruleErrors: string[] = [];

  const selectorCache = new Map<string, Selector>();
  const selectorOf = (text: string, ruleId: string): Selector => {
    const cached = selectorCache.get(text);
    if (cached) return cached;
    const parsed = parseSelector(text);
    for (const error of parsed.errors) ruleErrors.push(`rule \`${ruleId}\`: ${error}`);
    selectorCache.set(text, parsed.selector);
    return parsed.selector;
  };

  for (const rule of rules) {
    for (const assertion of rule.assertions) {
      violations.push(...evaluate(model, rule, assertion, selectorOf));
    }
  }

  const ordered = sortViolations(violations);
  return {
    violations: ordered,
    summary: {
      rulesEvaluated: rules.length,
      elements: model.elements.length,
      relations: model.relations.length,
      errors: ordered.filter((v) => v.severity === 'error').length,
      warnings: ordered.filter((v) => v.severity === 'warning').length,
      infos: ordered.filter((v) => v.severity === 'info').length,
    },
    ruleErrors: [...new Set(ruleErrors)].sort(compareIds),
  };
}

function evaluate(
  model: ArchModel,
  rule: RuleDef,
  assertion: Assertion,
  selectorOf: (text: string, ruleId: string) => Selector,
): Violation[] {
  switch (assertion.type) {
    case 'forbidDependency':
      return forbidDependency(model, rule, assertion.from, assertion.to, selectorOf);
    case 'allowDependency':
      return allowDependency(model, rule, assertion.from, assertion.to, selectorOf);
    case 'requireField':
      return requireField(model, rule, assertion.field, assertion.on, selectorOf);
    case 'forbidCycles':
      return forbidCycles(model, rule, assertion.within, selectorOf);
    case 'forbidOrphans':
      return forbidOrphans(model, rule, assertion.within, selectorOf);
  }
}

/**
 * Flags any declared dependency whose endpoints match both selectors.
 *
 * Deliberately checks *declared* relations only, not transitive reachability.
 * A transitive check sounds stricter but in practice fires on paths nobody
 * considers a dependency (everything reaches the database eventually), and a
 * rule that cries wolf gets deleted. Cycle detection covers the transitive
 * case where it genuinely matters.
 */
function forbidDependency(
  model: ArchModel,
  rule: RuleDef,
  fromText: string,
  toText: string,
  selectorOf: (text: string, ruleId: string) => Selector,
): Violation[] {
  const from = selectorOf(fromText, rule.id);
  const to = selectorOf(toText, rule.id);
  const out: Violation[] = [];

  for (const relation of model.relations) {
    const source = model.element(relation.sourceId);
    const dest = model.element(relation.destId);
    if (!source || !dest) continue;
    if (!matches(from, source, model) || !matches(to, dest, model)) continue;

    out.push({
      ruleId: rule.id,
      ruleTitle: rule.title,
      severity: rule.severity,
      code: 'rule/forbidden-dependency',
      message: `${source.name} must not depend on ${dest.name}.`,
      relationId: relation.id,
      elementId: source.id,
      loc: relation.provenance.source === 'declared' ? relation.provenance.loc : undefined,
      detail: `\`${source.id}\` matches ${describe(from)} and \`${dest.id}\` matches ${describe(to)}.`,
    });
  }
  return out;
}

/**
 * Whitelist semantics: everything matching `from` may depend on things matching
 * `to`, and on nothing else. This is the useful reading of `allow` — a bare
 * permission would assert nothing and never fire.
 */
function allowDependency(
  model: ArchModel,
  rule: RuleDef,
  fromText: string,
  toText: string,
  selectorOf: (text: string, ruleId: string) => Selector,
): Violation[] {
  const from = selectorOf(fromText, rule.id);
  const to = selectorOf(toText, rule.id);
  const out: Violation[] = [];

  for (const relation of model.relations) {
    const source = model.element(relation.sourceId);
    const dest = model.element(relation.destId);
    if (!source || !dest) continue;
    if (!matches(from, source, model)) continue;
    if (matches(to, dest, model)) continue;
    // A dependency on an ancestor or descendant is structural, not a breach.
    if (isRelated(model, source.id, dest.id)) continue;

    out.push({
      ruleId: rule.id,
      ruleTitle: rule.title,
      severity: rule.severity,
      code: 'rule/dependency-not-allowed',
      message: `${source.name} may only depend on ${describe(to)}, but depends on ${dest.name}.`,
      relationId: relation.id,
      elementId: source.id,
      loc: relation.provenance.source === 'declared' ? relation.provenance.loc : undefined,
      detail: `\`${source.id}\` matches ${describe(from)}; \`${dest.id}\` does not match ${describe(to)}.`,
    });
  }
  return out;
}

function requireField(
  model: ArchModel,
  rule: RuleDef,
  field: 'description' | 'technology' | 'owner' | 'source',
  onText: string,
  selectorOf: (text: string, ruleId: string) => Selector,
): Violation[] {
  const on = selectorOf(onText, rule.id);
  const out: Violation[] = [];

  for (const element of model.elements) {
    if (!matches(on, element, model)) continue;
    const value = readField(element, field);
    if (value !== undefined && value.trim() !== '') continue;

    out.push({
      ruleId: rule.id,
      ruleTitle: rule.title,
      severity: rule.severity,
      code: 'rule/missing-field',
      message: `${element.name} has no ${field}.`,
      elementId: element.id,
      loc: element.provenance.source === 'declared' ? element.provenance.loc : undefined,
      detail:
        field === 'source'
          ? 'Without a `source "<path>"` binding, drift against the repository cannot be checked for this element.'
          : `\`${element.id}\` matches ${describe(on)}, which requires \`${field}\`.`,
    });
  }
  return out;
}

function readField(
  element: Element,
  field: 'description' | 'technology' | 'owner' | 'source',
): string | undefined {
  switch (field) {
    case 'description':
      return element.description;
    case 'technology':
      return element.technology;
    case 'owner':
      return element.owner;
    case 'source':
      return element.sourcePath;
  }
}

function forbidCycles(
  model: ArchModel,
  rule: RuleDef,
  withinText: string | undefined,
  selectorOf: (text: string, ruleId: string) => Selector,
): Violation[] {
  const within = withinText ? selectorOf(withinText, rule.id) : undefined;
  const scope = within ? (element: Element): boolean => matches(within, element, model) : undefined;

  return model.cycles(scope).map((cycle) => {
    const names = cycle.map((id) => model.element(id)?.name ?? id);
    const first = cycle[0] as string;
    const element = model.element(first);
    return {
      ruleId: rule.id,
      ruleTitle: rule.title,
      severity: rule.severity,
      code: 'rule/dependency-cycle',
      message: `Dependency cycle: ${[...names, names[0]].join(' → ')}.`,
      elementId: first,
      loc: element?.provenance.source === 'declared' ? element.provenance.loc : undefined,
      detail: `Cycle of length ${cycle.length}: ${[...cycle, first].join(' → ')}.`,
    };
  });
}

/**
 * An element is an orphan when neither it nor anything inside it participates
 * in any relationship. Checking descendants too avoids flagging every system
 * whose dependencies are declared at container level.
 */
function forbidOrphans(
  model: ArchModel,
  rule: RuleDef,
  withinText: string | undefined,
  selectorOf: (text: string, ruleId: string) => Selector,
): Violation[] {
  const within = withinText ? selectorOf(withinText, rule.id) : undefined;
  const out: Violation[] = [];

  for (const element of model.elements) {
    if (within && !matches(within, element, model)) continue;
    // Deployment topology is described by nesting, not by relationships.
    if (element.kind === 'deploymentNode' || element.kind === 'infrastructureNode') continue;

    const family = [element, ...model.descendants(element.id)];
    const connected = family.some(
      (member) => model.outgoing(member.id).length > 0 || model.incoming(member.id).length > 0,
    );
    if (connected) continue;

    out.push({
      ruleId: rule.id,
      ruleTitle: rule.title,
      severity: rule.severity,
      code: 'rule/orphan-element',
      message: `${element.name} has no relationships.`,
      elementId: element.id,
      loc: element.provenance.source === 'declared' ? element.provenance.loc : undefined,
      detail:
        'Neither this element nor anything inside it appears in a relationship, so it cannot be reached or reasoned about.',
    });
  }
  return out;
}

/** True when either id is an ancestor of the other. */
function isRelated(model: ArchModel, a: string, b: string): boolean {
  return (
    model.ancestors(a).some((element) => element.id === b) ||
    model.ancestors(b).some((element) => element.id === a)
  );
}

function describe(selector: Selector): string {
  return selector.predicates.length === 0 ? 'anything' : `\`${selector.text}\``;
}

/**
 * Errors first, then by source position so a developer can walk the list top
 * to bottom through their file, then by stable ids to break every remaining tie.
 */
export function sortViolations(violations: readonly Violation[]): Violation[] {
  return [...violations].sort((a, b) => {
    const severity = SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity];
    if (severity !== 0) return severity;
    const fileA = a.loc?.file ?? '';
    const fileB = b.loc?.file ?? '';
    if (fileA !== fileB) return compareIds(fileA, fileB);
    const lineA = a.loc?.line ?? 0;
    const lineB = b.loc?.line ?? 0;
    if (lineA !== lineB) return lineA - lineB;
    if (a.ruleId !== b.ruleId) return compareIds(a.ruleId, b.ruleId);
    if (a.code !== b.code) return compareIds(a.code, b.code);
    return compareIds(
      `${a.elementId ?? ''}|${a.relationId ?? ''}|${a.message}`,
      `${b.elementId ?? ''}|${b.relationId ?? ''}|${b.message}`,
    );
  });
}

/**
 * A recommended starting rule set, offered by `arch init` rather than imposed.
 * Hidden built-in rules make a linter feel arbitrary; these are written in the
 * same DSL the user writes, so they can be read, edited or deleted.
 */
export const RECOMMENDED_RULES: readonly RuleDef[] = [
  {
    id: 'no-dependency-cycles',
    title: 'Architecture must be acyclic',
    severity: 'error',
    assertions: [{ type: 'forbidCycles' }],
  },
  {
    id: 'containers-have-owners',
    title: 'Every container has an owning team',
    severity: 'warning',
    assertions: [{ type: 'requireField', field: 'owner', on: 'element(kind:container)' }],
  },
  {
    id: 'containers-declare-technology',
    title: 'Every container declares its technology',
    severity: 'warning',
    assertions: [{ type: 'requireField', field: 'technology', on: 'element(kind:container)' }],
  },
  {
    id: 'no-orphans',
    title: 'Every element is connected to something',
    severity: 'warning',
    assertions: [{ type: 'forbidOrphans' }],
  },
];
