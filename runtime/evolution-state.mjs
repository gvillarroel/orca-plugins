import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { AssistantEntry, configure, defineDoc, defineDocFamily, InboxDoc, LiveDoc, UserEntry } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT as context, withAbortSignal } from '@earendil-works/chord/context';
import { initialScript, developScript, runAgentScript } from './evolution.mjs';

const buildTimeout = 5 * 60 * 1000;
const freshScript = () => ({ source: initialScript, checks: [] });
const docOptions = { version: 1, scope: 'conversation', history: 'latest', fork: 'initial', checkpointWhen: () => false };
const scriptDoc = defineDoc({ ...docOptions, kind: 'orca.agent-script',
  initial: () => ({ revision: 1, active: freshScript(), previous: null, job: null, proposal: null }) });
const requests = defineDocFamily({ ...docOptions, family: true, kind: 'orca.evolution-request', initial: () => ({ fingerprint: null }) });
const bad = (message, code = 400) => Object.assign(new Error(message), { statusCode: code });
const digest = (text) => createHash('sha256').update(text).digest('hex');
const plain = (value) => JSON.parse(JSON.stringify(value));
function checkedText(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw bad(label + ' must be text of up to ' + max + ' characters.');
  return value.trim();
}
function snapshot(state, model) {
  const { writerId, deadline, ...job } = state.job || {};
  return plain({ model, revision: state.revision, source: state.active.source, proposal: state.proposal,
    canRollback: !!state.previous, job: state.job ? job : null });
}

function acceptanceExample(examples = []) {
  if (!Array.isArray(examples) || examples.length > 1) throw bad('Supply at most one acceptance example.');
  return examples.map(example => {
    if (!example || typeof example.input !== 'string' || !example.input.trim() || example.input.length > 1000 ||
        typeof example.expected !== 'string' || !example.expected.trim() || example.expected.length > 1000) {
      throw bad('Provide an example message and expected reply of up to 1,000 characters each.');
    }
    return { input: example.input, expected: example.expected };
  });
}

export async function evolutionIsRunning(tx, conversationId) {
  return (await tx.doc(scriptDoc, conversationId)).job?.status === 'running';
}

async function requireIdle(tx, conversationId) {
  const live = await tx.doc(LiveDoc, conversationId);
  const inbox = await tx.doc(InboxDoc, conversationId);
  if (live.run || inbox.items.length) throw bad('Wait for the current conversation turn to finish.', 409);
}

export async function evaluateForChat(harness, conversationId, input) {
  if (typeof input !== 'string') return null;
  const state = await harness.snapshot(scriptDoc, conversationId, context);
  const revision = state?.revision ?? 1;
  if (!state || state.active.source === initialScript) return { revision };
  // Guest code runs outside the SQLite transaction. Commit only against the revision evaluated.
  try { return { revision, answer: await runAgentScript(state.active.source, input) }; }
  catch (error) { return { revision, error }; }
}

export async function commitScriptReply(tx, conversationId, input, requestId, evaluated, now) {
  if (!evaluated) return false;
  const state = await tx.doc(scriptDoc, conversationId);
  if (state.revision !== evaluated.revision) throw bad('The active script changed. Retry this message.', 409);
  if (evaluated.error) throw bad('The agent script failed: ' + evaluated.error.message, 422);
  if (typeof evaluated.answer !== 'string') return false;
  await requireIdle(tx, conversationId);
  const timestamp = now();
  const content = [{ type: 'text', text: evaluated.answer }];
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const user = await tx.appendEntry(UserEntry, conversationId, { model: [{ role: 'user', content: input, timestamp }] });
  const assistant = await tx.appendEntry(AssistantEntry, conversationId, { model: [{
    role: 'assistant', content, timestamp, usage, stopReason: 'stop', api: 'pi-durable-script',
    provider: 'pi-durable-script', model: 'revision-' + state.revision,
  }] });
  await tx.createSubmission({ type: 'input', conversationId, requestId, status: 'done', entry: user.id, answer: assistant.id });
  return true;
}

