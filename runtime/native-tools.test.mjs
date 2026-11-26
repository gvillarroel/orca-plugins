import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { openManager } from './manager.mjs';
import { nativeContext } from './native-tools.mjs';

const model = 'anthropic/claude-sonnet-4-6';
const name = 'qa-readme.txt';
const tool = { name: 'read', description: 'Read a workspace file', parameters: {
  type: 'object', properties: { path: { type: 'string' } }, required: ['path'],
} };

test('rejects ambiguous or oversized native capabilities before starting a run', () => {
  assert.equal(nativeContext(), null);
  assert.throws(() => nativeContext([tool, tool]), { statusCode: 400 });
  assert.throws(() => nativeContext([{ ...tool, name: 'read;else' }]), { statusCode: 400 });
  assert.throws(() => nativeContext([{ ...tool, parameters: [] }]), { statusCode: 400 });
  assert.throws(() => nativeContext([{ ...tool, description: 'X'.repeat(130 * 1024) }]), { statusCode: 400 });
  assert.throws(() => nativeContext([], 'X'.repeat(100 * 1024)), { statusCode: 400 });
});

function wireResponse(body, readOutput) {
  const use = !readOutput && body.tools?.some(item => item.name === 'call_orca_tool');
  const content = use ? { type: 'tool_use', id: 'toolu_test', name: 'call_orca_tool', input: {} } : { type: 'text', text: '' };
  const delta = use ? { type: 'input_json_delta', partial_json: JSON.stringify({ name: 'read', arguments: { path: name } }) } :
    { type: 'text_delta', text: readOutput ? 'Checked: ' + readOutput : 'Ordinary reply.' };
  const events = [
    { type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant', model: body.model,
      content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 8, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: content },
    { type: 'content_block_delta', index: 0, delta }, { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: use ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 12 } },
    { type: 'message_stop' },
  ];
  return new Response(events.map(e => 'event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n').join(''),
    { headers: { 'Content-Type': 'text/event-stream' } });
}

async function poll(manager, request, target) {
  const until = Date.now() + 5000;
  for (;;) {
    const reply = await manager.turn(request);
    if (reply.status === target) return reply;
    if (reply.status !== 'pending' || Date.now() >= until) throw Error('Expected ' + target + ', received ' + JSON.stringify(reply));
    await delay(15);
  }
}

test('a native tool grant survives restart, stays bound to its submission and resumes the original model', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    const results = body.messages.flatMap(msg => Array.isArray(msg.content) ? msg.content : []).filter(p => p.type === 'tool_result');
    const output = results.flatMap(p => typeof p.content === 'string' ? [p.content] : p.content.map(c => c.text)).join(' ');
    return wireResponse(body, output);
  });
  const dataDir = await mkdtemp(join(tmpdir(), 'orca-native-tools-'));
  const options = { dataDir, env: { ANTHROPIC_API_KEY: 'test-only' } };
  let manager = await openManager(options);
  t.after(async () => { await manager.close(); await rm(dataDir, { recursive: true, force: true }); });
  await manager.create({ id: 'review', name: 'Reviewer', model });
  await manager.create({ id: 'other', name: 'Other', model: 'demo' });
  const request = { id: 'review', requestId: 'a-native-request' };
  const send = { ...request, text: 'Read the file.', nativeTools: [tool], nativeSystem: 'Workspace guidance from Pi.' };
  await manager.send(send);
  const first = await poll(manager, request, 'tools');
  assert.match(JSON.stringify(requests[0].system), /Workspace guidance from Pi/);
  assert.match(JSON.stringify(requests[0].system), /Read a workspace file/);
  assert.equal(first.calls.length, 1);
  assert.equal(first.usage.input, 8);
  assert.equal(first.usage.output, 12);
  assert.equal(first.calls[0].name, 'read');
  assert.deepEqual(first.calls[0].arguments, { path: name });
  const result = { id: first.calls[0].id, isError: false, content: [{ type: 'text', text: 'Release 25' }] };
  await assert.rejects(manager.toolResults({ ...request, results: [{ ...result, isError: 'false' }] }), { statusCode: 400 });
  await assert.rejects(manager.toolResults({ ...request, results: [{ ...result, content: [{ type: 'file', path: name }] }] }), { statusCode: 400 });
  await manager.send(send);
  await assert.rejects(manager.send({ ...send, nativeTools: [] }), { statusCode: 409 });
  await assert.rejects(manager.send({ ...request, requestId: 'a-sidebar-request', text: 'hi' }), { statusCode: 409 });
  await manager.send({ id: 'other', requestId: request.requestId, text: 'hi' });
  await assert.rejects(manager.toolResults({ ...request, id: 'other', results: [result] }), { statusCode: 409 });
  await manager.close();
  manager = await openManager(options);
  assert.deepEqual(await poll(manager, request, 'tools'), first);
  assert.deepEqual(await manager.toolResults({ ...request, results: [result] }), { accepted: true });
  assert.deepEqual(await manager.toolResults({ ...request, results: [result] }), { accepted: true });
  await assert.rejects(manager.toolResults({ ...request, results: [{ ...result, content: [] }] }), { statusCode: 409 });
  assert.equal((await poll(manager, request, 'done')).text, 'Checked: Release 25');
  await manager.send({ id: 'review', requestId: 'plain', text: 'ordinary sidebar' });
  await poll(manager, { id: 'review', requestId: 'plain' }, 'done');
  assert.ok(!requests.at(-1).tools?.some(t => t.name === 'call_orca_tool'));
  assert.doesNotMatch(JSON.stringify(requests.at(-1).system), /Workspace guidance from Pi/);
  assert.ok(requests.at(-1).thread?.type !== 'continue' || Array.isArray(requests.at(-1).tools),
    'A panel turn must not inherit an unchanged native tool list from an upstream thread.');
  assert.deepEqual(await manager.toolResults({ ...request, results: [result] }), { accepted: true });
});

