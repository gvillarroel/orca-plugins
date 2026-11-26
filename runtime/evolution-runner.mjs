import { readFile } from 'node:fs/promises';
import { parentPort, workerData } from 'node:worker_threads';
import { Intrinsics, QuickJS } from 'quickjs-wasi';

// The guest gets a string and standard JavaScript. No host callbacks, module loader,
// filesystem, network, environment or durable credentials are installed in the guest.
async function execute(wasm, source, input) {
  let deadline = Infinity;
  using vm = await QuickJS.create({
    wasm, memoryLimit: 4 * 1024 * 1024, maxStackSize: 128 * 1024,
    intrinsics: Intrinsics.ALL & ~Intrinsics.DATE & ~Intrinsics.PERFORMANCE & ~Intrinsics.PROMISE,
    interruptHandler: () => performance.now() > deadline,
  });
  deadline = performance.now() + 100;
  using fn = vm.evalCode('"use strict"; delete Math.random;\n(\n' + source + '\n)', 'agent.js');
  if (!fn.isFunction) throw new Error('Invalid function');
  using text = vm.newString(input);
  using result = vm.callFunction(fn, vm.undefined, text);
  if (result.isNull) return null;
  if (!result.isString) throw new Error('Invalid response');
  const answer = result.toString();
  if (!answer.trim() || answer.length > 32000) throw new Error('Invalid response');
  return answer;
}

try {
  const wasm = await WebAssembly.compile(await readFile(new URL(import.meta.resolve('quickjs-wasi/quickjs.wasm'))));
  const answers = [];
  for (const input of workerData.inputs) answers.push(await execute(wasm, workerData.source, input));
  parentPort.postMessage({ answers });
} catch {
  parentPort.postMessage({ error: 'The agent script failed, exceeded its limits, or returned something other than nonempty text or null.' });
}
