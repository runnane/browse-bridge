/* global bridge */
import {
  AGGREGATE_CLASS, AGGREGATE_GLYPH, GLYPH, actionsView, agentsView, cleanError, configFailureView, errorField, fmtBytes, fmtDuration, fmtRate,
  RELAY_LABEL, appMenuView, generalView, hostById, hostRows, hostTitle, logForHost, logText, pairingAddressOf, pairingView, parseGeneralForm, parseHostForm, pickSelected,
  transportText, withHostSnapshot, TEST_LABEL, aliasOptions, aliasWarning, parseTestForm, problemBar, testResultView, updateView,
  browseView, browsersView, unpairText, BROWSERS_NOTE,
} from './viewmodel.js';

const $ = (id) => document.getElementById(id);
const TABS = ['status', 'traffic', 'log', 'settings'];
const FIELD_ERRORS = { id: 'errId', host: 'errHost', localAddress: 'errLocalAddress', sshOptions: 'errSshOptions', remotePort: 'errRemotePort', remoteBrowse: 'errRemoteBrowse' };
const FIELD_INPUTS = { id: 'fId', host: 'fHost', localAddress: 'fAddr', sshOptions: 'fOpts', remotePort: 'fRemotePort', remoteBrowse: 'fRemoteBrowse' };
/** Host form fields inside the collapsed Advanced section: an error on one opens it. */
const ADVANCED_FIELDS = new Set(['remotePort', 'remoteBrowse']);
/** The General page's fields (BBR-45); BBR-48 adds its checkbox to the same page. */
const GENERAL_ERRORS = { pollSeconds: 'errPollSeconds' };
const GENERAL_INPUTS = { pollSeconds: 'fPoll' };

/** HostManager snapshot: { overall, label, hosts: [per-host snapshot] }. */
let state = null;
/** The host every view and action is about. */
let selectedId = null;
/** What the Settings form holds: an existing host (`id`) or a new one (`adding`). */
let form = { adding: false, id: null };
let settingsDirty = false;
/** The General page is showing instead of the selected host's tabs. */
let generalShown = false;
/** The General form holds edits not yet applied: the 1 s refresh leaves its fields alone. */
let generalDirty = false;
/** Pairing codes the user closed, any host's: a closed dialog never comes back, and never brings another's back. */
const dismissedPairs = new Set();
/** The host list as last drawn; rebuilt only when it changes, so focus and clicks survive the 1 s refresh. */
let hostListKey = null;
/** The Log tab shows a placeholder instead of lines. */
let logPlaceholder = false;
/** "host" (the selected host's lines), "all", or "relay" (the selected host's remote relay log). */
let logView = 'host';
const appLog = [];
/** Per host id: { at, up, down } once a second, for the rate and the chart. */
const samples = new Map();
const flash = []; // transient message bars: { kind, text, el }

const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—');
const yesNo = (v, yes, no) => (v === true ? yes : v === false ? no : 'unknown');
const selected = () => hostById(state, selectedId);

// ---------- tabs ----------

function showTab(name) {
  if (generalShown) setGeneral(false);
  for (const t of document.querySelectorAll('.tab')) t.setAttribute('aria-selected', String(t.dataset.tab === name));
  for (const n of TABS) $(`${n}Page`).hidden = n !== name;
  if (name === 'traffic') drawChart();
}

/**
 * Show the General page (app-wide settings) in place of the host tabs, or go
 * back to the tab that was showing. No host row is highlighted while it shows.
 */
function setGeneral(on) {
  generalShown = on;
  $('navGeneral').setAttribute('aria-selected', String(on));
  document.querySelector('.tabs').hidden = on;
  $('generalPage').hidden = !on;
  const tab = document.querySelector('.tab[aria-selected="true"]')?.dataset.tab ?? 'status';
  for (const n of TABS) $(`${n}Page`).hidden = on || n !== tab;
  renderHostList();
  if (!on && tab === 'traffic') drawChart();
}

async function openGeneral() {
  if (!generalShown) {
    setGeneral(true);
    fillGeneral();
  }
  // The tray's Start at login item may have changed it since.
  try {
    $('autostart').checked = await bridge.autostart();
    await fillAppMenu();
  } catch (err) {
    addFlash('bad', cleanError(err.message));
  }
}
$('navGeneral').onclick = () => openGeneral();
$('navGeneral').onkeydown = (ev) => {
  if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openGeneral(); }
};
for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', () => showTab(t.dataset.tab));
document.addEventListener('keydown', (ev) => {
  if (ev.ctrlKey && /^[1-4]$/.test(ev.key)) {
    ev.preventDefault();
    showTab(TABS[Number(ev.key) - 1]);
  } else if (ev.key === 'F1') {
    ev.preventDefault();
    openInfo('help');
  }
});

// ---------- help and about (BBR-32) ----------

const INFO_DIALOGS = ['help', 'about'];

