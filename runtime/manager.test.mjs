import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { openManager } from './manager.mjs';

async function setup(t, env = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'orca-pi-manager-'));
  let manager = await openManager({ dataDir, env });
  t.after(async () => {
    await manager.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return {
    get manager() { return manager; },
    async reopen() {
      await manager.close();
      manager = await openManager({ dataDir, env });
      return manager;
    },
  };
}

async function settled(manager, id) {
  const deadline = Date.now() + 10000;
  let state;
  do {
    state = await manager.chat({ id });
    if (!state.busy) return state;
    await delay(10);
  } while (Date.now() < deadline);
  assert.fail('Chat did not settle: ' + JSON.stringify(state));
}

test('creates, edits and reopens distinct agent profiles, validating IDs and models', async (t) => {
  const db = await setup(t);
  const a = await db.manager.create({ name: 'Reviewer', id: 'review', instructions: 'Read carefully.' });
  assert.deepEqual(a, { id: 'review', name: 'Reviewer', instructions: 'Read carefully.', model: 'demo', managed: true });
  const b = await db.manager.create({ name: 'Reviewer', id: '' });
  assert.notEqual(b.id, a.id);
  assert.match(b.id, /^[a-z0-9-]{1,64}$/);
  const race = await Promise.allSettled([1, 2].map(() => db.manager.create({ id: 'unique', name: 'Same' })));
  assert.equal(race.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(race.find((result) => result.status === 'rejected').reason.statusCode, 409);
  await assert.rejects(db.manager.create({ id: '../no', name: 'Invalid' }), /ID must/);
  await assert.rejects(db.manager.update({ id: 'review', name: 'Rollback', model: 'made/up' }), /supported/);
  assert.equal((await db.manager.list()).find((p) => p.id === 'review').name, 'Reviewer');
  await db.manager.update({ id: 'review', name: 'Updated', instructions: 'Use examples.', model: 'anthropic/claude-sonnet-4-6' });
  await db.reopen();
  assert.deepEqual((await db.manager.list()).find((p) => p.id === 'review'), {
    id: 'review', name: 'Updated', model: 'anthropic/claude-sonnet-4-6', instructions: 'Use examples.', managed: true,
  });
  assert.equal((await db.manager.list()).length, 3);
  await assert.rejects(db.manager.chat({ id: 'absent' }), /not found/);
});

test('retries are idempotent and conversation histories survive restart without crossing agents', async (t) => {
  const db = await setup(t);
  const m = db.manager;
  await Promise.all(['a','b'].map((id) => m.create({ id, name: id })));
  const input = { id: 'a', text: 'private A', requestId: 'once' };
  const other = { id: 'b', text: 'private B', requestId: 'once' };
  const accepted = await Promise.all([m.send(input), m.send(input), m.send(other)]);
  assert(accepted.every((result) => result.accepted));
  assert.deepEqual((await settled(m, 'a')).messages, [
    { role: 'user', text: 'private A' }, { role: 'assistant', text: 'Demo echo: private A' },
  ]);
  assert.deepEqual((await settled(m, 'b')).messages, [
    { role: 'user', text: 'private B' }, { role: 'assistant', text: 'Demo echo: private B' },
  ]);
  await db.reopen();
  await db.manager.send(input);
  await assert.rejects(db.manager.send({ ...input, text: 'different' }), /different message/);
  assert.equal((await db.manager.chat({ id: 'a' })).messages.length, 2);
  await Promise.all(['one', 'two', 'three'].map((text) => db.manager.send({ id: 'a', requestId: text, text })));
  const afterQueue = await settled(db.manager, 'a');
  assert.deepEqual(afterQueue.messages.filter((msg) => msg.role === 'user').map((msg) => msg.text), ['private A', 'one', 'two', 'three']);
  assert.equal(afterQueue.messages.at(-1).role, 'assistant');
  assert.equal((await db.manager.chat({ id: 'b' })).messages.length, 2);
});

test('real providers require their own key and leave the chat available for a model change', async (t) => {
  const { manager } = await setup(t);
  const id = 'real';
  await manager.create({ id, name: 'Assistant', model: 'openai/gpt-4.1-mini' });
  const input = { id, text: 'hello', requestId: 'auth' };
  await assert.rejects(manager.send(input), /OPENAI_API_KEY/);
  await manager.update({ id, model: 'anthropic/claude-sonnet-4-6' });
  await assert.rejects(manager.send(input), /ANTHROPIC_API_KEY/);
  assert.deepEqual(await manager.chat({ id }), { messages: [], busy: false });
  await manager.update({ id, model: 'demo' });
  await manager.send(input);
  assert.equal((await settled(manager, id)).messages.at(-1).text, 'Demo echo: hello');
});

test('edited model and instructions reach the provider and provider failures reach the panel', async (t) => {
  let captured;
  // Intercept the provider transport. No requests leave the test process.
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    captured = { url: String(url), body: JSON.parse(options.body) };
    return Response.json({ error: { message: 'Test credential rejected', type: 'invalid_request_error' } }, { status: 401 });
  });
  const { manager } = await setup(t, { OPENAI_API_KEY: 'test-only-injected-credential' });
  await manager.create({ id: 'edited', name: 'Agent', instructions: 'OLD INSTRUCTIONS' });
  await manager.update({ id: 'edited', model: 'openai/gpt-4.1-mini', instructions: 'UPDATED INSTRUCTIONS' });
  await manager.send({ id: 'edited', text: 'Say hi.', requestId: 'first' });
  const state = await settled(manager, 'edited');
  assert.equal(captured.body.model, 'gpt-4.1-mini');
  assert.match(JSON.stringify(captured.body), /UPDATED INSTRUCTIONS/);
  assert.doesNotMatch(JSON.stringify(captured.body), /OLD INSTRUCTIONS/);
  assert.match(state.error, /Test credential rejected/);
});

