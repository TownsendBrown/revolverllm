import { builtinModules } from "node:module";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import electron from "vite-plugin-electron/simple";

const nodeBuiltins = [
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
];

const mainExternal = ["electron", "@huggingface/gguf", "better-sqlite3", "js-yaml", ...nodeBuiltins];

export default defineConfig({
  // Relative paths so loadFile() resolves bundled assets under file://
  base: "./",
  plugins: [
    react(),
    electron({
      main: {
        entry: "electron/main.ts",
        vite: {
          build: {
            rollupOptions: {
              external: mainExternal,
              output: { format: "cjs" },
            },
          },
        },
      },
      preload: {
        input: "electron/preload.ts",
        vite: {
          build: {
            rollupOptions: {
              external: ["electron", ...nodeBuiltins],
              output: { format: "cjs" },
            },
          },
        },
      },
    }),
  ],
  build: {
    outDir: "dist",
  },
});