/** Open the Help or About dialog; the other one closes, and opening one already open is a no-op. */
function openInfo(name) {
  if (!INFO_DIALOGS.includes(name)) return;
  for (const other of INFO_DIALOGS) if (other !== name && $(`${other}Dialog`).open) $(`${other}Dialog`).close();
  const d = $(`${name}Dialog`);
  if (!d.open) d.showModal();
  d.querySelector('.dlg-body').scrollTop = 0;
}
$('btnHelp').onclick = () => openInfo('help');
$('btnAbout').onclick = () => openInfo('about');
$('btnHelpAbout').onclick = () => openInfo('about');
$('btnHelpClose').onclick = () => $('helpDialog').close();
$('btnAboutClose').onclick = () => $('aboutDialog').close();
// BBR-47: the bundle is built in main (core/diagnostics.js); the status shows inside the dialog, which covers the flash bars.
$('btnCopyDiag').onclick = async () => {
  const status = $('diagStatus');
  try {
    await bridge.copyDiagnostics($('diagHide').checked);
    status.textContent = $('diagHide').checked ? 'Copied; host names hidden.' : 'Copied; host names included.';
  } catch (err) {
    status.textContent = cleanError(err.message);
  }
};
// Links name a key in core/about.js; main opens it in the system browser, and refuses any other.
for (const b of document.querySelectorAll('[data-link]')) {
  b.addEventListener('click', (ev) => {
    ev.preventDefault();
    bridge.openLink(b.dataset.link).catch((err) => addFlash('bad', cleanError(err.message)));
  });
}

// ---------- message bars ----------

function message(kind, text, { dismissable = true } = {}) {
  const el = document.createElement('div');
  el.className = `msg ${kind}`;
  const p = document.createElement('p');
  p.textContent = text;
  el.append(p);
  if (dismissable) {
    const x = Object.assign(document.createElement('button'), { className: 'x', textContent: '×', title: 'Dismiss' });
    x.onclick = () => { const i = flash.findIndex((f) => f.el === el); if (i >= 0) flash.splice(i, 1); el.remove(); };
    el.append(x);
  }
  return el;
}

function addFlash(kind, text) {
  flash.splice(0, flash.length); // one action result at a time
  flash.push({ el: message(kind, text), kind, text });
  renderMessages();
}

function renderMessages() {
  const bars = flash.map((f) => f.el);
  const s = selected();
  if (s && !form.adding) {
    // With an unreadable config file the blank host is not a first start: the config bar says what happened instead.
    if (s.overall === 'unconfigured' && !state?.configFailure) bars.push(message('info', `Set the SSH host for ${hostTitle(s)} in Settings to get started.`, { dismissable: false }));
    const problem = problemBar(s);
    if (problem) bars.push(message(problem.kind, problem.text, { dismissable: false }));
    for (const w of s.warnings) bars.push(message('warn', `${hostTitle(s)}: ${w}`, { dismissable: false }));
  }
  $('messages').replaceChildren(...bars);
}

// ---------- host list ----------

function renderHostList() {
  // The selected row stays highlighted while adding a host: the toolbar still acts on it.
  // While General shows, General is the highlighted entry instead.
  const rows = hostRows(state, generalShown ? null : selectedId);
  const key = JSON.stringify(rows);
  if (key === hostListKey) return;
  hostListKey = key;
  const focused = document.activeElement?.dataset?.host;
  const items = rows.map((r) => {
    const li = document.createElement('li');
    li.className = 'hostrow';
    li.dataset.host = r.id;
    li.tabIndex = 0;
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(r.selected));
    li.title = `${r.title}: ${r.label} — ${r.host}, pairs with ${r.address}`;
    const glyph = Object.assign(document.createElement('span'), { className: `glyph s-${r.overall}`, textContent: r.glyph });
    const name = Object.assign(document.createElement('span'), { className: 'hostname', textContent: r.title });
    const label = Object.assign(document.createElement('span'), { className: 'hostsub', textContent: r.label });
    const host = Object.assign(document.createElement('span'), { className: 'hostsub mono', textContent: r.host });
    const address = Object.assign(document.createElement('span'), { className: 'hostsub mono', textContent: r.address });
    li.append(glyph, name, label, host, address);
    li.onclick = () => select(r.id);
    li.onkeydown = (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); select(r.id); }
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        const next = ev.key === 'ArrowDown' ? li.nextElementSibling : li.previousElementSibling;
        if (next) { select(next.dataset.host); $('hostList').querySelector(`[data-host="${next.dataset.host}"]`)?.focus(); }
      }
    };
    return li;
  });
  $('hostList').replaceChildren(...items);
  // A row's state changed under the keyboard focus: keep the focus on the same host.
  if (focused) $('hostList').querySelector(`[data-host="${focused}"]`)?.focus();
}

function select(id) {
  // Choosing a host leaves General, even the host already selected.
  if (generalShown) setGeneral(false);
  const changed = id !== selectedId || form.adding;
  selectedId = id;
  if (!changed) return;
  form = { adding: false, id };
  settingsDirty = false;
  flash.splice(0, flash.length);
  clearTest();
  render();
  fillSettings(selected()?.config);
  showLog(logView);
}

// ---------- render ----------

