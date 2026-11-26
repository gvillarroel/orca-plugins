import { access, open } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const serviceId = /^[a-z][a-z0-9-]{0,63}$/;
const maxConfig = 256 * 1024;
const maxResponse = 2 * 1024 * 1024;
// Reserve room in Orca's 1 MiB panel reply for the live partial and envelope.
const maxMessageBytes = 160 * 1024;
const maxMessages = 80;
const validNumber = (n) => Number.isSafeInteger(n) && n > 0;
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function localPath(base, value) {
  requireValue(typeof value === 'string' && value.trim() && value.length <= 4096 &&
    !/^[\\/]{2}/.test(value) && !value.includes('\0'), 'La ruta del registro debe ser local.');
  return resolve(base, value);
}

async function readSmallFile(path, limit) {
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    requireValue(stat.isFile() && stat.size <= limit, 'Archivo no válido.');
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    requireValue(length <= limit, 'Archivo demasiado grande.');
    return bytes.toString('utf8', 0, length);
  } finally {
    await file.close();
  }
}

async function readConfig(path) {
  try {
    return JSON.parse(await readSmallFile(path, maxConfig));
  } catch {
    throw new Error('No se pudo leer la configuración JSON del registro externo.');
  }
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw new Error('No se pudo acceder al registro externo.');
  }
}

async function registryFile(root, options) {
  if (options.connectionsFile) {
    requireValue(isAbsolute(options.connectionsFile), 'El registro configurado en Orca requiere una ruta absoluta.');
    return localPath(root, options.connectionsFile);
  }
  if (options.env.PI_DURABLE_CONNECTIONS !== undefined) {
    return localPath(root, options.env.PI_DURABLE_CONNECTIONS);
  }
  if (options.workspaceRoot) {
    for (let directory = root; ; directory = dirname(directory)) {
      const file = join(directory, '.pi', 'durable-agents.json');
      if (await exists(file)) return file;
      if (directory === dirname(directory)) break;
    }
  }
  if (options.extensionDir) {
    const file = join(localPath(root, options.extensionDir), 'durable-agents.json');
    if (await exists(file)) return file;
  }
}

function validRegistration(item) {
  return record(item) && typeof item.id === 'string' && serviceId.test(item.id) &&
    Object.keys(item).every(key => ['id', 'name', 'configPath'].includes(key)) &&
    typeof item.configPath === 'string' && item.configPath.trim() &&
    (item.name === undefined || (typeof item.name === 'string' && item.name.trim() &&
      item.name.length <= 120 && !/[\u0000-\u001f]/.test(item.name)));
}

async function registrations(options) {
  const root = resolve(options.workspaceRoot || process.cwd());
  const path = await registryFile(root, options);
  if (!path) return [];
  const registry = await readConfig(path);
  requireValue(record(registry) && registry.version === 1 && Array.isArray(registry.services) &&
    registry.services.length <= 32 && Object.keys(registry).every(k => ['version', 'services'].includes(k)),
    'El registro externo debe usar el formato de conexiones versión 1.');
  const seen = new Set();
  return registry.services.map(item => {
    requireValue(validRegistration(item) && !seen.has(item.id), 'El registro contiene un servicio inválido o repetido.');
    seen.add(item.id);
    return { id: item.id, configPath: localPath(dirname(path), item.configPath) };
  });
}

async function readService(registration) {
  const config = await readConfig(registration.configPath);
  requireValue(record(config) && config.version === 1 && config.host === '127.0.0.1' &&
    validNumber(config.port) && config.port <= 65535 &&
    !['url', 'baseUrl', 'token', 'authorization', 'username', 'password'].some(key => key in config),
    'El servicio requiere una configuración local en 127.0.0.1 sin credenciales incrustadas.');
  return {
    id: registration.id,
    url: 'http://127.0.0.1:' + config.port,
    tokenPath: join(localPath(dirname(registration.configPath), config.dataDir), 'console-token'),
    configuredAgents: config.agents ?? []
  };
}

