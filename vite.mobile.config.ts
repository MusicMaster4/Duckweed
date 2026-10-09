import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    target: "chrome100",
    outDir: "android/app/build/generated/agentAssets",
    emptyOutDir: true,
    rollupOptions: { input: "mobile.html" },
  },
});
