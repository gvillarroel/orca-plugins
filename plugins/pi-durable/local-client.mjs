import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const offline = 'Start the Pi Durable service with npm start from the repository’s runtime directory.';

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
    throw new Error('The local connection settings are invalid. Restart the Pi Durable service.');
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
    if (signal?.aborted || timeout.aborted) throw new Error('The local service request timed out.');
    throw new Error(offline);
  }
  const result = await response.json();
  if (!response.ok) {
    throw Object.assign(new Error(result.error || 'The local service rejected the request.'), {
      status: response.status,
      code: result.code,
    });
  }
  return result;
}
