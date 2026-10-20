// One public installer, with instructions for the visitor rather than the VM.
export const INSTALL_COMMAND = 'curl -fsSL https://imperfect.computer/install | sh';
export function validOS(value) {
  return typeof value === 'string' && ['mac', 'linux', 'windows', 'mobile'].includes(value) ? value : null;
}

// Accept a navigator-shaped value so the launch page can share this mapping.
export function detectOS(visitor = {}) {
  const platform = visitor.userAgentData?.platform || visitor.platform || visitor.userAgent || '';
  const all = `${visitor.userAgentData?.platform || ''} ${visitor.platform || ''} ${visitor.userAgent || ''}`;
  if (visitor.userAgentData?.mobile || /Android|iPhone|iPad|iPod|Windows Phone|Mobile/i.test(all)
      || (/Mac/i.test(platform) && visitor.maxTouchPoints > 1)) return 'mobile';
  if (/Win/i.test(platform)) return 'windows';
  if (/Mac/i.test(platform)) return 'mac';
  return 'linux';
}

export function resolveOS(search, visitor = {}) {
  const params = search instanceof URLSearchParams ? search : new URLSearchParams(search);
  const values = params.getAll('os');
  return (values.length === 1 && validOS(values[0])) || detectOS(visitor);
}

export function installInstructions(os, platform = os === 'mac' ? 'mac' : 'linux') {
  const mac = platform === 'mac';
  return {
    platform: mac ? 'mac' : 'linux',
    label: mac ? 'Install on your Mac' : 'Install on Linux',
    hint: os === 'mobile' ? 'Run this on your computer.'
      : mac ? 'Open Terminal and paste this.'
      : os === 'windows' ? 'On Windows, run it inside WSL (Ubuntu).' : 'Paste this in a terminal.',
    command: INSTALL_COMMAND,
  };
}

// No browser globals at module scope: safe to import in the launch or Node tests.
export function bindInstallation(root, os, copy) {
  let platform = installInstructions(os).platform;
  const find = selector => root.querySelector(selector);
  const buttons = root.querySelectorAll('[data-platform]');
  function render() {
    const info = installInstructions(os, platform);
    find('#install-label').textContent = info.label;
    find('#install-hint').textContent = info.hint;
    find('#install-command').textContent = info.command;
    for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.platform === info.platform));
  }
  for (const button of buttons) button.addEventListener('click', () => {
    platform = button.dataset.platform === 'mac' ? 'mac' : 'linux';
    render();
  });
  find('#copy-command').addEventListener('click', async () => {
    const status = find('#copy-status');
    try { await copy(INSTALL_COMMAND); status.textContent = 'Copied.'; }
    catch { status.textContent = 'Couldn’t copy. Select the command above and copy it manually.'; }
  });
  render();
}