function render() {
  if (!state) return;
  selectedId = pickSelected(state.hosts, selectedId);
  renderHostList();
  const s = selected();
  const aggregate = state.overall;
  document.title = `browse-bridge — ${state.label}`;
  $('sbGlyph').textContent = AGGREGATE_GLYPH[aggregate] ?? '?';
  $('sbGlyph').className = `glyph s-${AGGREGATE_CLASS[aggregate] ?? 'unknown'}`;
  $('sbLabel').textContent = state.hosts.length > 1 ? state.label : (s?.label ?? state.label);
  renderConfigFailure();
  renderGeneral();
  renderUpdate();
  if (!s) return;

  const g = GLYPH[s.overall] ?? '?';
  for (const [glyphId, labelId] of [['pillGlyph', 'pillLabel'], ['glyph', 'label']]) {
    $(glyphId).textContent = g;
    $(glyphId).className = `glyph s-${s.overall}`;
    $(labelId).textContent = `${hostTitle(s)}: ${s.label}`;
  }
  $('pill').className = `pill s-${s.overall}`;
  $('label').className = `s-${s.overall}`;

  const configured = s.overall !== 'unconfigured';
  $('btnConnect').querySelector('span').textContent = s.connected ? 'Disconnect' : 'Connect';
  $('btnConnect').disabled = !configured;
  for (const id of ['btnPair', 'btnSetup', 'btnRelay']) $(id).disabled = !configured || Boolean(s.busy);
  if (s.busy) $('pillLabel').textContent = `${hostTitle(s)}: ${s.busy}…`;

  // Status
  $('host').textContent = s.host || 'not set';
  $('tunnel').textContent = `${s.tunnel.state}${s.tunnel.detail ? ` — ${s.tunnel.detail}` : ''}`;
  const st = s.status;
  $('relay').textContent = st
    ? `${yesNo(st.relayRunning, 'running', 'not running')}${st.relayPort ? ` on remote port ${st.relayPort}` : ''}${st.relayVersion ? ` · browse ${st.relayVersion}` : ''}`
    : (s.statusError ? `unknown — ${s.statusError}` : 'unknown');
  $('browser').textContent = st
    ? `${yesNo(st.extensionConnected, 'connected', 'not connected')}${st.browsers != null ? ` · ${st.browsers} paired` : ''} · pairs with ${s.pairingAddress}`
    : `unknown · pairs with ${s.pairingAddress}`;
  $('tabs').textContent = st ? `${st.tabs ?? 'unknown'} open · ${st.activeTargets ?? 'unknown'} attached` : 'unknown';
  const agents = agentsView(st?.agents);
  $('agents').textContent = agents.hint ? `${agents.text} — ${agents.hint}` : agents.text;
  $('autoupdate').textContent = st?.autoUpdate ?? 'unknown';
  const next = st?.nextStep && st.extensionConnected !== true && s.connected ? st.nextStep : '';
  $('nextStep').hidden = !next;
  $('nextStepText').textContent = next;
  $('sbChecked').textContent = s.statusAt ? `${hostTitle(s)} checked ${fmtTime(s.statusAt)}` : 'Not checked yet';

  renderBrowsers(s);
  renderBrowse(s);
  renderTraffic(s);
  renderPairing();
  renderMessages();
}

// ---------- browsers (BBR-98) ----------

/** What the Browsers list last drew, so the 1 s refresh rebuilds it only when it changed (a rebuild drops focus). */
let browsersKey = '';

/** One row per browser the relay lists; every string from the relay goes in as textContent. */
function renderBrowsers(s) {
  const v = browsersView(s.status);
  $('browserEmpty').hidden = !v.empty;
  $('browserEmpty').textContent = v.empty;
  $('browserNote').textContent = [v.partial, v.rows.length ? BROWSERS_NOTE : ''].filter(Boolean).join(' ');
  const key = JSON.stringify([s.id, Boolean(s.busy), v.rows]);
  if (key === browsersKey) return;
  browsersKey = key;
  const list = $('browserList');
  list.replaceChildren();
  for (const row of v.rows) {
    const el = $('browserRow').content.firstElementChild.cloneNode(true);
    el.querySelector('.bname').textContent = row.name;
    el.querySelector('.bid').textContent = row.id;
    el.querySelector('.bdetail').textContent = ` · ${row.detail}`;
    el.querySelector('.bcopy').onclick = () => { bridge.copy(row.id); addFlash('ok', `Copied browser id ${row.id}.`); };
    const unpair = el.querySelector('.bunpair');
    unpair.disabled = Boolean(s.busy);
    unpair.onclick = () => openUnpair(row);
    list.append(el);
  }
}

function openUnpair(row) {
  const s = selected();
  if (!s) return;
  $('unpairText').textContent = unpairText(row, s);
  $('unpairDialog').dataset.host = s.id;
  $('unpairDialog').dataset.browser = row.id;
  $('unpairDialog').showModal();
}
$('btnUnpairCancel').onclick = () => $('unpairDialog').close();
$('btnUnpairConfirm').onclick = async () => {
  const d = $('unpairDialog');
  const { host: id, browser } = d.dataset;
  const title = hostTitle(hostById(state, id) ?? { id });
  d.close();
  try {
    const r = await bridge.unpairBrowser(id, browser);
    addFlash(r.ok ? 'ok' : 'bad', `${title}: ${r.message}`);
  } catch (err) {
    addFlash('bad', `${title}: ${cleanError(err.message)}`);
  }
  await refresh();
};

// ---------- unreadable config file (BBR-36) ----------

/** The persistent bar: shown while main reports the config file unreadable, whatever host or form is showing. */
function renderConfigFailure() {
  const v = configFailureView(state?.configFailure);
  $('configFailure').hidden = !v;
  if (v && $('configFailureText').textContent !== v.text) $('configFailureText').textContent = v.text;
}

/** After Reload or Start over the host list may be a different one: select afresh and refill the form. */
async function afterConfigChange(ok) {
  await refresh();
  selectedId = null;
  select(pickSelected(state.hosts, null));
  if (state.configFailure) addFlash('bad', 'The config file still could not be read; nothing was changed.');
  else addFlash('ok', ok);
}

$('btnConfigReload').onclick = async () => {
  try {
    await bridge.reloadConfig();
    await afterConfigChange('The config file was read again.');
  } catch (err) {
    addFlash('bad', cleanError(err.message));
  }
};
$('btnConfigStartOver').onclick = () => {
  const v = configFailureView(state?.configFailure);
  if (!v) return;
  $('startOverText').textContent = v.startOverText;
  $('startOverDialog').showModal();
};
$('btnStartOverCancel').onclick = () => $('startOverDialog').close();
$('btnStartOverConfirm').onclick = async () => {
  $('startOverDialog').close();
  try {
    await bridge.startOver();
    await afterConfigChange('Started over with one empty host. Set its SSH host in Settings.');
    showTab('settings');
  } catch (err) {
    addFlash('bad', cleanError(err.message));
    await refresh();
  }
};

