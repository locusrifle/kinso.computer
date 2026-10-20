const path = require('node:path');

module.exports = {
  appId: 'computer.imperfect.client',
  productName: 'Imperfect',
  executableName: 'imperfect-client',
  electronVersion: '44.5.1',
  directories: {
    app: process.env.IMPERFECT_DESKTOP_STAGE,
    output: process.env.IMPERFECT_DESKTOP_OUTPUT,
    buildResources: __dirname,
  },
  files: ['**/*'], // Only the separately allowlisted staging directory, never the repo.
  asar: true,
  npmRebuild: false,
  nodeGypRebuild: false,
  buildDependenciesFromSource: false,
  // Tester builds are intentionally unsigned; no automatic account/key discovery.
  forceCodeSigning: false,
  publish: null,
  protocols: [{ name: 'Imperfect computer', schemes: ['imperfect'] }],
  artifactName: 'imperfect-client-${version}-${os}-${arch}.${ext}',
  linux: {
    target: ['AppImage', 'deb'],
    syncDesktopName: true,
    category: 'Network',
    icon: path.join(__dirname, 'icon.png'),
    desktop: { entry: { StartupWMClass: 'imperfect-client' } },
    synopsis: 'Your imperfect computer, on this desktop',
  },
  deb: { maintainer: 'Noah <noah@imperfect.computer>' },
  win: {
    target: ['nsis'],
    icon: path.join(__dirname, 'icon.ico'),
    // Keep goat/version PE resources, but never discover or use signing keys.
    // NSIS's uninstaller extraction still requires Wine on a Linux builder.
    signExecutable: false,
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    deleteAppDataOnUninstall: false,
    installerIcon: path.join(__dirname, 'icon.ico'),
    uninstallerIcon: path.join(__dirname, 'icon.ico'),
    shortcutName: 'Imperfect',
  },
  mac: {
    target: ['zip', 'dmg'],
    category: 'public.app-category.productivity',
    icon: path.join(__dirname, 'icon.png'),
    identity: null,
    hardenedRuntime: false,
    notarize: false,
    // Permission prompts describe LOCAL hands, not access to the cloud machine.
    extendInfo: {
      NSScreenCaptureUsageDescription: 'Let your agents see the local screen only after you turn screen access on.',
    },
  },
};
