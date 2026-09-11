import { getQuickJS, shouldInterruptAfterDeadline } from "quickjs-emscripten";

/** Execute YouTube's decipher code without exposing Node, the filesystem or secrets. */
export async function evaluatePlayer(data: { output: string }): Promise<unknown> {
  const engine = await getQuickJS();
  const vm = engine.newContext();
  vm.runtime.setMemoryLimit(32 * 1024 * 1024);
  vm.runtime.setMaxStackSize(1024 * 1024);
  vm.runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + 1000));
  try {
    const result = vm.evalCode(data.output);
    if (result.error) {
      const error = vm.dump(result.error);
      result.error.dispose();
      throw new Error(`YouTube player evaluation failed: ${JSON.stringify(error)}`);
    }
    try {
      return vm.dump(result.value);
    } finally {
      result.value.dispose();
    }
  } finally {
    vm.dispose();
  }
}
