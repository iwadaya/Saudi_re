import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    // Increase chunk size warning threshold — we intentionally have large screens
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        // Group chunks to reduce the number of separately hashed files.
        // Fewer chunks = less exposure to stale-chunk MIME errors after deploy.
        manualChunks(id) {
          // Keep heavy optional libs out of the vendor bundle so dynamic
          // imports actually pay off. exceljs is large and only used when
          // the user clicks Import/Export.
          if (id.includes('node_modules/exceljs')) {
            return 'exceljs';
          }
          if (id.includes('node_modules/pdf-parse')) {
            return 'pdf-parse';
          }
          // All other node_modules into one vendor chunk (stable hash)
          if (id.includes('node_modules')) {
            return 'vendor';
          }
          // Logic/utilities — must come before screens to avoid circular dependency.
          // straightProjections.js and other logic files are shared across prop/shared screens.
          if (id.includes('/logic/') || id.includes('/utils/') ||
              id.includes('/context/') || id.includes('/hooks/') ||
              id.includes('/config/') || id.includes('/components/')) {
            return 'app-core';
          }
          // NP final pricing (own chunk — largest screen)
          if (id.includes('final_pricing')) {
            return 'np-final-pricing';
          }
          // NP screens (excluding final_pricing)
          if (id.includes('/screens/non_proportional/')) {
            return 'np-screens';
          }
          // Facultative screens
          if (id.includes('/screens/facultative/') || id.includes('/screens/select/')) {
            return 'fac-screens';
          }
          // Shared screens — must come before prop-screens
          if (id.includes('/screens/shared/')) {
            return 'shared-screens';
          }
          // Proportional screens
          if (id.includes('/screens/proportional/')) {
            return 'prop-screens';
          }
        },
      },
    },
  },
});