// ---------- the browse version per host (BBR-41; the decisions are in core/browseversion.js and viewmodel.js) ----------

/** A Check Now for browse is on its way: its button stays disabled until it answers. */
let browseChecking = false;

function renderBrowse(s) {
  const v = browseView(s, state?.browse);
  $('browseWant').textContent = v.version;
  $('browseUpstream').textContent = v.upstream || '—';
  $('btnCheckBrowse').disabled = !v.canCheck || browseChecking;
  $('btnUpgradeBrowse').hidden = !v.upgrade;
  if (v.upgrade) {
    $('btnUpgradeBrowse').textContent = v.upgrade.text;
    $('btnUpgradeBrowse').title = `Install it on ${hostTitle(s)} only (${v.upgrade.note}), then check the version, auto-update off, loopback only and that the browser reconnects`;
    $('btnUpgradeBrowse').disabled = !v.upgrade.enabled;
  }
  $('btnRollbackBrowse').hidden = !v.rollback;
  if (v.rollback) {
    $('btnRollbackBrowse').textContent = v.rollback.text;
    $('btnRollbackBrowse').disabled = !v.rollback.enabled;
  }
  $('browseResult').hidden = !v.result;
  if (v.result) {
    $('browseResult').className = `msg ${v.result.kind}`;
    $('browseResultText').textContent = v.result.text;
  }
}

$('btnCheckBrowse').onclick = async () => {
  browseChecking = true;
  $('btnCheckBrowse').disabled = true;
  try {
    state = { ...state, browse: await bridge.checkBrowse() };
  } catch (err) {
    addFlash('bad', cleanError(err.message));
  } finally {
    browseChecking = false;
  }
  render();
};
// The outcome stays in the host's snapshot (browseChange) and shows under the buttons; the flash only says it finished.
const browseOutcome = (r) => (r.ok ? ['ok', `browse ${r.version} verified.`] : ['bad', `browse ${r.version} did not verify: ${r.problems.join('; ')}`]);
$('btnUpgradeBrowse').onclick = () => act((id) => bridge.upgradeBrowse(id), browseOutcome);
$('btnRollbackBrowse').onclick = () => act((id) => bridge.rollbackBrowse(id), browseOutcome);

function renderTraffic(s) {
  const t = s.traffic;
  $('up').textContent = t ? fmtBytes(t.bytesUp) : '—';
  $('down').textContent = t ? fmtBytes(t.bytesDown) : '—';
  $('conns').textContent = t ? `${t.connectionsActive} open · ${t.connectionsTotal} total · ${t.connectionsFailed} failed` : '—';
  const act = actionsView(t);
  $('actSummary').textContent = act.summary;
  $('actTop').textContent = act.top;
  $('actNote').textContent = act.note;
  $('sbTraffic').textContent = t ? `${hostTitle(s)}  ↑ ${fmtBytes(t.bytesUp)}   ↓ ${fmtBytes(t.bytesDown)}   ${t.connectionsActive} open` : '';
  const own = samples.get(s.id) ?? [];
  const last = own.at(-1);
  const prev = own.at(-2);
  if (t && last && prev && last.at > prev.at) {
    const secs = (last.at - prev.at) / 1000;
    $('rate').textContent = `↑ ${fmtRate((last.up - prev.up) / secs)}   ↓ ${fmtRate((last.down - prev.down) / secs)}`;
  } else {
    $('rate').textContent = '—';
  }
  const rows = [...s.connections].reverse().map((c) => {
    const tr = document.createElement('tr');
    const end = c.closedAt ? new Date(c.closedAt) : new Date();
    const cells = [
      [String(c.id)], [fmtTime(c.openedAt)], [fmtDuration(end - new Date(c.openedAt)), 'num'],
      [c.state === 'open' ? '…' : fmtBytes(c.up), 'num'], [c.state === 'open' ? '…' : fmtBytes(c.down), 'num'],
      [c.state === 'failed' ? `failed${c.error ? ` (${c.error})` : ''}` : c.state],
    ];
    for (const [text, cls] of cells) tr.append(Object.assign(document.createElement('td'), { textContent: text, className: cls ?? '' }));
    return tr;
  });
  if (!rows.length) {
    const tr = document.createElement('tr');
    tr.append(Object.assign(document.createElement('td'), { colSpan: 6, textContent: `No browser connections to ${hostTitle(s)} yet.`, className: 'muted' }));
    rows.push(tr);
  }
  $('connRows').replaceChildren(...rows);
}

function renderPairing() {
  const d = $('pairDialog');
  const v = pairingView(state, selectedId, { dismissed: dismissedPairs });
  if (v) {
    $('pairTitle').textContent = v.title;
    $('pairCode').textContent = v.code;
    $('pairAddr').textContent = v.address;
    $('pairExpiry').textContent = fmtTime(v.expiresAt);
    $('pairNote').textContent = v.note;
    d.dataset.code = v.code;
    if (!d.open) d.showModal();
  } else if (d.open) {
    d.close();
  }
}

// ---------- rate chart ----------

function sample() {
  const now = Date.now();
  for (const h of state?.hosts ?? []) {
    if (!h.traffic) { samples.delete(h.id); continue; }
    const own = samples.get(h.id) ?? [];
    own.push({ at: now, up: h.traffic.bytesUp, down: h.traffic.bytesDown });
    while (own.length > 121) own.shift();
    samples.set(h.id, own);
  }
  for (const id of samples.keys()) if (!hostById(state, id)) samples.delete(id);
}

