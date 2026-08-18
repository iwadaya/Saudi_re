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
          // recharts + its d3 / victory-vendor dependency tree is only used by
          // the NP final-pricing Pareto-simulation charts — keep it out of the
          // always-loaded vendor chunk (same rationale as exceljs/pdf-parse).
          if (id.includes('node_modules/recharts')
            || id.includes('node_modules/react-smooth')
            || id.includes('node_modules/victory-vendor')
            || id.includes('node_modules/d3-')
            || id.includes('node_modules/internmap')
            || id.includes('node_modules/decimal.js-light')) {
            return 'recharts';
          }
          // All other node_modules into one vendor chunk (stable hash)
          if (id.includes('node_modules')) {
            return 'vendor';
          }
          // Screen chunks come BEFORE app-core. Screens have their own
          // components/hooks/utils/config/logic subfolders; matching the
          // generic /components/ etc. patterns first would pull those
          // screen-local files into app-core, leaving the rest of the
          // screen in its own chunk and creating two-way (circular) chunk
          // dependencies (e.g. prop-screens ↔ app-core). Anchoring screens
          // first keeps each screen — subfolders and all — in one chunk, so
          // only genuinely top-level shared code falls through to app-core.

          // The facultative pricing engine (shared/fac) is pure math shared
          // across chunk boundaries: config/wizard.js reads the family
          // registry, and the fac screens read the registry, the exposure
          // profile and the property workbook. Left unassigned it lands in
          // whichever chunk happens to reach it first, which is how it ended
          // up inside fac-screens and pushed that chunk over budget. Its own
          // chunk keeps it out of both and puts its growth under its own gate.
          if (id.includes('/shared/fac/')) {
            return 'fac-engine';
          }

          // Shared FQ math helpers live under final_pricing/ for historical
          // reasons but are pure logic (their only deps are utils/format +
          // shared/pricingMath) and are imported across chunk boundaries —
          // e.g. screens/home/ReinsurerAnalysisModal pulls fqHelpers. Keeping
          // them in app-core stops app-core ↔ np-final-pricing back-references
          // from forming a circular chunk. Treat them as shared math, not
          // screen code.
          if (id.includes('/final_pricing/fqHelpers')
            || id.includes('/final_pricing/formatters')) {
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
          // Top-level shared code (src/logic, src/utils, src/context,
          // src/hooks, src/config, src/components). Reached only after the
          // screen checks above, so it never captures screen-local subfolders.
          if (id.includes('/logic/') || id.includes('/utils/') ||
              id.includes('/context/') || id.includes('/hooks/') ||
              id.includes('/config/') || id.includes('/components/')) {
            return 'app-core';
          }
        },
      },
    },
  },
});
