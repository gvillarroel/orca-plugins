import assert from 'node:assert/strict';
import test from 'node:test';
import { demoEvolutionReply, developScript, initialScript, runAgentScript } from './evolution.mjs';

test('offline author edits executable source, preserves older capabilities, and continues unrelated input', async () => {
  const requirement = 'Añade /palabras para contar palabras.';
  let observed;
  const wordCount = await developScript({
    requirement, acceptance: [{ input: '/palabras one\ttwo', expected: '2' }],
    author: async ({ system, prompt }) => {
      assert.match(system, /JavaScript/);
      observed = JSON.parse(prompt);
      return demoEvolutionReply(prompt);
    },
  });
  assert.equal(observed.requirement, requirement);
  assert.equal(observed.previous, initialScript);
  assert.notEqual(wordCount.script, initialScript);
  assert.equal(await runAgentScript(wordCount.script, '/palabras hola   mundo\nhoy'), '3');
  assert.equal(await runAgentScript(wordCount.script, '/palabrasX hello'), null);
  const followup = await developScript({
    previous: wordCount.script, checks: wordCount.checks, requirement: 'When I say "ping", reply "pong".',
  });
  assert.equal(await runAgentScript(followup.script, 'ping'), 'pong');
  assert.equal(await runAgentScript(followup.script, '/palabras uno dos'), '2');
  assert.equal(await runAgentScript(followup.script, 'regular chat'), null);
  assert.equal(await runAgentScript(wordCount.script, 'ping'), null);
});

test('accepts novel algorithms supplied by an author and independently verifies the requested case', async () => {
  const sort = 'function respond(text) { if (!text.startsWith("/sort ")) return null; return text.slice(6).split(",").map(s => s.trim()).sort().join(", "); }';
  const requirement = 'Sort a comma-separated list alphabetically after /sort.';
  const candidate = { script: sort, summary: 'Sort a list.', checks: [{ input: '/sort b,a', expected: 'a, b' }] };
  const author = async () => JSON.stringify(candidate);
  const verified = await developScript({ requirement, model: 'openai/gpt-4.1-mini', author,
    acceptance: [{ input: '/sort blue, red, amber', expected: 'amber, blue, red' }] });
  assert.equal(verified.script, sort);
  assert.equal(await runAgentScript(verified.script, '/sort 9,4,2,0'), '0, 2, 4, 9');
  await assert.rejects(developScript({ requirement, author, acceptance: [{ input: '/sort z,c', expected: 'wrong' }] }), /failed the check/);
  await assert.rejects(developScript({ requirement, author, previous: sort, checks: verified.checks }), /new behavior/);
});

test('rejects invalid proposals, unsupported clauses, and a regression on unannounced fallback inputs', async () => {
  await assert.rejects(developScript({ requirement: 'Add /words to count words and send an email' }), /offline editor/);
  await assert.rejects(developScript({ requirement: 'Something new', model: 'anthropic/claude-sonnet-4-6' }), /unavailable/);
  await assert.rejects(developScript({ requirement: 'Add /words to count words', author: async () => 'plain text' }), /JSON proposal/);
  await assert.rejects(developScript({ requirement: 'Whenever I say hello, say yes.',
    author: async () => JSON.stringify({ script: 'text => "yes"', summary: 'Reply to hello.', checks: [{ input: 'hello', expected: 'yes' }] }) }),
    /unrelated input/);
  await assert.rejects(developScript({ requirement: 'When I say "ping", reply "pong"', checks: [{ input: 'ping', expected: 'other' }] }),
    /conflicts/);
});

test('evolved programs run with bounded resources, isolated state and no host bindings', async () => {
  const inspect = '() => [typeof process, typeof require, typeof fetch, typeof WebSocket, typeof Date, typeof Math.random].join(",")';
  assert.equal(await runAgentScript(inspect, 'anything'), Array(6).fill('undefined').join(','));
  const state = '() => String(globalThis.counter = (globalThis.counter || 0) + 1)';
  assert.equal(await runAgentScript(state, 'first'), '1');
  assert.equal(await runAgentScript(state, 'second'), '1');
  for (const source of ['() => { while (true) {} }', '() => "a".repeat(10000000)', '() => ({})', '???']) {
    await assert.rejects(runAgentScript(source, 'test'), { statusCode: 422 });
  }
  assert.equal(await runAgentScript('() => "ready"', 'next run'), 'ready');
});
