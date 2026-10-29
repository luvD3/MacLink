const { MakerZIP } = require('@electron-forge/maker-zip');
const { MakerSquirrel } = require('@electron-forge/maker-squirrel');
const { VitePlugin } = require('@electron-forge/plugin-vite');
const { version } = require('./package.json');

module.exports = {
  packagerConfig: {
    asar: true,
    executableName: 'MacLink',
    icon: './assets/maclink.ico',
    appBundleId: 'app.maclink.viewer',
    extraResource: ['THIRD_PARTY_NOTICES.md', 'third-party'],
  },
  makers: [
    new MakerSquirrel({
      name: 'MacLink',
      exe: 'MacLink.exe',
      setupExe: `MacLink-${version}-Setup.exe`,
      setupIcon: './assets/maclink.ico',
      nuspecTemplate: './build/windows-installer.nuspectemplate',
      noMsi: true,
    }),
    new MakerZIP({}, ['win32']),
  ],
  plugins: [new VitePlugin({
    build: [
      { entry: 'src/main.ts', config: 'vite.main.config.ts', target: 'main' },
      { entry: 'src/preload.ts', config: 'vite.preload.config.ts', target: 'preload' },
    ],
    renderer: [{ name: 'main_window', config: 'vite.renderer.config.ts' }],
  })],
};
