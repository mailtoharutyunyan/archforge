/**
 * Tests for source-level structural edits.
 *
 * These matter more than most: the editor rewrites a user's file on every
 * canvas action, so a bug here corrupts real work. Two properties are checked
 * throughout — the edit does what it says, and the result still compiles.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compile } from '../packages/core/src/dsl/compile.ts';
import { ArchModel } from '../packages/core/src/model/model.ts';
import { hasErrors } from '../packages/core/src/diagnostics.ts';
import {
  addElement,
  addRelationship,
  addTag,
  proposeLocalId,
  removeElement,
  removeRelationship,
  setElementProperty,
} from '../packages/core/src/dsl/edit.ts';

/** Compiles text and fails the test with readable diagnostics if it breaks. */
function modelOf(text: string): ArchModel {
  const result = compile(text, 'test.arch');
  if (hasErrors(result.diagnostics)) {
    const detail = result.diagnostics
      .map((d) => `${d.loc?.line}:${d.loc?.column} ${d.code} ${d.message}`)
      .join('\n');
    assert.fail(`source does not compile:\n${detail}\n---\n${text}`);
  }
  return new ArchModel(result.workspace);
}

const BASE = `workspace "Test" {

  // A comment that must survive every edit.
  person customer "Customer" {
    description "Buys things."
  }

  system platform "Platform" {
    owner "team-a"

    container api "API" {
      technology "Go"
    }

    database db "Database" {
      technology "PostgreSQL"
    }
  }

  customer -> platform.api "Uses"
  platform.api -> platform.db "Reads"

  views {
    container containers "Containers" of platform
  }
}
`;

test('addElement nests inside a parent and keeps the file compiling', () => {
  const model = modelOf(BASE);
  const result = addElement(BASE, model, {
    keyword: 'container',
    name: 'Worker',
    parentId: 'platform',
    technology: 'Rust',
  });

  assert.equal(result.changed, true);
  const next = modelOf(result.text);
  const worker = next.element('platform.worker');
  assert.ok(worker, 'the new container should exist at platform.worker');
  assert.equal(worker.name, 'Worker');
  assert.equal(worker.technology, 'Rust');
  assert.equal(worker.kind, 'container');
  assert.equal(worker.parentId, 'platform');
});

test('edits preserve comments and unrelated formatting', () => {
  const model = modelOf(BASE);
  const result = addElement(BASE, model, {
    keyword: 'container',
    name: 'Worker',
    parentId: 'platform',
  });

  assert.ok(
    result.text.includes('// A comment that must survive every edit.'),
    'comments must not be destroyed by a structural edit',
  );
  // Everything before the insertion point should be untouched, byte for byte.
  const marker = BASE.indexOf('  system platform');
  assert.equal(result.text.slice(0, marker), BASE.slice(0, marker));
});

test('addElement at the top level lands before the views block', () => {
  const model = modelOf(BASE);
  const result = addElement(BASE, model, { keyword: 'system', name: 'Billing' });
  const next = modelOf(result.text);

  assert.ok(next.element('billing'), 'the new system should exist');
  assert.ok(
    result.text.indexOf('system billing') < result.text.indexOf('views {'),
    'declarations belong above the views block',
  );
});

test('addRelationship connects two elements', () => {
  const model = modelOf(BASE);
  const result = addRelationship(BASE, model, {
    sourceId: 'customer',
    destId: 'platform.db',
    description: 'Reads directly',
    technology: 'SQL',
  });

  const next = modelOf(result.text);
  const relation = next.relations.find(
    (r) => r.sourceId === 'customer' && r.destId === 'platform.db',
  );
  assert.ok(relation, 'the relationship should exist');
  assert.equal(relation.description, 'Reads directly');
  assert.equal(relation.technology, 'SQL');
});

test('addRelationship refuses duplicates, self-links and unknown ends', () => {
  const model = modelOf(BASE);

  const duplicate = addRelationship(BASE, model, {
    sourceId: 'customer',
    destId: 'platform.api',
  });
  assert.equal(duplicate.changed, false);
  assert.equal(duplicate.text, BASE);

  const self = addRelationship(BASE, model, { sourceId: 'customer', destId: 'customer' });
  assert.equal(self.changed, false);

  const missing = addRelationship(BASE, model, { sourceId: 'customer', destId: 'nope' });
  assert.equal(missing.changed, false);
});

test('setElementProperty replaces an existing property in place', () => {
  const model = modelOf(BASE);
  const result = setElementProperty(BASE, model, 'platform.api', 'technology', 'Java 21');

  const next = modelOf(result.text);
  assert.equal(next.requireElement('platform.api').technology, 'Java 21');
  // It must replace, not duplicate.
  assert.equal(result.text.match(/technology "Java 21"/g)?.length, 1);
  assert.equal(result.text.includes('technology "Go"'), false);
});

test('setElementProperty adds a property that was not there', () => {
  const model = modelOf(BASE);
  const result = setElementProperty(BASE, model, 'platform.api', 'owner', 'team-b');
  const next = modelOf(result.text);
  assert.equal(next.requireElement('platform.api').owner, 'team-b');
});

test('setElementProperty targets the right element, not a nested namesake', () => {
  // `platform` and `platform.api` both have a `technology`-shaped body; setting
  // it on the parent must not touch the child's line.
  const model = modelOf(BASE);
  const result = setElementProperty(BASE, model, 'platform', 'technology', 'Mixed');
  const next = modelOf(result.text);

  assert.equal(next.requireElement('platform').technology, 'Mixed');
  assert.equal(
    next.requireElement('platform.api').technology,
    'Go',
    "the child's technology must be untouched",
  );
});