async function readToken(service) {
  try {
    const token = (await readSmallFile(service.tokenPath, 256)).trim();
    if (/^[a-f0-9]{64}$/.test(token)) return token;
  } catch { /* Hide filesystem errors and contents from the panel. */ }
  throw new Error('El token local del servicio no está disponible o no es válido.');
}

async function request(service, route, body, signal) {
  const token = await readToken(service);
  let response;
  try {
    // A private direct connection avoids environment proxies. node:http does not follow redirects.
    response = await new Promise((resolve, reject) => {
      const req = httpRequest(service.url + route, {
        agent: false,
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: 'Bearer ' + token, ...(body && { 'content-type': 'application/json' }) },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000)
      }, resolve);
      req.on('error', reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  } catch {
    throw new Error('No se recibió respuesta del servicio local.');
  }
  if (response.statusCode < 200 || response.statusCode >= 300) {
    response.destroy();
    throw new Error('El servicio local respondió con HTTP ' + response.statusCode + '.');
  }
  const oversized = 'La respuesta del servicio externo supera el límite de transferencia de 2 MiB.';
  if (Number(response.headers['content-length']) > maxResponse) {
    response.destroy();
    throw new Error(oversized);
  }
  const chunks = [];
  let length = 0;
  try {
    for await (const part of response) {
      length += part.length;
      if (length > maxResponse) break;
      chunks.push(part);
    }
  } catch {
    throw new Error('La transferencia desde el servicio externo quedó incompleta.');
  }
  requireValue(length <= maxResponse, oversized);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('El servicio externo devolvió JSON inválido.'); }
}

function profiles(service, rows, online) {
  requireValue(Array.isArray(rows), 'El servicio no devolvió una lista de agentes.');
  const seen = new Set();
  return rows.map(agent => {
    requireValue(record(agent) && typeof agent.id === 'string' && serviceId.test(agent.id) &&
      !seen.has(agent.id) && typeof agent.name === 'string', 'La lista de agentes del servicio es inválida.');
    seen.add(agent.id);
    const profile = { id: 'external:' + service.id + '/' + agent.id, name: agent.name,
      managed: false, online: online && agent.active !== 0 && agent.active !== false };
    if (typeof agent.model === 'string') profile.model = agent.model;
    return profile;
  });
}

async function inventory(registration, signal) {
  let agents = [];
  try {
    const service = await readService(registration);
    agents = profiles(service, service.configuredAgents, false);
    const live = await request(service, '/v1/agents', undefined, signal);
    return { agents: profiles(service, live?.agents, true), warnings: [] };
  } catch (error) {
    return { agents, warnings: [registration.id + ': ' + error.message] };
  }
}

function publicText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text).join('\n');
}

function failureMessage(reason) {
  const known = ['model_error', 'no_model', 'aborted', 'reset', 'faulted', 'orphaned', 'interrupted',
    'restart_limit', 'nothing_to_answer', 'turn_limit'];
  return 'El envío quedó sin respuesta (' + (known.includes(reason) ? reason : 'falló el turno') + ').';
}

