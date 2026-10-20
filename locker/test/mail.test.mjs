import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMail } from '../mail.mjs';

test('store mail comes from Locus by default', async () => {
  let url;
  const mail = createMail({ key: 'test-key', fetchImpl: async address => {
    url = address;
    return { ok: true, json: async () => ({ message_id: 'test-message' }) };
  } });
  assert.equal(mail.inbox, 'locus@imperfect.computer');
  await mail.send({ to: 'member@example.com', subject: 'welcome', text: 'your membership' });
  assert.equal(url, 'https://api.agentmail.to/v0/inboxes/locus%40imperfect.computer/messages/send');
});
