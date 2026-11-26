import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeChatHandler } from '../plugins/pi-durable/native-chat.mjs';

const profile = { name: 'Release reviewer', id: 'reviewer', managed: true };
const tree = { id: 'repo::/worktree', hostId: 'local', identity: { key: 'wt2:local:uuid' } };
const opened = { worktreeId: tree.id, outcome: { kind: 'structured', sessionId: 'session-123' } };

function fixture({ workspace = 'identity:' + tree.identity.key, selected = tree, installed = [{ id: 'pi' }],
  checkProvider = async () => {}, launch = async () => opened, rename = async () => ({ applied: true }),
  show = async () => ({ kind: 'chat', places: [] }) } = {}) {
  const storage = new Map();
  const calls = [];
  const host = { call: async (method, params) => {
    switch (method) {
      case 'workspace.readContext': return { workspaceId: workspace };
      case 'storage.get': return { value: storage.get(params.key) };
      case 'storage.set': storage.set(params.key, structuredClone(params.value)); return {};
      case 'storage.delete': storage.delete(params.key); return {};
      default: assert.fail('Unexpected host method: ' + method);
    }
  } };
  async function cli(args) {
    calls.push(args);
    if (args[0] === 'worktree') return { worktree: selected };
    if (args[1] === 'installed') return { agents: installed };
    if (args[1] === 'show') return show(args);
    if (args[1] === 'launch') return launch(args);
    if (args[1] === 'rename') return rename(args);
    assert.fail('Unexpected CLI call');
  }
  const open = () => createNativeChatHandler({ host }, { cli, checkProvider });
  return { open, calls, storage };
}

test('uses the supported chat CLI with literal arguments and confirms the actual surface', async () => {
  const checked = [];
  const { open, calls } = fixture({ checkProvider: async id => checked.push(id) });
  const unsafeLookingName = 'An agent $(echo hi) & #1';
  const result = await open()({ ...profile, name: unsafeLookingName });
  assert.equal(result.status, 'opened');
  assert.equal(result.sessionId, 'session-123');
  assert.deepEqual(checked, ['reviewer']);
  const selector = 'identity:wt2:local:uuid';
  assert.deepEqual(calls, [
    ['worktree', 'show', '--worktree', selector],
    ['agent', 'installed', '--worktree', selector],
    ['agent', 'launch', '--agent', 'pi', '--model', 'pi-durable/reviewer', '--worktree', selector, '--surface', 'chat', '--focus'],
    ['chat', 'rename', '--session', 'session-123', '--name', unsafeLookingName + ' · reviewer'],
  ]);
});

test('concurrent opens and restart share one native session for the stable ID', async () => {
  const { open, calls } = fixture();
  const firstWorker = open();
  const [a,b] = await Promise.all([firstWorker(profile), firstWorker(profile)]);
  assert.equal(a.sessionId, b.sessionId);
  const afterRestart = await open()({ ...profile, name: 'New display name' });
  assert.equal(afterRestart.status, 'existing');
  assert.equal(afterRestart.sessionId, a.sessionId);
  assert.equal(calls.filter(c => c[1] === 'launch').length, 1);
});

test('refuses external agents, unavailable models, missing Pi and remote workspaces before launch', async () => {
  const cases = [
    [fixture(), { ...profile, id: 'external:team/reviewer', managed: false }, /locally managed/],
    [fixture({ workspace: null }), profile, /local Orca workspace/],
    [fixture({ selected: { ...tree, hostId: 'ssh:elsewhere' } }), profile, /on this computer/],
    [fixture({ selected: { ...tree, identity: { key: 'different' } } }), profile, /same Orca/],
    [fixture({ installed: [] }), profile, /enable Pi/],
    [fixture({ checkProvider: async () => { throw Error('Model unavailable'); } }), profile, /Model unavailable/],
  ];
  for (const [env, agent, error] of cases) {
    await assert.rejects(env.open()(agent), error);
    assert.ok(!env.calls.some(call => call[1] === 'launch'));
    assert.equal(env.storage.size, 0);
  }
});

test('guards terminal fallback, unverified outcome and failure to name an already opened tab', async () => {
  for (const [result, error] of [
    [{ worktreeId: tree.id, outcome: { kind: 'terminal', handle: 'term_ab' } }, /terminal/],
    [{ ...opened, worktreeId: 'another workspace' }, /Orca may have started/],
  ]) {
    const env = fixture({ launch: async () => result });
    const review = await env.open()(profile);
    assert.equal(review.status, 'needsReview');
    assert.match(review.message, error);
    assert.deepEqual(await env.open()(profile, { newChat: true, reviewId: 'outdated' }), review);
    assert.equal(env.calls.filter(c => c[1] === 'launch').length, 1);
    await env.open()(profile, { newChat: true, reviewId: review.reviewId });
    assert.equal(env.calls.filter(c => c[1] === 'launch').length, 2);
  }
  const env = fixture({ rename: async () => { throw Error('Title rejected'); } });
  assert.equal((await env.open()(profile)).status, 'opened');
  assert.equal((await env.open()(profile)).status, 'existing');
  assert.equal(env.calls.filter(c => c[1] === 'launch').length, 1);
});

test('replays a lost receipt only with the operation ID Orca supplied', async () => {
  const env = fixture({ launch: async args => {
    if (args.includes('--retry-launch')) {
      assert.equal(args.at(-1), 'operation-from-orca');
      return opened;
    }
    throw Object.assign(Error('reply lost'), { orcaError: { code: 'agent_session_operation_unknown',
      data: { launchOutcome: 'unknown', operationId: 'operation-from-orca' } } });
  } });
  await assert.rejects(env.open()(profile), /recover the same request/);
  assert.equal((await env.open()(profile)).status, 'opened');
});

test('only replaces an existing session if Orca confirms it has forgotten it', async () => {
  let code = 'runtime_timeout';
  const env = fixture({ show: async () => { throw Object.assign(Error(code), { orcaError: { code } }); } });
  await env.open()(profile);
  await assert.rejects(env.open()(profile), /runtime_timeout/);
  assert.equal(env.calls.filter(c => c[1] === 'launch').length, 1);
  code = 'agent_unknown';
  assert.equal((await env.open()(profile)).status, 'opened');
  assert.equal(env.calls.filter(c => c[1] === 'launch').length, 2);
});

test('an unrecoverable replay allows a deliberate replacement after review', async () => {
  const env = fixture({ launch: async () => {
    throw Object.assign(Error('receipt expired'), { orcaError: { code: 'agent_session_operation_unknown',
      data: { launchOutcome: 'unknown', operationId: 'expired-operation' } } });
  } });
  await assert.rejects(env.open()(profile), /recover the same request/);
  const review = await env.open()(profile);
  assert.equal(review.status, 'needsReview');
  assert.equal((await env.open()(profile)).reviewId, review.reviewId);
  assert.equal(env.calls.filter(c => c[1] === 'launch').length, 2);
});

test('a confirmed pre-launch refusal can be retried after fixing the cause', async () => {
  let refused = true;
  const env = fixture({ launch: async () => {
    if (!refused) return opened;
    throw Object.assign(Error('Pi unavailable'), { orcaError: { code: 'invalid_argument' } });
  } });
  await assert.rejects(env.open()(profile), /Pi unavailable/);
  refused = false;
  assert.equal((await env.open()(profile)).status, 'opened');
});
