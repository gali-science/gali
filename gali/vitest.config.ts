import { defineConfig } from "vitest/config";
import { TEST_CONFIG } from "./test/test.config.js";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: TEST_CONFIG.integrationTimeoutMs,
    hookTimeout: TEST_CONFIG.integrationTimeoutMs,
  },
});
