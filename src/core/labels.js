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

/** The host form's button that tries the ssh destination and the remote browse before anything is saved (BBR-46). */
export const TEST_LABEL = 'Test Connection';

/** The host form's field for extra `ssh -o` options (index.html shows it with a trailing colon). */
export const SSH_OPTIONS_LABEL = 'SSH options';

/** The General page's checkbox that turns the daily check for a newer browse-bridge on and off (BBR-43). */
export const CHECK_UPDATES_LABEL = 'Check for updates';

/** The About dialog's button that fast-forwards the source checkout, installs if needed and restarts (BBR-43). */
export const UPDATE_LABEL = 'Update and Restart';

/** The About dialog's button that checks for updates now, instead of waiting for the daily check (BBR-43). */
export const CHECK_NOW_LABEL = 'Check Now';

/** The Status tab's button that installs a newer browse on the selected host and verifies it there (BBR-41). */
export const UPGRADE_BROWSE_LABEL = 'Upgrade browse';

/** The Status tab's button that puts a host that runs its own browse version back on the app's pin (BBR-41). */
export const ROLLBACK_BROWSE_LABEL = 'Roll back browse';

/** What the browse extension is called in the Chrome Web Store and on its toolbar button, since browse 0.1.5. */
export const EXTENSION_NAME = 'OpenCode Browse';
