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
  and `second` (that render's text) in the JSON. `BB_SMOKE_INVALID=1` submits
  an Add Host form whose id clashes with the first host's and records the
  inline error under `invalid`; the config refuses it before writing.
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
- **The real dev004 tunnel and real Edge pairing.** Neither is reachable from
  the dev box. The owner verifies those.

## No CI

`ci: none`: a local green run is the only evidence, and must be said to be.
