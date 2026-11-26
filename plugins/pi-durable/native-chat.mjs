import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const agentId = /^[a-z0-9][a-z0-9-]{0,63}$/;
const sessionId = /^[a-z0-9-]{1,100}$/i;
const installProvider = 'Run pi install ./integrations/pi-durable-provider from the matching release checkout, start the matching local service, and try again.';

function commandsEnvironment() {
  const env = { ...process.env, NO_COLOR: '1' };
  // Orca withholds APPDATA from its worker; its CLI needs it to find the default Windows profile.
  if (process.platform === 'win32' && !env.APPDATA) env.APPDATA = join(homedir(), 'AppData', 'Roaming');
  return env;
}

async function run(binary, args) {
  return execute(binary, args, {
    cwd: homedir(), env: commandsEnvironment(), encoding: 'utf8', timeout: 25000,
    maxBuffer: 2 * 1024 * 1024, windowsHide: true, shell: false,
  });
}

async function orcaCommand(args) {
  // On Linux the bundled CLI is orca-ide; "orca" may be the GNOME screen reader.
  const cli = { win32: 'orca.exe', linux: 'orca-ide', darwin: 'orca' }[process.platform];
  if (!cli) throw new Error('Native chat requires Orca Desktop on Windows, macOS or Linux.');
  const app = dirname(process.execPath);
  const resources = process.resourcesPath || (process.platform === 'darwin'
    ? resolve(app, '..', 'Resources') : join(app, 'resources'));
  const bundled = join(resources, 'bin', cli);
  let stdout;
  try {
    ({ stdout } = await run(existsSync(bundled) ? bundled : cli, [...args, '--json']));
  } catch (error) {
    if (!error.stdout) {
      throw new Error('Could not reach the Orca CLI. Open the local desktop workspace and check the Orca CLI installation.');
    }
    stdout = error.stdout;
  }
  let reply;
  try { reply = JSON.parse(stdout); } catch { throw new Error('The Orca CLI did not return a launch receipt.'); }
  if (!reply.ok) {
    const error = new Error(reply.error?.message || 'Orca refused the request.');
    error.orcaError = reply.error;
    throw error;
  }
  return reply.result;
}

async function assertProvider(id) {
  let command = 'pi';
  let prefix = [];
  if (process.platform === 'win32') {
    // Node cannot execFile an npm .cmd shim. Resolve npm's actual Pi package entry without a shell.
    let found = false;
    for (const directory of (process.env.PATH || '').split(delimiter).filter(isAbsolute)) {
      if (existsSync(join(directory, 'pi.exe'))) { command = join(directory, 'pi.exe'); found = true; break; }
      if (!existsSync(join(directory, 'pi.cmd'))) continue;
      const root = join(directory, 'node_modules', '@earendil-works', 'pi-coding-agent');
      try {
        const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
        if (pkg.name !== '@earendil-works/pi-coding-agent' || typeof pkg.bin?.pi !== 'string') continue;
        prefix = [resolve(root, pkg.bin.pi)];
        command = process.execPath;
        found = true;
        break;
      } catch { /* Skip non-npm shims. */ }
    }
    if (!found) throw new Error('Install the Pi Coding Agent CLI and enable Pi in Orca Settings → Agents.');
  }
  let stdout;
  try { ({ stdout } = await run(command, [...prefix, '--list-models', 'pi-durable/' + id])); }
  catch { throw new Error('Unable to read the Pi model list. ' + installProvider); }
  const found = stdout.split(/\r?\n/).some(line => {
    const [provider, model] = line.trim().split(/\s+/);
    return provider === 'pi-durable' && model === id;
  });
  if (!found) throw new Error('Pi does not list the model pi-durable/' + id + '. ' + installProvider);
}

const uncertain = 'Orca may have started this chat. Check the open tabs and Session History before opening another native chat.';