export function createEvolutionManager({ harness, root, find, list, modelRef, availableModels, redact, now }) {
  const active = new Map();
  const closing = new AbortController();
  const { signal } = closing;
  function checkDeadline(job) {
    signal.throwIfAborted();
    if (now() >= job.deadline) throw bad('The evolution builder timed out after five minutes. Try again.', 408);
  }
  async function withAgent(id, callback) {
    return root.commit(async tx => {
      const profile = await find(tx, id);
      const state = await tx.doc(scriptDoc, profile.conversationId);
      return callback(tx, state, profile);
    }, context);
  }
  async function authorReply(id, job, { system, prompt }) {
    checkDeadline(job);
    const writerId = await withAgent(id, async (tx, state) => {
      if (state.job?.requestId !== job.requestId || state.job.status !== 'running') throw bad('Evolution request changed.', 409);
      if (state.job.writerId) return state.job.writerId;
      const writer = await tx.createConversation({ ownership: { kind: 'ownerless' } });
      await configure(tx, writer.id, { instructions: system, model: modelRef(job.builder), extensions: [], tools: [] });
      state.job.writerId = writer.id;
      return writer.id;
    });
    const writer = await harness.conversation(writerId, context);
    checkDeadline(job);
    await writer.submit({ type: 'input', content: prompt, requestId: 'write-script' }, context);
    for (;;) {
      checkDeadline(job);
      const answer = await writer.commit(async tx => {
        const submission = await tx.submissionByRequest(writerId, 'write-script');
        if (submission?.status === 'unanswered') throw bad('The evolution agent could not finish: ' +
          (typeof submission.detail === 'string' ? submission.detail : submission.reason), 422);
        if (submission?.status !== 'done') return null;
        const entry = await tx.entry(submission.answer);
        const message = entry?.model?.find(item => item.role === 'assistant');
        return (message?.content || []).filter(part => part.type === 'text').map(part => part.text).join('');
      }, context);
      if (answer !== null) return answer;
      await delay(180, undefined, { signal });
    }
  }
  async function build(id, requestId) {
    const saved = await withAgent(id, (_tx, state) => {
      if (state.job?.status === 'running') state.job.deadline ??= now() + buildTimeout;
      return plain({ job: state.job, script: state.active });
    });
    const { job, script } = saved;
    if (job?.status !== 'running' || job.requestId !== requestId) return;
    try {
      checkDeadline(job);
      const result = await developScript({ requirement: job.requirement, previous: script.source, checks: script.checks,
        model: job.builder, acceptance: job.acceptance, author: args => authorReply(id, job, args), signal });
      await withAgent(id, (_tx, state) => {
        if (state.job?.requestId !== job.requestId || state.revision !== job.baseRevision) throw bad('Evolution request is stale.', 409);
        checkDeadline(job);
        state.proposal = { requestId: job.requestId, requirement: job.requirement, builder: job.builder,
          baseRevision: job.baseRevision, source: result.script, checks: result.checks, summary: result.summary };
        state.job = null;
      });
    } catch (error) {
      if (signal.aborted) return;
      if (error.statusCode === 408) {
        const writerId = await withAgent(id, (_tx, state) => state.job?.requestId === requestId && state.job.writerId);
        if (writerId) {
          // Pi marks this private conversation for cancellation before waiting for it to go idle.
          // Bound that wait so a slow provider cannot hold open the target or delay service shutdown.
          const cleanupTimeout = AbortSignal.timeout(5000);
          const cleanup = withAbortSignal(AbortSignal.any([signal, cleanupTimeout]), context);
          try {
            const writer = await harness.conversation(writerId, cleanup);
            await writer.abort(cleanup);
          }
          catch (cause) {
            if (signal.aborted) return; // Recovery retries the expired job.
            if (!cleanupTimeout.aborted) console.error('Could not stop the expired evolution writer:', redact(cause.message));
          }
        }
      }
      if (signal.aborted) return;
      await withAgent(id, (_tx, state) => {
        if (state.job?.requestId === job.requestId) {
          state.job.status = 'failed';
          state.job.error = redact(String(error.message || error)).slice(0, 1800);
        }
      });
    }
  }
  function schedule(id, requestId) {
    const key = JSON.stringify([id, requestId]);
    if (signal.aborted || active.has(key)) return;
    const task = build(id, requestId).finally(() => active.delete(key));
    active.set(key, task);
    // The agent can have been deleted between reading the roster and scheduling recovery.
    task.catch(error => { if (error.statusCode !== 404 && !signal.aborted) console.error('Evolution worker:', redact(error.message)); });
  }
  return {
    async recover() {
      for (const item of await list()) {
        const state = await harness.snapshot(scriptDoc, item.conversationId, context);
        if (state?.job?.status === 'running') schedule(item.id, state.job.requestId);
      }
    },
    async close() { closing.abort(); await Promise.allSettled([...active.values()]); },
    get: ({ id }) => withAgent(id, (_tx, state, profile) => snapshot(state, profile.model)),
    async propose({ id, requestId, requirement, builderModel, acceptance }) {
      requestId = checkedText(requestId, 'Request ID', 160);
      requirement = checkedText(requirement, 'Requirement', 3000);
      acceptance = acceptanceExample(acceptance);
      const result = await withAgent(id, async (tx, state, profile) => {
        const builder = builderModel ?? profile.model;
        const receipt = await tx.doc(requests, profile.conversationId, digest(requestId), null);
        const fingerprint = digest(JSON.stringify([requirement, builderModel ?? null, acceptance]));
        if (receipt.fingerprint) {
          if (fingerprint !== receipt.fingerprint) throw bad('This request ID belongs to another evolution.', 409);
          return snapshot(state, profile.model);
        }
        if (!availableModels().includes(builder)) throw bad('Select a configured evolution model.', 422);
        if (state.job?.status === 'running') throw bad('An evolution is already running for this agent.', 409);
        receipt.fingerprint = fingerprint;
        state.job = { requestId, requirement, builder, acceptance, baseRevision: state.revision,
          status: 'running', deadline: now() + buildTimeout };
        state.proposal = null;
        return snapshot(state, profile.model);
      });
      if (result.job?.status === 'running') schedule(id, result.job.requestId);
      return result;
    },
    apply: ({ id, requestId, baseRevision }) => withAgent(id, async (tx, state, profile) => {
      checkedText(requestId, 'Request ID', 160);
      if (!Number.isSafeInteger(baseRevision) || baseRevision < 1) throw bad('Select a valid base revision.');
      if (state.lastApplied === requestId && state.revision === baseRevision + 1) return snapshot(state, profile.model);
      const proposal = state.proposal;
      if (!proposal || proposal.requestId !== requestId || baseRevision !== state.revision || baseRevision !== proposal.baseRevision) {
        throw bad('This proposal is no longer current. Reload the agent before applying changes.', 409);
      }
      await requireIdle(tx, profile.conversationId);
      state.previous = plain(state.active);
      state.active = { source: proposal.source, checks: plain(proposal.checks) };
      state.revision++;
      state.proposal = null;
      state.lastApplied = requestId;
      state.lastRollback = null;
      return snapshot(state, profile.model);
    }),
    rollback: ({ id, revision }) => withAgent(id, async (tx, state, profile) => {
      if (!Number.isSafeInteger(revision) || revision < 1) throw bad('Select a valid revision.');
      if (state.lastRollback === revision && state.revision === revision + 1) return snapshot(state, profile.model);
      if (!state.previous || revision !== state.revision || state.job?.status === 'running') {
        throw bad('Reload the current revision before restoring its previous script.', 409);
      }
      await requireIdle(tx, profile.conversationId);
      state.active = plain(state.previous);
      state.previous = null;
      state.proposal = null;
      state.job = null;
      state.revision++;
      state.lastApplied = null;
      state.lastRollback = revision;
      return snapshot(state, profile.model);
    }),
  };
}
