import { defineConfig } from "vitest/config";

/**
 * 包级 vitest 配置。
 *
 * 存在的理由：根 `vitest.config.ts` 会把 `root` 定在仓库根，于是 `pnpm --filter @void/pstack test`
 * 会去收集**整个 workspace** 的测试。这里把它定在本包，`pnpm -r test` 才不会变成「每个包都跑一遍全仓」。
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.spec.ts"],
    exclude: ["**/lib/**", "**/node_modules/**"],
  },
});
