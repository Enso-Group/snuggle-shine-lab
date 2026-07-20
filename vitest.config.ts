import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Standalone test config — deliberately does NOT reuse vite.config.ts, so unit
// tests run without the TanStack Start plugin or any Lovable tooling.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
