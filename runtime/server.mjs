import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openManager } from './manager.mjs';

const host = '127.0.0.1';
const methods = new Map([
  ['agents.list', async (manager, { summary }) => {
    const profiles = await manager.list();
    if (!summary) return { agents: profiles };
    return {
      agents: profiles.map(({ id, name, model, managed }) => ({ id, name, model, managed })),
      models: manager.availableModels(),
      nativeChatVersion: 1,
    };
  }],
  ['agents.profile', (manager, params) => manager.profile(params)],
  ['agents.create', (manager, params) => manager.create(params)],
  ['agents.update', (manager, params) => manager.update(params)],
  ['chat.read', (manager, params) => manager.chat(params)],
  ['chat.turn', (manager, params) => manager.turn(params)],
  ['chat.toolResults', (manager, params) => manager.toolResults(params)],
  ['chat.cancel', (manager, params) => manager.cancel(params)],
  ['chat.send', (manager, params) => manager.send(params)],
]);

function reply(response, status, result) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(result));
}

async function readParams(request, maxBytes) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('The request exceeds the size limit.');
    chunks.push(chunk);
  }
  let params;
  try {
    params = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('The request must contain valid JSON.');
  }
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new Error('Expected a JSON object containing the request parameters.');
  }
  return params;
}

// Binding before opening SQLite also reserves ownership against a second process.
export async function startService({ dataDir = join(homedir(), '.pi-durable-orca'), port = 47896 } = {}) {
  const token = randomBytes(32).toString('hex');
  const expected = Buffer.from('Bearer ' + token);
  const descriptor = join(dataDir, 'connection.json');
  const pending = new Set();
  let manager;
  let ready = false;

  async function handle(request, response) {
    const address = server.address();
    if (!ready || !address) return reply(response, 503, { error: 'The service is starting or shutting down.' });
    const supplied = Buffer.from(request.headers.authorization ?? '');
    if (request.headers.host !== host + ':' + address.port || request.headers.origin ||
        supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      return reply(response, 403, { error: 'Access denied.' });
    }
    const operation = methods.get(request.url?.slice(1));
    if (!operation) return reply(response, 404, { code: 'unknown_operation', error: 'Unknown operation.' });
    if (request.method !== 'POST' || request.headers['content-type'] !== 'application/json') {
      return reply(response, 400, { error: 'Use a POST request with a JSON body.' });
    }
    try {
      const maxBytes = request.url === '/chat.send' ? 12 * 1024 * 1024 :
        request.url === '/chat.toolResults' ? 3 * 1024 * 1024 + 4096 : 512 * 1024;
      const params = await readParams(request, maxBytes);
      const result = await operation(manager, params);
      reply(response, 200, result);
    } catch (error) {
      const status = [400, 404, 409, 422].includes(error.statusCode) ? error.statusCode : 400;
      reply(response, status, { error: error.message || 'The local operation failed.' });
    }
  }

  const server = createServer({ requestTimeout: 15000, headersTimeout: 10000 }, (req, res) => {
    const task = handle(req, res).catch(() => res.destroy());
    pending.add(task);
    task.finally(() => pending.delete(task));
  });
  const stopListening = () => new Promise(resolve => server.close(resolve));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  try {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    manager = await openManager({ dataDir });
    const temporary = descriptor + '.' + process.pid + '.tmp';
    await writeFile(temporary, JSON.stringify({ port: server.address().port, token }), { mode: 0o600, flag: 'wx' });
    await rename(temporary, descriptor);
    ready = true;
  } catch (error) {
    try { await manager?.close(); } finally { await stopListening(); }
    throw error;
  }

  let stopping;
  async function shutdown() {
    ready = false;
    try {
      const current = JSON.parse(await readFile(descriptor, 'utf8'));
      if (current.token === token) await rm(descriptor);
    } finally {
      await Promise.allSettled([...pending]);
      try { await manager.close(); } finally { await stopListening(); }
    }
  }
  return { port: server.address().port, close: () => stopping ??= shutdown() };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const service = await startService();
    console.log('Pi Durable is ready on this computer. Open the Pi Durable panel in Orca. Press Ctrl+C to stop.');
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.once(signal, () => service.close().catch(error => {
        console.error(error.message);
        process.exitCode = 1;
      }));
    }
  } catch (error) {
    console.error(error.code === 'EADDRINUSE'
      ? 'Local port 47896 is already in use. Check whether the Pi Durable service is running.'
      : error.message);
    process.exitCode = 1;
  }
}
