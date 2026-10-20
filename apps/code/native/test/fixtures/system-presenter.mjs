// Observe the integrated production presenter, never install a test-only
// substitute that could hide missing parent wiring.
export function withSystemPresenter(source) {
  const marker = '\t// Focus begun or ended (MOD+L, the window made phone-narrow and wide again).';
  if (!source.includes(marker)) throw new Error('System presenter integration anchor changed');
  if (!source.includes('systemControls.setPresenter(')) throw new Error('Production system presenter wiring is missing');
  return source.replace(marker, `
	globalThis.systemPanelFixture = { controls: systemControls,
		closeWindow: () => wm.close(wm.list().find(win => win.kind === 'system')), showFiles: () => wm.show(files),
		panelKind: () => wm.panel() };
` + marker);
}
