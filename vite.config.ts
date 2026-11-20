import { defineConfig } from 'vite';

export default defineConfig({
  base: '/CUBE_6_alpha_ver.1.0.0/',
  build: {
    // three.js is ~550 kB on its own; keep it in a separate, long-cached chunk
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: { manualChunks: { three: ['three'] } },
    },
  },
  test: {
    environment: 'node',
    passWithNoTests: true,
  },
});
