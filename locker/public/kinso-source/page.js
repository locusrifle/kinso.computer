// kinso.computer/source (locker/shop.mjs): pay once through Stripe, then copy the command. Once paid, this browser
// remembers it, so Code in the Mac's menu bar shows the command too (website/mac/shell.mjs). A paywall, not a lock.
const pay = document.getElementById('source-pay');
const status = document.getElementById('source-status');
pay?.addEventListener('click', async () => {
  pay.disabled = true;
  status.textContent = 'Opening checkout…';
  try {
    const res = await fetch('/source/checkout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.url) throw new Error(data.error || 'checkout could not be opened; please try again');
    location.href = data.url;
  } catch (error) {
    pay.disabled = false;
    status.textContent = `Sorry: ${error.message}.`;
  }
});

if (document.body.dataset.paid === '1') {
  try { localStorage.setItem('kinso-source-paid', '1'); } catch {}
}
const copy = document.getElementById('source-copy');
const command = document.getElementById('source-command');
copy?.addEventListener('click', () => {
  Promise.resolve(navigator.clipboard?.writeText(command.textContent))
    .then(() => { copy.textContent = 'Copied'; }, () => { copy.textContent = 'Select and copy'; });
});
