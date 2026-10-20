// Owner-scoped routes: /pulse.json is always this computer's observation.
// Windows select home via /machines.json then /peer/<id>/pulse.json, exactly
// like Files; no remote failure is allowed to fall back to local green.
import { join } from 'node:path';
import { smallJson, pulseSummary, heartbeat } from './doctor.mjs';

export function createPulseRoute({ stateDir, host = async () => 'this computer', incidents, workers, snapshot, now = Date.now }) {
  const read = async () => {
    try { const value = snapshot ? snapshot() : await smallJson(join(stateDir, 'status.json')); return Array.isArray(value?.invariants) ? value : null; }
    catch { return null; }
  };
  return {
    summary: async () => pulseSummary(await read(), now()),
    async view() {
      const status = await read(), check = heartbeat(status, now()), dataErrors = [];
      const list = async (ledger, label) => {
        if (!ledger) { dataErrors.push(`${label} is unavailable`); return null; }
        try { return await ledger.list(); } catch { dataErrors.push(`${label} is unreadable`); return null; }
      };
      const incidentRows = await list(incidents, 'Incident ledger'), workerRows = await list(workers, 'Worker ledger');
      const summary = pulseSummary(status, now());
      if (dataErrors.length && summary.state === 'ok') Object.assign(summary, { state: 'unknown', reason: `${dataErrors[0]}.`, healing: 'Inspect ledger permissions, capacity and corruption; evidence is never silently discarded.' });
      return { ...status, host: await host(), live: check.state === 'ok', summary, dataErrors,
        invariants: [...(status?.invariants ?? []), check], incidents: incidentRows, workers: workerRows };
    },
  };
}
