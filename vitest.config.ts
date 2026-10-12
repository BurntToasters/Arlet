import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/__tests__/**/*.test.ts"],
    setupFiles: ["src/__tests__/setup-dom.ts"],
    restoreMocks: true,
    mockReset: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/__tests__/**", "src/vite-env.d.ts"],
      // A floor a little under today's numbers, so coverage cannot erode
      // unnoticed. E2E remains the main test; raise these as it grows.
      thresholds: {
        statements: 58,
        branches: 48,
        functions: 60,
        lines: 61,
      },
    },
  },
});