function drawChart() {
  const c = $('chart');
  if (c.offsetParent === null) return; // tab hidden
  const own = samples.get(selectedId) ?? [];
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth;
  const h = c.clientHeight;
  c.width = w * dpr;
  c.height = h * dpr;
  const ctx = c.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  const css = getComputedStyle(document.documentElement);
  const rates = [];
  for (let i = 1; i < own.length; i++) {
    const secs = (own[i].at - own[i - 1].at) / 1000 || 1;
    rates.push({ up: (own[i].up - own[i - 1].up) / secs, down: (own[i].down - own[i - 1].down) / secs });
  }
  const max = Math.max(1024, ...rates.map((r) => Math.max(r.up, r.down)));
  $('chartMax').textContent = `scale ${fmtRate(max)}`;
  ctx.strokeStyle = css.getPropertyValue('--frame');
  ctx.lineWidth = 1;
  for (const f of [0.25, 0.5, 0.75]) {
    ctx.beginPath();
    ctx.moveTo(0, Math.round(h * f) + 0.5);
    ctx.lineTo(w, Math.round(h * f) + 0.5);
    ctx.stroke();
  }
  const step = w / 120;
  const line = (key, color, dash) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.setLineDash(dash);
    ctx.beginPath();
    rates.forEach((r, i) => {
      const x = w - (rates.length - 1 - i) * step;
      const y = h - 4 - (r[key] / max) * (h - 10);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.setLineDash([]);
  };
  line('up', css.getPropertyValue('--hl').trim(), []);
  line('down', css.getPropertyValue('--ok').trim(), [4, 3]);
}

// ---------- log ----------

function logLine(e) {
  const div = document.createElement('div');
  div.className = `lvl-${e.level}`;
  div.textContent = logText(e);
  return div;
}

function appendLog(e) {
  appLog.push(e);
  if (appLog.length > 500) appLog.shift();
  if (logView === 'relay' || logForHost([e], logView === 'all' ? 'all' : selectedId).length === 0) return;
  const el = $('log');
  if (logPlaceholder) {
    el.replaceChildren();
    logPlaceholder = false;
  }
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
  el.append(logLine(e));
  while (el.childElementCount > 500) el.firstChild.remove();
  if (atBottom) el.scrollTop = el.scrollHeight;
}

async function showLog(view) {
  logView = view;
  $('segHost').setAttribute('aria-pressed', String(view === 'host'));
  $('segAll').setAttribute('aria-pressed', String(view === 'all'));
  $('segRelay').setAttribute('aria-pressed', String(view === 'relay'));
  $('btnRefreshRelay').hidden = view !== 'relay';
  const el = $('log');
  if (view === 'relay') {
    // The answer is for the host selected now; it is dropped if the selection moved meanwhile.
    const id = selectedId;
    logPlaceholder = false;
    el.textContent = 'Loading…';
    let text;
    try {
      text = await bridge.relayLog(id);
    } catch (err) {
      text = cleanError(err.message);
    }
    if (logView !== 'relay' || selectedId !== id) return;
    el.textContent = text;
  } else {
    const lines = logForHost(appLog, view === 'all' ? 'all' : selectedId);
    logPlaceholder = !lines.length;
    if (lines.length) el.replaceChildren(...lines.map(logLine));
    else el.textContent = view === 'all' ? '' : `No lines about ${hostTitle(selected() ?? { id: selectedId })} yet.`;
  }
  el.scrollTop = el.scrollHeight;
}
$('segHost').onclick = () => showLog('host');
$('segAll').onclick = () => showLog('all');
$('segRelay').onclick = () => showLog('relay');
$('btnRefreshRelay').onclick = () => showLog('relay');
$('btnOpenLog').onclick = () => bridge.openLogFile();

// ---------- actions ----------

/** Run an action for the host selected at the click; its result names that host even if the selection moves. */
async function act(fn, describe) {
  const id = selectedId;
  const title = hostTitle(selected() ?? { id });
  try {
    const r = await fn(id);
    const out = describe?.(r);
    if (out) addFlash(out[0], `${title}: ${out[1]}`);
  } catch (err) {
    addFlash('bad', `${title}: ${cleanError(err.message)}`);
  }
  await refresh();
}

$('btnConnect').onclick = () => act((id) => (selected()?.connected ? bridge.disconnect(id) : bridge.connect(id)));
$('btnPair').onclick = () => {
  act((id) => bridge.pair(id), (p) => (p ? null : ['bad', `No pairing code came back. Is the relay running? Try ${RELAY_LABEL}, then see the Log tab.`]));
};
$('btnRelay').onclick = () => act((id) => bridge.startRelay(id), (ok) => (ok ? ['ok', 'Relay restarted.'] : ['bad', 'The relay did not start — see the Log tab.']));
$('btnSetup').onclick = () => act((id) => bridge.setup(id), (r) => (r.ok
  ? ['ok', `Host verified: browse ${r.version}, auto-update off, relay listening on loopback only.`]
  : ['bad', `Setup found problems: ${r.problems.join('; ')}`]));
$('btnCopyCode').onclick = () => bridge.copy($('pairCode').textContent);
$('btnCopyAddr').onclick = () => bridge.copy($('pairAddr').textContent);
const dismissPair = () => { if ($('pairDialog').dataset.code) dismissedPairs.add($('pairDialog').dataset.code); };
$('btnPairClose').onclick = () => { dismissPair(); $('pairDialog').close(); renderPairing(); };
$('pairDialog').addEventListener('cancel', dismissPair);

// ---------- settings: edit, add, remove ----------

function clearErrors() {
  $('formError').hidden = true;
  for (const [field, id] of Object.entries(FIELD_ERRORS)) {
    $(id).hidden = true;
    $(FIELD_INPUTS[field]).classList.remove('invalid');
  }
}

/** Show a config error next to the field it is about, or above the form when it is about none. */
function showError(text, field = errorField(text)) {
  clearErrors();
  if (field && FIELD_ERRORS[field] && (field !== 'id' || form.adding)) {
    if (ADVANCED_FIELDS.has(field)) $('advanced').open = true;
    $(FIELD_ERRORS[field]).textContent = text;
    $(FIELD_ERRORS[field]).hidden = false;
    $(FIELD_INPUTS[field]).classList.add('invalid');
    $(FIELD_INPUTS[field]).focus();
  } else {
    $('formError').textContent = text;
    $('formError').hidden = false;
  }
}

function setDirty(dirty) {
  settingsDirty = dirty;
  $('btnApply').disabled = !dirty && !form.adding;
  $('btnReset').disabled = !dirty && !form.adding;
}

function fillSettings(cfg) {
  const f = $('settings');
  for (const el of document.querySelectorAll('[data-adding]')) el.hidden = !form.adding;
  clearErrors();
  if (form.adding) {
    f.hostId.value = '';
    f.hostName.value = '';
    f.host.value = '';
    f.localAddress.value = '';
    f.localAddress.placeholder = 'next free';
    f.sshOptions.value = '';
    f.autoConnect.checked = true;
    f.countActions.checked = false;
    f.remotePort.value = '';
    f.remoteBrowse.value = '';
    $('fTransport').textContent = transportText('ssh');
    $('formTitle').textContent = 'New host';
    $('addrHint').textContent = "Leave empty for the next free 127.0.0.x; the port is always the relay's own";
    $('btnApply').textContent = 'Add Host';
    $('btnReset').textContent = 'Cancel';
    $('btnRemoveHost').hidden = true;
  } else if (cfg) {
    f.hostName.value = cfg.name ?? '';
    f.host.value = cfg.host;
    f.localAddress.value = cfg.localAddress;
    f.localAddress.placeholder = '';
    f.sshOptions.value = cfg.sshOptions.join(', ');
    f.autoConnect.checked = cfg.autoConnect;
    f.countActions.checked = cfg.countActions;
    // The Advanced section's fields are refilled; whether it is open is left as the user set it.
    f.remotePort.value = String(cfg.remotePort);
    f.remoteBrowse.value = cfg.remoteBrowse;
    $('fTransport').textContent = transportText(cfg.transport);
    $('formTitle').textContent = `Host ${cfg.id}${cfg.name && cfg.name !== cfg.id ? ` — ${cfg.name}` : ''}`;
    $('addrHint').textContent = `The extension pairs with ${pairingAddressOf(cfg)}`;
    $('btnApply').textContent = 'Apply';
    $('btnReset').textContent = 'Reset';
    $('btnRemoveHost').hidden = false;
    $('btnRemoveHost').disabled = (state?.hosts.length ?? 0) < 2;
    $('btnRemoveHost').title = $('btnRemoveHost').disabled ? 'The last host cannot be removed; edit it instead' : 'Disconnect this host and remove it from the list';
  }
  renderAliasWarning();
  setDirty(false);
}

// ---------- settings: ~/.ssh/config aliases and Test Connection (BBR-46) ----------

/** The Host aliases main read from ~/.ssh/config: [{ alias, localForward }]. */
let sshAliases = [];
/** Bumped whenever the form moves on, so a test answer that comes back late is dropped. */
let testSeq = 0;

async function loadAliases() {
  try {
    sshAliases = await bridge.sshAliases();
  } catch {
    sshAliases = [];
  }
  $('sshAliases').replaceChildren(...aliasOptions(sshAliases).map((o) => Object.assign(document.createElement('option'), { value: o.value, label: o.label })));
  renderAliasWarning();
}

function renderAliasWarning() {
  const w = aliasWarning(sshAliases, $('fHost').value);
  $('warnHost').hidden = !w;
  $('warnHost').textContent = w ?? '';
}

function clearTest() {
  testSeq++;
  $('testResult').hidden = true;
  $('btnTest').disabled = false;
  $('btnTest').textContent = TEST_LABEL;
}

function showTest(kind, text) {
  $('testResult').className = `msg ${kind}`;
  $('testResultText').textContent = text;
  $('testResult').hidden = false;
}

$('btnTest').onclick = async () => {
  const f = $('settings');
  const parsed = parseTestForm({ host: f.host.value, sshOptions: f.sshOptions.value, remoteBrowse: f.remoteBrowse.value });
  clearTest();
  // In the test's own bar: a clean Edit form is refilled every second, which clears the field errors.
  if (parsed.error) return showTest('bad', parsed.error);
  const seq = testSeq;
  $('btnTest').disabled = true;
  $('btnTest').textContent = 'Testing…';
  showTest('info', `Logging in to ${parsed.fields.host}…`);
  let view;
  try {
    view = testResultView(await bridge.testConnection({ ...parsed.fields, hostId: form.adding ? null : form.id }));
  } catch (err) {
    view = { kind: 'bad', text: cleanError(err.message) };
  }
  if (seq !== testSeq) return; // the form moved on while ssh ran
  $('btnTest').disabled = false;
  $('btnTest').textContent = TEST_LABEL;
  showTest(view.kind, view.text);
};

$('fHost').addEventListener('input', renderAliasWarning);
$('settings').addEventListener('input', () => {
  setDirty(true);
  // A result is about the fields it was run with.
  if (!$('testResult').hidden || $('btnTest').disabled) clearTest();
});
$('btnReset').onclick = () => {
  clearTest();
  if (form.adding) {
    form = { adding: false, id: selectedId };
    render();
  }
  fillSettings(selected()?.config);
};
$('btnAddHost').onclick = () => {
  form = { adding: true, id: null };
  flash.splice(0, flash.length);
  clearTest();
  loadAliases(); // the user may have just edited ~/.ssh/config
  fillSettings(null);
  render();
  showTab('settings');
  $('fHost').focus();
};
$('settings').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  // The host the form was filled from, not whichever is selected when the answer comes back.
  const target = { ...form };
  const parsed = parseHostForm({
    id: f.hostId.value, name: f.hostName.value, host: f.host.value,
    localAddress: f.localAddress.value, sshOptions: f.sshOptions.value, autoConnect: f.autoConnect.checked, countActions: f.countActions.checked,
    remotePort: f.remotePort.value, remoteBrowse: f.remoteBrowse.value,
  }, { adding: target.adding });
  if (parsed.error) return showError(parsed.error, parsed.field);
  try {
    if (target.adding) {
      const cfg = await bridge.addHost(parsed.fields);
      await refresh();
      select(cfg.id);
      addFlash('ok', `${hostTitle(cfg)}: added; the extension pairs with ${pairingAddressOf(cfg)}.`);
    } else {
      const cfg = await bridge.saveConfig(target.id, parsed.fields);
      await refresh();
      if (form.id === target.id && !form.adding) fillSettings(cfg);
      addFlash('ok', `${hostTitle(cfg)}: settings applied.`);
    }
  } catch (err) {
    if (form.adding === target.adding && form.id === target.id) showError(cleanError(err.message));
    else addFlash('bad', cleanError(err.message));
  }
});
$('settings').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
    ev.preventDefault();
    if (settingsDirty || form.adding) $('settings').requestSubmit();
  }
});
// ---------- General: app-wide settings (BBR-45) ----------

