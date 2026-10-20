// Codex token_count events repeat cumulative counters after tool/status events.
// Session identity plus counter position deduplicates mirrors, not unrelated runs.
export function codexUsageReader(device, onInvalid = () => {}) {
  let session = null, model = 'unknown', previous = null;
  return row => {
    const p = row.payload;
    if (row.type === 'session_meta') { session = p?.id; previous = null; return null; }
    if (row.type === 'turn_context') { model = p?.model || model; return null; }
    if (row.type !== 'event_msg' || p?.type !== 'token_count' || (!p.info?.total_token_usage && !p.info?.last_token_usage)) return null;
    const invalid = () => { onInvalid(); return null; };
    const total = p.info.total_token_usage;
    const finite = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
    const totalCached = total?.cached_input_tokens === undefined ? 0 : total.cached_input_tokens;
    if (!session || !total || !['input_tokens', 'output_tokens'].every(k => finite(total[k])) ||
      !finite(totalCached) || totalCached > total.input_tokens) return invalid();
    const calendar = typeof row.timestamp === 'string' ? row.timestamp.match(/^(\d{4}-\d{2}-\d{2})(?:[Tt ]|$)/)?.[1] : null;
    const date = calendar ? new Date(`${calendar}T00:00:00Z`) : null;
    const at = Date.parse(row.timestamp);
    if (!calendar || !Number.isFinite(at) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== calendar) return invalid();
    const position = JSON.stringify([total.input_tokens, totalCached, total.output_tokens]);
    if (previous?.position === position) return null;
    const last = p.info.last_token_usage || Object.fromEntries(['input_tokens', 'cached_input_tokens', 'output_tokens'].map(k => [k, (total[k] ?? 0) - (previous?.total[k] ?? 0)]));
    previous = { position, total };
    const cached = last.cached_input_tokens === undefined ? 0 : last.cached_input_tokens;
    if (![last.input_tokens, last.output_tokens, cached].every(finite) || cached > last.input_tokens) return invalid();
    if (last.input_tokens + last.output_tokens === 0) return null;
    return { key: JSON.stringify(['codex', session, position]), agent: 'codex', device, at, day: new Date(at).toISOString().slice(0, 10), provider: 'openai-codex', model,
      tokens: { input: last.input_tokens - cached, output: last.output_tokens, cacheRead: cached, cacheWrite: 0 }, cacheWrite1h: null };
  };
}
