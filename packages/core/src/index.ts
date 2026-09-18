/**
 * Browser-safe public API.
 *
 * Everything exported here runs unchanged in a browser: no `node:fs`, no
 * `node:path`, no process globals. That is what lets the static web editor and
 * the CLI share one engine instead of drifting into two implementations of the
 * same language — the mistake that makes most architecture tooling inconsistent
 * between its editor and its build step.
 *
 * Filesystem-dependent features (repository scanning, drift) live in
 * `index.node.ts`.
 */

export type {
  Assertion,
  Confidence,
  Element,
  ElementKind,
  Evidence,
  Provenance,
  RelationDirection,
  Relation,
  RequirableField,
  RuleDef,
  Severity,
  SourceLoc,
  Subtype,
  DynamicStep,
  ViewDef,
  ViewKind,
  Workspace,
} from './model/types.ts';
export { CONFIDENCE_ORDER, ELEMENT_KINDS, EMPTY_WORKSPACE, SEVERITY_ORDER } from './model/types.ts';

export { ArchModel } from './model/model.ts';

export type { Diagnostic } from './diagnostics.ts';
export {
  ArchInternalError,
  countBySeverity,
  diag,
  formatLoc,
  hasErrors,
  sortDiagnostics,
} from './diagnostics.ts';

export { compile, compileFiles } from './dsl/compile.ts';
export type { CompileResult, SourceFile } from './dsl/compile.ts';
export { emitWorkspace, emitWorkspaceData } from './dsl/emit.ts';
export type { EmitOptions } from './dsl/emit.ts';
export { synthesizeWorkspace } from './scan/synthesize.ts';
export { importPlantUml, looksLikePlantUml } from './import/plantuml.ts';
export type { ImportResult } from './import/plantuml.ts';
export type { SynthesizeOptions } from './scan/synthesize.ts';
export { parse } from './dsl/parser.ts';
export { lex } from './dsl/lexer.ts';

export { canonicalJson, canonicalize, normalizeTags, slug, sortBy } from './util/canonical.ts';
export { escapeXml, measureText, truncateText, wrapText } from './util/text.ts';

export { MATCH_ALL, matches, parseSelector, PREDICATE_KEYS, select } from './selector/selector.ts';
export type { Predicate, PredicateKey, Selector } from './selector/selector.ts';

export { derive, deriveAll, deriveById, undeclaredSteps } from './views/views.ts';
export type { DerivedView, ViewEdge, ViewNode } from './views/views.ts';

export { check, RECOMMENDED_RULES, sortViolations } from './rules/engine.ts';
export type { CheckResult, Violation } from './rules/engine.ts';

export { layout, nodeText } from './layout/layered.ts';
export type { Direction, EdgeRoute, Layout, LayoutOptions, NodeBox, NodeText } from './layout/layered.ts';

export {
  clearPosition,
  emptyLayout,
  parseLayout,
  pruneLayout,
  serializeLayout,
  setPosition,
} from './layout/store.ts';
export type { Position, ViewLayoutFile } from './layout/store.ts';

export { renderSvg } from './render/svg.ts';
export type { RenderOptions } from './render/svg.ts';
export { builtinGlyph, getIcon, ICON_PACKS, listIcons, resolveIcon } from './render/icons.ts';
export type { IconDef, IconQuery } from './render/icons.ts';

export { applyDiff, diff, formatDiff, isEmpty } from './diff/diff.ts';
export type { ArchDiff, ChangeType, ElementChange, FieldChange, RelationChange } from './diff/diff.ts';

export { toPlantUml } from './export/plantuml.ts';
export type { PlantUmlOptions } from './export/plantuml.ts';
export { toMermaid } from './export/mermaid.ts';
export type { MermaidOptions } from './export/mermaid.ts';

export { documentWorkspace } from './docs/markdown.ts';
export type { DocsOptions } from './docs/markdown.ts';
