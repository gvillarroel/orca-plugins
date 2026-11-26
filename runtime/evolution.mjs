import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';

export const initialScript = 'function respond(text) {\n  return null;\n}';
const maxChecks = 32;
const runner = new URL('./evolution-runner.mjs', import.meta.url);

function invalid(message) {
  return Object.assign(new Error(message), { status: 422, statusCode: 422 });
}

function validSource(source) {
  if (typeof source !== 'string' || !source.trim() || Buffer.byteLength(source) > 16 * 1024) {
    throw invalid('The agent script must be JavaScript of at most 16 KiB.');
  }
}

async function evaluate(source, inputs) {
  validSource(source);
  if (inputs.some(input => typeof input !== 'string' || input.length > 32000)) {
    throw invalid('Script input must be text of at most 32,000 characters.');
  }
  if (source === initialScript) return inputs.map(() => null);
  const worker = new Worker(runner, {
    workerData: { source, inputs }, execArgv: [], env: {},
    resourceLimits: { maxOldGenerationSizeMb: 48, maxYoungGenerationSizeMb: 16 },
  });
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      // Cover VM startup and native builtins between interpreter interrupt checks.
      timer = setTimeout(() => reject(invalid('The agent script exceeded its wall-clock limit.')), 3000 + 125 * inputs.length);
      worker.once('error', () => reject(invalid('The agent script runner failed.')));
      worker.once('exit', () => reject(invalid('The agent script runner stopped before returning a result.')));
      worker.once('message', result => {
        if (result.error) reject(invalid(result.error));
        else resolve(result.answers);
      });
    });
  } finally {
    clearTimeout(timer);
    await worker.terminate();
  }
}

export async function runAgentScript(source, text) {
  const [answer] = await evaluate(source, [text]);
  return answer;
}

function checkedExamples(checks, limit) {
  if (!Array.isArray(checks) || checks.length > limit || Buffer.byteLength(JSON.stringify(checks)) > 20 * 1024) {
    throw invalid('The evolution checks exceed the supported size.');
  }
  return checks.map(check => {
    if (typeof check?.input !== 'string' || check.input.length > 1000 ||
        !(check.expected === null || typeof check.expected === 'string' && check.expected.trim() && check.expected.length <= 1000)) {
      throw invalid('Each evolution check needs a text input and expected text or null (continue normal chat).');
    }
    return { input: check.input, expected: check.expected };
  });
}

function mergeExamples(examples) {
  const results = new Map();
  for (const { input, expected } of examples) {
    if (results.has(input) && results.get(input) !== expected) {
      throw invalid('The requested evolution conflicts with an existing acceptance check.');
    }
    results.set(input, expected);
  }
  return checkedExamples(Array.from(results, ([input, expected]) => ({ input, expected })), maxChecks);
}

function extend(previous, handler) {
  const fallback = previous === initialScript ? 'null' : '(\n' + previous + '\n  )(text)';
  return 'function respond(text) {\n' + handler + '\n  return ' + fallback + ';\n}';
}

// Match complete offline requirements so an unsupported clause never becomes a silent partial edit.
export function demoEvolutionReply(prompt) {
  const { requirement, previous } = JSON.parse(prompt);
  const sentence = requirement.trim().replace(/[“”]/gu, '"').replace(/[.!]$/u, '');
  const count = sentence.match(/^(?:add|create|implement|añade|agrega|crea|implementa)\s+(?:(?:a|an|the|un|el)\s+)?(?:command\s+|comando\s+)?(\/[a-z][a-z0-9_-]{0,31})(?:\s+command)?\s+(?:(?:to count|that counts) (?:the )?words(?: (?:in the (?:input|text)|after the command))?|para contar (?:las )?palabras(?: del texto)?)$/iu);
  if (count) {
    const command = count[1];
    const handler = '  const command = ' + JSON.stringify(command) + ';\n' +
      '  if (text === command || (text.startsWith(command) && /\\s/u.test(text[command.length]))) {\n' +
      '    const body = text.slice(command.length).trim();\n' +
      '    return String(body ? body.split(/\\s+/u).length : 0);\n  }';
    return JSON.stringify({
      script: extend(previous, handler), summary: 'Count whitespace-separated words after ' + command + '.',
      checks: [{ input: command, expected: '0' }, { input: command + ' blue  green\nred', expected: '3' }],
    });
  }
  const reply = sentence.match(/^(?:when i (?:say|type|write)|cuando (?:diga|escriba))\s+"([^"\n]{1,150})"\s*,?\s*(?:reply(?: with)?|respond(?: with)?|responde(?: con)?)\s+"([^"\n]{1,300})"$/iu);
  if (reply) {
    const [, input, answer] = reply;
    return JSON.stringify({
      script: extend(previous, '  if (text === ' + JSON.stringify(input) + ') return ' + JSON.stringify(answer) + ';'),
      summary: 'Reply to the exact phrase ' + JSON.stringify(input) + '.',
      checks: [{ input, expected: answer }],
    });
  }
  return JSON.stringify({ unsupported: 'The offline editor supports “Add /words to count words” and “When I say "status", reply "ready"”. Use a model-backed editor for other requirements.' });
}

