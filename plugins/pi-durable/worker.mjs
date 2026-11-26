import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createExternalRegistry } from './external.mjs';

const offline = 'Inicia el servicio de Pi Durable con npm start desde la carpeta runtime del repositorio.';

export async function callLocal(method, params, {
  dataDir = join(homedir(), '.pi-durable-orca'),
  signal,
} = {}) {
  let connection;
  try {
    connection = JSON.parse(await readFile(join(dataDir, 'connection.json'), 'utf8'));
  } catch {
    throw new Error(offline);
  }
  if (!Number.isInteger(connection.port) || connection.port < 1 || connection.port > 65535 ||
      typeof connection.token !== 'string' || !/^[0-9a-f]{64}$/.test(connection.token)) {
    throw new Error('Conexión local inválida. Reinicia el servicio de Pi Durable.');
  }
  const timeout = AbortSignal.timeout(10000);
  let response;
  try {
    response = await fetch('http://127.0.0.1:' + connection.port + '/' + method, {
      method: 'POST',
      redirect: 'error',
      headers: { Authorization: 'Bearer ' + connection.token, 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (error) {
    if (signal?.aborted || timeout.aborted) throw new Error('Se agotó el tiempo de espera del servicio local.');
    throw new Error(offline);
  }
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error || 'El servicio local rechazó la solicitud.'), { status: response.status });
  return result;
}

function receiptKey(id, file) {
  return 'receipt-' + createHash('sha256').update(file + '\n' + id).digest('hex');
}

const pageSize = 200;

function displayLabel(text, limit) {
  if (text.length <= limit) return text;
  const end = /[\uD800-\uDBFF]/.test(text[limit - 1]) ? limit - 1 : limit;
  return text.slice(0, end) + '…';
}

function rosterSummary({ id, name, model, managed, online }) {
  const agent = { id, name: displayLabel(name, 200), managed };
  if (typeof model === 'string') agent.model = displayLabel(model, 160);
  if (typeof online === 'boolean') agent.online = online;
  return agent;
}

/** A panel can replay a page after losing its reply without restarting discovery. */
export function createRosterHandler(load) {
  const snapshots = new Map();
  function forget(panelId) {
    clearTimeout(snapshots.get(panelId)?.timer);
    snapshots.delete(panelId);
  }
  function page(snapshot, offset) {
    const end = offset + pageSize;
    const result = { agents: snapshot.agents.slice(offset, end) };
    if (end < snapshot.agents.length) result.nextCursor = snapshot.token + ':' + end;
    return result;
  }
  return async (params, { panel, signal }) => {
    const panelId = panel.id;
    const expired = 'La página de agentes ya no está disponible. Actualiza la lista.';
    if (params?.cursor !== undefined) {
      const snapshot = snapshots.get(panelId);
      const cursor = params.cursor;
      const offset = typeof cursor === 'string' ? Number(cursor.split(':')[1]) : NaN;
      if (!snapshot?.agents || !Number.isSafeInteger(offset) || offset <= 0 || offset % pageSize ||
          offset >= snapshot.agents.length || cursor !== snapshot.token + ':' + offset) {
        throw new Error(expired);
      }
      return page(snapshot, offset);
    }
    forget(panelId);
    // Bound abandoned snapshots in both count and lifetime, including panels closed mid-read.
    if (snapshots.size >= 16) forget(snapshots.keys().next().value);
    const snapshot = { token: randomUUID(), timer: setTimeout(() => forget(panelId), 120000) };
    snapshot.timer.unref();
    snapshots.set(panelId, snapshot);
    try {
      const { agents, ...metadata } = await load(signal);
      if (snapshots.get(panelId) !== snapshot) throw new Error(expired);
      snapshot.agents = agents.map(rosterSummary);
      const first = { ...metadata, ...page(snapshot, 0) };
      if (!first.nextCursor) forget(panelId);
      return first;
    } catch (error) {
      if (snapshots.get(panelId) === snapshot) forget(panelId);
      throw error;
    }
  };
}

export default function activate(orca) {
  async function external() {
    const { settings } = await orca.host.call('settings.get', {});
    const file = settings.connectionsFile?.trim() || '';
    return { registry: createExternalRegistry({ connectionsFile: file || undefined }), file };
  }

  orca.panels.handle('agents.list', createRosterHandler(async (signal) => {
    const [local, other] = await Promise.allSettled([
      callLocal('agents.list', { summary: true }, { signal }),
      external().then(({ registry }) => registry.list({ signal })),
    ]);
    const agents = [];
    const warnings = [];
    for (const source of [local, other]) {
      if (source.status === 'rejected') warnings.push(source.reason.message);
      else {
        for (const profile of source.value.agents) agents.push(profile);
        warnings.push(...(source.value.warnings ?? []));
      }
    }
    const managedOnline = local.status === 'fulfilled';
    return { agents, warnings, managedOnline, models: managedOnline ? (local.value.models ?? ['demo']) : [] };
  }));
  orca.panels.handle('agents.profile', async ({ id }, { signal }) => {
    try {
      return await callLocal('agents.profile', { id }, { signal });
    } catch (error) {
      // The 0.1.0 service shipped full profiles in its list and had no profile route.
      if (error.status !== 404 || error.message !== 'Operación desconocida.') throw error;
      const { agents } = await callLocal('agents.list', {}, { signal });
      const profile = agents.find(agent => agent.id === id);
      if (!profile) throw new Error('Agente no encontrado.');
      return profile;
    }
  });
  for (const name of ['agents.create', 'agents.update', 'chat.read', 'chat.send']) {
    orca.panels.handle(name, async (params, { signal }) => {
      if (!params || typeof params !== 'object') throw new Error('Faltan los parámetros.');
      if (!String(params.id ?? '').startsWith('external:')) return callLocal(name, params, { signal });
      if (name !== 'chat.read' && name !== 'chat.send') {
        throw new Error('Edita la configuración de este agente en su servicio de origen.');
      }
      const { registry, file } = await external();
      const key = receiptKey(params.id, file);
      if (name === 'chat.read') {
        const { value } = await orca.host.call('storage.get', { key });
        return registry.chat({ id: params.id, ...value, signal });
      }
      const receipt = await registry.send({ ...params, signal });
      await orca.host.call('storage.set', { key, value: {
        submissionId: receipt.submissionId,
        conversationId: receipt.conversationId,
      } });
      return receipt;
    });
  }
}
