import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { createRegistry, defineDoc, Harness } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { openManager } from './manager.mjs';

async function setup(t, env = {}, prepare) {
  const dataDir = await mkdtemp(join(tmpdir(), 'orca-pi-manager-'));
  if (prepare) await prepare(dataDir);
  let manager = await openManager({ dataDir, env });
  t.after(async () => {
    await manager.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return {
    get manager() { return manager; },
    async reopen(nextEnv = env) {
      await manager.close();
      manager = await openManager({ dataDir, env: nextEnv });
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
  const db = await setup(t, { ANTHROPIC_API_KEY: 'offline-fixture' });
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

test('recruitment keys bind the original payload through concurrent creates, edits and restarts', async (t) => {
  const db = await setup(t, { OPENAI_API_KEY: 'offline-fixture' });
  const original = { name: 'Review', instructions: 'Read first.', model: 'openai/gpt-4.1-mini', requestId: 'recruit-1' };
  const [first, second] = await Promise.all([db.manager.create(original), db.manager.create(original)]);
  assert.deepEqual(first, second);
  await db.manager.update({ id: first.id, name: 'Edited', instructions: 'Now review.' });
  await db.reopen({});
  const same = await db.manager.create(original);
  assert.deepEqual(same, await db.manager.profile({ id: first.id }));
  assert.equal(same.name, 'Edited');
  assert.equal((await db.manager.list()).length, 1);
  for (const change of [{ name: 'Other' }, { id: first.id }, { instructions: 'Updated' }, { model: 'demo' }]) {
    await assert.rejects(db.manager.create({ ...original, ...change }), { statusCode: 409 });
  }
  const fixed = { id: 'chosen', name: 'A', requestId: 'explicit' };
  await db.manager.create(fixed);
  assert.equal((await db.manager.create(fixed)).id, 'chosen');
  await assert.rejects(db.manager.create({ ...fixed, requestId: 'other' }), { statusCode: 409 });
  await assert.rejects(db.manager.create({ id: 'chosen', name: 'A' }), { statusCode: 409 });
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
  const db = await setup(t);
  const id = 'real';
  const openai = 'openai/gpt-4.1-mini';
  const anthropic = 'anthropic/claude-sonnet-4-6';
  assert.deepEqual(db.manager.availableModels(), ['demo']);
  await assert.rejects(db.manager.create({ id, name: 'Assistant', model: openai }), /OPENAI_API_KEY/);
  await db.manager.create({ id, name: 'Assistant' });
  await assert.rejects(db.manager.update({ id, model: anthropic }), /ANTHROPIC_API_KEY/);
  await db.reopen({ OPENAI_API_KEY: 'test-only' });
  assert.deepEqual(db.manager.availableModels(), ['demo', openai]);
  await assert.rejects(db.manager.update({ id, model: 'openai/gpt-4.1' }), /supported/);
  await db.manager.update({ id, model: openai });
  await db.reopen({ ANTHROPIC_API_KEY: 'test-only' });
  assert.deepEqual(db.manager.availableModels(), ['demo', anthropic]);
  const input = { id, text: 'hello', requestId: 'auth' };
  await assert.rejects(db.manager.send(input), /OPENAI_API_KEY/);
  await db.manager.update({ id, model: anthropic });
  const manager = await db.reopen({});
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

function openaiStream(model, answer, turn) {
  const response = { id: 'resp_' + turn, object: 'response', model, status: 'in_progress', output: [] };
  const item = { id: 'msg_' + turn, type: 'message', role: 'assistant', status: 'in_progress', content: [] };
  const part = { type: 'output_text', text: '', annotations: [] };
  const coordinates = { item_id: item.id, output_index: 0, content_index: 0 };
  const completed = { ...item, status: 'completed', content: [{ ...part, text: answer }] };
  return [
    { type: 'response.created', response },
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.content_part.added', ...coordinates, part },
    { type: 'response.output_text.delta', ...coordinates, delta: answer.slice(0, 4) },
    { type: 'response.output_text.delta', ...coordinates, delta: answer.slice(4) },
    { type: 'response.output_text.done', ...coordinates, text: answer },
    { type: 'response.content_part.done', ...coordinates, part: completed.content[0] },
    { type: 'response.output_item.done', output_index: 0, item: completed },
    { type: 'response.completed', response: { ...response, status: 'completed', output: [completed],
      usage: { input_tokens: 30, output_tokens: 10, total_tokens: 40 } } },
  ].map((event, sequence_number) => ({ ...event, sequence_number }));
}

function anthropicStream(model, answer, turn) {
  return [
    { type: 'message_start', message: { id: 'msg_' + turn, type: 'message', role: 'assistant',
      model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 30, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: answer.slice(0, 4) } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: answer.slice(4) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } },
    { type: 'message_stop' },
  ];
}

function sseResponse(frames) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    pull(controller) {
      const event = frames.shift();
      if (!event) return controller.close();
      controller.enqueue(encoder.encode('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n'));
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
}

for (const [model, events, keyName] of [
  ['openai/gpt-4.1-mini', openaiStream, 'OPENAI_API_KEY'],
  ['anthropic/claude-sonnet-4-6', anthropicStream, 'ANTHROPIC_API_KEY'],
]) {
  test(model + ' completes streamed SDK turns on both sides of a restart', async (t) => {
    const requests = [];
    const answers = ['Answer from streamed tokens.', 'Resumed with prior context.'];
    t.mock.method(globalThis, 'fetch', async (url, opts) => {
      const body = JSON.parse(opts.body);
      const headers = new Headers(opts.headers);
      const turn = requests.length;
      requests.push({ url: String(url), body, headers });
      return sseResponse(events(body.model, answers[turn], turn));
    });
    const db = await setup(t, { [keyName]: 'offline-test-key' });
    const { id } = await db.manager.create({ name: 'Agent', model, instructions: 'Use the available history.' });
    const transcript = [];
    for (const [turn, text] of ['First input.', 'Second input.'].entries()) {
      await db.manager.send({ id, text, requestId: 'turn-' + turn });
      const chat = await settled(db.manager, id);
      assert.equal(chat.error, undefined);
      transcript.push({ role: 'user', text }, { role: 'assistant', text: answers[turn] });
      assert.deepEqual(chat.messages, transcript);
      await db.reopen();
      assert.deepEqual((await db.manager.chat({ id })).messages, transcript);
    }
    assert.equal(requests.length, 2);
    const expectedUrl = keyName === 'OPENAI_API_KEY' ? 'https://api.openai.com/v1/responses' : 'https://api.anthropic.com/v1/messages';
    for (const { url, headers, body } of requests) {
      assert.equal(new URL(url).origin + new URL(url).pathname, expectedUrl);
      assert.equal(headers.get(keyName === 'OPENAI_API_KEY' ? 'authorization' : 'x-api-key'),
        keyName === 'OPENAI_API_KEY' ? 'Bearer offline-test-key' : 'offline-test-key');
      assert.equal(body.model, model.split('/')[1]);
      assert.equal(body.stream, true);
      assert(JSON.stringify(body).includes('Use the available history.'));
    }
    assert(JSON.stringify(requests[1].body).includes(answers[0]));
    assert(JSON.stringify(requests[1].body).includes('First input.'));
  });
}

test('an earlier profile with an unlisted provider model can still be renamed, edited and used', async (t) => {
  const legacyModel = 'openai/gpt-4.1';
  // Seed the previous on-disk profile shape through the public Pi API.
  async function seed(dataDir) {
    const storage = await openNodeSqliteStorage(join(dataDir, 'agents.sqlite'));
    const harness = await Harness.open(storage, { models: createModels(), registry: createRegistry() }, BACKGROUND_CONTEXT);
    try {
      const root = await harness.root(BACKGROUND_CONTEXT);
      const agent = { model: { provider: 'openai', modelId: 'gpt-4.1' }, instructions: 'Legacy instructions.' };
      const conv = await harness.createConversation({ ownership: { kind: 'ownerless' }, agent }, BACKGROUND_CONTEXT);
      const roster = defineDoc({
        kind: 'orca.agent-roster', version: 1, scope: 'conversation', history: 'latest', fork: 'initial',
        initial: () => ({ agents: [] }), checkpointWhen: () => false,
      });
      await root.commit(async (tx) => {
        const doc = await tx.doc(roster, root.id);
        doc.agents.push({ id: 'old', name: 'Old', model: legacyModel, instructions: agent.instructions, conversationId: conv.id });
      }, BACKGROUND_CONTEXT);
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
    }
  }
  const { manager } = await setup(t, { OPENAI_API_KEY: 'offline-test-key' }, seed);
  assert(!manager.availableModels().includes(legacyModel));
  await manager.update({ id: 'old', name: 'Renamed' });
  await manager.update({ id: 'old', instructions: 'New legacy instructions.', model: legacyModel });
  let requestedModel;
  t.mock.method(globalThis, 'fetch', async (_url, opts) => {
    requestedModel = JSON.parse(opts.body).model;
    return sseResponse(openaiStream(requestedModel, 'Legacy reply.', 1));
  });
  await manager.send({ id: 'old', text: 'Continue.', requestId: 'old-reply' });
  assert.equal((await settled(manager, 'old')).messages.at(-1).text, 'Legacy reply.');
  assert.equal(requestedModel, 'gpt-4.1');
  assert.equal((await manager.profile({ id: 'old' })).name, 'Renamed');
  await assert.rejects(manager.create({ name: 'New', model: legacyModel }), /supported/);
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
