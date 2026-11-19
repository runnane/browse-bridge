/* global bridge */
import {
  AGGREGATE_CLASS, AGGREGATE_GLYPH, GLYPH, actionsView, cleanError, errorField, fmtBytes, fmtDuration, fmtRate,
  hostById, hostRows, hostTitle, logForHost, logText, pairingAddressOf, pairingView, parseHostForm, pickSelected, withHostSnapshot,
} from './viewmodel.js';

const $ = (id) => document.getElementById(id);
const TABS = ['status', 'traffic', 'log', 'settings'];
const FIELD_ERRORS = { id: 'errId', host: 'errHost', localAddress: 'errLocalAddress', sshOptions: 'errSshOptions' };
const FIELD_INPUTS = { id: 'fId', host: 'fHost', localAddress: 'fAddr', sshOptions: 'fOpts' };

/** HostManager snapshot: { overall, label, hosts: [per-host snapshot] }. */
let state = null;
/** The host every view and action is about. */
let selectedId = null;
/** What the Settings form holds: an existing host (`id`) or a new one (`adding`). */
let form = { adding: false, id: null };
let settingsDirty = false;
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
  for (const t of document.querySelectorAll('.tab')) t.setAttribute('aria-selected', String(t.dataset.tab === name));
  for (const n of TABS) $(`${n}Page`).hidden = n !== name;
  if (name === 'traffic') drawChart();
}
for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', () => showTab(t.dataset.tab));
document.addEventListener('keydown', (ev) => {
  if (ev.ctrlKey && /^[1-4]$/.test(ev.key)) {
    ev.preventDefault();
    showTab(TABS[Number(ev.key) - 1]);
  }
});

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
    if (s.overall === 'unconfigured') bars.push(message('info', `Set the SSH host for ${hostTitle(s)} in Settings to get started.`, { dismissable: false }));
    for (const w of s.warnings) bars.push(message('warn', `${hostTitle(s)}: ${w}`, { dismissable: false }));
  }
  $('messages').replaceChildren(...bars);
}

// ---------- host list ----------

function renderHostList() {
  // The selected row stays highlighted while adding a host: the toolbar still acts on it.
  const rows = hostRows(state, selectedId);
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
  const changed = id !== selectedId || form.adding;
  selectedId = id;
  if (!changed) return;
  form = { adding: false, id };
  settingsDirty = false;
  flash.splice(0, flash.length);
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
  $('autoupdate').textContent = st?.autoUpdate ?? 'unknown';
  const next = st?.nextStep && st.extensionConnected !== true && s.connected ? st.nextStep : '';
  $('nextStep').hidden = !next;
  $('nextStepText').textContent = next;
  $('sbChecked').textContent = s.statusAt ? `${hostTitle(s)} checked ${fmtTime(s.statusAt)}` : 'Not checked yet';

  renderTraffic(s);
  renderPairing();
  renderMessages();
}

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
  act((id) => bridge.pair(id), (p) => (p ? null : ['bad', 'No pairing code came back. Is the relay running? Try Restart Relay, then see the Log tab.']));
};
$('btnRelay').onclick = () => act((id) => bridge.startRelay(id), (ok) => (ok ? ['ok', 'Relay restarted.'] : ['bad', 'The relay did not start — see the Log tab.']));
$('btnSetup').onclick = () => act((id) => bridge.setup(id), (r) => (r.ok
  ? ['ok', 'Host verified: pinned browse version, auto-update off, relay listening on loopback only.']
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
    $('formTitle').textContent = `Host ${cfg.id}${cfg.name && cfg.name !== cfg.id ? ` — ${cfg.name}` : ''}`;
    $('addrHint').textContent = `The extension pairs with ${pairingAddressOf(cfg)}`;
    $('btnApply').textContent = 'Apply';
    $('btnReset').textContent = 'Reset';
    $('btnRemoveHost').hidden = false;
    $('btnRemoveHost').disabled = (state?.hosts.length ?? 0) < 2;
    $('btnRemoveHost').title = $('btnRemoveHost').disabled ? 'The last host cannot be removed; edit it instead' : 'Disconnect this host and remove it from the list';
  }
  setDirty(false);
}

$('settings').addEventListener('input', (ev) => {
  if (ev.target.id === 'autostart') return;
  setDirty(true);
});
$('btnReset').onclick = () => {
  if (form.adding) {
    form = { adding: false, id: selectedId };
    render();
  }
  fillSettings(selected()?.config);
};
$('btnAddHost').onclick = () => {
  form = { adding: true, id: null };
  flash.splice(0, flash.length);
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
$('autostart').addEventListener('change', (ev) => bridge.setAutostart(ev.target.checked));

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

async function refresh() {
  state = await bridge.state();
  render();
}

// The tray's per-host items (Show logs, Pair browser…) bring the window up on that host.
// Registered before the first await so a request sent right after load is not dropped.
bridge.onSelect(async ({ id, tab } = {}) => {
  await ready;
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
  if (selected()?.overall === 'unconfigured') showTab('settings');
  $('autostart').checked = await bridge.autostart();
  $('sbVersion').textContent = await bridge.version();
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
