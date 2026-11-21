/**
 * The words a person is told to look for (BBR-37). Plain strings with no
 * imports, so the Electron-free core (tray, controller) and the window's ES-module
 * renderer (through viewmodel.js) read the same constants. A message that names a
 * control reads it from here; test/labels.test.js pins that, and that index.html's
 * buttons carry the same text.
 */

/** The toolbar button and tray item that installs, pins and verifies browse on the remote host. */
export const SETUP_LABEL = 'Set Up Host';

/** The toolbar button and tray item that runs `browse restart` on the remote host (starts the relay if it is not running). */
export const RELAY_LABEL = 'Restart Relay';

/** What the browse extension is called in the Chrome Web Store and on its toolbar button, since browse 0.1.5. */
export const EXTENSION_NAME = 'OpenCode Browse';
