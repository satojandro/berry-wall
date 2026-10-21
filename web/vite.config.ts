import { defineConfig } from "vite";

export default defineConfig({
  server: { port: 5180, strictPort: true },
  preview: { port: 5180, strictPort: true },
  define: {
    // @near-js/transactions (and its borsh dependency) use Node's Buffer.
    // Vite doesn't polyfill Node globals in the browser — inject them.
    "global": "globalThis",
  },
  resolve: {
    alias: {
      buffer: "buffer/",
    },
  },
  optimizeDeps: {
    include: ["buffer"],
  },
});