export function createNativeChatHandler(orca, { cli = orcaCommand, checkProvider = assertProvider } = {}) {
  const pending = new Map();

  async function open(profile, workspaceId, key, options) {
    const selector = /^(identity:|folder:)/.test(workspaceId) ? workspaceId : 'id:' + workspaceId;
    const { worktree } = await cli(['worktree', 'show', '--worktree', selector]);
    if (worktree?.hostId !== 'local' ||
        (worktree.id !== workspaceId && 'identity:' + worktree.identity?.key !== workspaceId)) {
      throw new Error('Select a workspace on this computer in the same Orca Desktop profile.');
    }
    let { value: receipt } = await orca.host.call('storage.get', { key });
    if (receipt?.status === 'opened') {
      // Closing the tab leaves the saved chat in Session History. Only a confirmed unknown
      // identity permits a replacement. A temporary CLI error never starts another session.
      try {
        const saved = await cli(['agent', 'show', 'orca_session_id:' + receipt.sessionId]);
        if (saved.kind !== 'chat') throw new Error('The stored session is not an Orca chat.');
        const place = saved.places?.find(row => row.worktreeId === worktree.id);
        const title = place?.title || receipt.title;
        const location = place ? 'Select “' + title + '” in the tab bar.' : 'Open “' + title + '” from Orca Session History.';
        return { status: 'existing', sessionId: receipt.sessionId, message: 'Your native conversation already exists. ' + location };
      } catch (error) {
        if (error.orcaError?.code !== 'agent_unknown') throw error;
        await orca.host.call('storage.delete', { key });
        receipt = null;
      }
    }
    const confirmed = options?.newChat === true && receipt?.reviewId && receipt.reviewId === options.reviewId;
    if (confirmed) receipt = null;
    if (receipt && !receipt.operationId) {
      return { status: 'needsReview', reviewId: receipt.reviewId, message: receipt.message || uncertain };
    }
    const installed = await cli(['agent', 'installed', '--worktree', selector]);
    if (!installed.agents.some(agent => agent.id === 'pi')) {
      throw new Error('Install the Pi Coding Agent CLI and enable Pi in Orca Settings → Agents.');
    }
    await checkProvider(profile.id);
    const args = ['agent', 'launch', '--agent', 'pi', '--model', 'pi-durable/' + profile.id,
      '--worktree', selector, '--surface', 'chat', '--focus'];
    if (receipt?.operationId) args.push('--retry-launch', receipt.operationId);
    const starting = receipt || { status: 'starting', reviewId: randomUUID() };
    await orca.host.call('storage.set', { key, value: starting });
    let result;
    try {
      result = await cli(args);
    } catch (error) {
      const detail = error.orcaError;
      if (!starting.operationId && detail?.data?.operationId && detail?.data?.launchOutcome === 'unknown') {
        await orca.host.call('storage.set', { key, value: { ...starting, operationId: detail.data.operationId } });
        throw new Error('Orca could not confirm the launch. Select this agent again to recover the same request.');
      } else if (detail && !receipt?.operationId && !detail.code?.startsWith('agent_session_operation_') &&
                 !['runtime_error','runtime_timeout','runtime_unavailable'].includes(detail.code)) {
        await orca.host.call('storage.delete', { key });
        throw error;
      }
      const message = uncertain + ' ' + error.message;
      await orca.host.call('storage.set', { key, value: { status: 'starting', reviewId: starting.reviewId, message } });
      return { status: 'needsReview', reviewId: starting.reviewId, message };
    }
    if (result.outcome?.kind === 'terminal') {
      const message = 'Orca opened a terminal instead of native Chat. Check that Pi supports RPC and is enabled in Orca Settings before starting another chat.';
      await orca.host.call('storage.set', { key, value: { status: 'terminal', reviewId: starting.reviewId, message } });
      return { status: 'needsReview', reviewId: starting.reviewId, message };
    }
    const id = result.outcome?.sessionId;
    if (result.outcome?.kind !== 'structured' || !sessionId.test(id || '') || result.worktreeId !== worktree.id) {
      return { status: 'needsReview', reviewId: starting.reviewId, message: uncertain };
    }
    const title = profile.name + ' · ' + profile.id;
    const saved = { status: 'opened', sessionId: id, title };
    // Save before naming. Failure to rename a real tab must never create a second session.
    await orca.host.call('storage.set', { key, value: saved });
    try {
      await cli(['chat', 'rename', '--session', id, '--name', title]);
    } catch {
      saved.title = 'Pi';
      await orca.host.call('storage.set', { key, value: saved });
      return { status: 'opened', sessionId: id, message: 'Orca opened the native Pi chat, but could not rename the tab.' };
    }
    return { status: 'opened', sessionId: id, message: 'Opened “' + title + '” in Orca Chat.' };
  }

  return async function openNativeChat(profile, options = {}) {
    if (!profile?.managed || !agentId.test(profile.id) || typeof profile.name !== 'string') {
      throw new Error('Native chat requires a locally managed Pi Durable agent.');
    }
    const context = await orca.host.call('workspace.readContext', {});
    if (!context?.workspaceId) throw new Error('Open a local Orca workspace before starting a native chat.');
    const key = 'native-' + createHash('sha256').update(context.workspaceId + '\n' + profile.id).digest('hex');
    if (pending.has(key)) return pending.get(key);
    const result = open(profile, context.workspaceId, key, options).finally(() => pending.delete(key));
    pending.set(key, result);
    return result;
  };
}
