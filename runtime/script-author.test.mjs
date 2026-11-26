import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { openManager } from './manager.mjs';

function anthropicReply(model, text) {
  const split = Math.floor(text.length / 2);
  const frames = [
    { type: 'message_start', message: { id: 'msg_editor', type: 'message', role: 'assistant',
      model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 70, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ...[text.slice(0, split), text.slice(split)].map(piece =>
      ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } })),
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 60 } },
    { type: 'message_stop' },
  ];
  return new Response(frames.map(frame => 'event: ' + frame.type + '\ndata: ' + JSON.stringify(frame) + '\n\n').join(''),
    { headers: { 'content-type': 'text/event-stream' } });
}

async function waitFor(read, finished) {
  const deadline = Date.now() + 15000;
  for (;;) {
    const state = await read();
    if (finished(state)) return state;
    if (Date.now() >= deadline) assert.fail('Timed out waiting for ' + JSON.stringify(state));
    await delay(20);
  }
}

test('a separate streamed provider conversation edits existing source without receiving target chat', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'orca-author-stream-'));
  const model = 'anthropic/claude-sonnet-4-6';
  const env = { ANTHROPIC_API_KEY: 'test-author-only' };
  let manager = await openManager({ dataDir, env });
  t.after(async () => { await manager.close(); await rm(dataDir, { recursive: true, force: true }); });
  const id = 'analyst';
  const privateInstruction = 'Target private instruction sentinel.';
  const privateMessage = 'Target private transcript sentinel.';
  await manager.create({ id, name: 'Analyst', instructions: privateInstruction, model: 'demo' });
  async function speak(text, requestId) {
    await manager.send({ id, text, requestId });
    const turn = await waitFor(() => manager.turn({ id, requestId }), item => item.status !== 'pending');
    assert.equal(turn.status, 'done', JSON.stringify(turn));
    return turn.text;
  }
  async function draft(request) {
    await manager.evolution.propose({ id, ...request });
    const state = await waitFor(() => manager.evolution.get({ id }), state => state.job?.status !== 'running');
    assert.ok(state.proposal, state.job?.error || 'No proposal was created.');
    return state.proposal;
  }

  const seed = await draft({ requestId: 'exact', requirement: 'When I say "ping", reply "pong".' });
  await manager.evolution.apply({ id, requestId: seed.requestId, baseRevision: seed.baseRevision });
  assert.equal(await speak(privateMessage, 'private'), 'Demo echo: ' + privateMessage);
  const chatBeforeEvolution = await manager.chat({ id });
  const requirement = 'Add a command named /median. Find the median of the numbers after it, averaging the middle pair for an even count.';
  const acceptance = [{ input: '/median 14 4 2 8', expected: '6' }];
  const script = [
    'function respond(text) {',
    '  if (text.startsWith("/median ")) {',
    '    const input = text.slice(8).trim();',
    '    const values = input.split(/\\s+/u).map(Number).sort((a, b) => a - b);',
    '    if (!input || !values.every(Number.isFinite)) return null;',
    '    const mid = Math.floor(values.length / 2);',
    '    return String(values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2);',
    '  }',
    '  return (' + seed.source + ')(text);',
    '}',
  ].join('\n');
  const proposal = { script, summary: 'Compute the median of a list of numbers.', checks: [
    { input: '/median 9 2 3', expected: '3' }, { input: '/median x', expected: null },
  ] };
  const requests = [];
  // Intercept only at the SDK transport boundary. Harness still schedules and records the editor turn.
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url: new URL(url), headers: new Headers(options.headers), body });
    return anthropicReply(body.model, JSON.stringify(proposal));
  });

  const median = await draft({ requestId: 'median', requirement, builderModel: model, acceptance });
  assert.equal(requests.length, 1);
  const [{ url, headers, body }] = requests;
  assert.equal(url.origin + url.pathname, 'https://api.anthropic.com/v1/messages');
  assert.equal(headers.get('x-api-key'), env.ANTHROPIC_API_KEY);
  assert.equal(body.stream, true);
  assert.equal(body.model, model.split('/')[1]);
  assert.match(JSON.stringify(body.system), /evolution author/);
  assert.equal(body.tools?.length ?? 0, 0);
  assert.equal(body.messages.length, 1);
  const [authorInput] = body.messages;
  assert.equal(authorInput.role, 'user');
  const authorPrompt = typeof authorInput.content === 'string' ? authorInput.content :
    authorInput.content.filter(block => block.type === 'text').map(block => block.text).join('');
  assert.deepEqual(JSON.parse(authorPrompt), { requirement, previous: seed.source, checks: seed.checks, acceptance });
  assert.ok(!JSON.stringify(body).includes(privateMessage));
  assert.ok(!JSON.stringify(body).includes(privateInstruction));
  assert.deepEqual(await manager.chat({ id }), chatBeforeEvolution);
  assert.equal((await manager.profile({ id })).model, 'demo');
  assert.equal(median.source, script);
  for (const check of [...seed.checks, ...acceptance, ...proposal.checks]) {
    assert.deepEqual(median.checks.find(item => item.input === check.input), check);
  }

  await manager.evolution.apply({ id, requestId: median.requestId, baseRevision: median.baseRevision });
  assert.equal(await speak('/median 99 7 8 9 10', 'live'), '9');
  await manager.close();
  manager = await openManager({ dataDir, env: {} });
  const restored = await manager.evolution.get({ id });
  assert.equal(restored.source, script);
  assert.equal(restored.revision, median.baseRevision + 1);
  assert.equal(await speak('/median -11 2 12 0', 'reopened'), '1');
  assert.equal(await speak('ping', 'original-capability'), 'pong');
  assert.equal(await speak('ordinary chat', 'ordinary'), 'Demo echo: ordinary chat');
  assert.equal(requests.length, 1);
});
