import { defineConfig } from "vite";

export default defineConfig({
  root: "react",
  build: {
    outDir: "../dist/client",
    emptyOutDir: true,
  },
});
