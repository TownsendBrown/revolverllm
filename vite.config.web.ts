import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/** Web-only build for Docker frontend (no Electron). */
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
  },
});
