import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { openManager } from './manager.mjs';

async function fixture(t, env = {}, now = Date.now) {
  const dataDir = await mkdtemp(join(tmpdir(), 'orca-evolve-'));
  let manager = await openManager({ dataDir, env, now });
  t.after(async () => { await manager.close(); await rm(dataDir, { recursive: true, force: true }); });
  await manager.create({ id: 'writer', name: 'Text helper', instructions: 'Leave ordinary messages alone.' });
  await manager.create({ id: 'other', name: 'Control' });
  return { get manager() { return manager; }, async restart(afterClose) {
    await manager.close(); afterClose?.(); manager = await openManager({ dataDir, env, now }); return manager;
  } };
}
async function waitFor(read, done) {
  const deadline = Date.now() + 15000;
  for (;;) {
    const result = await read();
    if (done(result)) return result;
    if (Date.now() >= deadline) assert.fail('Timed out: ' + JSON.stringify(result));
    await delay(25);
  }
}
function finished(manager) {
  return waitFor(() => manager.evolution.get({ id: 'writer' }), state => state.job?.status !== 'running');
}
async function answer(manager, id, text, requestId) {
  await manager.send({ id, requestId, text });
  const turn = await waitFor(() => manager.turn({ id, requestId }), turn => turn.status !== 'pending');
  assert.equal(turn.status, 'done', JSON.stringify(turn)); return turn.text;
}

const request = { id: 'writer', requestId: 'add-words', requirement: 'Add a /words command that counts words.',
  acceptance: [{ input: '/words one two three', expected: '3' }] };

test('an independent author develops, tests and promotes a per-agent script and rolls it back durably', async t => {
  const db = await fixture(t);
  let m = db.manager;
  assert.equal(await answer(m, 'writer', '/words one two three', 'before'), 'Demo echo: /words one two three');
  const admitted = await m.evolution.propose(request);
  assert.equal(admitted.job.status, 'running');
  const checked = await finished(m);
  assert.ok(checked.proposal, JSON.stringify(checked.job));
  assert.equal(checked.revision, 1);
  assert.notEqual(checked.proposal.source, checked.source);
  assert.deepEqual(checked.proposal.checks.find(c => c.input === request.acceptance[0].input), request.acceptance[0]);
  assert.equal(await answer(m, 'writer', '/words one two three', 'draft'), 'Demo echo: /words one two three');
  const reAdmitted = await m.evolution.propose(request);
  assert.equal(reAdmitted.proposal.requestId, request.requestId);
  await assert.rejects(m.evolution.propose({ ...request, requirement: 'A different change' }), { statusCode: 409 });
  const apply = { id: 'writer', requestId: request.requestId, baseRevision: 1 };
  const [applied, retried] = await Promise.all([m.evolution.apply(apply), m.evolution.apply(apply)]);
  assert.equal(applied.revision, 2);
  assert.deepEqual(applied, retried);
  assert.equal(await answer(m, 'writer', '/words check these four words', 'after'), '4');
  assert.equal(await answer(m, 'other', '/words check these four words', 'after'), 'Demo echo: /words check these four words');
  m = await db.restart();
  assert.equal((await m.evolution.get({ id: 'writer' })).source, checked.proposal.source);
  assert.equal(await answer(m, 'writer', '/words still works', 'restarted'), '2');
  assert.equal(await answer(m, 'writer', 'ordinary chat', 'ordinary'), 'Demo echo: ordinary chat');
  assert.equal((await m.chat({ id: 'writer' })).messages.filter(msg => msg.role === 'user').length, 5);
  const undo = { id: 'writer', revision: 2 };
  const restored = await m.evolution.rollback(undo);
  assert.equal(restored.source, checked.source);
  assert.equal(restored.revision, 3);
  assert.deepEqual(await m.evolution.rollback(undo), restored);
  await assert.rejects(m.evolution.apply(apply), { statusCode: 409 });
  assert.equal(await answer(m, 'writer', '/words still works', 'undo'), 'Demo echo: /words still works');
  assert.equal(await answer(m, 'writer', '/words check these four words', 'after'), '4');
});

test('a failed acceptance example and an unsupported offline requirement preserve the active script', async t => {
  const { manager } = await fixture(t);
  const before = await manager.evolution.get({ id: 'writer' });
  for (const change of [
    { ...request, acceptance: [{input:'/words red green',expected:'999'}] },
    { ...request, requestId: 'unsupported', requirement: 'Configure a third-party payroll integration.' },
  ]) {
    await manager.evolution.propose(change);
    const state = await finished(manager);
    assert.equal(state.job.status, 'failed');
    assert.ok(state.job.error);
    assert.equal(state.proposal, null);
    assert.equal(state.source, before.source);
    assert.equal(state.revision, before.revision);
  }
  assert.equal((await manager.chat({ id: 'writer' })).messages.length, 0);
  assert.equal((await manager.list()).length, 2);
});

test('reopening the service resumes an admitted evolution without changing its request or the target conversation', async t => {
  const db = await fixture(t);
  await db.manager.evolution.propose(request);
  const manager = await db.restart();
  const state = await finished(manager);
  assert.equal(state.proposal?.requestId, request.requestId, state.job?.error);
  assert.equal(state.job, null);
  assert.equal(state.revision, 1);
});

test('a hung evolution expires, aborts its private model request and releases the target', { timeout: 15000 }, async t => {
  let advance = 0;
  const started = Promise.withResolvers();
  const aborted = Promise.withResolvers();
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => {
    started.resolve();
    await new Promise((_, reject) => {
      const stop = () => { aborted.resolve(); reject(signal.reason); };
      if (signal.aborted) stop();
      else signal.addEventListener('abort', stop, { once: true });
    });
  });
  const db = await fixture(t, { OPENAI_API_KEY: 'local-fixture' }, () => Date.now() + advance);
  await db.manager.evolution.propose({ ...request, builderModel: 'openai/gpt-4.1-mini' });
  await started.promise;
  await assert.rejects(db.manager.delete({ id: 'writer', requestId: 'remove' }), { statusCode: 409 });
  advance = 6 * 60 * 1000;
  const state = await finished(db.manager);
  assert.equal(state.job.status, 'failed');
  assert.match(state.job.error, /timed out/);
  assert.equal(state.proposal, null);
  assert.equal(state.revision, 1);
  await aborted.promise;
  await db.manager.evolution.propose({ ...request, requestId: 'retry-with-demo' });
  assert.ok((await finished(db.manager)).proposal);
  assert.deepEqual(await db.manager.delete({ id: 'writer', requestId: 'remove' }), { id: 'writer', deleted: true });
});

test('restart honors the original admission deadline', async t => {
  let advance = 0;
  const db = await fixture(t, {}, () => Date.now() + advance);
  await db.manager.evolution.propose(request);
  await db.restart(() => { advance = 6 * 60 * 1000; });
  const state = await finished(db.manager);
  assert.equal(state.job?.status, 'failed');
  assert.match(state.job.error, /timed out/);
  assert.equal(state.revision, 1);
  assert.equal(state.proposal, null);
});