test('setElementProperty removes a property when given undefined', () => {
  const model = modelOf(BASE);
  const result = setElementProperty(BASE, model, 'platform.api', 'technology', undefined);
  const next = modelOf(result.text);
  assert.equal(next.requireElement('platform.api').technology, undefined);
});

test('setElementProperty gives a bodyless declaration a body', () => {
  const source = `workspace "T" {
  person p "Person"
  system s "S" {
    container c "C" { technology "Go" }
  }
  p -> s.c "Uses"
}
`;
  const model = modelOf(source);
  const result = setElementProperty(source, model, 'p', 'description', 'A person');
  const next = modelOf(result.text);
  assert.equal(next.requireElement('p').description, 'A person');
});

test('renaming rewrites the header string only', () => {
  const model = modelOf(BASE);
  const result = setElementProperty(BASE, model, 'platform.api', 'name', 'Public API');
  const next = modelOf(result.text);

  assert.equal(next.requireElement('platform.api').name, 'Public API');
  // The identifier, and therefore every reference to it, must be unchanged.
  assert.ok(next.element('platform.api'), 'the id must not change when renaming');
  assert.equal(next.relations.some((r) => r.destId === 'platform.api'), true);
});

test('removeElement also removes relationships that referenced it', () => {
  const model = modelOf(BASE);
  const result = removeElement(BASE, model, 'platform.db');

  // Must still compile: a dangling reference would be a compile error.
  const next = modelOf(result.text);
  assert.equal(next.element('platform.db'), undefined);
  assert.equal(
    next.relations.some((r) => r.destId === 'platform.db'),
    false,
    'relationships pointing at a removed element must go with it',
  );
  assert.ok(next.element('platform.api'), 'siblings must survive');
});

test('removeElement removes descendants and their relationships', () => {
  const model = modelOf(BASE);
  const result = removeElement(BASE, model, 'platform');
  const next = modelOf(result.text);

  assert.equal(next.element('platform'), undefined);
  assert.equal(next.element('platform.api'), undefined);
  assert.equal(next.element('platform.db'), undefined);
  assert.equal(next.relations.length, 0);
  assert.ok(next.element('customer'), 'unrelated elements must survive');
});

test('removeRelationship removes only that relationship', () => {
  const model = modelOf(BASE);
  const target = model.relations.find((r) => r.destId === 'platform.db');
  assert.ok(target);

  const result = removeRelationship(BASE, model, target.id);
  const next = modelOf(result.text);
  assert.equal(next.relations.length, model.relations.length - 1);
  assert.equal(next.relations.some((r) => r.destId === 'platform.db'), false);
});

test('addTag merges into an existing tag line', () => {
  const source = `workspace "T" {
  system s "S" {
    container c "C" {
      technology "Go"
      tag internal
    }
  }
  s.c -> s.c2 "x"
  container c2 "C2" { technology "Go" }
}
`;
  // Deliberately malformed reference above would not compile, so use a clean one.
  const clean = `workspace "T" {
  system s "S" {
    container c "C" {
      technology "Go"
      tag internal
    }
    container c2 "C2" { technology "Go" }
  }
  s.c -> s.c2 "x"
}
`;
  void source;
  const model = modelOf(clean);
  const result = addTag(clean, model, 's.c', 'critical');
  const next = modelOf(result.text);

  assert.deepEqual(next.requireElement('s.c').tags, ['critical', 'internal']);
});

test('braces inside strings do not confuse block detection', () => {
  const tricky = `workspace "T" {
  system s "S" {
    description "a { brace } inside a string"
    container c "C" {
      // a } in a comment
      technology "Go"
    }
  }
}
`;
  const model = modelOf(tricky);
  const result = addElement(tricky, model, {
    keyword: 'container',
    name: 'Second',
    parentId: 's',
  });
  const next = modelOf(result.text);

  assert.ok(next.element('s.second'), 'the new container should be inside the system');
  assert.equal(next.requireElement('s.second').parentId, 's');
  assert.equal(
    next.requireElement('s').description,
    'a { brace } inside a string',
    'the string must be untouched',
  );
});

test('proposeLocalId avoids collisions', () => {
  const model = modelOf(BASE);
  assert.equal(proposeLocalId(model, 'Payment Worker', 'platform'), 'paymentWorker');
  assert.equal(proposeLocalId(model, 'API', 'platform'), 'api2');
  assert.equal(proposeLocalId(model, 'Customer', undefined), 'customer2');
});

test('a sequence of edits keeps the model valid at every step', () => {
  let text = BASE;
  const apply = (fn: (m: ArchModel) => { text: string; changed: boolean }): void => {
    const model = modelOf(text);
    const result = fn(model);
    assert.equal(result.changed, true);
    text = result.text;
    modelOf(text); // must still compile
  };

  apply((m) => addElement(text, m, { keyword: 'container', name: 'Worker', parentId: 'platform' }));
  apply((m) => setElementProperty(text, m, 'platform.worker', 'technology', 'Kotlin'));
  apply((m) => addRelationship(text, m, { sourceId: 'platform.worker', destId: 'platform.db' }));
  apply((m) => addTag(text, m, 'platform.worker', 'async'));
  apply((m) => setElementProperty(text, m, 'platform.worker', 'name', 'Background Worker'));
  apply((m) => removeElement(text, m, 'platform.worker'));

  const final = modelOf(text);
  assert.equal(final.element('platform.worker'), undefined);
  assert.ok(final.element('platform.api'), 'the rest of the model survived');
  assert.ok(text.includes('// A comment that must survive every edit.'));
});
