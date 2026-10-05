import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Each DB test file provisions its own ephemeral database.
    fileParallelism: true,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
