import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { startService } from './server.mjs';

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'orca-pi-http-'));
  const descriptor = join(dataDir, 'connection.json');
  let service;
  t.after(async () => {
    try { await service?.close(); } finally { await rm(dataDir, { recursive: true, force: true }); }
  });
  async function start() {
    service = await startService({ dataDir, port: 0 });
    const connection = JSON.parse(await readFile(descriptor, 'utf8'));
    assert.equal(connection.port, service.port);
    assert.match(connection.token, /^[a-f0-9]{64}$/);
    return connection;
  }
  return { dataDir, descriptor, start, close: () => service.close() };
}

function post({ port, token }, method, params, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: '127.0.0.1', port, method: 'POST', path: '/' + method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...headers,
      },
    }, (response) => {
      response.setEncoding('utf8');
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('error', reject);
      response.on('end', () => {
        try { resolve({ status: response.statusCode, body: JSON.parse(body) }); } catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.end(JSON.stringify(params));
  });
}

test('reserves the listening port and rejects requests without its token, host and origin policy', async (t) => {
  const f = await fixture(t);
  const connection = await f.start();
  await assert.rejects(startService({ dataDir: f.dataDir, port: connection.port }), { code: 'EADDRINUSE' });
  assert.deepEqual(JSON.parse(await readFile(f.descriptor, 'utf8')), connection);
  const results = await Promise.all([
    post({ port: connection.port }, 'agents.list', {}),
    post({ ...connection, token: '0'.repeat(64) }, 'agents.list', {}),
    post(connection, 'agents.list', {}, { Host: 'localhost:' + connection.port }),
    post(connection, 'agents.list', {}, { Origin: 'https://example.com' }),
  ]);
  for (const result of results) {
    assert.equal(result.status, 403);
    assert.equal(typeof result.body.error, 'string');
  }
  assert.deepEqual(await post(connection, 'agents.list', {}), { status: 200, body: { agents: [] } });
});

test('serves authenticated profiles and chats, unlinks its descriptor and rotates its token on restart', async (t) => {
  const f = await fixture(t);
  const connection = await f.start();
  const profile = { id: 'local-agent', name: 'Local agent', instructions: 'Keep answers short.', model: 'demo' };
  const created = await post(connection, 'agents.create', profile);
  assert.deepEqual(created, { status: 200, body: { ...profile, managed: true } });
  assert.deepEqual((await post(connection, 'agents.list', {})).body.agents, [created.body]);
  const list = await post(connection, 'agents.list', { summary: true });
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.agents, [{ id: profile.id, name: profile.name, model: 'demo', managed: true }]);
  assert.ok(list.body.models.includes('demo'));
  assert.equal(list.body.nativeChatVersion, 1);
  assert.deepEqual(await post(connection, 'agents.profile', { id: profile.id }), created);
  assert.deepEqual(await post(connection, 'unknown.method', {}), {
    status: 404, body: { code: 'unknown_operation', error: 'Unknown operation.' },
  });
  assert.equal((await post(connection, 'agents.profile', { id: 'missing' })).status, 404);
  const input = { id: profile.id, text: 'hello over HTTP', requestId: 'first' };
  assert.deepEqual(await post(connection, 'chat.send', input), { status: 200, body: { accepted: true } });
  const deadline = Date.now() + 5000;
  let chat;
  do {
    const result = await post(connection, 'chat.read', { id: profile.id });
    assert.equal(result.status, 200);
    chat = result.body;
    if (!chat.busy) break;
    await delay(15);
  } while (Date.now() < deadline);
  assert.deepEqual(chat, {
    busy: false,
    messages: [{ role: 'user', text: input.text }, { role: 'assistant', text: 'Demo echo: ' + input.text }],
  });
  await f.close();
  await assert.rejects(readFile(f.descriptor), { code: 'ENOENT' });

  const restarted = await f.start();
  const turn = await post(restarted, 'chat.turn', { id: profile.id, requestId: 'first' });
  assert.equal(turn.status, 200);
  assert.equal(turn.body.status, 'done');
  assert.equal(turn.body.text, 'Demo echo: ' + input.text);
  assert.deepEqual(await post(restarted, 'chat.cancel', { id: profile.id, requestId: 'first' }),
    { status: 200, body: { status: 'settled' } });
  // The native tool channel admits multi-megabyte results through HTTP; a call from
  // a different turn is refused by the manager after the body passes transport framing.
  const id = 'orca_00000000-0000-4000-8000-000000000000';
  const nativeResult = { id, isError: false, content: [{ type: 'text', text: 'x'.repeat(1000 * 1024) }] };
  const large = await post(restarted, 'chat.toolResults', {
    id: profile.id, requestId: 'first', results: [nativeResult, nativeResult, nativeResult],
  });
  assert.equal(large.status, 409);
  assert.match(large.body.error, /does not own/);
  assert.notEqual(restarted.token, connection.token);
  assert.equal((await post({ ...restarted, token: connection.token }, 'agents.list', {})).status, 403);
  assert.deepEqual((await post(restarted, 'chat.read', { id: profile.id })).body, chat);
});