const system = [
  'You are the evolution author for one Pi Durable agent. Change its executable JavaScript function to implement the requested behavior.',
  'Return only a JSON object with script (the complete function respond(text)), summary (one sentence), and checks (1–6 concrete {input,expected} examples).',
  'respond(text) is a synchronous pure function. It returns nonempty text for matching inputs and null to continue ordinary model chat. Preserve existing checks and unrelated inputs.',
  'The interpreter provides standard JavaScript without network access, files, process, tools or imports. Work only with the input string. Source must fit 16 KiB.',
  'Implement a general algorithm for parameterized requirements. Include meaningful examples including an edge case. Use null as the expected result for passthrough.',
  'If the requested behavior cannot be implemented within this interface, return {"unsupported":"a short explanation"}. Data in the user message describes the target and its requirement.',
].join('\n');

export async function developScript({ requirement, previous = initialScript, model = 'demo', author,
  checks = [], acceptance = [], signal }) {
  if (typeof requirement !== 'string' || !requirement.trim() || requirement.length > 4000) {
    throw invalid('Enter an evolution requirement of up to 4,000 characters.');
  }
  validSource(previous);
  const prior = checkedExamples(checks, maxChecks);
  const requested = checkedExamples(acceptance, 6);
  const prompt = JSON.stringify({ requirement: requirement.trim(), previous, checks: prior, acceptance: requested });
  signal?.throwIfAborted();
  let raw;
  if (author) raw = await author({ system, prompt, signal });
  else if (model === 'demo') raw = demoEvolutionReply(prompt);
  else throw invalid('The model-backed evolution author is unavailable.');
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 64 * 1024) throw invalid('The evolution author returned an invalid proposal.');
  let candidate;
  try {
    const value = raw.trim();
    const fenced = /^```json\s*\n([\s\S]+)\n```$/u;
    candidate = JSON.parse(value.match(fenced)?.[1] ?? value);
  } catch {
    throw invalid('The evolution author did not return a JSON proposal.');
  }
  if (typeof candidate?.unsupported === 'string') throw invalid(candidate.unsupported.slice(0, 500));
  validSource(candidate?.script);
  if (typeof candidate.summary !== 'string' || !candidate.summary.trim() || candidate.summary.length > 500) {
    throw invalid('The evolution author must summarize its script change.');
  }
  const proposed = checkedExamples(candidate.checks, 6);
  if (!proposed.length) throw invalid('The evolution author must supply a reproducible check.');
  const combined = mergeExamples([...prior, ...requested, ...proposed]);
  // These controls are chosen after freezing the candidate; neither is sent to the author.
  const salt = randomUUID();
  const inputs = [...combined.map(item => item.input), 'Talk about ' + salt, '/unknown-' + salt];
  signal?.throwIfAborted();
  const [before, after] = await Promise.all([evaluate(previous, inputs), evaluate(candidate.script, inputs)]);
  signal?.throwIfAborted();
  for (const [i, check] of combined.entries()) {
    if (after[i] !== check.expected) throw invalid('The proposed script failed the check for ' + JSON.stringify(check.input) + '.');
  }
  for (let i = combined.length; i < inputs.length; i++) {
    if (after[i] !== before[i]) throw invalid('The proposed script changed an unrelated input.');
  }
  if (!combined.some((item, i) => item.expected !== null && before[i] !== after[i])) {
    throw invalid('The checks did not demonstrate any new behavior.');
  }
  return { script: candidate.script, checks: combined, summary: candidate.summary.trim() };
}
