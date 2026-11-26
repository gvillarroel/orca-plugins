import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { configure, createRegistry, defineDoc, Harness, InboxDoc, LiveDoc } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';

const rosterDoc = defineDoc({
  kind: 'orca.agent-roster', version: 1, scope: 'conversation', history: 'latest', fork: 'initial',
  initial: () => ({ agents: [] }), checkpointWhen: () => false,
});
const keys = { openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY' };
const supportedModels = ['demo', 'openai/gpt-4.1-mini', 'anthropic/claude-sonnet-4-6'];
const CHAT_MESSAGE_LIMIT = 80;
const CHAT_JSON_BYTES = 160 * 1024;

function invalid(message, status = 400) {
  return Object.assign(new Error(message), { status, statusCode: status });
}

function string(value, field, limit, { empty = false } = {}) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > limit) {
    throw invalid(`${field} must be ${empty ? '' : 'nonempty '}text of at most ${limit} characters.`);
  }
  return value;
}

function agentId(id) {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
    throw invalid('ID must be 1–64 lowercase letters, digits or hyphens and begin with a letter or digit.');
  }
  return id;
}

function findProfile(roster, id) {
  agentId(id);
  const profile = roster.agents.find((item) => item.id === id);
  if (!profile) throw invalid('Agent not found.', 404);
  return profile;
}

function publicProfile({ id, name, instructions, model }) {
  return { id, name, instructions, model, managed: true };
}