function clearGeneralErrors() {
  $('generalError').hidden = true;
  for (const [field, id] of Object.entries(GENERAL_ERRORS)) {
    $(id).hidden = true;
    $(GENERAL_INPUTS[field]).classList.remove('invalid');
  }
}

/** An error next to the General field it is about, or above the page (e.g. the unreadable-config refusal). */
function showGeneralError(text, field = null) {
  clearGeneralErrors();
  if (field && GENERAL_ERRORS[field]) {
    $(GENERAL_ERRORS[field]).textContent = text;
    $(GENERAL_ERRORS[field]).hidden = false;
    $(GENERAL_INPUTS[field]).classList.add('invalid');
    $(GENERAL_INPUTS[field]).focus();
  } else {
    $('generalError').textContent = text;
    $('generalError').hidden = false;
  }
}

function setGeneralDirty(dirty) {
  generalDirty = dirty;
  $('btnGeneralApply').disabled = !dirty;
  $('btnGeneralReset').disabled = !dirty;
}

/** The read-only lines follow every refresh; the poll field only while it holds no unapplied edit. */
function renderGeneral() {
  const v = generalView(state?.app);
  if (!v) return;
  $('gBrowseVersion').textContent = v.browseVersion;
  $('gPinNote').textContent = v.pinNote;
  $('gConfigPath').textContent = v.configPath;
  if (!generalDirty && document.activeElement !== $('fPoll')) $('fPoll').value = v.pollSeconds;
  // The box follows config.json, except while its own save is on the way.
  if (!checkUpdatesSaving) $('checkUpdates').checked = v.checkUpdates;
}

