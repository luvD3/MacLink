const { MakerZIP } = require('@electron-forge/maker-zip');
const { VitePlugin } = require('@electron-forge/plugin-vite');

module.exports = {
  packagerConfig: {
    asar: true,
    executableName: 'MacLink',
    appBundleId: 'app.maclink.viewer',
    extraResource: ['THIRD_PARTY_NOTICES.md', 'third-party'],
  },
  makers: [new MakerZIP({}, ['win32'])],
  plugins: [new VitePlugin({
    build: [
      { entry: 'src/main.ts', config: 'vite.main.config.ts', target: 'main' },
      { entry: 'src/preload.ts', config: 'vite.preload.config.ts', target: 'preload' },
    ],
    renderer: [{ name: 'main_window', config: 'vite.renderer.config.ts' }],
  })],
};
