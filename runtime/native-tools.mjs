import { createHash, randomUUID } from 'node:crypto';
import {
  configure, defineDoc, defineDocFamily, defineExtension, defineSignal, defineTool, InboxDoc, LiveDoc, section,
} from '@earendil-works/pi-durable';

const semantics = { version: 1, scope: 'conversation', history: 'latest', fork: 'initial', checkpointWhen: () => false };
const stateDoc = defineDoc({ ...semantics, kind: 'orca.native-tools', initial: () => ({ active: null }) });
const receiptDoc = defineDocFamily({ ...semantics, kind: 'orca.native-tool-receipt', initial: () => ({ hashes: {} }) });
const answer = defineSignal({ name: 'orca.native-tool-result', version: 1, schema: { type: 'object' } });
const toolName = /^[a-zA-Z0-9_.:-]{1,128}$/;
const callId = /^orca_[a-f0-9-]{36}$/;
const deadlineMs = 10 * 60 * 1000;
const jsonSize = value => Buffer.byteLength(JSON.stringify(value));
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const receiptKey = requestId => fingerprint(requestId);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const reject = (message, status = 400) => Object.assign(new Error(message), { status, statusCode: status });
const failed = text => ({ isError: true, output: [{ type: 'text', text }] });

export function nativeContext(nativeTools = [], nativeSystem = '') {
  if (!Array.isArray(nativeTools) || nativeTools.length > 128 || jsonSize(nativeTools) > 128 * 1024 ||
      typeof nativeSystem !== 'string' || Buffer.byteLength(nativeSystem) > 96 * 1024) {
    throw reject('Native tool definitions or system context exceed the supported limits.');
  }
  const seen = new Set();
  const tools = nativeTools.map(tool => {
    if (!object(tool) || typeof tool.name !== 'string' || !toolName.test(tool.name) || seen.has(tool.name) ||
        typeof tool.description !== 'string' || !object(tool.parameters)) throw reject('Invalid native tool definition.');
    seen.add(tool.name);
    return { name: tool.name, description: tool.description, parameters: tool.parameters };
  });
  return nativeSystem || tools.length ? { tools, system: nativeSystem } : null;
}

// A chat opens the grant in the same commit as its user input. Normal requests can still queue
// together. A native run must own exactly one input to keep a different client from using its tools.
export async function prepareNativeInput(tx, conversationId, grant, requestId, existing) {
  const state = await tx.doc(stateDoc, conversationId);
  if (existing) {
    if (state.active?.requestId === requestId && state.active.fingerprint !== fingerprint(grant)) {
      throw reject('This request ID was already used with different native capabilities.', 409);
    }
    return;
  }
  if (state.active) {
    const prev = await tx.submissionByRequest(conversationId, state.active.requestId);
    if (prev && !['done', 'unanswered'].includes(prev.status)) {
      throw reject('Wait for the current native turn before sending another message to this agent.', 409);
    }
    state.active = null;
    await configure(tx, conversationId, { extensions: [] });
  }
  if (!grant) return;
  const live = await tx.doc(LiveDoc, conversationId);
  const inbox = await tx.doc(InboxDoc, conversationId);
  if (live.run || inbox.items.length) throw reject('Wait for the current turn before starting a native turn.', 409);
  state.active = { requestId, fingerprint: fingerprint(grant), tools: grant.tools, system: grant.system, calls: [] };
  await configure(tx, conversationId, { extensions: [nativeExtension], tools: grant.tools.length ? [handoff] : [] });
}

export async function pendingNativeRound(tx, conversationId, input, now) {
  const { active } = await tx.doc(stateDoc, conversationId);
  if (!active || active.requestId !== input.requestId) return;
  const live = await tx.doc(LiveDoc, conversationId);
  if (!live.run?.inputs.includes(input.id)) return;
  const pending = active.calls.filter(call => !call.closed && call.deadline > now);
  if (!pending.length) return;
  const calls = pending.map(({ id, name, arguments: args }) => ({ id, name, arguments: args }));
  const reply = { status: 'tools', calls };
  const usage = pending.find(call => call.usage)?.usage;
  if (usage) reply.usage = usage;
  // Nested arguments and usage are transaction drafts, so detach the full reply before returning.
  return JSON.parse(JSON.stringify(reply));
}

// A native grant serializes admissions until this input settles. A public task id therefore
// stays safe to abort after the transaction; later runs get different task ids. Ordinary
// runs can coalesce inputs, so only their still-queued individual submissions can be withdrawn.
export async function cancelNativeTurn(harness, conv, requestId, ctx) {
  const target = await conv.commit(async tx => {
    const input = await tx.submissionByRequest(conv.id, requestId);
    if (input?.type !== 'input') return { status: 'unconfirmed' };
    if (input.status === 'unanswered') return { status: input.reason === 'aborted' ? 'cancelled' : 'settled' };
    if (input.status === 'done') return { status: 'settled' };
    if (input.status === 'queued') return { submissionId: input.id };
    const { active } = await tx.doc(stateDoc, conv.id);
    const { run } = await tx.doc(LiveDoc, conv.id);
    if (active?.requestId === requestId && run?.inputs.length === 1 && run.inputs[0] === input.id) {
      return { taskId: run.taskId, submissionId: input.id };
    }
    return { status: 'unconfirmed' };
  }, ctx);
  if (target.status) return target;
  const submission = await harness.submission(target.submissionId, ctx);
  if (!submission) return { status: 'unconfirmed' };
  if (target.taskId === undefined) {
    const status = await submission.abort(ctx);
    if (status === 'aborted') return { status: 'cancelled' };
    if (status === 'already_placed') return cancelNativeTurn(harness, conv, requestId, ctx);
  } else {
    await harness.abortTask(target.taskId, ctx);
  }
  const settled = await submission.wait(ctx);
  return { status: settled.status === 'unanswered' && settled.reason === 'aborted' ? 'cancelled' : 'settled' };
}