// ---------- updates (BBR-43): the notice in the status bar and About; the decisions are in core/updater.js ----------

/** Check for updates saves on change, like Start at login, through the same app-settings save as the poll interval. */
let checkUpdatesSaving = false;

function renderUpdate() {
  const v = updateView(state?.update);
  $('sbUpdate').hidden = !v.bar;
  $('sbUpdate').textContent = v.bar ?? '';
  $('aboutUpdateText').textContent = v.text;
  const list = $('aboutUpdateSubjects');
  const key = JSON.stringify(v.subjects);
  if (list.dataset.key !== key) {
    list.dataset.key = key;
    list.replaceChildren(...v.subjects.map((s) => Object.assign(document.createElement('li'), { textContent: s })));
  }
  list.hidden = !v.subjects.length;
  $('btnUpdateNow').hidden = !v.showUpdate;
  $('btnUpdateNow').disabled = !v.canUpdate;
  $('btnCheckUpdates').disabled = !v.canCheck;
}

$('sbUpdate').onclick = () => openInfo('about');
$('btnCheckUpdates').onclick = async () => {
  $('btnCheckUpdates').disabled = true;
  try {
    state = { ...state, update: await bridge.checkForUpdates() };
  } catch (err) {
    $('aboutUpdateText').textContent = cleanError(err.message);
  }
  render();
};
// The About dialog covers the flash bars, so the outcome (a refusal and its reason) shows in the dialog's own text.
$('btnUpdateNow').onclick = async () => {
  $('btnUpdateNow').disabled = true;
  $('btnCheckUpdates').disabled = true;
  $('aboutUpdateText').textContent = 'Updating browse-bridge…';
  try {
    state = { ...state, update: await bridge.updateNow() };
    render();
  } catch (err) {
    $('aboutUpdateText').textContent = cleanError(err.message);
  }
};
$('checkUpdates').addEventListener('change', async (ev) => {
  checkUpdatesSaving = true;
  try {
    await bridge.saveAppSettings({ checkUpdates: ev.target.checked });
    await refresh();
  } catch (err) {
    showGeneralError(cleanError(err.message));
  } finally {
    checkUpdatesSaving = false;
    renderGeneral();
  }
});

