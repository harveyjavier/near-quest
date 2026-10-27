import { defineConfig } from 'vite';

/**
 * Vite config for the Phaser client.
 *
 * Everything under public/ (the generated tile atlases) is copied to dist/
 * verbatim, so the Firebase deploy is `npm run build` then `firebase deploy`.
 */
export default defineConfig({
  base: './',
  server: {
    host: true,   // reachable from a phone on the same network for real device QA
    // PORT lets a tool that assigns its own port drive the dev server; a plain
    // `npm run dev` still lands on the usual 5173.
    port: Number(process.env.PORT) || 5173,
  },
  build: {
    outDir: 'dist',
    // Off for production; opt in with `SOURCEMAP=true npm run build` for a
    // build you intend to debug. Not a style preference: the Phaser map alone
    // is ~9.4MB against a ~1.5MB bundle, so shipping maps made them five
    // sixths of everything Firebase served, and published readable source for
    // the whole game with it.
    sourcemap: process.env.SOURCEMAP === 'true',
    // Phaser is ~1.2MB minified; warning about it on every build is just noise.
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: {
        // Vite 8 bundles with rolldown, which takes manualChunks as a function
        // rather than a map. Splitting the two big vendors out keeps the game
        // code in a small chunk that redeploys without busting their cache.
        manualChunks(id) {
          if (id.includes('node_modules/phaser')) return 'phaser';
          if (id.includes('node_modules/colyseus.js')) return 'colyseus';
          return null;
        },
      },
    },
  },
});
