// paretoMonteCarloClient.js
// ─────────────────────────────────────────────────────────────────
// Main-thread handle to the Monte-Carlo Web Worker. Keeps the 10k-trial
// simulation OFF the UI thread — the engine never runs on the main thread
// in production. Each run() posts one job and resolves with the engine
// results; jobs are tagged with an id so a debounced re-run's earlier
// (now-stale) job can be ignored when it lands.
//
// Spawned lazily on first run so opening the tab costs nothing until a
// simulation is actually requested. Call terminate() on unmount.

export function createMonteCarloRunner() {
  let worker = null;
  let seq = 0;
  const pending = new Map();

  const ensure = () => {
    if (worker) return worker;
    worker = new Worker(new URL('./paretoMonteCarlo.worker.js', import.meta.url), { type: 'module' });
    worker.addEventListener('message', (event) => {
      const { id, ok, results, error } = event.data || {};
      const job = pending.get(id);
      if (!job) return;
      pending.delete(id);
      if (ok) job.resolve(results);
      else job.reject(new Error(error || 'Monte-Carlo failed'));
    });
    worker.addEventListener('error', (event) => {
      pending.forEach((job) => job.reject(new Error(event.message || 'worker error')));
      pending.clear();
    });
    return worker;
  };

  return {
    /** Run one simulation; resolves with the engine `results`. */
    run(params) {
      const w = ensure();
      seq += 1;
      const id = seq;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        w.postMessage({ id, params });
      });
    },
    terminate() {
      if (worker) { worker.terminate(); worker = null; }
      pending.clear();
    },
  };
}

export default createMonteCarloRunner;
