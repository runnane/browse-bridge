# AGENTS.md

Electron tray app; see README.md for what it does. Tracker project **BBR** (`browse-bridge`); per-repo facts are in [`.agents/repo.json`](.agents/repo.json), gate traps in [`.agents/gates.md`](.agents/gates.md).

- **Logic lives in `src/core/` as plain Node modules**; `src/main.js` is a thin Electron shell. Keep it that way — everything in `core/` is tested without a display.
- **Gates:** the command in `gates.all` of [`.agents/repo.json`](.agents/repo.json) — do not copy it here. Run it with `BROWSE_BIN=<path to a browse 0.1.4 binary>` so the integration test is not skipped, and say so if it was.
- **The integration test and the headless smoke run start a real browse relay.** They stop it by the pid browse reports; if a run is killed, find the relay by its port (`ss -ltnp`) and signal that pid — never by name.
- **The tray cannot be tested headlessly** (GTK needs a display). `BB_SMOKE_OUT` renders the window only.
- **Never put a pairing code in a log** — `Logger` redacts `XXXX-XXXX`; a test pins it.
- **No test may reach a real ssh.** `npm test` / `npm run gates` set `BB_FORBID_SSH=1`, and `src/core/exec.js` then refuses any ssh/scp/sftp (including the tunnel's default spawner) whose destination is not loopback; stub the transport instead. Running `node --test` directly bypasses the guard, so use the npm scripts. Detail in [`.agents/gates.md`](.agents/gates.md).
- **Every ssh call is `BatchMode=yes`** — Electron has no tty, a prompt would hang for ever.
- **`test/ssh.test.js` starts a private sshd** on 127.0.0.1:39922 (throwaway keys and HOME; relay 39978, proxy 127.0.0.3:39978, ssh forward 39981 — test files run in parallel, so ports never overlap) to cover the ssh transport; it stops sshd and the relay by pid. **`test/sshtest-sshd.test.js`** starts another on 127.0.0.1:39924 for Test Connection (BBR-46), with a stub `browse` script, so it runs without `BROWSE_BIN`; it stops sshd by its pid file.
- **Never read the real `~/.ssh/config` in a test.** `src/core/sshconfig.js` takes the text and a reader; tests pass fixtures and a fake reader, or a throwaway directory.
- **A browser connection is proven only by a completed pairing, never by a 101.** The browse extension binds its pairing proof to the port it dials, so each host's pairing address is its own loopback address (`127.0.0.N`) on the relay's own port. `test/support/pair-client.js` runs the extension's real handshake. BBR-20 shipped a fix that opened the socket and could not pair; BBR-21 is the real one.
