# browse-bridge

A tray app that lets AI agents on a remote dev host (e.g. `dev004`) drive the
browser on **this** machine, using [browse](https://github.com/anomalyco/browse)
(an MCP server + Chromium extension from the [OpenCode](https://opencode.ai)
project) over an SSH tunnel you already have.

> browse-bridge is an independent project. It is **not affiliated with,
> endorsed by, or supported by** OpenCode, Anomaly or the browse project — see
> [Credits and affiliation](#credits-and-affiliation).

It replaces the manual routine:

```
# before (Playwright MCP)                      # now (browse, done by this app)
npx @playwright/mcp --extension --port 8931    browse relay runs on dev004, loopback only
ssh -R 8931:localhost:8931 dev004              ssh -N -L 19989:127.0.0.1:19988 dev004
```

```
 Edge + browse extension ──► 127.0.0.1:19988 ──► 127.0.0.1:19989 ══ssh -L══► dev004 127.0.0.1:<relay port> ◄── Claude (browse mcp)
                             (app's counting      (ssh forward)
                              proxy)
```

The browser connects *out* to the relay, so the forward is `-L` from this
machine — no inbound ports, nothing listening on dev004 beyond loopback, and
the link (which browse itself does not encrypt) rides inside SSH.

<img width="888" height="575" alt="image" src="https://github.com/user-attachments/assets/8c3de882-0793-4e99-82c7-c6e05f533ef4" />

## What it does

- **Tunnel, kept up:** `ssh -N -L` with `BatchMode`, `ExitOnForwardFailure`,
  keepalives, and reconnect with backoff (1 s → 30 s). Follows the relay if it
  moves port.
- **Set Up Host:** one button installs browse **pinned** (0.1.5) into
  `~/.local` on the remote (no sudo). On Linux (x64 or arm64, glibc or musl)
  it downloads the native binary's tarball from the npm registry with `curl`
  and checks its SHA-512 against the registry's integrity, so the remote
  needs neither npm nor Node; npm is used only on a non-Linux remote. The
  script runs under the remote's POSIX `sh`, so a busybox-only host such as
  stock Alpine needs no bash. It turns auto-update **off** persistently,
  binds the relay to `127.0.0.1`, restarts it — then **verifies at the remote**
  (version, `autoUpdate.effective`, and that the relay port listens on loopback
  only). Any mismatch shows as a problem, never as success. A host that was
  upgraded on its own (below) gets its own version instead of the pin.
- **A newer browse, one host at a time:** at start-up and once a day (with
  **Check for updates** on in General), and on **Check Now** on the Status
  tab, the app reads the newest stable `@opencode/browse` from the npm registry
  and says whether this release was tested with it ("browse 0.1.6 available
  (not yet tested with this app)"). **Upgrade browse** on a host's Status tab
  runs the same setup with that version on that host only, then verifies there:
  the version, auto-update off, loopback only, and a status poll that shows the
  browser reconnecting (when one was connected before). **Roll back browse**
  puts the host back on the pin the same way. Every result is written to the
  host's log, and a failed one stays a warning on the host. Nothing upgrades on
  its own: there is no auto-upgrade switch.
- **Several hosts at once:** the window's **host list** (left) shows every
  configured host with its state, ssh destination and pairing address. Select
  one and the toolbar, Status, Traffic, Log and Settings act on that host only.
  **Add Host…** gives a new host the next free loopback address (or the one you type),
  **Remove Host…** (in Settings) disconnects and drops one, and a refused
  setting (an address another host uses, a duplicate id, a bad ssh destination) is
  shown next to the field it is about. A host's relay port and remote browse
  path are under **Advanced** in its Settings, collapsed by default.
- **General:** below the host list, the settings for the whole app. These are
  start at login, the status poll interval and the pinned browse version, shown
  read-only (one host can run another version through **Upgrade browse**, above).
  **Open Config File** opens `config.json` for anything else.
- **Pair browser:** asks the selected host's relay for a one-time code and
  shows it with **that host's** address to enter (`localhost:19988` for the
  first host, `127.0.0.2:19988` for the second, …). Codes never reach the log.
  It works while a browser is already connected, too: the dialog stays open
  until a browser the relay did not list before appears, so a second browser
  or profile can pair with the same host.
- **Status:** polls `browse status --json` over ssh (multiplexed): relay,
  extension, paired browsers, agent tabs, auto-update. Anything unmeasured
  shows as *unknown*, not healthy.
- **Browsers:** under Status, one row per browser paired with the host,
  connected or not (from `browse pair --list`, since `browse status` lists only
  connected ones): its
  name (as the extension reports it, e.g. "Brave on laptop"), its id, whether
  it is connected, which one is the default, and its agent tabs. The id (or
  the name) is what an agent passes as `browser` when it opens a tab, so two
  agents on one host can each drive their own browser; **Copy id** copies it.
  **Unpair…** asks first, then runs `browse pair --revoke <id>` on that host,
  and reports success only once `browse pair --list` no longer lists it. An
  unpaired browser needs a new pairing code to come back. The name comes from
  browse; browse-bridge only shows it.
- **Traffic:** bytes up/down, live rate, connections open/total/failed, and a
  per-connection log line. On a host's own loopback address (`127.0.0.2`, …)
  it reads the browser's request heads only to rename that exact address in
  the `Host:` header to `127.0.0.1`, the only loopback name the relay accepts.
  Any other name (a DNS-rebound one, say) is passed on as sent, so the relay's
  rebinding check still applies. The port is never changed. What the relay
  sends is not decoded unless you opt in, below.
- **Browser actions (opt-in, per host):** tick **Count browser actions** in
  Settings and the Traffic tab counts the commands the relay sends the
  browser, by type (navigate, pointer, keyboard, screenshot, script, read,
  tab, setup, other), and lists the names sent most often. Each connection's
  log line gets a summary (`· 42 commands: pointer 20 · script 12 · …`).
  Only the command's **name** is read (`Page.navigate`,
  `Input.dispatchMouseEvent`, …), never its parameters: no URL, typed text
  or script reaches the window or the log. The browser's replies are never
  decoded. These are browser commands, not agent tool calls: the agent's
  tool calls go to the relay on the remote host and never cross this tunnel,
  and one tool call (a click, say) is usually several commands. Pairing and
  keep-alive pings are not counted. If a connection cannot be read (a browse
  version other than 0.1.5 that compresses or changes its frames, say), the
  tab says so rather than showing zero.
- **Logs:** live in the window, in `~/.config/browse-bridge/logs/app.log`
  (rotated at 1 MB), plus the remote relay log on demand. Each line is tagged
  with its host; the Log tab shows the selected host's lines (or **All hosts**)
  and the selected host's relay log.
- **Tray:** one icon for every host together — all up (green disc), some down
  (amber half disc), all down (red disc with a bar), all stopped (grey square),
  no host (grey dash): each differs by **shape** as well as colour. The tooltip
  names each host and its state in words (`dev004: Connected · dev005: Tunnel
  down`). Each host has a submenu with its own controls (Connect/Disconnect,
  Pair browser…, Restart Relay, Set Up Host, Show logs); Show window, Open
  log file, Start at login, Help, About browse-bridge… and Quit stay top level. Every control is in the
  menu (Linux tray clicks are unreliable). Desktop notification, naming the
  host, when a host connects or disconnects. Optional start at login (XDG
  autostart, which Plasma reads), in the tray menu and on the General page.

- **Help and About:** **Help** (toolbar, tray, or <kbd>F1</kbd>) explains first
  run, several hosts, every state and the shortcuts. **About** shows the running
  version, the licence and a link to this repository, which opens in your
  default browser.

## Install (on the machine with the browser)

Requires key-based ssh to the remote host (the app never prompts for a password
— load your key into the agent or set `IdentityFile`).

### The AppImage

Download `browse-bridge-x86_64.AppImage` and `SHA256SUMS` from the latest
[GitHub release](https://github.com/runnane/browse-bridge/releases/latest),
check the file, and run it:

```bash
sha256sum -c SHA256SUMS --ignore-missing
chmod +x browse-bridge-x86_64.AppImage
./browse-bridge-x86_64.AppImage
```

It needs FUSE 3's `fusermount3` (or run it with `APPIMAGE_EXTRACT_AND_RUN=1`),
and no Node. To add it to the application menu, tick **Show in application
menu** on the General page. Keep the file where it is: autostart and the menu
entry name its path. It updates itself (see Updating).

### From a source checkout (development)

Requires Node ≥ 22 (npm or pnpm both work).

```bash
git clone git@github.com:runnane/browse-bridge.git ~/dev/browse-bridge
cd ~/dev/browse-bridge
npm install        # or: pnpm install
bin/browse-bridge
```

`bin/browse-bridge` starts Electron with Chromium's setuid sandbox when
`chrome-sandbox` is set up, and with `--no-sandbox` otherwise (Ubuntu 24.04
blocks the unprivileged sandbox; the window only loads this app's own local
page). It prints the `chown`/`chmod` that keeps the sandbox, if you prefer.

On pnpm 10 the install skips Electron's download; `bin/browse-bridge`
fetches it on first launch (one-off, ~100 MB).

### Updating

One setting, **Check for updates** (General; on by default), governs both
install kinds.

**The AppImage** checks GitHub Releases at start-up and once a day. A newer
release shows as **Update available: browse-bridge X.Y.Z** in the status bar,
the tray and About, and is downloaded in the background. It is installed when
browse-bridge quits, over the same file, so autostart and the menu entry keep
working (keep the file's name free of a version number: electron-updater
writes a versioned name under the new version instead). The app never restarts by itself, because a restart drops every
tunnel. To install at once, click **Update and Restart** in About: every host
is stopped cleanly, the update installs, and the app starts again. With
**Check for updates** off, nothing is checked or downloaded, and an update
already downloaded is not installed on quit.

**A source checkout**: with **Check for updates** on, the app fetches the
checkout's default branch at start-up and once a day, with no prompt (ssh
`BatchMode=yes`), and shows **Update available: N commits** in the status bar,
the tray and About. Nothing is installed until you click
**Update and Restart** in About: it fast-forwards the checkout (`git merge --ff-only`), runs
`npm install` or `pnpm install` (whichever installed `node_modules`) only when
`package.json` or a lockfile changed, then stops every host and restarts. It
refuses, changing nothing, when a tracked file has local changes, the checkout
is not on the default branch, or it has commits of its own. A failed fetch
reads "Could not check for updates", never "up to date". By hand, the same is
`git pull --ff-only`, then the install if the lockfile changed, then a restart.

## First run

Use the **plain** host (e.g. `jon@dev004`), not an alias that carries a
`LocalForward`, and stop any manual `ssh -L 19988` first — the app owns
`localhost:19988` and reports that address "in use" otherwise.

1. In the window, set **SSH host** (`jon@dev004` or an `~/.ssh/config` alias)
   on the Settings tab and **Apply**. The field suggests the aliases in your
   `~/.ssh/config` and warns about one with a `LocalForward`; **Test
   Connection** tries the login and the remote browse before anything is
   saved, and says what to do when ssh refuses. For another host, use
   **Add Host…** under the host list.
2. **Set Up Host** → expect "Host verified".
3. Install the **OpenCode Browse** extension in Edge/Chrome (Chrome Web Store; in Edge
   allow extensions from other stores).
4. **Pair browser** → in the extension: *Options → advanced / Pair with a
   code*, enter the code and the address `localhost:19988`, click Connect.
5. The host's row in the window, and its line in the tray tooltip, say
   "Connected". (The tray icon is a filled green disc once every host's
   bridge is up, which does not wait for a browser.)

Agents on the remote use it through the `browse` MCP server
(`browse install -a claude` registers it; you did this once already).

## Config

`~/.config/browse-bridge/config.json` (written by the Settings form and the General page) holds a
**list of hosts**, each bridged on its own at the same time, plus two app-wide
settings:

```json
{
  "pollSeconds": 10,
  "hosts": [
    { "id": "host-1", "host": "jon@dev004" },
    { "id": "build", "name": "build box", "host": "jon@build01", "localAddress": "127.0.0.2", "innerPort": 19991 }
  ]
}
```

Only values that differ from the defaults are stored, so a later default (for
example a new browse pin) still applies.

If you edit the file by hand and it no longer reads (a JSON typo, an invalid
value), the app keeps it: it copies the file to
`config.json.broken-<timestamp>`, shows the error in the window and the tray
menu, and saves nothing over it. Fix the file and click **Reload**, or click
**Start Over** to replace it with one empty host.

The *in the window* column says where each key is edited. A key marked
*file only* is changed by editing config.json: **Open Config File** on the
General page opens it.

App-wide (the **General** page, below the host list):

| key | default | in the window | meaning |
| --- | --- | --- | --- |
| `browseVersion` | 0.1.5 | General, read-only | pinned version setup installs and checks on every host without its own |
| `pollSeconds` | 10 | General | status poll interval in seconds (2 to 3600 in the window); a change reconnects no host |
| `checkUpdates` | true | General | check daily whether origin has a newer browse-bridge (see Updating) and whether the npm registry has a newer browse; saves on tick, reconnects no host |

Start at login is on the General page too. It is not a config key: it is the
XDG autostart entry, and it saves as soon as you tick it.

**Show in application menu** (General, source installs only) writes
`$XDG_DATA_HOME/applications/browse-bridge.desktop` (`~/.local/share/applications/`
when unset) and installs an icon under `icons/hicolor/`, so KRunner, the
launcher or GNOME's overview can start browse-bridge without a terminal. Unlike
the login entry it does not pass `--hidden`: the window opens. Unticking removes
both. It is hidden in a packaged build, which ships its own entry.

Per host (each entry in `hosts`):

| key | default | in the window | meaning |
| --- | --- | --- | --- |
| `id` | `host-1`, `host-2`, … | Settings, on Add Host only | lower-case id; tags that host's log lines |
| `name` | — | Settings | display name |
| `host` | — | Settings | ssh destination |
| `localAddress` | 127.0.0.1, 127.0.0.2, … | Settings | the extension pairs with `<localAddress>:<relay port>` (127.0.0.1 shows as `localhost`) |
| `innerPort` | 19989, 19991, … | file only | ssh's forward port on 127.0.0.1 (internal) |
| `remotePort` | 19988 | Settings → Advanced | relay port until status reports the real one |
| `remoteBrowse` | `$HOME/.local/bin/browse` | Settings → Advanced | browse on the remote. Set Up Host installs browse only at the default path; anywhere else it must already be the pinned version |
| `transport` | `ssh` | Settings → Advanced, read-only | `ssh`, or `local` to run browse on this machine (tests) |
| `autoConnect` | true | Settings | connect when the app starts |
| `countActions` | false | Settings | count the commands the relay sends the browser (see above) |
| `sshOptions` | `[]` | Settings | extra `-o Key=value` options |
| `browseVersion` | — (the pin) | Status, **Upgrade browse** / **Roll back browse** | this host's own browse version, a stable `x.y.z`; set by Upgrade, removed by Roll back. Set Up Host and the version warning use it instead of the pin. A change reconnects no host |

**Why an address per host, not a port per host:** the browse extension binds
its pairing proof to the port it dials, and the relay checks it against its own
port. So the extension must dial **the relay's own port** (19988 unless the
remote moved it), and the only thing left to tell hosts apart is the address.
A proxy on any other port opens the socket but every pairing code is refused
as "wrong pairing code" (BBR-21). The pairing port is therefore not a setting:
it follows the port `browse status` reports.

A host without an address or inner port gets the first free one (127.0.0.1,
then 127.0.0.2, …; a `local`-transport host starts at 127.0.0.2, since the relay
itself holds 127.0.0.1). Values a host has are never moved, so removing one host
leaves the others' pairing addresses alone. Two hosts with the same
`localAddress` or `innerPort`, or that share an `id`, are refused when the
config is loaded or saved.

### One browser profile, one host at a time

Every host stays bridged at once, each on its own `<localAddress>:<relay port>`. A
browser **profile**, though, follows **one** host at a time: the browse
extension keeps one relay address and one connection. So:

- To use a second host from the same profile, enter that host's address in
  the extension's options. Pairing is remembered per address, so switching a
  profile back to a host it already paired with needs no new code.
- To use two hosts at the same moment, pair a second profile (or a second
  browser) with the other host's address.
- To give one host two browsers (say, two agent sessions there, each driving
  its own), pair the second browser with the **same** host: **Pair Browser…**
  issues a fresh code even while one browser is connected. The relay then
  lists both (the Status tab's **Browsers** list), and an agent picks one with
  the `browser` argument when it opens a tab (`tabs` with `action: "new"`);
  without it, a tab opens in the first connected browser.

The window shows and edits every host. The tray shows them all at once: its
icon is the aggregate, and each host has its own submenu.

**Migration:** a config from an earlier release (top-level `host`, … and no
`hosts`) loads as a one-host list (`id` `host-1`) with the same values. A stored
`localPort` is dropped, and each host gets an address in list order, so the
first keeps `localhost:19988` and a browser already paired there keeps working.
Every other host needs pairing once at its new address. The file is rewritten
on the next Save.

### Which browse versions work together

The pin today is browse **0.1.5**: Set Up Host installs it on each remote
host, turns browse's auto-update off, and warns when a host runs anything
else. The browser extension is not pinned: the Chrome Web Store always serves
the newest **stable** release (development builds never reach the store). So
a pinned relay meets an extension that moves on its own. This is why that is
safe, and how long it stays safe.

**Compatibility.** The extension and the relay agree on an *extension protocol*
number; a relay accepts the range MIN..CURRENT and refuses anything outside it
(the connection closes with code 4003). The pinned relay accepts 3..3. Browse
0.1.5, the current stable, also speaks 3, with the same pairing scheme
(`opencode-browser-pairing-v3`), handshake and relay-to-browser frames: 0.1.5
is a rename of the extension to OpenCode Browse and nothing else. The 0.1.6
development line changes none of those either. *Evidence:* read from
upstream's source at each tag (BBR-39); a live run of the store extension
against the pinned relay is not yet measured (BBR-51).

**How far the pin may lag.** The pin may stay behind upstream for as long as
the newest stable extension's protocol lies inside the pin's MIN..CURRENT
range and the pairing scheme is unchanged; the age of the pin does not matter.
Check on every upstream stable release, ideally within about two weeks:

```bash
node scripts/check-browse-pin.js   # exit 0: compatible; 1: move the pin; 2: could not check
```

It compares `protocol.rs` at the pin's tag and the newest stable tag, and
lists which of the handshake, pairing, protocol and wire files changed, so you
know what to read. When a stable release raises the protocol above the pin's
CURRENT, move the pin before that extension reaches the store; otherwise the
extension is refused and tells the user to update browse. A pin bump is itself
gated on the integration tests against the real binary (`BROWSE_BIN`, below).

**"browse 0.1.5 is out of date" in the extension.** With auto-update off, the
relay still checks for releases and tells the extension about newer ones, so
the extension's settings page shows *"browse 0.1.5 is out of date (… is out).
Run …"* with an update command (for an npm install, `npm install -g
@opencode/browse@latest`). **Ignore it.** Running that command on a host
replaces the pinned version with whatever is newest, which is exactly what the
pin exists to prevent; the app will then warn that the running version is not
the pinned one, and Set Up Host puts the pin back. To try a newer browse, use
**Upgrade browse** on one host's Status tab: it installs the version the app's
registry check found on that host only and verifies it there, and **Roll back
browse** returns it to the pin. Updating browse-bridge moves the pin for every
host once a version is tested (`TESTED_BROWSE_VERSIONS` beside the pin in
`src/core/config.js`). *Evidence:* the
notice and its command are read from upstream's source; the live wording and
where it appears are not yet measured (BBR-51).

## Development

```bash
npm run gates                                 # syntax check + all tests
BROWSE_BIN=~/.local/bin/browse npm run gates  # + integration tests against real browse (local, and ssh via a private sshd)
BB_SMOKE_OUT=/tmp/bb bin/browse-bridge --ozone-platform=headless   # render the window headlessly → /tmp/bb.png/.json
```

The integration test runs the controller against the real browse binary in a
throwaway `HOME` on ports 39988–39991, and stops the relay it started.

### Build an AppImage locally

```bash
pnpm install
pnpm run dist      # → dist/browse-bridge-x86_64.AppImage
```

`dist` runs electron-builder with `--publish never`; nothing is uploaded from a
local build. The file name carries no version, so the autostart and
application-menu entries the app writes (they name `$APPIMAGE`, not the
transient `/tmp/.mount_*` path) keep working after the file is replaced.
The AppImage keeps Chromium's sandbox where unprivileged user namespaces work,
and starts with `--no-sandbox` where they do not (Ubuntu 24.04+ by default),
the same policy as `bin/browse-bridge`. It uses the static AppImage runtime,
so it needs FUSE 3's `fusermount3` but not libfuse2 (absent from a default
Ubuntu 24.04). Without FUSE at all, run it with `APPIMAGE_EXTRACT_AND_RUN=1`.

### Cutting a release

A release is a `v*` tag pushed to `main`. The tag push, and nothing else,
builds the AppImage, smokes it headlessly, and publishes it to GitHub Releases
with `latest-linux.yml` (the updater's feed) and `SHA256SUMS`
(`.github/workflows/release.yml`). `main` takes no direct pushes, so the
version bump is an ordinary PR and the tag comes after it merges. The workflow
refuses a tag whose commit is not an ancestor of `origin/main`:

1. On a topic branch cut from fresh `origin/main` (named for the release
   issue, e.g. `chore/bbr-99-release-0-2-0`), run `pnpm run release`.
   release-it picks the bump from the conventional commits since the last tag,
   rewrites `package.json`'s `version` and commits it. It does not tag, push
   or publish; `.release-it.json` turns those off.
2. Push the branch and open a PR carrying the release issue's key. Merge it
   once `gates` is green.
3. On the merge commit, push the tag, which must be `v` plus the new version
   (the workflow's first step fails any other tag):

   ```bash
   git fetch origin
   git tag v0.2.0 origin/main
   git push origin v0.2.0
   ```

The workflow runs the same gates as every PR, then the build, then the smoke
render, and publishes only if all of them are green. Changes to the workflow
itself run all of it except the publish on their PR.

## Credits and affiliation

All of the browser automation — the `browse` MCP server, the relay and the
Chromium extension — is [**browse**](https://github.com/anomalyco/browse), made
by the [OpenCode](https://opencode.ai) team at Anomaly and published on npm as
[`@opencode/browse`](https://www.npmjs.com/package/@opencode/browse) under the
[MIT License](https://github.com/anomalyco/browse/blob/main/LICENSE)
(Copyright © 2025 opencode). browse-bridge only tunnels, watches and sets up
what browse already does; thanks to its authors for building it.

- **Not affiliated.** browse-bridge is an independent, unofficial companion
  tool. It is not affiliated with, endorsed by, sponsored by or supported by
  OpenCode, Anomaly or the browse project. "browse" and "OpenCode" are used
  only to name the software this app works with; they belong to their owners.
- **Not bundled.** This repository contains no browse code or assets. **Set Up
  Host** installs the pinned `@opencode/browse` release from the npm
  registry onto your remote host, and the extension comes from the Chrome Web
  Store; both are distributed by their authors under their own license.
- **Where to report problems.** Bugs in browse itself (the MCP server, relay,
  extension or pairing) belong in
  [browse's issue tracker](https://github.com/anomalyco/browse/issues) — but
  please reproduce them without browse-bridge first. Anything about the tunnel,
  tray, window or setup button belongs here, not upstream.

## License

[MIT](LICENSE). browse is licensed separately by its authors, also under MIT.
