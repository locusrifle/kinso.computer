// One kind of email: a short plain-text note with a link or a key in it.
// Sent from an AgentMail inbox (locus@imperfect.computer unless MAIL_INBOX
// says otherwise), so a buyer's reply lands somewhere a person, or Locus's
// agent, reads. Without a key the note is written to the log, so nothing is
// silently lost while the service is being set up.

export function createMail({ key = '', inbox = 'locus@imperfect.computer', fetchImpl = fetch, log = console } = {}) {
  return {
    configured: Boolean(key),
    inbox,
    async send({ to, subject, text }) {
      if (!key) {
        log.warn(`[mail not configured] to=${to} subject=${JSON.stringify(subject)}\n${text}`);
        return { delivered: false };
      }
      const response = await fetchImpl(`https://api.agentmail.to/v0/inboxes/${encodeURIComponent(inbox)}/messages/send`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ to: [to], subject, text }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`mail failed (${response.status}): ${body.slice(0, 300)}`);
      }
      return { delivered: true, id: (await response.json().catch(() => ({}))).message_id ?? '' };
    },
    // The newest mail that came in (not what was sent from here), newest first.
    async received() {
      if (!key) return [];
      const response = await fetchImpl(`https://api.agentmail.to/v0/inboxes/${encodeURIComponent(inbox)}/messages?limit=20`, {
        headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`inbox ${response.status}`);
      return ((await response.json()).messages ?? []).filter(m => m.labels?.includes('received'));
    },
  };
}