/** Discard unapplied edits and show what the config holds. */
function fillGeneral() {
  clearGeneralErrors();
  setGeneralDirty(false);
  const v = generalView(state?.app);
  if (v) $('fPoll').value = v.pollSeconds;
  renderGeneral();
}

$('general').addEventListener('input', (ev) => {
  // Start at login and Show in application menu save on change, on their own; they never make the form dirty.
  if (ev.target.id === 'autostart' || ev.target.id === 'appMenu' || ev.target.id === 'checkUpdates') return;
  setGeneralDirty(true);
});
$('general').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const parsed = parseGeneralForm({ pollSeconds: $('fPoll').value });
  if (parsed.error) return showGeneralError(parsed.error, parsed.field);
  try {
    const app = await bridge.saveAppSettings(parsed.fields);
    await refresh();
    fillGeneral();
    addFlash('ok', `General: settings applied; each host's status is checked every ${app.pollSeconds} s.`);
  } catch (err) {
    showGeneralError(cleanError(err.message));
  }
});
$('general').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
    ev.preventDefault();
    if (generalDirty) $('general').requestSubmit();
  }
});
$('btnGeneralReset').onclick = () => fillGeneral();
$('btnOpenConfig').onclick = () => bridge.openConfigFile().catch((err) => addFlash('bad', cleanError(err.message)));
$('autostart').addEventListener('change', (ev) => bridge.setAutostart(ev.target.checked));
$('appMenu').addEventListener('change', (ev) => bridge.setAppMenu(ev.target.checked).catch((err) => addFlash('bad', cleanError(err.message))));

/** Show in application menu: hidden for a package-manager build (not an AppImage); the box follows the entry on disk. */
async function fillAppMenu() {
  const v = appMenuView(await bridge.appMenu());
  $('appMenuRow').hidden = v.hidden;
  $('appMenuNote').hidden = v.hidden;
  $('appMenu').checked = v.checked;
}

$('btnRemoveHost').onclick = () => {
  const s = selected();
  if (!s) return;
  $('removeText').textContent = `Disconnect ${hostTitle(s)} (${s.host || 'no ssh host'}, ${s.pairingAddress}) and remove it from the list? A browser profile paired with it stops reaching agents there.`;
  $('removeDialog').dataset.host = s.id;
  $('removeDialog').showModal();
};
$('btnRemoveCancel').onclick = () => $('removeDialog').close();
$('btnRemoveConfirm').onclick = async () => {
  const id = $('removeDialog').dataset.host;
  const title = hostTitle(hostById(state, id) ?? { id });
  $('removeDialog').close();
  try {
    await bridge.removeHost(id);
    await refresh();
    selectedId = null; // render() already moved off the removed host; force the form to refill for the new one
    select(pickSelected(state.hosts, null));
    addFlash('ok', `${title}: removed.`);
  } catch (err) {
    addFlash('bad', `${title}: ${cleanError(err.message)}`);
  }
};

// ---------- start ----------

/** The About dialog's text, from main (core/about.js), so the page holds no version or URL of its own. */
function fillAbout(info) {
  $('aboutName').textContent = info.name;
  $('aboutVersion').textContent = info.version;
  $('aboutDescription').textContent = info.description;
  $('aboutLicense').textContent = `${info.license} License`;
  $('helpBrowseVersion').textContent = info.browseVersion;
  if (info.icon) $('aboutIcon').src = info.icon;
  for (const l of info.links) for (const b of document.querySelectorAll(`[data-link="${l.key}"]`)) b.title = l.url;
}

async function refresh() {
  state = await bridge.state();
  render();
}

// The tray's per-host items (Show logs, Pair browser…) bring the window up on that host.
// Registered before the first await so a request sent right after load is not dropped.
bridge.onSelect(async ({ id, tab, dialog } = {}) => {
  await ready;
  if (dialog) return openInfo(dialog);
  if (hostById(state, id)) select(id);
  if (tab && TABS.includes(tab)) showTab(tab);
  if (tab === 'log' && logView === 'all') showLog('host');
});

const ready = (async () => {
  state = await bridge.state();
  selectedId = pickSelected(state.hosts, null);
  form = { adding: false, id: selectedId };
  render();
  fillSettings(selected()?.config);
  loadAliases();
  fillGeneral();
  if (selected()?.overall === 'unconfigured' && !state.configFailure) showTab('settings');
  $('autostart').checked = await bridge.autostart();
  await fillAppMenu();
  $('sbVersion').textContent = await bridge.version();
  fillAbout(await bridge.about());
  for (const e of await bridge.log()) appLog.push(e);
  showLog('host');
  bridge.onState((snap) => {
    const known = hostById(state, snap.id);
    state = withHostSnapshot(state, snap);
    render();
    if (known && snap.id === selectedId && !settingsDirty && !form.adding) fillSettings(snap.config);
  });
  bridge.onLog(appendLog);
  // Byte counters change without events; sample once a second for rates and the chart.
  setInterval(async () => {
    await refresh();
    if (!settingsDirty && !form.adding && form.id === selectedId) fillSettings(selected()?.config);
    sample();
    drawChart();
  }, 1000);
  window.addEventListener('resize', drawChart);
})();
