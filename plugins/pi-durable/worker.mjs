import { createHash } from 'node:crypto';
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
  if (!response.ok) throw new Error(result.error || 'El servicio local rechazó la solicitud.');
  return result;
}

function receiptKey(id, file) {
  return 'receipt-' + createHash('sha256').update(file + '\n' + id).digest('hex');
}

export default function activate(orca) {
  async function external() {
    const { settings } = await orca.host.call('settings.get', {});
    const file = settings.connectionsFile?.trim() || '';
    return { registry: createExternalRegistry({ connectionsFile: file || undefined }), file };
  }

  orca.panels.handle('agents.list', async (_params, { signal }) => {
    const [local, other] = await Promise.allSettled([
      callLocal('agents.list', {}, { signal }),
      external().then(({ registry }) => registry.list()),
    ]);
    const agents = [];
    const warnings = [];
    for (const source of [local, other]) {
      if (source.status === 'rejected') warnings.push(source.reason.message);
      else {
        agents.push(...source.value.agents);
        warnings.push(...(source.value.warnings ?? []));
      }
    }
    return { agents, warnings };
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