function textContent(content) {
  if (typeof content === 'string') return content;
  return (content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('');
}

function clip(text, limit) {
  if (text.length <= limit) return text;
  // Avoid splitting a UTF-16 surrogate pair at the display boundary.
  const end = /[\uD800-\uDBFF]/.test(text[limit - 1]) ? limit - 1 : limit;
  return text.slice(0, end) + '…';
}

async function chatSnapshot(tx, conversationId) {
  const inbox = await tx.doc(InboxDoc, conversationId);
  const live = await tx.doc(LiveDoc, conversationId);
  const result = { messages: [], busy: Boolean(live.run || inbox.items.length) };
  let bytes = 0;
  function appendNewest(role, content) {
    const original = textContent(content);
    if (!original) return true;
    const text = clip(original, 12000);
    const size = Buffer.byteLength(JSON.stringify({ role, text })) + 1;
    if (result.messages.length >= CHAT_MESSAGE_LIMIT || bytes + size > CHAT_JSON_BYTES) {
      result.truncated = true;
      return false;
    }
    if (text !== original) result.truncated = true;
    bytes += size;
    result.messages.push({ role, text });
    return true;
  }

  let room = true;
  for (let i = inbox.items.length - 1; i >= 0 && room; i--) {
    const item = inbox.items[i];
    if (item.mode !== 'write') room = appendNewest('user', item.content);
  }
  let cursor;
  let pages = 0;
  while (room && pages < 6) {
    const page = await tx.scanEntries({ conversationId, order: 'descending' }, 32, cursor);
    pages++;
    for (const entry of page.items) {
      if (entry.kind !== 'pi.user' && entry.kind !== 'pi.assistant') continue;
      for (const { role, content } of (entry.model ?? []).toReversed()) {
        if (role === 'user' || role === 'assistant') room = appendNewest(role, content);
        if (!room) break;
      }
      if (!room) break;
    }
    cursor = page.next;
    if (cursor === undefined) break;
  }
  if (cursor !== undefined) result.truncated = true;
  result.messages.reverse();
  const partial = textContent(live.generation?.message?.content);
  if (partial) {
    result.liveText = clip(partial, 8000);
    if (partial !== result.liveText) result.truncated = true;
  }
  if (live.runFailure) result.error = clip(live.runFailure.detail || live.runFailure.reason, 2000);
  return result;
}

function demoProvider() {
  const demo = fauxProvider();
  // Script each actual model invocation, including ones resumed after restarting the host.
  function reply(transcript) {
    const lastUser = transcript.messages.findLast((message) => message.role === 'user');
    const text = textContent(lastUser?.content);
    return fauxAssistantMessage('Demo echo: ' + text);
  }
  const provider = { ...demo.provider };
  for (const method of ['stream', 'streamSimple']) {
    provider[method] = (...args) => {
      demo.appendResponses([reply]);
      return demo.provider[method](...args);
    };
  }
  return provider;
}

function modelRef(model, models) {
  if (model === 'demo') return { provider: 'faux', modelId: 'faux-1' };
  string(model, 'Model', 160);
  const [provider, modelId, extra] = model.split('/');
  if (extra !== undefined || !Object.hasOwn(keys, provider) || !models.getModel(provider, modelId)) {
    throw invalid('Select demo or a supported OpenAI or Anthropic provider/model ID.');
  }
  return { provider, modelId };
}

export async function openManager({ dataDir, env = process.env }) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const models = createModels({ authContext: {
    env: async (name) => env[name],
    fileExists: async () => false,
  } });
  models.setProvider(openaiProvider());
  models.setProvider(anthropicProvider());
  models.setProvider(demoProvider());
  const storage = await openNodeSqliteStorage(join(dataDir, 'agents.sqlite'));
  const harness = await Harness.open(storage, {
    models, registry: createRegistry(), settings: { afterFailedRun: 'continue' },
  }, context);
  let root;
  try {
    root = await harness.root(context);
    harness.resume();
  } catch (error) {
    await harness.close(context);
    throw error;
  }

  const profiles = async () => (await harness.snapshot(rosterDoc, root.id, context)) ?? { agents: [] };
  function availableModels() {
    return supportedModels.filter((model) => model === 'demo' || env[keys[model.split('/')[0]]]?.trim());
  }
  function newModel(model) {
    if (!supportedModels.includes(model)) throw invalid('Select a supported model from the helper’s model list.');
    const ref = modelRef(model, models);
    if (model !== 'demo' && !env[keys[ref.provider]]?.trim()) {
      throw invalid(`Set ${keys[ref.provider]} in the helper environment and restart it to select this model.`, 422);
    }
    return ref;
  }
  const conversationFor = async (id) => {
    const { conversationId } = findProfile(await profiles(), id);
    return harness.conversation(conversationId, context);
  };

  return {
    availableModels,

    async list() {
      return (await profiles()).agents.map(publicProfile);
    },

    async profile({ id }) {
      return publicProfile(findProfile(await profiles(), id));
    },

    async create({ name, id, instructions = '', model = 'demo', requestId }) {
      const requestedId = id === undefined || id === '' ? null : agentId(id);
      name = string(name, 'Name', 96).trim();
      string(instructions, 'Instructions', 16000, { empty: true });
      string(model, 'Model', 160);
      let fingerprint;
      if (requestId !== undefined) {
        string(requestId, 'Request ID', 160);
        fingerprint = createHash('sha256').update(JSON.stringify([requestedId, name, instructions, model])).digest('hex');
      }
      // Read the receipt before generating an ID or writing anything. The same commit owns
      // the receipt, metadata and conversation, including when concurrent HTTP calls retry.
      return root.commit(async (tx) => {
        const roster = await tx.doc(rosterDoc, root.id);
        if (requestId !== undefined) {
          const existing = roster.agents.find((item) => item.recruitment?.requestId === requestId);
          if (existing) {
            if (existing.recruitment.fingerprint !== fingerprint) throw invalid('This request ID was used for a different agent.', 409);
            return publicProfile(existing);
          }
        }
        const stableId = requestedId ?? randomUUID();
        if (roster.agents.some((p) => p.id === stableId)) throw invalid('This agent ID is already in use.', 409);
        const ref = newModel(model);
        const conversation = await tx.createConversation({ ownership: { kind: 'ownerless' } });
        await configure(tx, conversation.id, { instructions, model: ref });
        const item = { id: stableId, name, instructions, model, conversationId: conversation.id };
        if (requestId !== undefined) item.recruitment = { requestId, fingerprint };
        roster.agents.push(item);
        return publicProfile(item);
      }, context);
    },

    async update({ id, name, instructions, model }) {
      return root.commit(async (tx) => {
        const profile = findProfile(await tx.doc(rosterDoc, root.id), id);
        if (name !== undefined) profile.name = string(name, 'Name', 96).trim();
        const changeInstructions = instructions !== undefined && instructions !== profile.instructions;
        const changeModel = model !== undefined && model !== profile.model;
        if (changeInstructions || changeModel) {
          const live = await tx.doc(LiveDoc, profile.conversationId);
          if (live.run) throw invalid('Wait for the current reply before editing this agent.', 409);
          const changes = {};
          if (changeInstructions) {
            profile.instructions = string(instructions, 'Instructions', 16000, { empty: true });
            changes.instructions = profile.instructions;
          }
          if (changeModel) {
            changes.model = newModel(model);
            profile.model = model;
          }
          await configure(tx, profile.conversationId, changes);
        }
        return publicProfile(profile);
      }, context);
    },

    async chat({ id }) {
      const conv = await conversationFor(id);
      // Read the transcript, queued inputs and live response at one commit boundary.
      const result = await conv.commit((tx) => chatSnapshot(tx, conv.id), context);
      if (result.error) {
        for (const name of Object.values(keys)) {
          if (env[name]) result.error = result.error.replaceAll(env[name], '[redacted]');
        }
      }
      return result;
    },

    async send({ id, text, requestId }) {
      string(text, 'Message', 32000);
      string(requestId, 'Request ID', 160);
      const conv = await conversationFor(id);
      await conv.commit(async (tx) => {
        const existing = await tx.submissionByRequest(conv.id, requestId);
        if (existing) {
          const original = existing.entry === undefined
            ? (await tx.doc(InboxDoc, conv.id)).items.find((item) => item.id === existing.id)?.content
            : (await tx.entry(existing.entry))?.model?.[0]?.content;
          if (original !== undefined && textContent(original) !== text) {
            throw invalid('This request ID was already used for a different message.', 409);
          }
          return;
        }
        const profile = findProfile(await tx.doc(rosterDoc, root.id), id);
        const { provider } = modelRef(profile.model, models);
        const key = keys[provider];
        if (key && !env[key]?.trim()) throw invalid(`Set ${key} in the helper environment and restart it before sending.`, 422);
        await conv.submit(tx, { type: 'input', content: text, requestId });
      }, context);
      return { accepted: true };
    },

    close: () => harness.close(context),
  };
}
