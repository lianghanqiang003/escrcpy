import { createWindowManager } from '@escrcpy/electron-setup/main'

export default {
  name: 'module:main',
  apply(mainApp) {
    createWindowManager('main', {
      singleton: true,
      mainWindow: true,
      browserWindow: {
        persistenceBounds: true,
        // Live phone previews must keep presenting while this window is occluded.
        webPreferences: { backgroundThrottling: false },
      },
      hooks: {},
    })
  },
}
