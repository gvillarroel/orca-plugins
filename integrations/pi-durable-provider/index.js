import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools } from '@earendil-works/pi-ai';
import { callLocal } from '../../plugins/pi-durable/local-client.mjs';
import { durableInput, observeStop, replyToTurn, turnSignature } from './turn.mjs';
import { allowedCalls, claimHandoff, nativeCatalog } from './tools.mjs';

const provider = 'pi-durable';

async function profiles(signal) {
  const roster = await callLocal('agents.list', { summary: true }, { signal });
  return roster.nativeChatVersion === 1 ? roster.agents.filter((agent) => agent.managed) : [];
}

export default async function activate(pi) {
  let agents;
  try {
    agents = await profiles(AbortSignal.timeout(2000));
  } catch {
    // The optional companion must allow regular Pi sessions to start while the local service is offline.
    return;
  }
  if (!agents.length) return;
  const { getBuiltinModel } = await import('@earendil-works/pi-ai/providers/all');
  function descriptor({ id, name, model }) {
    if (model === 'demo') return {
      id, name, reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 32000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const [vendor, modelId] = model.split('/');
    const upstream = getBuiltinModel(vendor, modelId);
    if (!upstream) return null;
    return { id, name, reasoning: false, input: upstream.input, contextWindow: upstream.contextWindow,
      maxTokens: upstream.maxTokens, cost: upstream.cost };
  }

  // Compaction and other auxiliary model calls must never become user turns in the durable transcript.
  let expectedSignature;
  const handoffs = new Map();
  pi.on('context_with_system', (event) => {
    expectedSignature = turnSignature(event.messages);
  });
  pi.on('agent_end', (_event, ctx) => {
    for (const [key, handoff] of handoffs) {
      if (handoff.sessionId === ctx.sessionManager.getSessionId()) {
        handoff.stop.release();
        handoffs.delete(key);
      }
    }
  });

  function streamSimple(model, context, options = {}) {
    const stream = createAssistantMessageEventStream();
    const output = {
      role: 'assistant', api: model.api, model: model.id, provider, content: [], timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'pending',
    };
    async function respond() {
      let stop;
      stream.push({ type: 'start', partial: output });
      try {
        // A running Pi tab may outlive a profile edit or service restart.
        const profile = (await profiles(options.signal)).find((agent) => agent.id === model.id);
        const current = profile && descriptor(profile);
        if (!current) throw new Error('This Pi Durable profile or its native-chat service is unavailable.');
        const input = durableInput(current, options.sessionId, context.messages, expectedSignature);
        const available = profile.model === 'demo' ? [] : getCurrentTools(context.messages);
        if (!input.results && available.length) {
          Object.assign(input, nativeCatalog(available, getCurrentSystemPrompt(context.messages)));
        }
        handoffs.get(input.requestId)?.stop.release();
        handoffs.delete(input.requestId);
        stop = observeStop(callLocal, input, options.signal);
        output.responseId = input.requestId;
        function startText() {
          if (output.content.length) return;
          output.content.push({ type: 'text', text: '' });
          stream.push({ type: 'text_start', contentIndex: 0, partial: output });
        }
        const turn = await replyToTurn(callLocal, input, options.signal, (delta, snapshot) => {
          startText();
          output.content[0].text = snapshot;
          stream.push({ type: 'text_delta', contentIndex: 0, delta, partial: output });
        }, stop);
        if (turn.usage) output.usage = turn.usage;
        // A durable generation may have been retried. Its committed response is authoritative.
        if (output.content.length || turn.status === 'done' || turn.text) {
          startText();
          const text = turn.text ?? output.content[0].text;
          output.content[0].text = text;
          stream.push({ type: 'text_end', contentIndex: 0, content: text, partial: output });
        }
        if (turn.status === 'tools') {
          const sent = context.messages.filter((message) => message.role === 'assistant' &&
            message.provider === provider && message.responseId === input.requestId)
            .flatMap((message) => message.content.filter((part) => part.type === 'toolCall').map((part) => part.id));
          const calls = allowedCalls(turn.calls, available, sent);
          options.signal?.throwIfAborted();
          await claimHandoff(input.requestId, calls);
          options.signal?.throwIfAborted();
          for (const call of calls) {
            const contentIndex = output.content.length;
            output.content.push(call);
            stream.push({ type: 'toolcall_start', contentIndex, partial: output });
            stream.push({ type: 'toolcall_delta', contentIndex, delta: JSON.stringify(call.arguments), partial: output });
            stream.push({ type: 'toolcall_end', contentIndex, toolCall: call, partial: output });
          }
          output.stopReason = 'toolUse';
          handoffs.set(input.requestId, { sessionId: options.sessionId, stop });
        } else {
          output.stopReason = 'stop';
        }
        stream.push({ type: 'done', reason: output.stopReason, message: output });
      } catch (error) {
        output.stopReason = options.signal?.aborted ? 'aborted' : 'error';
        output.errorMessage = options.signal?.aborted ? (await stop?.message() ?? 'Stopped in Pi.') : error.message;
        stream.push({ type: 'error', reason: output.stopReason, error: output });
      } finally {
        if (output.stopReason !== 'toolUse') stop?.release();
        stream.end();
      }
    }
    void respond();
    return stream;
  }

  pi.registerProvider(provider, {
    api: 'pi-durable-local', baseUrl: 'http://127.0.0.1', apiKey: 'local', streamSimple,
    models: agents.map(descriptor).filter(Boolean),
  });
}
