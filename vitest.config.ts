import { defineConfig } from "vitest/config";

// Standalone test config — deliberately does NOT reuse vite.config.ts, so unit
// tests run without the TanStack Start plugin or any Lovable tooling.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
