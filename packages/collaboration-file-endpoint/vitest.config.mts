import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.mts"],
    coverage: {
      include: ["src/**/*.ts"],
    },
  },
});
