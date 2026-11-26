import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { toolResults } from './tools.mjs';

// Pi can batch multiple user messages before the next provider call.
function userInputs(messages) {
  const inputs = [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === 'system') continue;
    if (message.role !== 'user') break;
    inputs.push(message);
  }
  return inputs.reverse();
}

function round(messages) {
  const chat = messages.filter((message) => message.role !== 'system');
  if (chat.at(-1)?.role !== 'toolResult') return { users: userInputs(chat) };
  let end = chat.length;
  while (end && chat[end - 1].role === 'toolResult') end--;
  const assistant = chat[end - 1];
  if (assistant?.role !== 'assistant') return { users: [] };
  const lastUser = chat.findLastIndex((message) => message.role === 'user');
  return { users: userInputs(chat.slice(0, lastUser + 1)), assistant, results: chat.slice(end) };
}

function userSignature(inputs) {
  if (!inputs.length) return null;
  const hash = createHash('sha256');
  for (const { timestamp, content } of inputs) hash.update(JSON.stringify([timestamp, content]));
  return hash.digest('hex');
}

export function turnSignature(messages) {
  const { users, assistant, results } = round(messages);
  const signature = userSignature(users);
  return assistant && signature ? createHash('sha256').update(JSON.stringify([signature, assistant.responseId, results])).digest('hex') : signature;
}

export function durableInput(model, sessionId, messages, expectedSignature) {
  if (!sessionId || !expectedSignature || expectedSignature !== turnSignature(messages)) {
    throw new Error('Pi Durable accepts user chat turns. This Pi operation requires a separate model.');
  }
  const { users: inputs, assistant, results } = round(messages);
  const receipt = createHash('sha256').update(JSON.stringify([model.id, sessionId, userSignature(inputs)])).digest('hex');
  const identity = { id: model.id, requestId: 'pi-' + receipt };
  if (assistant) return { ...identity, results: toolResults(assistant, results, model, identity.requestId) };
  const blocks = [];
  let images = 0;
  let imageBytes = 0;
  let textLength = 0;
  for (const { content, timestamp } of inputs) {
    if (!Number.isSafeInteger(timestamp)) throw new Error('Pi did not identify this user message.');
    if (blocks.length) {
      blocks.push({ type: 'text', text: '\n\n' });
      textLength += 2;
    }
    const parts = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
    if (!Array.isArray(parts)) throw new Error('Invalid Pi message content.');
    for (const part of parts) {
      if (part?.type === 'text' && typeof part.text === 'string') {
        textLength += part.text.length;
        blocks.push({ type: 'text', text: part.text });
      } else if (part?.type === 'image') {
        if (!model.input.includes('image')) throw new Error('This Pi Durable model accepts text only. Remove the image or choose a vision model.');
        if (typeof part.data !== 'string' || !part.data || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(part.mimeType)) {
          throw new Error('Attach a PNG, JPEG, WebP or GIF image.');
        }
        images++;
        imageBytes += Buffer.byteLength(part.data, 'base64');
        if (images > 4 || imageBytes > 8 * 1024 * 1024) throw new Error('Attach up to four images totaling at most 8 MiB.');
        blocks.push({ type: 'image', data: part.data, mimeType: part.mimeType });
      } else {
        throw new Error('Pi Durable accepts text and supported image attachments only.');
      }
    }
  }
  if (textLength > 32000) throw new Error('Send up to 32,000 characters of text to Pi Durable.');
  const text = images ? undefined : blocks.map((part) => part.text).join('');
  if (!images && !text.trim()) throw new Error('Enter a message to send to Pi Durable.');
  // Pi preserves user-message timestamps on retries. A new send of the same text has its own timestamp.
  return { ...identity, ...(images ? { content: blocks } : { text }) };
}

const stopMessages = {
  cancelled: 'Pi Durable cancelled this turn.',
  settled: 'This Pi Durable turn had already finished.',
  unconfirmed: 'Pi stopped waiting. Pi Durable could not confirm cancellation of this turn.',
};

// A Stop can also arrive between model calls while Pi runs a tool. Keep this observer for that handoff.
export function observeStop(call, { id, requestId }, signal) {
  signal?.throwIfAborted();
  let confirmation;
  async function cancel() {
    try {
      const result = await call('chat.cancel', { id, requestId }, { signal: AbortSignal.timeout(2000) });
      return stopMessages[result.status] ?? stopMessages.unconfirmed;
    } catch {
      return stopMessages.unconfirmed;
    }
  }
  function onAbort() { confirmation ??= cancel(); }
  signal?.addEventListener('abort', onAbort, { once: true });
  return {
    message: () => confirmation,
    release: () => signal?.removeEventListener('abort', onAbort),
  };
}

export async function replyToTurn(call, input, signal, onText, observer) {
  const stop = observer ?? observeStop(call, input, signal);
  try {
    return await submitAndWait(call, input, signal, onText);
  } catch (error) {
    if (signal?.aborted) throw new DOMException(await stop.message() ?? 'Stopped in Pi.', 'AbortError');
    throw error;
  } finally {
    if (!observer) stop.release();
  }
}

async function submitAndWait(call, input, signal, onText) {
  signal?.throwIfAborted();
  const { id, requestId } = input;
  if (input.results) {
    // Each result has its own durable receipt. Send them separately so parallel tool output stays
    // within the transport limit and a connection loss can replay the completed prefix safely.
    for (const result of input.results) {
      signal?.throwIfAborted();
      await call('chat.toolResults', { id, requestId, results: [result] }, { signal });
    }
  } else {
    await call('chat.send', input, { signal });
  }
  let streamed = '';
  while (true) {
    signal?.throwIfAborted();
    const turn = await call('chat.turn', { id, requestId }, { signal });
    if (['pending', 'tools', 'done'].includes(turn.status) && typeof turn.text === 'string' &&
        turn.text.length > streamed.length && turn.text.startsWith(streamed)) {
      onText(turn.text.slice(streamed.length), turn.text);
      streamed = turn.text;
    }
    if (turn.status === 'done' && typeof turn.text === 'string') return turn;
    if (turn.status === 'tools') return turn;
    if (turn.status === 'error') throw new Error(turn.error || 'The durable turn failed.');
    if (turn.status !== 'pending') throw new Error('The Pi Durable service returned an unknown turn state.');
    await delay(350, undefined, { signal });
  }
}
