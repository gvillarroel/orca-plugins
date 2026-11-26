import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { openManager } from './manager.mjs';
import { startService } from './server.mjs';

test('deleting a managed agent retires its identity, preserves other histories and survives a restart', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'orca-delete-'));
  let service = await startService({ dataDir, port: 0 });
  t.after(async () => {
    try { await service.close(); } finally { await rm(dataDir, { recursive: true, force: true }); }
  });
  const connection = () => readFile(join(dataDir, 'connection.json'), 'utf8').then(JSON.parse);
  let descriptor = await connection();
  async function post(method, params) {
    const response = await fetch('http://127.0.0.1:' + descriptor.port + '/' + method, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + descriptor.token },
      body: JSON.stringify(params),
    });
    return { status: response.status, body: await response.json() };
  }

  const recruit = { name: 'Reviewer', requestId: 'original-recruitment' };
  const first = await post('agents.create', recruit);
  assert.equal(first.status, 200);
  const id = first.body.id;
  const second = await post('agents.create', { id: 'other', name: recruit.name });
  assert.equal(second.status, 200);
  await post('chat.send', { id: 'other', requestId: 'welcome', text: 'other conversation' });
  const until = Date.now() + 5000;
  while ((await post('chat.turn', { id: 'other', requestId: 'welcome' })).body.status !== 'done') {
    if (Date.now() > until) assert.fail('Demo reply did not settle.');
    await delay(15);
  }

  const deletion = { id, requestId: 'remove-reviewer' };
  assert.equal((await post('agents.delete', { id })).status, 400);
  assert.equal((await post('agents.delete', { ...deletion, id: 'external:team/reviewer' })).status, 400);
  assert.equal((await post('agents.delete', { ...deletion, id: 'unknown' })).status, 404);
  const receipts = await Promise.all([post('agents.delete', deletion), post('agents.delete', deletion)]);
  for (const receipt of receipts) assert.deepEqual(receipt, { status: 200, body: { id, deleted: true } });
  await service.close();
  service = await startService({ dataDir, port: 0 });
  descriptor = await connection();

  assert.deepEqual(await post('agents.delete', deletion), receipts[0]);
  assert.equal((await post('agents.delete', { ...deletion, id: 'other' })).status, 409);
  assert.equal((await post('agents.create', recruit)).status, 409);
  assert.equal((await post('agents.create', { id, name: 'Replacement' })).status, 409);
  assert.deepEqual((await post('agents.list', {})).body.agents.map(a => a.id), ['other']);
  for (const [method, params] of [
    ['agents.profile', {}], ['agents.update', { name: 'Resurrect' }], ['chat.read', {}],
    ['chat.send', { text: 'from old tab', requestId: 'stale' }], ['chat.turn', { requestId: 'stale' }],
    ['chat.cancel', { requestId: 'stale' }], ['chat.toolResults', { requestId: 'stale', results: [] }],
    ['evolution.get', {}], ['evolution.propose', { requestId: 'stale', requirement: 'Add /words to count words' }],
    ['evolution.apply', { requestId: 'stale', baseRevision: 1 }], ['evolution.rollback', { revision: 2 }],
  ]) {
    assert.equal((await post(method, { ...params, id })).status, 404, method);
  }
  assert.deepEqual((await post('chat.read', { id: 'other' })).body.messages, [
    { role: 'user', text: 'other conversation' }, { role: 'assistant', text: 'Demo echo: other conversation' },
  ]);
});

test('deletion refuses an agent with a live reply or queued input', { timeout: 10000 }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'orca-delete-busy-'));
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  t.mock.method(globalThis, 'fetch', async () => {
    started.resolve();
    await release.promise;
    return Response.json({ error: { type: 'invalid_request_error', message: 'Test turn ended' } }, { status: 401 });
  });
  const manager = await openManager({ dataDir, env: { OPENAI_API_KEY: 'local-fixture' } });
  t.after(async () => {
    release.resolve();
    try { await manager.close(); } finally { await rm(dataDir, { recursive: true, force: true }); }
  });
  const { id } = await manager.create({ name: 'Busy', model: 'openai/gpt-4.1-mini' });
  await manager.send({ id, requestId: 'working', text: 'first' });
  await started.promise;
  await manager.send({ id, requestId: 'queued', text: 'second' });
  const remove = { id, requestId: 'remove' };
  await assert.rejects(manager.delete(remove), { statusCode: 409 });
  assert.equal((await manager.profile({ id })).id, id);
  release.resolve();
  const until = Date.now() + 5000;
  while ((await manager.chat({ id })).busy) {
    if (Date.now() > until) assert.fail('The queued inputs did not settle.');
    await delay(15);
  }
  assert.deepEqual(await manager.delete(remove), { id, deleted: true });
});