const handoff = defineTool({
  name: 'call_orca_tool',
  description: 'Run an available tool in the user’s native Orca/Pi session, with its exact name and JSON arguments.',
  parameters: {
    type: 'object', properties: { name: { type: 'string' }, arguments: { type: 'object', additionalProperties: true } },
    required: ['name', 'arguments'], additionalProperties: false,
  },
  replay: 'safe',
  executionMode: 'sequential',
  async execute({ name, arguments: args }, api, ctx) {
    const delivered = await api.readSignal(answer, 'result', ctx);
    if (delivered && 'value' in delivered) {
      return { output: delivered.value.content, isError: delivered.value.isError };
    }
    if (delivered || api.wake?.reason === 'expired') return failed('The native Pi tool result timed out.');
    if (!object(args) || jsonSize(args) > 64 * 1024) return failed('Native tool arguments must be a JSON object up to 64 KiB.');
    const pending = await api.commit(async tx => {
      const { active } = await tx.doc(stateDoc, api.conversationId);
      if (!active || !active.tools.some(tool => tool.name === name)) return null;
      const input = await tx.submissionByRequest(api.conversationId, active.requestId);
      const live = await tx.doc(LiveDoc, api.conversationId);
      if (!input || input.status !== 'placed' || !live.run?.inputs.includes(input.id)) return null;
      let call = active.calls.find(item => item.taskId === api.taskId);
      if (!call) {
        if (active.calls.length >= 32) return null;
        call = { id: 'orca_' + randomUUID(), taskId: api.taskId, name, arguments: args, deadline: api.now() + deadlineMs };
        // Model-issued tool tasks name the exact assistant entry. Report its usage once even
        // when that single generation requested multiple tools which Pi executes sequentially.
        const task = await tx.task(api.taskId);
        if (task?.input?.kind === 'model') {
          call.assistant = task.input.assistant;
          if (!active.calls.some(item => item.assistant === call.assistant)) {
            const entry = await tx.entry(call.assistant);
            const usage = entry?.model?.find(m => m.role === 'assistant')?.usage;
            if (usage) call.usage = usage;
          }
        }
        active.calls.push(call);
      }
      return { until: call.deadline };
    }, ctx);
    if (!pending) return failed('This tool is unavailable for this native turn or the per-turn call limit was reached.');
    if (pending.until <= api.now()) return failed('The native Pi tool result timed out.');
    return { sleep: { until: pending.until, signals: [answer.key('result')] } };
  },
  async cancel(_args, api, ctx) {
    await api.commit(async tx => {
      const { active } = await tx.doc(stateDoc, api.conversationId);
      const call = active?.calls.find(item => item.taskId === api.taskId);
      if (call) call.closed = true;
    }, ctx);
  },
});

export const nativeExtension = defineExtension({
  name: 'orca-native-session', tools: [handoff], sections: [section('orca_native_session', async (input, ctx) => {
    const state = await input.read.snapshot(stateDoc, input.conversationId, ctx);
    if (!state?.active) return undefined;
    const { system, tools } = state.active;
    return [system, tools.length ? 'Use call_orca_tool to invoke the following native tools with their exact names and matching arguments. Wait for a tool result before reporting its output.\n' + JSON.stringify(tools) : '']
      .filter(Boolean).join('\n\n');
  })],
});

function checkedResult(value) {
  if (!object(value) || !callId.test(value.id) || typeof value.isError !== 'boolean' ||
      !Array.isArray(value.content) || value.content.length > 32 || jsonSize(value.content) > 2 * 1024 * 1024) {
    throw reject('Invalid or oversized native tool result.');
  }
  const content = value.content.map(part => {
    if (part?.type === 'text' && typeof part.text === 'string') return { type: 'text', text: part.text };
    if (part?.type === 'image' && ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(part.mimeType) &&
        typeof part.data === 'string' && part.data.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(part.data)) {
      return { type: 'image', mimeType: part.mimeType, data: part.data };
    }
    throw reject('A native tool result must contain text or supported image blocks.');
  });
  return { id: value.id, isError: value.isError, content };
}

export async function acceptNativeResults(tx, conversationId, requestId, results, now) {
  if (!Array.isArray(results) || !results.length || results.length > 32 || jsonSize(results) > 3 * 1024 * 1024) {
    throw reject('Expected 1–32 native tool results up to 3 MiB total.');
  }
  const input = await tx.submissionByRequest(conversationId, requestId);
  if (input?.type !== 'input') throw reject('Message not found.', 404);
  const { active } = await tx.doc(stateDoc, conversationId);
  const receipts = await tx.doc(receiptDoc, conversationId, receiptKey(requestId), null);
  for (const result of results.map(checkedResult)) {
    const digest = fingerprint(result);
    if (Object.hasOwn(receipts.hashes, result.id)) {
      if (receipts.hashes[result.id] !== digest) throw reject('This call already received a different result.', 409);
      continue;
    }
    const call = active?.requestId === requestId && active.calls.find(item => item.id === result.id);
    if (!call || call.closed || call.deadline <= now || input.status !== 'placed') {
      throw reject('This request does not own a pending native tool call with this ID.', 409);
    }
    const delivered = await tx.signal(call.taskId, answer, 'result', { content: result.content, isError: result.isError });
    if (delivered !== 'delivered') throw reject('This native tool call no longer accepts a result.', 409);
    receipts.hashes[result.id] = digest;
    call.closed = true;
  }
  return { accepted: true };
}
