// The launch site supplies the visitor's OS; the remote browser's is the VM's. A launch link made for a company
// (?for=kinso), or the company's own site (kinso.computer: company), opens that company's own version of the Shop.
const FOR = new Set(['kinso']);
export function visitorShopURL(visitor = {}, search = '', company = null) {
  visitor ||= {};
  const platform = visitor.userAgentData?.platform || visitor.platform || visitor.userAgent || '';
  const agent = `${visitor.userAgentData?.platform || ''} ${visitor.platform || ''} ${visitor.userAgent || ''}`;
  const mobile = visitor.userAgentData?.mobile || /Android|iPhone|iPad|iPod|Windows Phone|Mobile/i.test(agent)
    || (/Mac/i.test(platform) && visitor.maxTouchPoints > 1);
  const os = mobile ? 'mobile' : /Win/i.test(platform) ? 'windows' : /Mac/i.test(platform) ? 'mac' : 'linux';
  let who = company;
  try { who ??= new URLSearchParams(search).get('for'); } catch { /* no company */ }
  if (FOR.has(who)) return 'https://kinso.computer/kinso/';
  return `https://imperfect.computer/shop?os=${os}`;
}
export function initShop({ open, restore, company = null, win = globalThis.window }) {
  const show = () => {
    restore();
    void Promise.resolve().then(() => open(visitorShopURL(win.navigator, win.location?.search, company))).catch(() => {});
  };
  win.addEventListener('mac:shop', show);
  return { dispose: () => win.removeEventListener('mac:shop', show) };
}
