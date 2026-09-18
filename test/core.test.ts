/**
 * Engine tests: compiler, view derivation, selectors, rules, diff, layout,
 * rendering determinism, emit round-trip and the palette.
 *
 * The bias here is towards properties rather than snapshots. Snapshots of a
 * renderer mostly test that nothing changed; properties like "the same model
 * renders to the same bytes" and "applying a diff reproduces the target" keep
 * holding as the code grows.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compile, compileFiles } from '../packages/core/src/dsl/compile.ts';
import { emitWorkspace } from '../packages/core/src/dsl/emit.ts';
import { ArchModel } from '../packages/core/src/model/model.ts';
import { hasErrors } from '../packages/core/src/diagnostics.ts';
import { derive, deriveAll, undeclaredSteps } from '../packages/core/src/views/views.ts';
import { parseSelector, select } from '../packages/core/src/selector/selector.ts';
import { check, RECOMMENDED_RULES } from '../packages/core/src/rules/engine.ts';
import { applyDiff, diff, isEmpty } from '../packages/core/src/diff/diff.ts';
import { layout } from '../packages/core/src/layout/layered.ts';
import { renderSvg } from '../packages/core/src/render/svg.ts';
import { toPlantUml } from '../packages/core/src/export/plantuml.ts';
import { toMermaid } from '../packages/core/src/export/mermaid.ts';
import { documentWorkspace } from '../packages/core/src/docs/markdown.ts';
import { canonicalJson } from '../packages/core/src/util/canonical.ts';
import { measureText, wrapText } from '../packages/core/src/util/text.ts';
import { paletteByGroup, PALETTE, searchPalette } from '../packages/core/src/catalog.ts';
import { pruneLayout, parseLayout, serializeLayout } from '../packages/core/src/layout/store.ts';

function modelOf(text: string): ArchModel {
  const result = compile(text, 'test.arch');
  if (hasErrors(result.diagnostics)) {
    assert.fail(
      `does not compile:\n${result.diagnostics.map((d) => `${d.loc?.line} ${d.message}`).join('\n')}`,
    );
  }
  return new ArchModel(result.workspace);
}

const SAMPLE = `workspace "Shop" {
  person customer "Customer" { description "Buys." }
  person admin "Admin" { tag staff }

  system shop "Shop" {
    owner "team-shop"
    tag domain-shop

    container web "Web" {
      technology "React"
      kind browser
      tag public
    }
    container api "API" {
      technology "Go"
      kind api
      source "services/api"
      tag internal
      component handler "Handler" { technology "chi" }
      component store "Store" { technology "sqlc" }
    }
    database db "Shop DB" { technology "PostgreSQL 16" tag stateful }
    topic events "shop.events" { technology "Kafka" tag async }
  }

  system payments "Payments" { external  tag third-party }

  deploymentNode aws "AWS" {
    deploymentNode eks "EKS" {
      deploymentNode apiPod "api" { instanceOf shop.api instances "3" }
    }
    infrastructureNode rds "RDS" { instanceOf shop.db }
  }

  customer -> shop.web "Shops" { technology "HTTPS" }
  admin -> shop.api "Administers" { technology "HTTPS" }
  shop.web -> shop.api.handler "Calls" { technology "HTTPS/JSON" }
  shop.api.handler -> shop.api.store "Delegates"
  shop.api.store -> shop.db "SQL" { technology "pgx" }
  shop.api.store -> shop.events "Publishes" { technology "Kafka" tag async }
  shop.api -> payments "Charges" { technology "HTTPS" }

  views {
    context landscape "Landscape" of shop
    container containers "Containers" of shop
    component apiParts "API parts" of shop.api
    deployment prod "Production" of aws
    dynamic checkout "Checkout" {
      customer -> shop.web "Opens"
      shop.web -> shop.api.handler "Submits"
      shop.api.store -> shop.db "Writes"
    }
  }

  rules {
    rule no-cycles { severity error  forbid cycles }
    rule owned { severity warning  require owner on element(kind:container) }
  }
}
`;

// --------------------------------------------------------------------- compiler

test('the compiler resolves structure, references and inheritance', () => {
  const model = modelOf(SAMPLE);

  assert.equal(model.requireElement('shop.api').kind, 'container');
  assert.equal(model.requireElement('shop.db').kind, 'container');
  assert.equal(model.requireElement('shop.db').subtype, 'database');
  assert.equal(model.requireElement('shop.api.handler').kind, 'component');
  assert.equal(model.requireElement('aws.eks.apiPod').kind, 'deploymentNode');

  // Owner is inherited from the enclosing system.
  assert.equal(model.requireElement('shop.api').owner, 'team-shop');
  // `external` becomes a tag.
  assert.ok(model.requireElement('payments').tags.includes('external'));
  // instanceOf resolves to a full id.
  assert.equal(model.requireElement('aws.eks.apiPod').instanceOf, 'shop.api');
  assert.equal(model.requireElement('aws.eks.apiPod').properties['instances'], '3');
});

test('the compiler reports nesting violations, duplicates and bad references', () => {
  const bad = compile(
    `workspace "B" {
      container loose "Loose"
      system s "S" {
        container a "A"
        container a "A again"
        component c "C"
      }
      s.a -> nowhere "x"
      s.a -> s.a "self"
    }`,
    'bad.arch',
  );

  const codes = bad.diagnostics.map((d) => d.code);
  assert.ok(codes.includes('compile/invalid-nesting'), 'a top-level container is invalid');
  assert.ok(codes.includes('compile/duplicate-id'), 'duplicate ids are reported');
  assert.ok(codes.includes('compile/unresolved-reference'), 'unknown references are reported');
  assert.ok(codes.includes('compile/self-relationship'), 'self relationships are reported');
});

test('diagnostics carry a usable source location and hint', () => {
  const bad = compile(`workspace "B" {\n  system s "S" {\n    tecnology "oops"\n  }\n}`, 'b.arch');
  const diagnostic = bad.diagnostics.find((d) => d.code === 'compile/unknown-property');
  assert.ok(diagnostic, 'a misspelt property is reported');
  assert.equal(diagnostic.loc?.line, 3);
  assert.match(diagnostic.hint ?? '', /technology/, 'the hint should suggest the real property');
});

test('ambiguous references are refused rather than guessed', () => {
  const ambiguous = compile(
    `workspace "A" {
      system one "One" { container api "A" { technology "x" } }
      system two "Two" { container api "B" { technology "x" } }
      one.api -> api "?"
    }`,
    'a.arch',
  );
  assert.ok(ambiguous.diagnostics.some((d) => d.code === 'compile/ambiguous-reference'));
});

test('multiple files compile into one workspace', () => {
  const result = compileFiles([
    { file: 'a.arch', text: 'workspace "Split" {\n system a "A" { container x "X" { technology "Go" } }\n}' },
    { file: 'b.arch', text: 'system b "B"\na.x -> b "calls"' },
  ]);
  assert.equal(hasErrors(result.diagnostics), false);
  const model = new ArchModel(result.workspace);
  assert.ok(model.element('a.x'));
  assert.ok(model.element('b'));
  assert.equal(model.relations.length, 1);
});

// ------------------------------------------------------------------ graph queries

test('graph queries answer impact questions', () => {
  const model = modelOf(SAMPLE);

  const direct = model.dependents('shop.db', { transitive: false }).map((e) => e.id);
  assert.deepEqual(direct, ['shop.api.store']);

  const transitive = model.dependents('shop.db').map((e) => e.id);
  assert.ok(transitive.includes('shop.web'), 'the web app transitively depends on the database');
  assert.ok(transitive.includes('customer'));

  assert.deepEqual(model.cycles(), [], 'the sample is acyclic');
  assert.equal(model.ancestorOfKind('shop.api.handler', 'system')?.id, 'shop');
});

test('cycles are found once, in a canonical rotation', () => {
  const model = modelOf(`workspace "C" {
    system s "S" {
      container a "A" { technology "x" }
      container b "B" { technology "x" }
      container c "C" { technology "x" }
    }
    s.a -> s.b "1"
    s.b -> s.c "2"
    s.c -> s.a "3"
  }`);

  const cycles = model.cycles();
  assert.equal(cycles.length, 1, 'one cycle, reported once');
  assert.deepEqual(cycles[0], ['s.a', 's.b', 's.c'], 'rotated to start at the smallest id');
});

// ----------------------------------------------------------------------- views

test('views derive the right elements at each C4 level', () => {
  const model = modelOf(SAMPLE);
  const views = new Map(deriveAll(model).map((view) => [view.id, view]));

  const landscape = views.get('landscape');
  assert.ok(landscape);
  const landscapeIds = landscape.nodes.map((node) => node.element.id).sort();
  assert.deepEqual(landscapeIds, ['admin', 'customer', 'payments', 'shop']);

  const containers = views.get('containers');
  assert.ok(containers);
  const containerIds = containers.nodes.map((node) => node.element.id);
  assert.ok(containerIds.includes('shop.api'));
  assert.ok(containerIds.includes('shop.db'));
  assert.ok(containerIds.includes('payments'), 'external neighbours appear');
  assert.equal(containerIds.includes('shop.api.handler'), false, 'components stay hidden');

  const apiParts = views.get('apiParts');
  assert.ok(apiParts);
  const partIds = apiParts.nodes.map((node) => node.element.id);
  assert.ok(partIds.includes('shop.api.handler'));
  assert.ok(partIds.includes('shop.db'), 'a sibling container is shown as itself');
  assert.equal(partIds.includes('shop'), false, 'not the whole parent system');
});

test('relationships are lifted to the level being viewed', () => {
  const model = modelOf(SAMPLE);
  const containers = deriveAll(model).find((view) => view.id === 'containers');
  assert.ok(containers);

  // Declared web -> api.handler, so the container view must show web -> api.
  const lifted = containers.edges.find(
    (edge) => edge.sourceId === 'shop.web' && edge.destId === 'shop.api',
  );
  assert.ok(lifted, 'a component-level dependency appears between containers');
  assert.equal(lifted.lifted, true, 'and is marked as lifted');

  // api.handler -> api.store is internal to one container: it must not appear.
  assert.equal(
    containers.edges.some((edge) => edge.sourceId === edge.destId),
    false,
    'an element never depends on itself through lifting',
  );
});

test('a deployment view lifts traffic onto the nodes that host it', () => {
  const model = modelOf(SAMPLE);
  const prod = deriveAll(model).find((view) => view.id === 'prod');
  assert.ok(prod);
  assert.ok(prod.edges.length > 0, 'deployment views show communication, not just nesting');
  assert.ok(
    prod.edges.some((edge) => edge.sourceId === 'aws.eks.apiPod' && edge.destId === 'aws.rds'),
    'api pod to RDS, via instanceOf',
  );
});

test('dynamic views keep step order and flag undeclared steps', () => {
  const model = modelOf(SAMPLE);
  const checkout = deriveAll(model).find((view) => view.id === 'checkout');
  assert.ok(checkout);
  assert.deepEqual(
    checkout.edges.map((edge) => edge.order),
    [1, 2, 3],
  );

  const withTypo = modelOf(`workspace "D" {
    system s "S" {
      container a "A" { technology "x" }
      container b "B" { technology "x" }
    }
    s.a -> s.b "real"
    views { dynamic d "D" { s.b -> s.a "not declared" } }
  }`);
  const definition = withTypo.views[0];
  assert.ok(definition);
  assert.deepEqual(undeclaredSteps(withTypo, definition), ['s.b -> s.a']);
});

test('view include and exclude selectors filter the result', () => {
  const model = modelOf(`workspace "F" {
    system s "S" {
      container a "A" { technology "x" tag keep }
      container b "B" { technology "x" tag drop }
    }
    s.a -> s.b "x"
    views {
      container filtered "Filtered" of s { exclude element(tag:drop) }
    }
  }`);
  const view = derive(model, model.views[0]!);
  const ids = view.nodes.map((node) => node.element.id);
  assert.ok(ids.includes('s.a'));
  assert.equal(ids.includes('s.b'), false, 'excluded elements are dropped');
});

// ------------------------------------------------------------------- selectors

test('selectors match on every supported predicate', () => {
  const model = modelOf(SAMPLE);
  const ids = (expression: string): string[] =>
    select(parseSelector(expression).selector, model)
      .map((element) => element.id)
      .sort();

  assert.deepEqual(ids('element(kind:database)'), ['shop.db']);
  assert.deepEqual(ids('tag:async'), ['shop.events']);
  assert.deepEqual(ids('element(id:shop.api)'), ['shop.api']);
  assert.deepEqual(ids('element(owner:team-shop)').includes('shop.api'), true);
  assert.deepEqual(ids('element(tech:postgres*)'), ['shop.db']);
  assert.ok(ids('element(in:shop)').includes('shop.api.handler'), '`in` is transitive');
  assert.ok(ids('element(in:shop)').includes('shop'), '`in` includes the element itself');
  // Tags are inherited, so a domain tag on a system covers its containers.
  assert.ok(ids('element(tag:domain-shop)').includes('shop.api'), 'tags inherit downwards');
  assert.equal(
    ids('element(owntag:domain-shop)').includes('shop.api'),
    false,
    'owntag matches only where the tag is declared',
  );
  assert.deepEqual(ids('element(source:services/api)'), ['shop.api']);
  assert.equal(ids('*').length, model.elements.length);

  // `kind` matches structural kind or subtype.
  assert.ok(ids('element(kind:container)').includes('shop.web'));
  assert.ok(ids('element(kind:browser)').includes('shop.web'));
});

test('malformed selectors report errors instead of matching everything', () => {
  assert.ok(parseSelector('element(nonsense:x)').errors.length > 0);
  assert.ok(parseSelector('element(tag)').errors.length > 0);
  // A selector with an unknown predicate must not silently match all.
  const result = parseSelector('element(nonsense:x)');
  assert.deepEqual(result.selector.predicates, []);
});

test('selector text is canonical, so rules diff stably', () => {
  const a = parseSelector('element(tag:b,kind:a)').selector.text;
  const b = parseSelector('element(kind:a,tag:b)').selector.text;
  assert.equal(a, b, 'predicate order must not affect the canonical form');
});

// ----------------------------------------------------------------------- rules

test('rules detect forbidden dependencies with an explanation', () => {
  const model = modelOf(`workspace "R" {
    system orders "Orders" { tag domain-order
      container svc "Svc" { technology "x" tag internal }
    }
    system pay "Pay" { tag domain-payment
      container core "Core" { technology "x" tag internal }
    }
    orders.svc -> pay.core "reaches in"
    rules {
      rule domains "No cross-domain" {
        severity error
        forbid element(tag:domain-order) -> element(tag:internal, tag:domain-payment)
      }
    }
  }`);

  const result = check(model);
  assert.equal(result.summary.errors, 1);
  const violation = result.violations[0];
  assert.ok(violation);
  assert.equal(violation.code, 'rule/forbidden-dependency');
  assert.equal(violation.ruleId, 'domains');
  assert.ok(violation.loc, 'a violation points at a source location');
  assert.match(violation.detail ?? '', /matches/, 'and explains why it matched');
});

test('allow rules act as a whitelist', () => {
  const model = modelOf(`workspace "R" {
    system s "S" {
      container web "Web" { technology "x" tag front }
      container api "API" { technology "x" kind api }
      database db "DB" { technology "x" }
    }
    s.web -> s.api "ok"
    s.web -> s.db "not ok"
    rules {
      rule only-api "Front end may only call the API" {
        severity error
        allow element(tag:front) -> element(kind:api)
      }
    }
  }`);

  const result = check(model);
  assert.equal(result.summary.errors, 1);
  assert.equal(result.violations[0]?.code, 'rule/dependency-not-allowed');
  assert.match(result.violations[0]?.message ?? '', /DB/);
});

test('require, cycles and orphans rules fire correctly', () => {
  const model = modelOf(`workspace "R" {
    system s "S" {
      container a "A" { technology "x" }
      container b "B" { }
    }
    system lonely "Lonely" { }
    s.a -> s.b "x"
    s.b -> s.a "y"
    rules {
      rule tech { severity warning  require technology on element(kind:container) }
      rule cyc { severity error  forbid cycles }
      rule orph { severity warning  forbid orphans }
    }
  }`);

  const result = check(model);
  const codes = result.violations.map((v) => v.code);
  assert.ok(codes.includes('rule/missing-field'), 'B has no technology');
  assert.ok(codes.includes('rule/dependency-cycle'), 'a<->b is a cycle');
  assert.ok(codes.includes('rule/orphan-element'), 'Lonely has no relationships');

  // A system whose containers are connected is not an orphan.
  assert.equal(
    result.violations.filter((v) => v.code === 'rule/orphan-element' && v.elementId === 's').length,
    0,
  );
});

test('rule results are deterministic and severity-ordered', () => {
  const model = modelOf(SAMPLE);
  const first = check(model, RECOMMENDED_RULES);
  const second = check(model, RECOMMENDED_RULES);
  assert.equal(canonicalJson(first.violations), canonicalJson(second.violations));

  const severities = first.violations.map((v) => v.severity);
  const rank = { error: 0, warning: 1, info: 2 } as const;
  for (let i = 1; i < severities.length; i += 1) {
    assert.ok(
      rank[severities[i - 1]!] <= rank[severities[i]!],
      'errors must come before warnings',
    );
  }
});

// ------------------------------------------------------------------------ diff

test('diff reports additions, removals and field changes', () => {
  const before = modelOf(SAMPLE);
  const after = modelOf(
    SAMPLE.replace('technology "Go"', 'technology "Rust"').replace(
      'system payments "Payments" { external  tag third-party }',
      'system payments "Payments" { external  tag third-party }\n  system extra "Extra" { }\n  shop.api -> extra "new"',
    ),
  );

  const result = diff(before, after);
  assert.equal(isEmpty(result), false);
  assert.equal(result.summary.elementsAdded, 1);
  assert.equal(result.summary.relationsAdded, 1);

  const changed = result.elements.find((change) => change.id === 'shop.api');
  assert.ok(changed);
  assert.equal(changed.type, 'changed');
  const technology = changed.fields.find((field) => field.field === 'technology');
  assert.deepEqual([technology?.before, technology?.after], ['Go', 'Rust']);
});

test('an unchanged model produces an empty diff', () => {
  const model = modelOf(SAMPLE);
  // Reformatting must not register as a change.
  const reformatted = modelOf(SAMPLE.replace(/\n/g, '\n\n'));
  assert.equal(isEmpty(diff(model, reformatted)), true);
});

test('applying a diff reproduces the target model', () => {
  const before = modelOf(SAMPLE);
  const after = modelOf(
    SAMPLE.replace('technology "React"', 'technology "Svelte"').replace(
      '  shop.api -> payments "Charges" { technology "HTTPS" }',
      '',
    ),
  );

  const result = diff(before, after);
  const applied = applyDiff(before, result, after);

  assert.equal(applied.elements.length, after.elements.length);
  assert.equal(applied.relations.length, after.relations.length);
  assert.equal(
    canonicalJson(applied.elements.map((e) => e.id)),
    canonicalJson(after.elements.map((e) => e.id).sort()),
  );
});

// --------------------------------------------------------------- layout, render

test('layout is deterministic and keeps everything on the canvas', () => {
  const model = modelOf(SAMPLE);
  for (const view of deriveAll(model)) {
    const a = layout(view, { direction: 'TB' });
    const b = layout(view, { direction: 'TB' });
    assert.equal(canonicalJson(a), canonicalJson(b), `${view.id} layout must be stable`);

    for (const box of a.nodes) {
      assert.ok(box.x >= 0 && box.y >= 0, `${box.id} must not be placed off-canvas`);
      assert.ok(box.x + box.width <= a.width, `${box.id} must fit the reported width`);
      assert.ok(box.y + box.height <= a.height, `${box.id} must fit the reported height`);
      assert.ok(box.width > 0 && box.height > 0);
    }
  }
});

test('nested elements stay inside their boundary', () => {
  const model = modelOf(SAMPLE);
  const containers = deriveAll(model).find((view) => view.id === 'containers');
  assert.ok(containers);
  const computed = layout(containers, {});
  const boxes = new Map(computed.nodes.map((box) => [box.id, box]));

  const shop = boxes.get('shop');
  assert.ok(shop);
  for (const id of ['shop.api', 'shop.web', 'shop.db', 'shop.events']) {
    const box = boxes.get(id);
    assert.ok(box, `${id} should be laid out`);
    assert.ok(box.x >= shop.x, `${id} left edge inside the boundary`);
    assert.ok(box.y >= shop.y, `${id} top edge inside the boundary`);
    assert.ok(box.x + box.width <= shop.x + shop.width, `${id} right edge inside`);
    assert.ok(box.y + box.height <= shop.y + shop.height, `${id} bottom edge inside`);
  }
});

test('a pinned top-level element lands exactly where it was put', () => {
  const model = modelOf(SAMPLE);
  const landscape = deriveAll(model).find((view) => view.id === 'landscape')!;
  const base = layout(landscape, {});
  const before = base.nodes.find((box) => box.id === 'customer')!;

  const pinned = layout(landscape, { overrides: { customer: { x: 640, y: 480 } } });
  const after = pinned.nodes.find((box) => box.id === 'customer')!;

  assert.equal(after.x, 640);
  assert.equal(after.y, 480);
  assert.equal(after.pinned, true);
  assert.notEqual(before.x, after.x);
});

test('a pin cannot drag a child out of its parent boundary', () => {
  // Pins are numbers in a file: stale, hand-edited, or from a drag that went
  // too far. None of those may draw a container outside the system that owns
  // it, so containment is enforced at layout time rather than trusted.
  const model = modelOf(SAMPLE);
  const containers = deriveAll(model).find((view) => view.id === 'containers')!;

  const pinned = layout(containers, { overrides: { 'shop.api': { x: 9000, y: 9000 } } });
  const api = pinned.nodes.find((box) => box.id === 'shop.api')!;
  const shop = pinned.nodes.find((box) => box.id === 'shop')!;

  assert.ok(api.x >= shop.x, 'clamped inside the left edge');
  assert.ok(api.y >= shop.y, 'clamped inside the top edge');
  assert.ok(api.x + api.width <= shop.x + shop.width, 'clamped inside the right edge');
  assert.ok(api.y + api.height <= shop.y + shop.height, 'clamped inside the bottom edge');

  // A modest pin within the boundary is still respected.
  const gentle = layout(containers, {
    overrides: { 'shop.api': { x: shop.x + 40, y: shop.y + 60 } },
  });
  const moved = gentle.nodes.find((box) => box.id === 'shop.api')!;
  assert.equal(moved.x, shop.x + 40);
  assert.equal(moved.y, shop.y + 60);
});

test('pinning a boundary carries its children', () => {
  const model = modelOf(SAMPLE);
  const containers = deriveAll(model).find((view) => view.id === 'containers')!;
  const base = layout(containers, {});
  const shopBefore = base.nodes.find((box) => box.id === 'shop')!;
  const apiBefore = base.nodes.find((box) => box.id === 'shop.api')!;
  const offset = { x: shopBefore.x + 120, y: shopBefore.y + 90 };

  const pinned = layout(containers, { overrides: { shop: offset } });
  const shopAfter = pinned.nodes.find((box) => box.id === 'shop')!;
  const apiAfter = pinned.nodes.find((box) => box.id === 'shop.api')!;

  assert.equal(shopAfter.x, offset.x);
  assert.equal(
    apiAfter.x - shopAfter.x,
    apiBefore.x - shopBefore.x,
    'the child keeps its position relative to the boundary',
  );
  assert.equal(apiAfter.y - shopAfter.y, apiBefore.y - shopBefore.y);
});

test('rendering is byte-identical for the same input', () => {
  const model = modelOf(SAMPLE);
  for (const view of deriveAll(model)) {
    const computed = layout(view, {});
    const first = renderSvg(view, computed, { theme: 'light', workspaceName: 'Shop' });
    const second = renderSvg(view, computed, { theme: 'light', workspaceName: 'Shop' });
    assert.equal(first, second, `${view.id} must render identically`);
  }
});

test('rendered SVG is well formed and free of non-determinism', () => {
  const model = modelOf(SAMPLE);
  const view = deriveAll(model).find((candidate) => candidate.id === 'containers')!;
  const svg = renderSvg(view, layout(view, {}), { theme: 'auto' });

  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /<\/svg>\n$/);
  // Nested <svg> elements are used for icons, so just check the tags balance.
  assert.equal(
    (svg.match(/<svg[\s>]/g) ?? []).length,
    (svg.match(/<\/svg>/g) ?? []).length,
    'svg tags must balance',
  );
  assert.equal(svg.includes('NaN'), false, 'no NaN geometry');
  assert.equal(svg.includes('undefined'), false, 'no undefined interpolations');
  assert.equal(/\d{13}/.test(svg), false, 'no timestamps');

  // Every element is addressable for the editor.
  for (const node of view.nodes) {
    assert.ok(svg.includes(`data-arch-id="${node.element.id}"`), `${node.element.id} addressable`);
  }
});

test('exports are produced for every view and are self-contained', () => {
  const model = modelOf(SAMPLE);
  for (const view of deriveAll(model)) {
    const puml = toPlantUml(model, view, {});
    assert.match(puml, /^@startuml/m);
    assert.match(puml, /@enduml\n$/);
    assert.equal(
      /^!include/m.test(puml),
      false,
      'standalone output must not depend on an external macro library',
    );

    const mermaid = toMermaid(view, {});
    assert.ok(mermaid.length > 0);
    assert.ok(
      mermaid.startsWith('%%') || mermaid.includes('flowchart') || mermaid.includes('sequenceDiagram'),
    );
  }
});

test('PlantUML C4 mode refuses to invent an include location', () => {
  const model = modelOf(SAMPLE);
  const view = deriveAll(model)[0]!;
  assert.throws(() => toPlantUml(model, view, { style: 'c4' }), /includeBase/);
  const ok = toPlantUml(model, view, { style: 'c4', includeBase: 'assets/plantuml' });
  assert.match(ok, /!include assets\/plantuml\//);
});

test('documentation is generated from the model', () => {
  const model = modelOf(SAMPLE);
  const markdown = documentWorkspace(model, deriveAll(model), {});
  assert.match(markdown, /^# Shop/m);
  assert.match(markdown, /Technology inventory/);
  assert.match(markdown, /PostgreSQL 16/);
  assert.match(markdown, /team-shop/);
});

// ------------------------------------------------------------------ emit + layout store

test('emit produces source that compiles to the same model', () => {
  const model = modelOf(SAMPLE);
  const emitted = emitWorkspace(model);
  const round = modelOf(emitted);

  assert.equal(round.elements.length, model.elements.length);
  assert.equal(round.relations.length, model.relations.length);
  assert.equal(round.views.length, model.views.length);
  assert.equal(round.rules.length, model.rules.length);

  // Element identity and key fields survive the round trip.
  for (const element of model.elements) {
    const other = round.element(element.id);
    assert.ok(other, `${element.id} survives emit`);
    assert.equal(other.name, element.name);
    assert.equal(other.technology, element.technology);
    assert.equal(other.subtype, element.subtype);
  }
});

test('emit is stable: emitting twice gives identical text', () => {
  const model = modelOf(SAMPLE);
  const once = emitWorkspace(model);
  const twice = emitWorkspace(modelOf(once));
  assert.equal(once, twice);
});

test('layout files prune stale entries and keep the rest', () => {
  const model = modelOf(SAMPLE);
  const view = deriveAll(model).find((candidate) => candidate.id === 'containers')!;
  const file = parseLayout(
    JSON.stringify({
      view: 'containers',
      positions: { 'shop.api': { x: 10, y: 20 }, 'gone.away': { x: 1, y: 2 } },
    }),
    'containers',
  );

  const result = pruneLayout(file, view);
  assert.deepEqual(result.removed, ['gone.away']);
  assert.deepEqual(result.layout.positions['shop.api'], { x: 10, y: 20 });
  // Serialisation is canonical.
  assert.equal(serializeLayout(result.layout), serializeLayout(result.layout));
  assert.match(serializeLayout(result.layout), /\n$/);
});

// --------------------------------------------------------------------- palette

test('the palette is searchable and well formed', () => {
  assert.ok(PALETTE.length > 80, 'the palette should be substantial');

  const ids = PALETTE.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, 'palette ids must be unique');

  for (const entry of PALETTE) {
    assert.ok(entry.label.length > 0);
    assert.ok(entry.keyword.length > 0);
    assert.ok(entry.group.length > 0);
  }

  assert.equal(searchPalette('postgres')[0]?.id, 'postgres');
  assert.equal(searchPalette('PostgreSQL')[0]?.id, 'postgres');
  assert.ok(searchPalette('kafka').some((entry) => entry.id === 'kafka'));
  assert.ok(searchPalette('serverless').some((entry) => entry.id === 'lambda'), 'hidden terms work');
  assert.equal(searchPalette('zzzznope').length, 0);

  // Grouping keeps every entry and drops nothing.
  const grouped = paletteByGroup();
  const total = grouped.reduce((sum, section) => sum + section.entries.length, 0);
  assert.equal(total, PALETTE.length);
});

test('every palette entry produces a compiling declaration', () => {
  // A palette entry that cannot be placed anywhere is a broken button.
  for (const entry of PALETTE) {
    const host =
      entry.keyword === 'person' || entry.keyword === 'system'
        ? `workspace "T" {\n  ${entry.keyword} e1 "${entry.label}" {${
            entry.technology ? `\n technology "${entry.technology}"\n` : ''
          }}\n}`
        : entry.keyword === 'component'
          ? `workspace "T" {\n system s "S" { container c "C" { technology "x"\n  component e1 "${entry.label}" {}\n } }\n}`
          : entry.keyword === 'deploymentNode' || entry.keyword === 'infrastructureNode'
            ? `workspace "T" {\n deploymentNode n "N" {\n  ${entry.keyword} e1 "${entry.label}" {}\n }\n}`
            : `workspace "T" {\n system s "S" {\n  ${entry.keyword} e1 "${entry.label}" {${
                entry.technology ? `\n technology "${entry.technology}"\n` : ''
              }}\n }\n}`;

    const result = compile(host, 'palette.arch');
    assert.equal(
      hasErrors(result.diagnostics),
      false,
      `palette entry \`${entry.id}\` (${entry.keyword}) should compile: ${result.diagnostics
        .map((d) => d.message)
        .join('; ')}`,
    );
  }
});

// ------------------------------------------------------------------------ text

test('text measurement and wrapping behave sensibly', () => {
  assert.ok(measureText('mmmm', 14) > measureText('iiii', 14), 'wide glyphs measure wider');
  assert.equal(measureText('', 14), 0);

  const lines = wrapText('the quick brown fox jumps over the lazy dog', 12, 80);
  assert.ok(lines.length > 1, 'long text wraps');
  for (const line of lines) {
    assert.ok(measureText(line, 12) <= 80 + 0.01, `"${line}" fits the width`);
  }

  // A single unbreakable token is split rather than allowed to overflow.
  const long = wrapText('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 12, 40);
  assert.ok(long.length > 1);
  assert.equal(wrapText('   ', 12, 100).length, 0);
});

test('canonical JSON sorts keys and ends with a newline', () => {
  const json = canonicalJson({ b: 1, a: { d: 2, c: 3 } });
  assert.equal(json, '{\n  "a": {\n    "c": 3,\n    "d": 2\n  },\n  "b": 1\n}\n');
  assert.equal(canonicalJson({ x: undefined, y: 1 }), '{\n  "y": 1\n}\n');
});
