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
          // The local Excel adapter dynamically imports exceljs. Keep the
          // adapter separate from app-core so one pay-on-click import does
          // not make the core chunk participate in the exceljs graph.
          if (id.includes('/utils/excel')) {
            return 'excel-adapter';
          }
          // Straight-projection defaults are used by the workbench and a
          // no-triangulation fallback. Isolate them from app-core so the
          // fallback remains lazy and the workbench can share a small chunk.
          if (id.includes('/logic/straightProjections')) {
            return 'straight-projections';
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
            if (id.includes('/screens/shared/ExcelImportAgent')) {
              return 'excel-import-agent';
            }
            if (id.includes('/screens/shared/LossParetoScreen') ||
                id.includes('/screens/shared/RpComparisonModal')) {
              return 'loss-pareto-screen';
            }
            if (id.includes('/screens/shared/LossSelectionScreen') ||
                id.includes('/screens/shared/LossAnalysisModal') ||
                id.includes('/screens/shared/LossQuarterSuggestModal')) {
              return 'loss-selection-screen';
            }
            if (id.includes('/screens/shared/LossListScreen')) {
              return 'loss-list-screen';
            }
            if (id.includes('/screens/shared/ProfileScreen')) {
              return 'profile-screen';
            }
            if (id.includes('/screens/shared/DocumentsScreen') ||
                id.includes('/screens/shared/Wording')) {
              return 'documents-screen';
            }
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
