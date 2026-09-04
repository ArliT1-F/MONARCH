import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    environment: "node",
  },
  resolve: {
    alias: [
      // Mirror apps/dashboard/tsconfig.json "@/*" -> "./*" (regex so the
      // workspace packages "@monarch/*" are left untouched).
      { find: /^@\//, replacement: path.resolve(__dirname, "apps/dashboard") + "/" },
    ],
  },
});
