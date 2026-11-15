import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 20000,
    // `vscode` only exists inside the extension host; unit tests cover the pure core.
    server: { deps: { external: ["vscode"] } },
  },
});
