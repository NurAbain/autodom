import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/tests/**/*.test.ts",
      "apps/*/tests/**/*.test.ts",
      "tests-ts/**/*.test.ts",
    ],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 20_000,
    hookTimeout: 60_000,
    restoreMocks: true,
  },
});
