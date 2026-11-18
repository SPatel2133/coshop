import { defineConfig } from "vite";

export default defineConfig({
  root: "react",
  publicDir: false,
  build: {
    outDir: "../dist/client",
    emptyOutDir: true,
  },
});
