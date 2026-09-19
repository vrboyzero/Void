import { configDefaults, defineConfig } from "vitest/config";

/**
 * Void workspace vitest root.
 *
 * This file exists mainly to STOP vitest's upward config search: without it,
 * `E:\project\star-sanctuary\vitest.config.ts` (a sibling project) is inherited,
 * and its `maxWorkers: 2` collides with vitest 2.x's default `minThreads`
 * (availableParallelism - 1), failing every run with
 * `RangeError: options.minThreads and options.maxThreads must not conflict`.
 *
 * Keeping the config here also means build outputs are never re-collected as
 * test sources.
 */
export default defineConfig({
  test: {
    environment: "node",
    exclude: [...configDefaults.exclude, "**/lib/**", "**/dist/**", "参考项目/**", "deepseek-harness-master/**"],
  },
});