function chatView(snapshot) {
  requireValue(validNumber(snapshot?.conversation?.id) && Array.isArray(snapshot.entries),
    'El servicio devolvió una conversación inválida.');
  const live = snapshot.docs?.['pi.live'];
  const result = { conversationId: snapshot.conversation.id, messages: [], busy: !!live?.run };
  function clip(text, limit) {
    if (text.length <= limit) return text;
    result.truncated = true;
    const end = /[\uD800-\uDBFF]/.test(text[limit - 1]) ? limit - 1 : limit;
    return text.slice(0, end) + '…';
  }
  let last;
  let bytes = 0;
  entries: for (let i = snapshot.entries.length - 1; i >= 0; i--) {
    const entry = snapshot.entries[i];
    if (!Array.isArray(entry?.model)) continue;
    for (let j = entry.model.length - 1; j >= 0; j--) {
      const message = entry.model[j];
      if (message?.role !== 'user' && message?.role !== 'assistant') continue;
      last ??= message;
      const text = publicText(message.content);
      if (!text.trim()) continue;
      const row = { role: message.role, text: clip(text, 12000) };
      const size = Buffer.byteLength(JSON.stringify(row)) + 1;
      if (result.messages.length >= maxMessages || bytes + size > maxMessageBytes) {
        result.truncated = true;
        break entries;
      }
      result.messages.push(row);
      bytes += size;
    }
  }
  result.messages.reverse();
  const partial = live?.generation?.message;
  if (result.busy && partial?.role === 'assistant') {
    const text = publicText(partial.content);
    if (text.trim()) result.liveText = clip(text, 8000);
  }
  if (!result.busy && last?.role === 'assistant' && ['error', 'aborted'].includes(last.stopReason)) {
    result.error = last.stopReason === 'aborted' ? 'El turno fue cancelado.' : 'Falló la generación de la respuesta.';
  }
  if (!result.busy && live?.runFailure) result.error = failureMessage(live.runFailure.reason);
  return result;
}

/** Connection selection: Orca setting, PI_DURABLE_CONNECTIONS, nearest .pi registry, explicit extensionDir. */
export function createExternalRegistry({ env = process.env, ...defaults } = {}) {
  function options(input) {
    return { ...defaults, env, workspaceRoot: input?.workspaceRoot ?? defaults.workspaceRoot };
  }
  async function target(input) {
    const match = typeof input.id === 'string' && /^external:([a-z][a-z0-9-]{0,63})\/([a-z][a-z0-9-]{0,63})$/.exec(input.id);
    requireValue(match, 'Identificador de agente externo inválido.');
    const rows = await registrations(options(input));
    const registration = rows.find(row => row.id === match[1]);
    requireValue(registration, 'El servicio ya no está registrado.');
    return { service: await readService(registration), route: '/v1/agents/' + match[2] };
  }
  return {
    async list(input = {}) {
      try {
        const rows = await registrations(options(input));
        const all = await Promise.all(rows.map(row => inventory(row, input.signal)));
        return { agents: all.flatMap(item => item.agents), warnings: all.flatMap(item => item.warnings) };
      } catch (error) {
        return { agents: [], warnings: [error.message] };
      }
    },
    async chat(input) {
      const { service, route } = await target(input);
      const view = chatView(await request(service, route + '/chat', undefined, input.signal));
      if (validNumber(input.submissionId) && input.conversationId === view.conversationId) {
        const status = await request(service, route + '/submissions/' + input.submissionId, undefined, input.signal);
        requireValue(status?.conversationId === view.conversationId && status.id === input.submissionId,
          'El recibo no pertenece a esta conversación.');
        if (['queued', 'placed'].includes(status.status)) view.busy = true;
        if (status.status === 'unanswered') view.error = failureMessage(status.reason);
      }
      return view;
    },
    async send(input) {
      requireValue(typeof input.text === 'string' && input.text.trim() && input.text.length <= 100000 &&
        typeof input.requestId === 'string' && input.requestId.trim() && input.requestId.length <= 512,
        'El envío requiere texto y un identificador de solicitud estable.');
      const { service, route } = await target(input);
      try {
        const receipt = await request(service, route + '/messages', {
          content: input.text, requestId: input.requestId, whenBusy: 'followUp'
        }, input.signal);
        requireValue(validNumber(receipt?.conversationId) && validNumber(receipt.submissionId),
          'El servicio devolvió un recibo de admisión inválido.');
        return { accepted: true, requestId: input.requestId,
          conversationId: receipt.conversationId, submissionId: receipt.submissionId };
      } catch (error) {
        const retry = new Error(error.message + ' Para reintentar este envío, conserva el mismo identificador.');
        retry.requestId = input.requestId;
        throw retry;
      }
    }
  };
}