test('restarting past the tool deadline and stopping an exact native turn both release the conversation', async t => {
  let offset = 0;
  let threadTools;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body);
    const current = body.messages.slice(body.messages.findLastIndex(m => m.role === 'user' &&
      (typeof m.content === 'string' || m.content.some(part => part.type === 'text'))));
    const result = current.flatMap(m => Array.isArray(m.content) ? m.content : []).find(part => part.type === 'tool_result');
    if (body.thread?.type !== 'continue' || body.tools) threadTools = body.tools;
    return wireResponse({ ...body, tools: threadTools }, result ? 'client tool ended' : '');
  });
  const dataDir = await mkdtemp(join(tmpdir(), 'orca-native-deadline-'));
  const options = { dataDir, env: { ANTHROPIC_API_KEY: 'test-only' }, now: () => Date.now() + offset };
  let manager = await openManager(options);
  t.after(async () => { await manager.close(); await rm(dataDir, { recursive: true, force: true }); });
  await manager.create({ id: 'agent', name: 'Agent', model });
  const send = { id: 'agent', requestId: 'expiry', nativeTools: [tool], text: 'Read a file.' };
  await manager.send(send);
  const { calls } = await poll(manager, send, 'tools');
  const late = { id: calls[0].id, isError: false, content: [{ type: 'text', text: 'late' }] };
  await manager.close();
  offset += 10 * 60 * 1000 + 1000;
  manager = await openManager(options);
  await assert.rejects(manager.toolResults({ ...send, results: [late] }), { statusCode: 409 });
  assert.equal((await poll(manager, send, 'done')).text, 'Checked: client tool ended');
  assert.deepEqual(await manager.cancel(send), { status: 'settled' });
  const next = { ...send, requestId: 'stop', text: 'Read another file.' };
  await manager.send(next);
  const second = await poll(manager, next, 'tools');
  assert.deepEqual(await manager.cancel({ ...next, requestId: 'missing' }), { status: 'unconfirmed' });
  assert.deepEqual(await manager.cancel(send), { status: 'settled' });
  assert.deepEqual(await manager.cancel(next), { status: 'cancelled' });
  assert.deepEqual(await manager.cancel(next), { status: 'cancelled' });
  assert.equal((await manager.turn(next)).status, 'error');
  await assert.rejects(manager.toolResults({ ...next, results: [{ ...late, id: second.calls[0].id }] }), { statusCode: 409 });
  await manager.send({ id: 'agent', requestId: 'after-stop', text: 'Still available?' });
  await poll(manager, { id: 'agent', requestId: 'after-stop' }, 'done');
});
