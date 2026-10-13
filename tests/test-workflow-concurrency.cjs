'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { before, test } = require('node:test');
const { parse } = require('yaml');

const workflow = parse(fs.readFileSync(path.resolve(__dirname, '../.github/workflows/validate.yml'), 'utf8'));
let expressions;
before(async () => { expressions = await import('@actions/expressions'); });

function context(runId, overrides = {}) {
  return {
    workflow: workflow.name, event_name: 'push', ref: 'refs/heads/main',
    run_id: String(runId), run_attempt: '1', sha: 'a'.repeat(40), ...overrides
  };
}

function evaluate(source, github) {
  const { Lexer, Parser, Evaluator, data } = expressions;
  source = source.replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/, '$1');
  const tokens = new Lexer(source).lex().tokens;
  const expression = new Parser(tokens, ['github'], []).parse();
  const values = Object.entries(github).map(([key, value]) => ({ key, value: new data.StringData(value) }));
  return new Evaluator(expression, new data.Dictionary({
    key: 'github', value: new data.Dictionary(...values)
  })).evaluate();
}

function policy(configuration, github) {
  const cancel = configuration['cancel-in-progress'] ?? false;
  return {
    group: configuration.group.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, source) => evaluate(source, github).coerceString()),
    cancel: typeof cancel === 'boolean' ? cancel : evaluate(cancel, github).value,
    queue: configuration.queue ?? 'single'
  };
}

test('rerunning an older main build cannot cancel a newer main validation or publication', () => {
  const newer = context(202, { sha: 'b'.repeat(40) });
  const olderRerun = context(201, { run_attempt: '2' });
  const active = policy(workflow.concurrency, newer);
  const rerun = policy(workflow.concurrency, olderRerun);
  assert.notEqual(rerun.group, active.group, 'older and newer main runs must not compete at workflow level');
  assert.equal(rerun.cancel, false);
  assert.equal(active.cancel, false);
});

test('a new main push cannot interrupt a publication already running', () => {
  const active = policy(workflow.concurrency, context(201));
  const incoming = policy(workflow.concurrency, context(202, { sha: 'b'.repeat(40) }));
  assert.notEqual(incoming.group, active.group);
  assert.equal(incoming.cancel, false);
});

test('new validation still supersedes an older run of the same pull request', () => {
  const pr = { event_name: 'pull_request', ref: 'refs/pull/12/merge' };
  const active = policy(workflow.concurrency, context(301, pr));
  const incoming = policy(workflow.concurrency, context(302, { ...pr, sha: 'b'.repeat(40) }));
  assert.equal(incoming.group, active.group);
  assert.equal(incoming.cancel, true);
});

test('different pull requests cannot cancel each other', () => {
  const first = policy(workflow.concurrency, context(301, { event_name: 'pull_request', ref: 'refs/pull/12/merge' }));
  const second = policy(workflow.concurrency, context(302, { event_name: 'pull_request', ref: 'refs/pull/13/merge' }));
  assert.notEqual(second.group, first.group);
});

test('marketplace publication serializes runs without replacing an already pending newer build', () => {
  const configuration = workflow.jobs['publish-marketplace'].concurrency;
  const newer = context(202, { sha: 'b'.repeat(40) });
  const olderRerun = context(201, { run_attempt: '2' });
  const active = policy(configuration, context(200));
  const waiting = policy(configuration, newer);
  const incoming = policy(configuration, olderRerun);
  assert.equal(incoming.group, waiting.group);
  assert.equal(waiting.group, active.group);
  assert.equal(incoming.cancel, false, 'a rerun must not cancel the running publisher');
  // GitHub's default single pending slot replaces its previous occupant even
  // with cancel-in-progress: false. The max queue preserves that waiting run.
  assert.equal(incoming.queue, 'max', 'a rerun must not evict the newer pending publisher');
  assert.notEqual(waiting.group, policy(workflow.concurrency, newer).group, 'job and workflow locks must be distinct');
});

test('publication still depends on validation and is restricted to main pushes', () => {
  const publish = workflow.jobs['publish-marketplace'];
  assert.deepEqual([...publish.needs].sort(), ['validate', 'verify-distribution']);
  assert.equal(evaluate(publish.if, context(201)).value, true);
  assert.equal(evaluate(publish.if, context(301, { event_name: 'pull_request', ref: 'refs/pull/12/merge' })).value, false);
  assert.equal(evaluate(publish.if, context(201, { ref: 'refs/heads/codex/marketplace' })).value, false);
});
