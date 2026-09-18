/**
 * Tests for identifier renaming.
 *
 * Renaming touches the declaration plus every reference — relationships, view
 * scopes, dynamic steps, `instanceOf`. The implementation verifies its own
 * result by recompiling, so these tests check both halves: that a legitimate
 * rename updates everything, and that a rename which would damage the model is
 * refused outright rather than applied.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compile } from '../packages/core/src/dsl/compile.ts';
import { ArchModel } from '../packages/core/src/model/model.ts';
import { hasErrors } from '../packages/core/src/diagnostics.ts';
import { renameIdentifier } from '../packages/core/src/dsl/edit.ts';

function modelOf(text: string): ArchModel {
  const result = compile(text, 'test.arch');
  if (hasErrors(result.diagnostics)) {
    assert.fail(
      `source does not compile:\n${result.diagnostics
        .map((d) => `${d.loc?.line}:${d.loc?.column} ${d.message}`)
        .join('\n')}\n---\n${text}`,
    );
  }
  return new ArchModel(result.workspace);
}

const SOURCE = `workspace "Test" {

  person customer "Customer"

  system platform "Platform" {
    container api "API" {
      technology "Go"
      description "The api handles requests."
    }
    database db "Database" {
      technology "PostgreSQL"
    }
  }

  deploymentNode aws "AWS" {
    deploymentNode pod "api-pod" {
      instanceOf platform.api
    }
  }

  customer -> platform.api "Uses"
  platform.api -> platform.db "Reads"

  views {
    container containers "Containers" of platform
    component apiParts "API parts" of platform.api
    dynamic flow "A request" {
      customer -> platform.api "Calls"
      platform.api -> platform.db "Queries"
    }
  }

  rules {
    rule r "No cycles" { severity error  forbid cycles }
  }
}
`;

test('renaming an identifier updates every reference', () => {
  const model = modelOf(SOURCE);
  const result = renameIdentifier(SOURCE, model, 'platform.api', 'paymentApi');

  assert.equal(result.changed, true, result.note);
  const next = modelOf(result.text);

  assert.ok(next.element('platform.paymentApi'), 'the renamed element should exist');
  assert.equal(next.element('platform.api'), undefined, 'the old id should be gone');

  // Relationships followed the rename.
  assert.ok(
    next.relations.some((r) => r.destId === 'platform.paymentApi' && r.sourceId === 'customer'),
    'inbound relationship should point at the new id',
  );
  assert.ok(
    next.relations.some((r) => r.sourceId === 'platform.paymentApi' && r.destId === 'platform.db'),
    'outbound relationship should come from the new id',
  );

  // View scope, dynamic steps and instanceOf followed the rename.
  const componentView = next.views.find((view) => view.id === 'apiParts');
  assert.equal(componentView?.scopeId, 'platform.paymentApi');

  const dynamic = next.views.find((view) => view.id === 'flow');
  assert.ok(dynamic);
  assert.equal(dynamic.steps[0]?.destId, 'platform.paymentApi');
  assert.equal(dynamic.steps[1]?.sourceId, 'platform.paymentApi');

  assert.equal(next.requireElement('aws.pod').instanceOf, 'platform.paymentApi');

  // Counts unchanged: nothing lost, nothing duplicated.
  assert.equal(next.elements.length, model.elements.length);
  assert.equal(next.relations.length, model.relations.length);
});

test('renaming does not touch matching words inside strings', () => {
  const model = modelOf(SOURCE);
  const result = renameIdentifier(SOURCE, model, 'platform.api', 'paymentApi');
  const next = modelOf(result.text);

  assert.equal(
    next.requireElement('platform.paymentApi').description,
    'The api handles requests.',
    'prose that happens to contain the identifier must be left alone',
  );
});

test('renaming preserves the display name', () => {
  const model = modelOf(SOURCE);
  const result = renameIdentifier(SOURCE, model, 'platform.api', 'paymentApi');
  const next = modelOf(result.text);
  assert.equal(next.requireElement('platform.paymentApi').name, 'API');
});

test('renaming a top-level element works', () => {
  const model = modelOf(SOURCE);
  const result = renameIdentifier(SOURCE, model, 'customer', 'shopper');
  assert.equal(result.changed, true, result.note);

  const next = modelOf(result.text);
  assert.ok(next.element('shopper'));
  assert.equal(next.element('customer'), undefined);
  assert.ok(next.relations.some((r) => r.sourceId === 'shopper'));
  assert.equal(next.relations.length, model.relations.length);
});

test('renaming rejects invalid, empty and duplicate identifiers', () => {
  const model = modelOf(SOURCE);

  for (const bad of ['', '  ', '9lives', 'has space', 'dotted.name']) {
    const result = renameIdentifier(SOURCE, model, 'platform.api', bad);
    assert.equal(result.changed, false, `\`${bad}\` should be rejected`);
    assert.equal(result.text, SOURCE);
  }

  const duplicate = renameIdentifier(SOURCE, model, 'platform.api', 'db');
  assert.equal(duplicate.changed, false, 'a taken identifier should be rejected');
  assert.equal(duplicate.text, SOURCE);
});

test('renaming to the same identifier is a no-op', () => {
  const model = modelOf(SOURCE);
  const result = renameIdentifier(SOURCE, model, 'platform.api', 'api');
  assert.equal(result.changed, false);
});

test('an ambiguous bare identifier is still renamed correctly', () => {
  // Two systems each contain a child called `api`; renaming one must not
  // disturb the other. The full-path rewrite handles this; the bare-name
  // shortcut must not fire.
  const source = `workspace "T" {
  system a "A" {
    container api "A API" { technology "Go" }
  }
  system b "B" {
    container api "B API" { technology "Go" }
  }
  a.api -> b.api "Calls"
}
`;
  const model = modelOf(source);
  const result = renameIdentifier(source, model, 'a.api', 'aApi');
  assert.equal(result.changed, true, result.note);

  const next = modelOf(result.text);
  assert.ok(next.element('a.aApi'), 'the target was renamed');
  assert.ok(next.element('b.api'), 'the namesake in the other system was left alone');
  assert.equal(next.requireElement('b.api').name, 'B API');
  assert.ok(next.relations.some((r) => r.sourceId === 'a.aApi' && r.destId === 'b.api'));
  assert.equal(next.relations.length, 1);
});

test('renaming is refused rather than applied when it would break the model', () => {
  // `platform` is referenced by qualified paths everywhere. Renaming it to a
  // name that collides with a child identifier would be caught by the taken
  // check; here we assert the general safety property instead: whatever the
  // outcome, the text is either valid or untouched.
  const model = modelOf(SOURCE);
  const result = renameIdentifier(SOURCE, model, 'platform', 'estate');

  if (result.changed) {
    const next = modelOf(result.text);
    assert.ok(next.element('estate'));
    assert.ok(next.element('estate.api'), 'children move with the parent path');
    assert.equal(next.relations.length, model.relations.length);
    assert.equal(next.views.length, model.views.length);
  } else {
    assert.equal(result.text, SOURCE, 'a refused rename must leave the source untouched');
  }
});

test('renaming an unknown element is refused', () => {
  const model = modelOf(SOURCE);
  const result = renameIdentifier(SOURCE, model, 'does.not.exist', 'whatever');
  assert.equal(result.changed, false);
  assert.equal(result.text, SOURCE);
});
