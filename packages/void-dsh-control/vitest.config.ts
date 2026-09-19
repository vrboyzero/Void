import { configDefaults, defineConfig } from "vitest/config";

/**
 * 本包脱离 Void 主 workspace 单独解析依赖（见 pnpm-workspace.yaml 注释），
 * 因此这里也自带 vitest 根，避免向上继承到 `E:\project\star-sanctuary\vitest.config.ts`
 * 的 `maxWorkers: 2`（会与 vitest 2.x 默认 minThreads 冲突）。
 */
export default defineConfig({
  test: {
    environment: "node",
    exclude: [...configDefaults.exclude, "**/lib/**", "**/dist/**"],
    // 真实组合测试需要拉起 Cordis + HTTP + MCP，串行执行更容易定位失败。
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
