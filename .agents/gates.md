# Gates

```bash
npm run gates                                   # syntax check + node --test test/
BROWSE_BIN=/path/to/browse npm run gates        # + the two integration tests
```

**Always set `BROWSE_BIN`** to a real browse binary of the pinned version
(`PINNED_BROWSE_VERSION` in `src/core/config.js`). Without it the two
integration tests **skip**, and a green run then says nothing about browse
itself. Say which ran when you quote a result.

Get a binary without installing anything globally:

```bash
mkdir -p /tmp/bb-browse && cd /tmp/bb-browse
npm pack @opencode/browse-linux-x64@<pinned> && tar xzf *.tgz
# → /tmp/bb-browse/package/bin/browse
```

Is the pin still safe against upstream's newest stable? `node scripts/check-browse-pin.js` compares the extension protocol range and pairing scheme from source (network, not in the gates; exit 0 compatible, 1 not, 2 network error). It does not replace the `BROWSE_BIN` run.

The gates need only node, so a fresh worktree is enough (`worktreeSafe: true`).
`npm install` is needed only to *launch* the app (Electron).

## What each test needs, and leaves behind

| file | starts | ports | cleans up by |
| --- | --- | --- | --- |
| `test/integration.test.js` | a real browse relay, throwaway `HOME` | relay 39988, proxy 127.0.0.2:39988, inner 39991 | the pid `browse status` reports |
| `test/ssh.test.js` | an unprivileged `sshd` + a relay, throwaway keys/`HOME` | sshd 39922, relay 39978, proxy 127.0.0.3:39978, forward 39981 | the sshd pid file and the relay's port owner |

`node --test` runs files **in parallel**, so the two files' ports must never
overlap. That happened once and made both tests fail on each other's relay.

If a run is killed, find leftovers by **port** (`ss -ltnp | grep ':399'`) and
signal that pid. Never kill by name. A leaked ssh ControlMaster shows up as
`ssh: …/bb-ssh-*/cm/cm-* [mux]`.

## What green does not cover

- **The tray, notifications and autostart on Plasma.** GTK needs a display.
  `BB_SMOKE_OUT=<prefix> bin/browse-bridge --ozone-platform=headless` renders
  the window only, and skips the tray. `BB_THEME=dark|light`,
  `BB_SMOKE_SIZE=WxH` and `BB_SMOKE_PAIR=1` (needs a local relay config) vary
  the render. It writes `<prefix>-<tab>.png` and `<prefix>.json` (any console
  errors are listed there). With two or more hosts configured it also selects
  the second host and writes `<prefix>-host2.png`, `<prefix>-host2-log.png`
  and `second` (that render's text) in the JSON. Then it opens **General**
  (BBR-45) and writes `<prefix>-general.png`, with `general` in the JSON:
  `shown`, `tabsHidden`, `text`, `pollSeconds` and `autostart` (`text` is
  innerText, which leaves input values out, so the poll field's value is its
  own key). Next it selects the first host's Settings, expands the
  **Advanced** section and writes `<prefix>-advanced.png`, with `advanced`
  in the JSON: `host`, `collapsedByDefault` (true unless something opened it
  before the hook), `open`, `text`, `remotePort`, `remoteBrowse` and
  `transport`. `BB_SMOKE_INVALID=1` submits
  an Add Host form whose id clashes with the first host's and records the
  inline error under `invalid`; the config refuses it before writing. Last,
  it opens the Help and About dialogs, writes `<prefix>-help.png` and
  `<prefix>-about.png`, and records each dialog's text under `dialogs` (a
  closed `<dialog>` is not in `text`, so check `dialogs`, and that `about`
  shows a version).
- **Render with a throwaway config**, never your own: write
  `<tmp>/xdg/browse-bridge/config.json` (hosts with `autoConnect: false` and
  `.invalid` ssh hosts) and run with `XDG_CONFIG_HOME=<tmp>/xdg HOME=<tmp>/home`.
  The app log's `started; config <path>` line shows which file was read.
- **The window's renderer is an ES module** (`<script type="module">`), so it
  shares `src/ui/viewmodel.js` with the tests. If the module fails to load,
  nothing renders and `errors` may still be empty. Check that `text` shows
  host data, not just that `errors` is `[]`. Measured 2026-11-18 (BBR-15): a
  load-time error in `renderer.js` makes the smoke hook **hang**. It never
  writes `<prefix>.json`. So run the render under `timeout 90`, and treat a
  timeout (exit 124) or a missing JSON as red.
- **Where the render can run.** In a worktree-isolated agent session, Claude
  Code's isolation guard refuses the command because it "sets
  XDG_CONFIG_HOME". Run it from a session that is not worktree-isolated, e.g.
  the orchestrator against a `git worktree add --detach` of `origin/main` with
  `node_modules` symlinked from the primary checkout. Never drop the
  `XDG_CONFIG_HOME`/`HOME` override to get past the guard.
- **A throwaway `HOME` alone is the same isolation, and the guard allows it.**
  Measured 2026-11-19 (BBR-32): with `XDG_CONFIG_HOME` **unset** in the
  session (check: `echo "${XDG_CONFIG_HOME-unset}"`), Electron puts the config
  under `$HOME/.config`. So write `<tmp>/home/.config/browse-bridge/config.json`
  and run with only `HOME=<tmp>/home`, from inside the isolated worktree
  (`node_modules` symlinked in, and removed before committing: the
  `node_modules/` ignore rule matches a directory, not a symlink). It is valid
  only when the app log's `started; config <path>` line names that file, so
  read that line every time. If `XDG_CONFIG_HOME` is set, this route is
  closed.
- **The real dev004 tunnel and real Edge pairing.** Neither is reachable from
  the dev box. The owner verifies those.

## No CI

`ci: none`: a local green run is the only evidence, and must be said to be.
