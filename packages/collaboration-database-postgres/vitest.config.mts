import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.mts"],
    // Every test file uses the same `collaboration` schema, so files run one after another.
    fileParallelism: false,
    coverage: {
      include: ["src/**/*.ts"],
    },
  },
});
