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
- **Set up remote host:** one button installs browse **pinned** (0.1.4) into
  `~/.local` on the remote (no sudo), turns auto-update **off** persistently,
  binds the relay to `127.0.0.1`, restarts it — then **verifies at the remote**
  (version, `autoUpdate.effective`, and that the relay port listens on loopback
  only). Any mismatch shows as a problem, never as success.
- **Several hosts at once:** the window's **host list** (left) shows every
  configured host with its state, ssh destination and pairing address. Select
  one and the toolbar, Status, Traffic, Log and Settings act on that host only.
  **Add Host…** gives a new host the next free loopback address (or the one you type),
  **Remove Host…** (in Settings) disconnects and drops one, and a refused
  setting (an address another host uses, a duplicate id, a bad ssh destination) is
  shown next to the field it is about.
- **Pair browser:** asks the selected host's relay for a one-time code and
  shows it with **that host's** address to enter (`localhost:19988` for the
  first host, `127.0.0.2:19988` for the second, …). Codes never reach the log.
- **Status:** polls `browse status --json` over ssh (multiplexed): relay,
  extension, paired browsers, agent tabs, auto-update. Anything unmeasured
  shows as *unknown*, not healthy.
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
  version other than 0.1.4 that compresses or changes its frames, say), the
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
  Pair browser…, Start relay, Set up remote host, Show logs); Show window, Open
  log file, Start at login and Quit stay top level. Every control is in the
  menu (Linux tray clicks are unreliable). Desktop notification, naming the
  host, when a host connects or disconnects. Optional start at login (XDG
  autostart, which Plasma reads).

## Install (on the machine with the browser)

Requires Node ≥ 22 (npm or pnpm both work), and key-based ssh to the remote host (the app never
prompts for a password — load your key into the agent or set `IdentityFile`).

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

## First run

Use the **plain** host (e.g. `jon@dev004`), not an alias that carries a
`LocalForward`, and stop any manual `ssh -L 19988` first — the app owns
`localhost:19988` and reports that address "in use" otherwise.

1. In the window, set **SSH host** (`jon@dev004` or an `~/.ssh/config` alias)
   on the Settings tab and **Apply**. For another host, use **Add Host…**
   under the host list.
2. **Set up remote host** → expect "Remote verified".
3. Install the browse extension in Edge/Chrome (Chrome Web Store; in Edge
   allow extensions from other stores).
4. **Pair browser** → in the extension: *Options → advanced / Pair with a
   code*, enter the code and the address `localhost:19988`, click Connect.
5. The host's row in the window, and its line in the tray tooltip, say
   "Connected". (The tray icon is a filled green disc once every host's
   bridge is up, which does not wait for a browser.)

Agents on the remote use it through the `browse` MCP server
(`browse install -a claude` registers it; you did this once already).

## Config

`~/.config/browse-bridge/config.json` (written by the Settings form) holds a
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

App-wide:

| key | default | meaning |
| --- | --- | --- |
| `browseVersion` | 0.1.4 | pinned version setup installs and checks |
| `pollSeconds` | 10 | status poll interval |

Per host (each entry in `hosts`):

| key | default | meaning |
| --- | --- | --- |
| `id` | `host-1`, `host-2`, … | lower-case id; tags that host's log lines |
| `name` | — | display name |
| `host` | — | ssh destination |
| `localAddress` | 127.0.0.1, 127.0.0.2, … | the extension pairs with `<localAddress>:<relay port>` (127.0.0.1 shows as `localhost`) |
| `innerPort` | 19989, 19991, … | ssh's forward port on 127.0.0.1 (internal) |
| `remotePort` | 19988 | relay port until status reports the real one |
| `remoteBrowse` | `$HOME/.local/bin/browse` | browse on the remote |
| `autoConnect` | true | connect when the app starts |
| `sshOptions` | `[]` | extra `-o Key=value` options |

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

The window shows and edits every host. The tray shows them all at once: its
icon is the aggregate, and each host has its own submenu.

**Migration:** a config from an earlier release (top-level `host`, … and no
`hosts`) loads as a one-host list (`id` `host-1`) with the same values. A stored
`localPort` is dropped, and each host gets an address in list order, so the
first keeps `localhost:19988` and a browser already paired there keeps working.
Every other host needs pairing once at its new address. The file is rewritten
on the next Save.

## Development

```bash
pnpm gates                                    # syntax check + all tests
BROWSE_BIN=~/.local/bin/browse pnpm gates     # + integration tests against real browse (local, and ssh via a private sshd)
BB_SMOKE_OUT=/tmp/bb bin/browse-bridge --ozone-platform=headless   # render the window headlessly → /tmp/bb.png/.json
```

The integration test runs the controller against the real browse binary in a
throwaway `HOME` on ports 39988–39991, and stops the relay it started.

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
- **Not bundled.** This repository contains no browse code or assets. **Set up
  remote host** installs the pinned `@opencode/browse` release from the npm
  registry onto your remote host, and the extension comes from the Chrome Web
  Store; both are distributed by their authors under their own license.
- **Where to report problems.** Bugs in browse itself (the MCP server, relay,
  extension or pairing) belong in
  [browse's issue tracker](https://github.com/anomalyco/browse/issues) — but
  please reproduce them without browse-bridge first. Anything about the tunnel,
  tray, window or setup button belongs here, not upstream.

## License

[MIT](LICENSE). browse is licensed separately by its authors, also under MIT.
