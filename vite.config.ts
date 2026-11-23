import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset paths, so the build works at any GitHub Pages path. Renaming the repository
  // moves the site to https://<user>.github.io/<new name>/, and a fixed '/<repo>/' base broke it.
  base: './',
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
    // the CPU tests search for real (up to ~4 s locally); CI machines can be slower than the 5 s default
    testTimeout: 30_000,
  },
});
