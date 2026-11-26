import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { allowedCalls, claimHandoff, nativeCatalog } from '../integrations/pi-durable-provider/tools.mjs';
import { durableInput, replyToTurn, turnSignature } from '../integrations/pi-durable-provider/turn.mjs';

const model = { id: 'reviewer', input: ['text'] };
const vision = { ...model, input: ['text', 'image'] };
const user = (content, timestamp = 1) => ({ role: 'user', content, timestamp });
const text = (value) => ({ type: 'text', text: value });
const picture = { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' };
const inputFor = (messages, selected = model, session = 's1') =>
  durableInput(selected, session, messages, turnSignature(messages));

test('uses only new user turns and sends identical receipts on retries across Pi processes', () => {
  const current = [user('first'), { role: 'assistant', content: [text('reply')] },
    user([text('Hello '), text('world')], 11), { role: 'system', content: 'tool catalog' }, user('Also this', 12)];
  const sent = inputFor(current);
  assert.equal(sent.text, 'Hello world\n\nAlso this');
  assert.equal(sent.id, 'reviewer');
  assert.equal(inputFor(structuredClone(current)).requestId, sent.requestId);
  assert.notEqual(inputFor(current, model, 's2').requestId, sent.requestId);
  assert.notEqual(inputFor([user(sent.text, 13)]).requestId, sent.requestId);
  assert.notEqual(inputFor(current, { ...model, id: 'other' }).requestId, sent.requestId);
});

test('refuses tool continuations, auxiliary model calls and missing real session identity', () => {
  const messages = [user('a')];
  assert.throws(() => durableInput(model, 's1', [user('summary', 9)], turnSignature(messages)), /user chat turns/);
  assert.throws(() => durableInput(model, 's1', [user('summary', 1)], turnSignature(messages)), /user chat turns/);
  assert.throws(() => inputFor([...messages, { role: 'toolResult', content: [text('result')] }]), /user chat turns/);
  assert.throws(() => inputFor(messages, model, ''), /user chat turns/);
  assert.throws(() => inputFor([user('x'.repeat(32001))]), /32,000/);
  assert.throws(() => inputFor([user('  ')]), /Enter a message/);
});

test('preserves image data, MIME type and block order including image-only turns', () => {
  const blocks = [text('left'), picture, text('right')];
  const input = inputFor([user(blocks)], vision);
  assert.deepEqual(input.content, blocks);
  assert.equal('text' in input, false);
  assert.deepEqual(inputFor([user([picture])], vision).content, [picture]);
  assert.notEqual(inputFor([user([picture, ...blocks])], vision).requestId, input.requestId);
  assert.throws(() => inputFor([user(blocks)]), /text only/);
  assert.throws(() => inputFor([user([{ ...picture, mimeType: 'image/svg+xml' }])], vision), /PNG/);
  assert.throws(() => inputFor([user(Array(5).fill(picture))], vision), /four images/);
  assert.throws(() => inputFor([user([{ ...picture, data: 'A'.repeat(12 * 1024 * 1024) }])], vision), /8 MiB/);
  assert.throws(() => inputFor([user([{ type: 'audio', data: 'clip' }])], vision), /supported image/);
});

test('submits once, polls only that receipt, streams growth and returns the committed snapshot', async () => {
  const usage = { input: 12, output: 7 };
  const replies = [{ status: 'pending', text: 'pre' }, { status: 'pending', text: 'previous' },
    { status: 'done', text: 'replacement after restart', usage }];
  const input = inputFor([user('hello')]);
  const deltas = [];
  let sends = 0;
  const call = async (method, params) => {
    if (method === 'chat.send') { sends++; assert.deepEqual(params, input); return { accepted: true }; }
    assert.equal(method, 'chat.turn');
    assert.deepEqual(params, { id: input.id, requestId: input.requestId });
    return replies.shift();
  };
  const result = await replyToTurn(call, input, undefined, (delta) => deltas.push(delta));
  assert.equal(sends, 1);
  assert.deepEqual(deltas, ['pre', 'vious']);
  assert.deepEqual(result, { status: 'done', text: 'replacement after restart', usage });
});

test('propagates service failures and aborts waiting without resubmitting the input', async () => {
  const input = inputFor([user('hello')]);
  const failure = async (method) => method === 'chat.send' ? {} : { status: 'error', error: 'Provider unavailable' };
  await assert.rejects(replyToTurn(failure, input, undefined, () => {}), /Provider unavailable/);
  const ctrl = new AbortController();
  let sends = 0;
  const call = async (method) => {
    if (method === 'chat.send') { sends++; return {}; }
    ctrl.abort();
    return { status: 'pending' };
  };
  await assert.rejects(replyToTurn(call, input, ctrl.signal, () => {}), { name: 'AbortError' });
  assert.equal(sends, 1);
});

const readTool = { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } };
const readCall = { id: 'call-1', name: 'read', arguments: { path: 'notes.txt' } };

