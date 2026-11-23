# Gates

```bash
npm run gates                                   # syntax check + node --test test/*.test.js
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

**Measured auto-mode classifier verdicts on that step** (newest first). Send
it as the plain step above, alone: no pipes, no commands appended. The
classifier judges a compound call as a whole. A refusal is never routed
around (a container copy-out, another tool, a rewording); the owner confirms
the exact step instead.

**The verdict differs from one session to the next**, so a `BROWSE_BIN` run is
never guaranteed. The same plain step passed on one day and was refused the
next. An owner's confirmation covers only the session it was given in. Plan
for the gates to run without `BROWSE_BIN`, and say so whenever they do.

| date | call | verdict |
| --- | --- | --- |
| 2026-11-23 | the plain step for 0.1.4, alone (BBR-76) | refused, *Undermining Oversight* |
| 2026-11-23 | the plain step for 0.1.5, alone (BBR-76) | refused, *Undermining Oversight* |
| 2026-11-22 | the plain step for 0.1.5, alone, retried unaltered after the owner confirmed it in an attended session (BBR-40) | passed |
| 2026-11-22 | the plain step for 0.1.5, alone, before confirmation (BBR-40) | refused, *Undermining Oversight* |
| 2026-11-22 | `npm pack @opencode/browse-linux-x64@0.1.5 2>&1 \| grep …` + unpack + run, with two unrelated commands appended | refused, *Undermining Oversight* |
| 2026-11-22 | the plain step for 0.1.4 (`mkdir`, `cd`, `npm pack`, `tar xzf`, `browse version`) | passed |
| 2026-11-22 | `npm pack` of the arm64 and arm64-musl 0.1.4 tarballs, not run | passed |
| 2026-11-22 | curl of the Chrome Web Store listing with a Google consent cookie | refused, *Unauthorized Access*. The store's version needs a real browser (BBR-51) |
| 2026-11-21 | `npm pack` of 0.1.4 and 0.1.5, then `browse --version` | refused, *Undermining Oversight* |

Real tarballs downloaded and run **inside throwaway Docker containers** passed
on both days (BBR-64, BBR-66, BBR-67). A binary inside a container does not
give `BROWSE_BIN` a host path, and copying one out to dodge a refusal is
routing around it.

Is the pin still safe against upstream's newest stable? `node scripts/check-browse-pin.js` compares the extension protocol range and pairing scheme from source (network, not in the gates; exit 0 compatible, 1 not, 2 network error). It does not replace the `BROWSE_BIN` run.

The gates need node plus the system tools the setup script uses (bash, sh,
tar, gzip, coreutils, grep, sed, awk, openssl), all from the host, nothing from
`node_modules`, so a fresh worktree is enough (`worktreeSafe: true`).
`/bin/sh` must not be bash (a test refuses it): every `script()` body runs
remotely under `sh -s` (BBR-57), and the POSIX runs are only evidence where
`sh` is dash. busybox is optional; where present, the parse check and
`test/setup-tilde.test.js` also run under its ash, Alpine's `sh`. It cannot run
the whole-script cases: ash finds its own `uname`, `od`, `tar` applets whatever
`PATH` says, so the fakes would not hold. Note that `sh -n` passes a bash
substring like `${x:2}`; only running the script (dash: "Bad substitution")
catches it.
`npm install` is needed only to *launch* the app (Electron).

## What each test needs, and leaves behind

| file | starts | ports | cleans up by |
| --- | --- | --- | --- |
| `test/integration.test.js` | a real browse relay, throwaway `HOME` | relay 39988, proxy 127.0.0.2:39988, inner 39991 | the pid `browse status` reports |
| `test/ssh.test.js` | an unprivileged `sshd` + a relay, throwaway keys/`HOME` | sshd 39922, relay 39978, proxy 127.0.0.3:39978, forward 39981 | the sshd pid file and the relay's port owner |
| `test/sshtest-sshd.test.js` | an unprivileged `sshd`, throwaway keys/known_hosts/`HOME`, a stub `browse` script; needs no `BROWSE_BIN`, so it runs whenever `/usr/sbin/sshd` exists | sshd 39924 | the sshd pid file |
| `test/setup-script.test.js` | `SETUP_SCRIPT` under `sh -s` (dash) and `bash -s` in a throwaway `HOME`, against a fake `curl` serving a locally made tarball; PATH is an allow-list of symlinked host tools plus fakes, never `/usr/bin`, so the real curl and npm cannot run | none | nothing to stop (the fake browse only prints); its `bb-setup-*` / `bb-piece-*` temp dirs are removed after each test (BBR-61) |

`node --test` runs files **in parallel**, so the two files' ports must never
overlap. That happened once and made both tests fail on each other's relay.

## The ssh guard (BBR-60)

`npm test` and `npm run gates` set `BB_FORBID_SSH=1`. With it, `assertSshAllowed`
in `src/core/exec.js` refuses (throws, prints `BB_FORBID_SSH: refusing to run ssh
to "<dest>"`, and sets `process.exitCode = 1` so a caller that swallows the throw
still fails its file) any `ssh`/`scp`/`sftp` whose destination, the argument
after `--`, is not loopback (`127.x.y.z`, `localhost`, `::1`). It covers `run()`
(so every transport call) and the tunnel's default spawner. The two private-sshd
tests pass because they connect to 127.0.0.1, not because they are listed. Unset,
nothing changes (`test/sshguard.test.js` pins both directions).

If a test trips it, stub the transport (see how `test/hosts.test.js` stubs
`pollNow`); do not exempt the test. A bare `node --test file` run does not set
the variable: prefix it with `BB_FORBID_SSH=1`.

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
- **A throwaway `HOME` alone is refused inside an isolated session too.**
  On 2026-11-19 (BBR-32) the guard allowed it. On 2026-11-23 (BBR-70) a
  worktree-isolated subagent sent `HOME=<tmp>/home BB_SMOKE_OUT=… timeout 90 …`
  with `XDG_CONFIG_HOME` unset, and it was refused: "sets HOME, injecting git
  configuration whose effect on where git writes can't be verified". So
  **every smoke render is run by a session that is not worktree-isolated**
  (the orchestrator), pointed at the isolated worktree's path. With
  `XDG_CONFIG_HOME` unset (`echo "${XDG_CONFIG_HOME-unset}"`), Electron reads
  `$HOME/.config`, so write `<tmp>/home/.config/browse-bridge/config.json` and
  run with only `HOME=<tmp>/home`. The run is valid only when the app log
  (`<tmp>/home/.config/browse-bridge/logs/app.log`) reads `started <version>;
  config <that file>`, so read that line every time.
- **The AppImage render** (BBR-70). After `pnpm run dist`, run
  `dist/browse-bridge-x86_64.AppImage --ozone-platform=headless` directly,
  with the same `HOME`, `BB_SMOKE_OUT` and `timeout 90`. It is built on the
  static AppImage runtime, so it needs no libfuse2. Check
  `dialogs.about` shows the bare `package.json` version (a packaged build makes
  no git call). To prove the startup refresh, first plant stale
  `<tmp>/home/.config/autostart/browse-bridge.desktop` and
  `<tmp>/home/.local/share/applications/browse-bridge.desktop` with
  `Exec=/tmp/.mount_stale/…`. After the run, both `Exec=` lines must name the
  AppImage, and only the autostart one has `--hidden`.
- **The real dev004 tunnel and real Edge pairing.** Neither is reachable from
  the dev box. The owner verifies those.

## CI

`ci: github-hosted`. Two workflows in `.github/workflows/`:

- **`gates.yml`** runs `npm run gates` on every PR and on every push to
  `main`, with `BROWSE_BIN` set to the pinned browse, so **nothing skips**. Its
  `gates` check is the one the merge waits for. It is the only place the two
  browse integration tests are guaranteed to run, because the local download
  of browse is classifier-refused in some sessions (table above). A local run
  without `BROWSE_BIN` is still worth doing first, and must say that two tests
  skipped.
- **`release.yml`** runs the gates again, builds the AppImage and smokes it
  headlessly. On a PR it is a **dry run**, triggered only when the PR touches
  the workflow files, `scripts/`, `package.json` or the lockfile; it never
  publishes. On a pushed `v*` tag it publishes to GitHub Releases. A tag is
  never pushed as part of an issue's PR (AGENTS.md).
