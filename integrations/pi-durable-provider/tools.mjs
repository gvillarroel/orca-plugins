import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const maxResultBytes = 2 * 1024 * 1024;
const toolName = /^[A-Za-z0-9_.:-]{1,128}$/;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const bytes = (value) => Buffer.byteLength(JSON.stringify(value));

export function nativeCatalog(tools, system) {
  if (!tools.length) return {};
  const names = new Set();
  const nativeTools = tools.map(({ name, description, parameters }) => {
    if (typeof name !== 'string' || !toolName.test(name) || names.has(name) || typeof description !== 'string' || !object(parameters)) {
      throw new Error('The active Pi tool catalog contains an invalid or duplicate definition.');
    }
    names.add(name);
    return { name, description, parameters };
  });
  if (nativeTools.length > 128 || bytes(nativeTools) > 128 * 1024) {
    throw new Error('The Pi tool catalog exceeds 128 tools or 128 KiB. Disable unneeded tools for this session.');
  }
  if (Buffer.byteLength(system) > 96 * 1024) {
    throw new Error('The Pi system instructions exceed 96 KiB. Shorten their workspace context and retry.');
  }
  return { nativeTools, nativeSystem: system };
}

export function allowedCalls(calls, available, alreadySent) {
  if (!Array.isArray(calls) || !calls.length || calls.length > 32) throw new Error('Invalid Pi Durable tool handoff.');
  const names = new Set(available.map((tool) => tool.name));
  const seen = new Set(alreadySent);
  return calls.map((call) => {
    if (!object(call)) throw new Error('Invalid Pi Durable tool call.');
    const { id, name, arguments: args } = call;
    if (typeof id !== 'string' || !id || id.length > 128 || seen.has(id)) {
      throw new Error('Pi Durable returned a missing or previously issued tool call ID.');
    }
    if (!names.has(name) || !object(args) || bytes(args) > 64 * 1024) {
      throw new Error('Pi Durable requested an unavailable tool or invalid arguments. No tool was started.');
    }
    seen.add(id);
    return { type: 'toolCall', id, name, arguments: args };
  });
}

// Persist the claim before yielding any tool call to Pi. A crash at that boundary leaves the outcome unknown.
export async function claimHandoff(requestId, calls, dir = join(homedir(), '.pi-durable-orca', 'native-tool-receipts')) {
  await mkdir(dir, { mode: 0o700, recursive: true });
  for (const { id } of calls) {
    const fingerprint = createHash('sha256').update(JSON.stringify([requestId, id])).digest('hex');
    try {
      await writeFile(join(dir, fingerprint), '', { flag: 'wx', mode: 0o600, flush: true });
    } catch (error) {
      if (error.code === 'EEXIST') {
        throw new Error('This tool call was already handed to Pi. Its outcome is unknown. Inspect the tool history before starting another action.');
      }
      throw new Error('Could not record the native tool handoff. No tool was started.');
    }
  }
}

export function toolResults(assistant, messages, model, requestId) {
  if (assistant.provider !== 'pi-durable' || assistant.model !== model.id ||
      assistant.responseId !== requestId || assistant.stopReason !== 'toolUse') {
    throw new Error('These tool results belong to a different provider, profile or user turn.');
  }
  const calls = new Map();
  for (const part of assistant.content) {
    if (part.type !== 'toolCall') continue;
    if (calls.has(part.id)) throw new Error('Duplicate native tool call ID.');
    calls.set(part.id, part.name);
  }
  const results = messages.map(({ toolCallId: id, toolName: name, content, isError }) => {
    if (!calls.has(id) || calls.get(id) !== name || typeof isError !== 'boolean') {
      throw new Error('Unexpected or repeated native tool result.');
    }
    calls.delete(id);
    if (!Array.isArray(content) || content.length > 32 || bytes(content) > maxResultBytes || content.some((part) => !(
      (part?.type === 'text' && typeof part.text === 'string') ||
      (part?.type === 'image' && model.input.includes('image') && typeof part.data === 'string' &&
        part.data.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(part.data) &&
        ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(part.mimeType))
    ))) {
      return { id, isError: true, content: [{ type: 'text', text: 'Pi ran the tool, but its result could not be forwarded: unsupported content or more than 32 blocks or 2 MiB.' }] };
    }
    return { id, isError, content: content.map((part) => part.type === 'text'
      ? { type: 'text', text: part.text } : { type: 'image', mimeType: part.mimeType, data: part.data }) };
  });
  if (calls.size) throw new Error('Pi has not returned all results for this tool handoff.');
  return results;
}
