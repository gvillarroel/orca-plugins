import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';
import { createExternalRegistry } from '../plugins/pi-durable/external.mjs';

const agentId = 'external:one/writer';
const agents = [{ id: 'writer', name: 'Writer' }];

async function files(t) {
  const root = await mkdtemp(join(tmpdir(), 'pi-durable-registry-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  async function json(path, value) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(value));
  }
  async function registry(path, rows) {
    await json(path, { version: 1, services: rows.map(([id, config]) =>
      ({ id, configPath: relative(dirname(path), config) })) });
    return path;
  }
  async function service(name, port, host = '127.0.0.1') {
    const config = join(root, name, 'config.json');
    await json(config, { version: 1, host, port, dataDir: './state', agents });
    const token = randomBytes(32).toString('hex');
    const state = join(dirname(config), 'state');
    await mkdir(state);
    await writeFile(join(state, 'console-token'), token);
    return { config, token };
  }
  return { root, json, registry, service };
}

async function owner(t, handler) {
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch(error => {
      res.destroy(error);
      t.diagnostic(error.message);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return server.address().port;
}

test('nearest workspace registry, explicit env, installed fallback and Orca setting have distinct precedence', async t => {
  const f = await files(t);
  const port = await owner(t, (req, res) => res.end(JSON.stringify({ agents })));
  const { config } = await f.service('service', port);
  const inner = join(f.root, 'project', 'inner');
  const workspaceRoot = join(inner, 'subfolder');
  const ext = join(f.root, 'extension');
  await f.registry(join(f.root, 'project', '.pi', 'durable-agents.json'), [['parent', config]]);
  await f.registry(join(inner, '.pi', 'durable-agents.json'), [['nearest', config]]);
  const envFile = await f.registry(join(f.root, 'explicit.json'), [['env', config]]);
  const setting = await f.registry(join(f.root, 'settings.json'), [['setting', config]]);
  await f.registry(join(ext, 'durable-agents.json'), [['fallback', config]]);
  const check = async (overrides, id) => {
    const api = createExternalRegistry({ workspaceRoot, env: {}, extensionDir: ext, ...overrides });
    const result = await api.list();
    assert.deepEqual(result.warnings, []);
    assert.equal(result.agents[0].id, 'external:' + id + '/writer');
  };
  await check({}, 'nearest');
  const env = { PI_DURABLE_CONNECTIONS: relative(workspaceRoot, envFile) };
  await check({ env }, 'env');
  await check({ env, connectionsFile: setting }, 'setting');
  await check({ workspaceRoot: join(f.root, 'elsewhere') }, 'fallback');
  const invalid = await createExternalRegistry({ env: { PI_DURABLE_CONNECTIONS: '' }, workspaceRoot }).list();
  assert.deepEqual(invalid.agents, []);
  assert.equal(invalid.warnings.length, 1);
});

test('authenticated inventory keeps duplicate agent IDs distinct, offline agents visible, and credentials private', async t => {
  const f = await files(t);
  let token;
  const port = await owner(t, (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer ' + token);
    assert.equal(req.url, '/v1/agents');
    res.end(JSON.stringify({ agents }));
  });
  const online = await f.service('online', port);
  token = online.token;
  const offline = await f.service('offline', port);
  await rm(join(dirname(offline.config), 'state', 'console-token'));
  const file = await f.registry(join(f.root, 'connections.json'), [['one', online.config], ['two', offline.config]]);
  const result = await createExternalRegistry({ connectionsFile: file }).list();
  assert.deepEqual(result.agents, [
    { id: agentId, name: 'Writer', online: true, managed: false },
    { id: 'external:two/writer', name: 'Writer', online: false, managed: false }
  ]);
  assert.equal(result.warnings.length, 1);
  assert.ok(!JSON.stringify(result).includes(token));
});

test('external conversations retain public text, active progress and stable admission across a lost receipt', async t => {
  const f = await files(t);
  let token, calls = 0, status = 'placed';
  const seen = new Map();
  const snapshot = {
    conversation: { id: 33 }, entries: [
      { id: 1, model: [{ role: 'user', content: 'uno' }] },
      { id: 2, model: [{ role: 'assistant', content: [
        { type: 'thinking', thinking: 'hidden' }, { type: 'toolCall', name: 'secret-tool' }, { type: 'text', text: 'bien' }
      ] }, { role: 'toolResult', content: 'hidden' }] },
      { id: 3, model: [{ role: 'user', content: 'uno' }] }
    ], docs: { 'pi.live': { run: { taskId: 4, inputs: [9] }, generation: { message: {
      role: 'assistant', content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: 'progreso' }]
    } } } }
  };
  const prefix = '/v1/agents/writer';
  const port = await owner(t, async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer ' + token);
    if (req.url === prefix + '/chat') return res.end(JSON.stringify(snapshot));
    if (req.url === prefix + '/submissions/9') return res.end(JSON.stringify({
      id: 9, conversationId: 33, status, reason: 'no_model', detail: 'private diagnostic'
    }));
    assert.equal(req.method, 'POST');
    assert.equal(req.url, prefix + '/messages');
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const message = JSON.parse(raw);
    assert.deepEqual(message, { content: 'uno', requestId: 'request-1', whenBusy: 'followUp' });
    seen.set(message.requestId, 9);
    if (++calls === 1) return res.destroy();
    res.writeHead(202);
    res.end(JSON.stringify({ conversationId: 33, submissionId: 9 }));
  });
  const service = await f.service('owner', port);
  token = service.token;
  const file = await f.registry(join(f.root, 'connections.json'), [['one', service.config]]);
  const api = createExternalRegistry({ connectionsFile: file });
  const args = { id: agentId, text: 'uno', requestId: 'request-1' };
  await assert.rejects(api.send(args), error => error.requestId === 'request-1');
  const receipt = await api.send(args);
  assert.deepEqual(receipt, { accepted: true, conversationId: 33, submissionId: 9, requestId: 'request-1' });
  assert.equal(seen.size, 1);
  const read = () => api.chat({ id: agentId, ...receipt });
  const live = await read();
  assert.deepEqual(live.messages, [{ role: 'user', text: 'uno' }, { role: 'assistant', text: 'bien' }, { role: 'user', text: 'uno' }]);
  assert.equal(live.liveText, 'progreso');
  assert.equal(live.busy, true);
  snapshot.docs['pi.live'] = {};
  status = 'queued';
  assert.equal((await read()).busy, true);
  status = 'done';
  snapshot.entries.push({ id: 4, model: [{ role: 'assistant', content: [{ type: 'text', text: 'progreso' }] }] });
  const final = await read();
  assert.equal(final.liveText, undefined);
  assert.equal(final.busy, false);
  assert.deepEqual(final.messages.at(-1), { role: 'assistant', text: 'progreso' });
  assert.equal(final.messages.filter(message => message.text === 'progreso').length, 1);
  status = 'unanswered';
  assert.match((await read()).error, /no_model/);
  snapshot.docs['pi.live'] = { runFailure: { reason: 'faulted', detail: 'private diagnostic' } };
  const failed = await api.chat({ id: agentId });
  assert.match(failed.error, /faulted/);
  assert.ok(!JSON.stringify(failed).includes('private diagnostic'));
});

