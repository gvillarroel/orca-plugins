import assert from 'node:assert/strict';
import test from 'node:test';
import { createRosterHandler } from '../plugins/pi-durable/worker.mjs';

const context = id => ({ panel: { id, surface: 'panel', contributionId: 'agents' }, signal: new AbortController().signal });

test('pages compact agent summaries in stable order within the Orca bridge limit', async () => {
  const oversized = '\u0001'.repeat(260) + '😀'.repeat(900);
  const agents = Array.from({ length: 453 }, (_, i) => ({
    id: 'external:owner/agent-' + i, name: oversized, model: oversized,
    managed: false, online: true, instructions: 'private instructions'
  }));
  const metadata = { managedOnline: true, models: ['demo'], warnings: ['example warning'] };
  let requests = 0;
  const list = createRosterHandler(async () => {
    requests++;
    return { agents, ...metadata };
  });
  const windowA = context('panel-a');
  const first = await list({}, windowA);
  assert.equal(first.agents.length, 200);
  assert.ok(first.nextCursor);
  assert.deepEqual(first.models, metadata.models);
  assert.deepEqual(first.warnings, metadata.warnings);
  assert.equal(first.managedOnline, true);
  assert.deepEqual(Object.keys(first.agents[0]).sort(), ['id', 'managed', 'model', 'name', 'online']);
  assert.ok(first.agents[0].name.endsWith('…') && first.agents[0].model.endsWith('…'));
  const originalIds = agents.map(agent => agent.id);
  agents[211].id = 'changed-after-read';
  agents.pop();
  const second = await list({ cursor: first.nextCursor }, windowA);
  const replay = await list({ cursor: first.nextCursor }, windowA);
  assert.deepEqual(second, replay);
  const third = await list({ cursor: second.nextCursor }, windowA);
  assert.equal(third.nextCursor, undefined);
  assert.equal(second.models, undefined);
  const pages = [first, second, third];
  assert.deepEqual(pages.flatMap(p => p.agents.map(a => a.id)), originalIds);
  for (const response of pages) assert.ok(Buffer.byteLength(JSON.stringify(response)) < 1024 * 1024);
  assert.equal(requests, 1);
});

test('cursors are specific to an open panel and invalidated by its next refresh', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const agents = Array.from({ length: 201 }, (_, id) => ({ id: String(id), name: 'Agent', managed: true }));
  const list = createRosterHandler(async () => ({ agents }));
  const a = context('window-a'), b = context('window-b');
  const first = await list({}, a);
  const other = await list({}, b);
  assert.notEqual(first.nextCursor, other.nextCursor);
  for (const cursor of [other.nextCursor, 'garbage', {}, first.nextCursor.replace(':200', ':1')]) {
    await assert.rejects(list({ cursor }, a), /Refresh/);
  }
  await list({}, a);
  await assert.rejects(list({ cursor: first.nextCursor }, a), /Refresh/);
  assert.equal((await list({ cursor: other.nextCursor }, b)).agents[0].id, '200');
  t.mock.timers.tick(120001);
  await assert.rejects(list({ cursor: other.nextCursor }, b), /Refresh/);
});

test('a slow refresh cannot overwrite a newer snapshot for the same panel', async () => {
  let complete;
  let calls = 0;
  const agents = Array.from({ length: 201 }, (_, i) => ({ id: 'new-' + i, name: 'New', managed: true }));
  const list = createRosterHandler(() => {
    if (calls++ === 0) return new Promise(resolve => { complete = resolve; });
    return { agents };
  });
  const panel = context('same-panel');
  const slow = list({}, panel);
  const current = await list({}, panel);
  complete({ agents: [] });
  await assert.rejects(slow, /Refresh/);
  assert.equal((await list({ cursor: current.nextCursor }, panel)).agents[0].id, 'new-200');
});