test('offers only named active Pi tools and checks catalog, prompt and call limits before dispatch', () => {
  assert.deepEqual(nativeCatalog([readTool], 'work context'), { nativeTools: [readTool], nativeSystem: 'work context' });
  assert.deepEqual(nativeCatalog([], 'work context'), {});
  assert.throws(() => nativeCatalog([readTool, readTool], ''), /duplicate/);
  assert.throws(() => nativeCatalog([readTool], 's'.repeat(96 * 1024 + 1)), /instructions/);
  assert.throws(() => nativeCatalog([{ ...readTool, description: 's'.repeat(128 * 1024) }], ''), /128 KiB/);
  assert.deepEqual(allowedCalls([readCall], [readTool], []), [{ type: 'toolCall', ...readCall }]);
  assert.throws(() => allowedCalls([{ ...readCall, name: 'write' }], [readTool], []), /unavailable tool/);
  assert.throws(() => allowedCalls([readCall, readCall], [readTool], []), /previously issued/);
  assert.throws(() => allowedCalls([readCall], [readTool], [readCall.id]), /previously issued/);
  assert.throws(() => allowedCalls([{ ...readCall, arguments: 'invalid' }], [readTool], []), /invalid arguments/);
});

test('passes native tool results to the original durable request across multiple rounds without resubmitting', async () => {
  const thread = [user('Read the note', 21)];
  const first = inputFor(thread);
  const assistant = (call) => ({ role: 'assistant', provider: 'pi-durable', model: model.id, responseId: first.requestId,
    stopReason: 'toolUse', content: [{ type: 'toolCall', ...call }] });
  const result = (id) => ({ role: 'toolResult', toolCallId: id, toolName: 'read', content: [text('workspace value')], isError: false });
  thread.push(assistant(readCall), result(readCall.id));
  const sent = inputFor(thread);
  assert.deepEqual(sent, { id: model.id, requestId: first.requestId, results: [{ id: readCall.id, content: [text('workspace value')], isError: false }] });
  const nextCall = { ...readCall, id: 'call-2' };
  const calls = [];
  const local = async (method) => {
    calls.push(method);
    return method === 'chat.toolResults' ? { accepted: true } : { status: 'tools', calls: [nextCall] };
  };
  assert.deepEqual(await replyToTurn(local, sent, undefined, () => {}), { status: 'tools', calls: [nextCall] });
  assert.deepEqual(calls, ['chat.toolResults', 'chat.turn']);
  thread.push(assistant(nextCall), result(nextCall.id));
  assert.equal(inputFor(thread).requestId, first.requestId);
  assert.deepEqual(inputFor(thread).results.map((item) => item.id), [nextCall.id]);
  assert.throws(() => inputFor(thread, model, 'other session'), /different provider/);
  assert.throws(() => inputFor([...thread.slice(0, -1), result('unrelated')]), /Unexpected/);
  const unsupported = inputFor([...thread.slice(0,-1), { ...result(nextCall.id), content: [{ type: 'binary' }] }]);
  assert.equal(unsupported.results[0].isError, true);
  assert.match(unsupported.results[0].content[0].text, /could not be forwarded/);
});

test('persists exclusive handoff receipts before allowing a tool to run, including competing Pi processes', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-durable-native-claims-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const results = await Promise.allSettled([claimHandoff('same', [readCall], dir), claimHandoff('same', [readCall], dir)]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.match(results.find((result) => result.status === 'rejected').reason.message, /already handed/);
  await assert.rejects(claimHandoff('same', [readCall], dir), /already handed/);
  await claimHandoff('other', [readCall], dir);
});

test('Stop targets this submission only and distinguishes confirmation, settlement and uncertainty', async () => {
  const input = inputFor([user('stop me')]);
  for (const [status, message] of [
    ['cancelled', /cancelled this turn/], ['settled', /already finished/], ['unconfirmed', /could not confirm/],
  ]) {
    const stop = new AbortController();
    const invoked = [];
    const call = async (method, data, options) => {
      invoked.push(method);
      if (method === 'chat.cancel') {
        assert.notEqual(options.signal, stop.signal);
        assert.equal(options.signal.aborted, false);
        assert.deepEqual(data, { id: input.id, requestId: input.requestId });
        return { status };
      }
      if (method === 'chat.turn') stop.abort();
      return { status: 'pending' };
    };
    await assert.rejects(replyToTurn(call, input, stop.signal, () => {}), message);
    assert.deepEqual(invoked, ['chat.send', 'chat.turn', 'chat.cancel']);
  }
});

test('aborting before sending or a transport failure never cancels another turn', async () => {
  const input = inputFor([user('stop me')]);
  const calls = [];
  const offline = async (method) => { calls.push(method); throw new Error('service offline'); };
  await assert.rejects(replyToTurn(offline, input, AbortSignal.abort(), () => {}), { name: 'AbortError' });
  assert.deepEqual(calls, []);
  await assert.rejects(replyToTurn(offline, input, new AbortController().signal, () => {}), /offline/);
  assert.deepEqual(calls, ['chat.send']);
});

test('Stop bounds the cleanup request when the local service does not respond', async () => {
  const input = inputFor([user('stop me')]);
  const stop = new AbortController();
  const calls = [];
  const call = async (method, _params, { signal }) => {
    calls.push(method);
    if (method === 'chat.cancel') await delay(6000, undefined, { signal });
    if (method === 'chat.send') stop.abort();
    return { status: 'pending' };
  };
  await assert.rejects(replyToTurn(call, input, stop.signal, () => {}), /could not confirm/);
  assert.deepEqual(calls, ['chat.send', 'chat.cancel']);
});