test('invalid hosts and redirects never receive authentication; response diagnostics stay private', async t => {
  const f = await files(t);
  let forwarded = 0, redirected = 0;
  const other = await owner(t, (req, res) => { forwarded++; res.end(); });
  const first = await owner(t, (req, res) => {
    redirected++;
    res.writeHead(307, { location: 'http://127.0.0.1:' + other + '/target' });
    res.end('owner-only diagnostic');
  });
  const a = await f.service('one', first);
  const b = await f.service('invalid', other, '0.0.0.0');
  const file = await f.registry(join(f.root, 'connections.json'), [['one', a.config], ['two', b.config]]);
  const api = createExternalRegistry({ connectionsFile: file });
  const result = await api.list();
  assert.equal(forwarded, 0);
  assert.equal(redirected, 1);
  assert.equal(result.agents[0].online, false);
  assert.equal(result.warnings.length, 2);
  assert.match(result.warnings[0], /HTTP 307/);
  assert.ok(!JSON.stringify(result).includes('owner-only diagnostic'));
  await assert.rejects(api.chat({ id: 'external:one/../v1' }), /Invalid external agent ID/);
});

test('large external transcripts fit Orca responses and retain the newest public messages', async t => {
  const f = await files(t);
  // JSON escapes expand the serialized byte size independently of character count.
  const body = '\u0001'.repeat(3500);
  const entries = Array.from({ length: 54 }, (_, i) => ({
    id: i, model: [{ role: 'assistant', content: body + ' ' + i }]
  }));
  entries.push({ id: 54, model: [
    { role: 'user', content: 'última pregunta' },
    { role: 'assistant', content: 'última respuesta' }
  ] });
  let snapshot = { conversation: { id: 8 }, entries, docs: {} };
  let chunked = false;
  const port = await owner(t, (_req, res) => {
    const data = JSON.stringify(snapshot);
    if (chunked) {
      res.write(data.slice(0, 24));
      res.end(data.slice(24));
    } else {
      res.end(data);
    }
  });
  const { config } = await f.service('service', port);
  const file = await f.registry(join(f.root, 'connections.json'), [['one', config]]);
  const api = createExternalRegistry({ connectionsFile: file });
  const read = () => api.chat({ id: agentId });
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) > 1024 * 1024);
  const recent = await read();
  assert.ok(Buffer.byteLength(JSON.stringify(recent)) < 256 * 1024);
  assert.equal(recent.truncated, true);
  assert.deepEqual(recent.messages.slice(-2), [
    { role: 'user', text: 'última pregunta' }, { role: 'assistant', text: 'última respuesta' }
  ]);
  assert.ok(recent.messages.length < entries.length);
  assert.ok(recent.messages.at(-3).text.endsWith(' 53'));

  const large = 'x'.repeat(11999) + '💬'.repeat(800);
  snapshot = { conversation: { id: 8 }, entries: [{ model: [{ role: 'user', content: large }] }],
    docs: { 'pi.live': { run: {}, generation: { message: { role: 'assistant', content: large } } } } };
  const partial = await read();
  assert.equal(partial.truncated, true);
  assert.ok(partial.messages[0].text.endsWith('…') && partial.messages[0].text.isWellFormed());
  assert.ok(partial.liveText.length < large.length && partial.liveText.endsWith('…'));

  snapshot.entries = Array.from({ length: 81 }, (_, i) => ({ model: [{ role: 'user', content: String(i) }] }));
  snapshot.docs = {};
  const many = await read();
  assert.equal(many.truncated, true);
  assert.equal(many.messages.length, 80);
  assert.equal(many.messages[0].text, '1');
  assert.equal(many.messages.at(-1).text, '80');
  snapshot.entries.shift();
  assert.ok(!(await read()).truncated);

  snapshot.entries = [{ model: [{ role: 'assistant', content: 'z'.repeat(2 * 1024 * 1024) }] }];
  await assert.rejects(read(), /exceeds the 2 MiB transfer limit/);
  chunked = true;
  await assert.rejects(read(), /exceeds the 2 MiB transfer limit/);
});