test('an admitted input survives abrupt process exit and can be retried after recovery', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'orca-pi-interrupt-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const managerUrl = new URL('./manager.mjs', import.meta.url).href;
  const script = `
    const { openManager } = await import(process.argv[1]);
    const m = await openManager({ dataDir: process.argv[2], env: {} });
    await m.create({ id: 'persistent', name: 'Persistent' });
    await m.send({ id: 'persistent', text: 'admitted', requestId: 'unique' });
    process.exit(0);
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, managerUrl, dataDir], {
    encoding: 'utf8', timeout: 15000, windowsHide: true,
  });
  assert.equal(child.status, 0, child.stderr);
  const manager = await openManager({ dataDir, env: {} });
  try {
    assert.deepEqual((await settled(manager, 'persistent')).messages, [
      { role: 'user', text: 'admitted' }, { role: 'assistant', text: 'Demo echo: admitted' },
    ]);
    await manager.send({ id: 'persistent', text: 'admitted', requestId: 'unique' });
    assert.equal((await manager.chat({ id: 'persistent' })).messages.length, 2);
  } finally {
    await manager.close();
  }
});

test('truncates long panel previews while preserving the complete admitted message', async (t) => {
  const { manager } = await setup(t);
  await manager.create({ id: 'long', name: 'Long' });
  const text = 'z'.repeat(20000) + ' ending';
  const input = { id: 'long', text, requestId: 'long-input' };
  await manager.send(input);
  const state = await settled(manager, 'long');
  assert.equal(state.truncated, true);
  assert.equal(state.messages.length, 2);
  assert(state.messages.every((message) => message.text.endsWith('…')));
  assert(Buffer.byteLength(JSON.stringify(state)) < 256 * 1024);
  await manager.send(input);
  await assert.rejects(manager.send({ ...input, text: text.slice(0, -1) }), /different message/);
});
