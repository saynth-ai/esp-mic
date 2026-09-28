'use strict';

/*
 * Live dashboard. All data arrives over one WebSocket (/ws):
 *   snapshot   — full state on connect
 *   status     — one device changed
 *   recordings — recording list / storage changed
 * The 1-second timer below only re-renders relative times ("5 s ago"); it never polls the server.
 */

const $ = (id) => document.getElementById(id);

const state = {
  devices: new Map(),
  selected: null,
  recordings: [],
  totalRecordings: 0,
  storage: null,
  server: null,
  playing: null,
};

// ------------------------------------------------------------ formatting

function fmtBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function fmtClock(seconds) {
  const t = Math.max(0, Math.round(seconds || 0));
  const p = (x) => String(x).padStart(2, '0');
  return `${p(Math.floor(t / 3600))}:${p(Math.floor((t % 3600) / 60))}:${p(t % 60)}`;
}

function fmtShortDuration(seconds) {
  const t = Math.max(0, Math.round(seconds || 0));
  if (t < 3600) return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  return fmtClock(t);
}

function fmtSpan(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
  return `${Math.floor(s / 86400)} d ${Math.floor((s % 86400) / 3600)} h`;
}

const now = () => Date.now();
const ago = (iso) => (iso ? `${fmtSpan((now() - Date.parse(iso)) / 1000)} ago` : '—');
const timeOf = (iso) => (iso ? new Date(iso).toLocaleTimeString() : '—');
const dateTimeOf = (iso) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' }) : '—';

function setText(id, text, cls) {
  const el = $(id);
  el.textContent = text;
  if (cls !== undefined) el.className = cls;
}

function setPill(id, text, kind) {
  const el = $(id);
  el.textContent = text;
  el.className = `pill ${kind || ''}`;
}

// ------------------------------------------------------------ rendering

function currentDevice() {
  if (state.selected && state.devices.has(state.selected)) return state.devices.get(state.selected);
  // Prefer a connected device, then any device.
  const all = [...state.devices.values()];
  const pick = all.find((d) => d.connected) || all[0] || null;
  state.selected = pick ? pick.device_id : null;
  return pick;
}

function renderTabs() {
  const tabs = $('device-tabs');
  const devices = [...state.devices.values()].sort((a, b) => a.device_id.localeCompare(b.device_id));
  tabs.replaceChildren(
    ...devices.map((d) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tab';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(d.device_id === state.selected));
      const dot = document.createElement('span');
      dot.className = `dot${d.recording ? ' rec' : d.connected ? ' on' : ''}`;
      b.append(dot, document.createTextNode(d.device_id));
      b.addEventListener('click', () => {
        state.selected = d.device_id;
        render();
      });
      return b;
    }),
  );
  // Tabs are only useful with more than one microphone.
  tabs.hidden = devices.length < 2;
}

function renderDevice() {
  const d = currentDevice();
  $('empty').hidden = !!d || !state.server;

  if (!d) {
    for (const id of ['dev-pill', 'ws-pill', 'au-pill']) setPill(id, 'No device', '');
    return;
  }

  // ESP32 device card
  setText('dev-id', d.device_id);
  setPill('dev-pill', d.connected ? 'Online' : 'Offline', d.connected ? 'ok' : 'bad');
  setText('dev-status', d.connected ? 'CONNECTED' : 'DISCONNECTED', d.connected ? 'state-ok' : 'state-bad');
  setText('dev-ip', d.ip || '—');
  if (d.connected) {
    setText('dev-wifi', `CONNECTED${d.wifi_ssid ? ` · ${d.wifi_ssid}` : ''}${d.wifi_rssi != null ? ` · ${d.wifi_rssi} dBm` : ''}`, 'state-ok');
  } else {
    setText('dev-wifi', 'UNKNOWN (device offline)', 'muted');
  }
  setText('dev-fw', d.firmware || '—');
  setText('dev-heap', d.free_heap != null ? `${fmtBytes(d.free_heap)}${d.min_free_heap != null ? ` (min ${fmtBytes(d.min_free_heap)})` : ''}` : '—');
  setText('dev-uptime', d.uptime_s != null && d.connected ? fmtSpan(d.uptime_s) : '—');
  setText('dev-reset', d.reset_reason || '—');

  // WebSocket card
  setPill('ws-pill', d.connected ? 'Connected' : 'Disconnected', d.connected ? 'ok' : 'bad');
  setText('ws-status', d.connected ? 'CONNECTED' : 'DISCONNECTED', d.connected ? 'state-ok' : 'state-bad');
  setText('ws-remote', d.remote_address || '—');
  $('ws-reason-label').textContent = d.connected ? 'Last disconnect' : 'Disconnected';
  setText('ws-reason', d.connected ? '—' : d.disconnect_reason ? `${ago(d.disconnected_at)} · ${d.disconnect_reason}` : '—');

  // Audio card
  let streamText, streamCls, pillText, pillKind;
  if (!d.connected) {
    [streamText, streamCls, pillText, pillKind] = ['OFFLINE', 'state-bad', 'Offline', 'bad'];
  } else if (d.streaming) {
    [streamText, streamCls, pillText, pillKind] = ['STREAMING', 'state-ok', d.recording ? 'Recording' : 'Streaming', d.recording ? 'rec' : 'ok'];
  } else {
    [streamText, streamCls, pillText, pillKind] = ['CONNECTED · NO AUDIO', 'state-idle', 'Idle', 'idle'];
  }
  setPill('au-pill', pillText, pillKind);
  setText('au-stream', streamText, streamCls);
  setText('au-recording', d.recording ? 'YES' : 'NO', d.recording ? 'state-bad' : '');
  $('au-dot').className = `rec-dot${d.recording ? ' on' : ''}`;
  setText('au-duration', fmtClock(d.recording_duration));
  setText('au-rate', `${d.sample_rate} Hz`);
  const pcmFmt = `PCM ${d.bits}-bit ${d.channels === 1 ? 'Mono' : `${d.channels} ch`}`;
  setText('au-format', d.format === 'ima_adpcm' ? `IMA-ADPCM 4:1 → ${pcmFmt}` : pcmFmt);
  setText('au-gain', d.mic_gain_db != null ? `${d.mic_gain_db > 0 ? '+' : ''}${d.mic_gain_db.toFixed(1)} dB${d.agc ? ' (AGC)' : ''}` : '—');
  setText('au-file', d.current_recording || '—');
  setText('au-packets', d.packets_received.toLocaleString());
  setText('au-bytes', fmtBytes(d.bytes_received));

  const warnings = [];
  if (d.rate_warning) warnings.push(d.rate_warning);
  if (d.recording_error) warnings.push(`Write error: ${d.recording_error}`);
  if (d.invalid_frames) warnings.push(`${d.invalid_frames} invalid audio frame(s) dropped`);
  if (d.dropped_bytes) warnings.push(`Device dropped ${fmtBytes(d.dropped_bytes)} of audio (network too slow)`);
  $('au-warn').hidden = warnings.length === 0;
  $('au-warn').textContent = warnings.join(' · ');

  renderRelativeTimes();
  renderLive();
}

function renderRelativeTimes() {
  const d = currentDevice();
  if (d) {
    setText('ws-since', d.connected && d.connected_since ? `${timeOf(d.connected_since)} · ${fmtSpan((now() - Date.parse(d.connected_since)) / 1000)}` : '—');
    setText('ws-last', d.last_packet ? `${timeOf(d.last_packet)} · ${ago(d.last_packet)}` : '—');
    if (!d.connected && d.disconnect_reason) setText('ws-reason', `${ago(d.disconnected_at)} · ${d.disconnect_reason}`);
  }
  if (state.server) {
    const up = state.server.uptime_s + (Date.now() - state.server.receivedAt) / 1000;
    $('server-line').textContent = `Server ${state.server.version} · up ${fmtSpan(up)} · ${state.server.sample_rate} Hz ${state.server.format} · stored as ${state.server.storage_format || 'wav'}`;
  }
}

function renderStorage() {
  const s = state.storage;
  if (!s) return;
  setPill('st-pill', `${s.recordings} files`, 'neutral');
  setText('st-count', s.recordings.toLocaleString());
  setText('st-size', fmtBytes(s.total_bytes));
  if (s.disk_free_bytes != null && s.disk_total_bytes) {
    const used = 1 - s.disk_free_bytes / s.disk_total_bytes;
    setText('st-free', `${fmtBytes(s.disk_free_bytes)} of ${fmtBytes(s.disk_total_bytes)}`);
    $('st-meter').style.width = `${(used * 100).toFixed(1)}%`;
  } else {
    setText('st-free', '—');
  }
  const last = s.last_recording;
  setText('st-last', last ? `${last.filename} (${fmtShortDuration(last.duration_seconds)})` : '—');
}

function renderRecordings() {
  const body = $('rec-body');
  $('rec-total').textContent = state.totalRecordings
    ? `${state.totalRecordings} total${state.totalRecordings > state.recordings.length ? `, newest ${state.recordings.length} shown` : ''}`
    : '';

  if (state.recordings.length === 0) {
    const tr = document.createElement('tr');
    tr.className = 'placeholder';
    const td = document.createElement('td');
    td.colSpan = 7;
    td.textContent = 'No recordings yet. They appear automatically when a microphone streams audio.';
    tr.append(td);
    body.replaceChildren(tr);
    selected.clear();
    renderBulk();
    return;
  }

  // Live duration for files still being written comes from the device status.
  const live = new Map();
  for (const d of state.devices.values()) if (d.current_recording) live.set(d.current_recording, d);

  // Forget selections for files that no longer exist or are being recorded.
  const deletable = new Set(state.recordings.filter((r) => !r.active && !live.has(r.filename)).map((r) => r.filename));
  for (const f of [...selected]) if (!deletable.has(f)) selected.delete(f);

  body.replaceChildren(
    ...state.recordings.map((r) => {
      const tr = document.createElement('tr');
      const liveDev = live.get(r.filename);
      const canDelete = deletable.has(r.filename);
      tr.className = [state.playing === r.filename && 'playing', selected.has(r.filename) && 'selected'].filter(Boolean).join(' ');

      const pick = document.createElement('td');
      pick.className = 'pick';
      if (canDelete) {
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = selected.has(r.filename);
        cb.dataset.filename = r.filename;
        cb.setAttribute('aria-label', `Select ${r.filename}`);
        cb.addEventListener('change', () => {
          if (cb.checked) selected.add(r.filename);
          else selected.delete(r.filename);
          disarmBulk();
          renderRecordings();
        });
        pick.append(cb);
      }

      const name = document.createElement('td');
      name.className = 'name';
      name.textContent = r.filename;
      if (r.active || liveDev) {
        const tag = document.createElement('span');
        tag.className = 'live-tag';
        tag.textContent = 'REC';
        name.append(tag);
      }

      const cell = (text, cls) => {
        const td = document.createElement('td');
        td.textContent = text;
        if (cls) td.className = cls;
        return td;
      };

      const url = `/recordings/${encodeURIComponent(r.filename)}`;
      const actions = document.createElement('td');
      actions.className = 'actions';
      const play = document.createElement('button');
      play.type = 'button';
      play.className = 'btn primary';
      if (liveDev) {
        // Still being recorded: a file snapshot would stop at its current end, so listen live instead.
        const on = live.wanted && live.device === liveDev.device_id;
        play.textContent = on ? '■ Stop live' : '🔊 Live';
        play.addEventListener('click', () => (on ? stopLive() : startLive(liveDev.device_id)));
      } else {
        play.textContent = state.playing === r.filename ? '▶ Playing' : '▶ Play';
        play.addEventListener('click', () => playRecording(r.filename, url));
      }
      const dl = document.createElement('a');
      dl.className = 'btn';
      dl.href = `${url}?download=1`;
      dl.setAttribute('download', r.filename);
      dl.textContent = '↓ Download';
      actions.append(play, dl);
      if (!r.active && !liveDev) actions.append(deleteButton(r.filename, url));

      tr.append(
        pick,
        name,
        cell(r.device_id || '—', 'mono'),
        cell(dateTimeOf(r.started_at)),
        cell(fmtShortDuration(liveDev ? liveDev.recording_duration : r.duration_seconds), 'num'),
        cell(fmtBytes(liveDev ? liveDev.recording_bytes : r.size_bytes), 'num'),
        actions,
      );
      return tr;
    }),
  );
  renderBulk();
}

// Two-step delete: the first click arms the button for 4 s, the second deletes.
const armedDeletes = new Map(); // filename → timeout id

function deleteButton(filename, url) {
  const b = document.createElement('button');
  b.type = 'button';
  const armed = armedDeletes.has(filename);
  b.className = `btn danger${armed ? ' armed' : ''}`;
  b.textContent = armed ? 'Confirm?' : 'Delete';
  b.title = armed ? `Permanently delete ${filename}` : 'Delete this recording';
  b.addEventListener('click', async () => {
    if (!armedDeletes.has(filename)) {
      armedDeletes.set(filename, setTimeout(() => {
        armedDeletes.delete(filename);
        renderRecordings();
      }, 4000));
      renderRecordings();
      return;
    }
    clearTimeout(armedDeletes.get(filename));
    armedDeletes.delete(filename);
    b.disabled = true;
    b.textContent = 'Deleting…';
    try {
      const res = await fetch(url, { method: 'DELETE' });
      if (res.status === 401) {
        location.href = '/login';
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      if (state.playing === filename) closePlayer();
      // Remove locally right away; the server also pushes the updated list to every dashboard.
      state.recordings = state.recordings.filter((r) => r.filename !== filename);
      state.totalRecordings = Math.max(0, state.totalRecordings - 1);
      alertBar(`Deleted ${filename} · ${state.totalRecordings} remaining.`, 'ok');
      renderRecordings();
    } catch (err) {
      b.disabled = false;
      b.textContent = 'Delete';
      alertBar(`Could not delete ${filename}: ${err.message}`);
    }
  });
  return b;
}

function alertBar(text, kind = 'warn') {
  const el = $('rec-alert');
  el.textContent = text;
  el.className = kind === 'ok' ? 'notice' : 'warn';
  el.hidden = false;
  clearTimeout(alertBar.t);
  alertBar.t = setTimeout(() => (el.hidden = true), 6000);
}

// ------------------------------------------------------------ multi-select delete

const selected = new Set();
let bulkTimer = null;

function renderBulk() {
  const n = selected.size;
  $('bulk').hidden = n === 0;
  const armed = bulkTimer !== null;
  const shownNote = state.totalRecordings > state.recordings.length ? ` (of ${state.totalRecordings} total)` : '';
  $('bulk-text').textContent = armed
    ? `Permanently delete ${n} recording${n === 1 ? '' : 's'}${shownNote}? This cannot be undone.`
    : `${n} selected${shownNote}`;
  $('bulk-delete').hidden = armed;
  $('bulk-delete').textContent = `Delete selected (${n})`;
  $('bulk-confirm').hidden = !armed;
  const boxes = [...document.querySelectorAll('#rec-body td.pick input')];
  const all = $('pick-all');
  all.disabled = boxes.length === 0;
  all.checked = boxes.length > 0 && boxes.every((b) => b.checked);
  all.indeterminate = !all.checked && boxes.some((b) => b.checked);
}

function disarmBulk() {
  if (bulkTimer) clearTimeout(bulkTimer);
  bulkTimer = null;
}

$('pick-all').addEventListener('change', (e) => {
  for (const cb of document.querySelectorAll('#rec-body td.pick input')) {
    if (e.target.checked) selected.add(cb.dataset.filename);
    else selected.delete(cb.dataset.filename);
  }
  disarmBulk();
  renderRecordings();
});

// Step 1: ask for confirmation (auto-cancels after 8 s).
$('bulk-delete').addEventListener('click', () => {
  if (selected.size === 0) return;
  bulkTimer = setTimeout(() => {
    bulkTimer = null;
    renderBulk();
  }, 8000);
  renderBulk();
});

$('bulk-cancel').addEventListener('click', () => {
  disarmBulk();
  selected.clear();
  renderRecordings();
});

// Step 2: delete everything selected in one request.
$('bulk-confirm').addEventListener('click', async () => {
  disarmBulk();
  const filenames = [...selected];
  $('bulk-confirm').disabled = true;
  try {
    const res = await fetch('/recordings/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filenames }),
    });
    if (res.status === 401) {
      location.href = '/login';
      return;
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    for (const f of body.deleted) selected.delete(f);
    if (body.deleted.includes(state.playing)) closePlayer();
    const gone = new Set(body.deleted);
    state.recordings = state.recordings.filter((r) => !gone.has(r.filename));
    state.totalRecordings = Math.max(0, state.totalRecordings - body.deleted.length);
    const n = body.deleted.length;
    let msg = `Deleted ${n} recording${n === 1 ? '' : 's'} · ${state.totalRecordings} remaining.`;
    if (body.failed.length) {
      msg += ` ${body.failed.length} skipped: ${body.failed.map((f) => `${f.filename} (${f.error})`).join(', ')}`;
    }
    alertBar(msg, body.failed.length ? 'warn' : 'ok');
  } catch (err) {
    alertBar(`Could not delete: ${err.message}`);
  } finally {
    $('bulk-confirm').disabled = false;
    renderRecordings();
  }
});

function playRecording(filename, url) {
  stopLive();
  const audio = $('audio');
  state.playing = filename;
  $('player').hidden = false;
  $('player-name').textContent = filename;
  // Cache-bust so a file that was still growing is re-read in full.
  audio.src = `${url}?t=${Date.now()}`;
  audio.play().catch(() => {
    /* autoplay may be blocked; the controls are visible */
  });
  renderRecordings();
}

function closePlayer() {
  const audio = $('audio');
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  $('player').hidden = true;
  if (state.playing !== null) {
    state.playing = null;
    renderRecordings();
  }
}

$('player-close').addEventListener('click', closePlayer);

function render() {
  currentDevice();
  renderTabs();
  renderDevice();
  renderStorage();
  renderRecordings();
}

// ------------------------------------------------------------ live listening
//
// /ws/live?device=<id> streams the device's raw PCM (s16le mono) as binary frames.
// Each frame is scheduled back-to-back on the Web Audio clock with a ~0.3 s cushion;
// if playback drifts too far behind (network burst) it jumps forward to stay live.

const LIVE_BUFFER_S = 0.3;
const LIVE_MAX_LAG_S = 1.0;
const live = { ws: null, ctx: null, device: null, rate: 16000, next: 0, level: 0, wanted: false };

function startLive(deviceId) {
  stopLive();
  closePlayer();
  live.wanted = true;
  live.device = deviceId;
  live.ctx = live.ctx || new (window.AudioContext || window.webkitAudioContext)();
  live.ctx.resume();
  openLiveSocket();
  renderLive();
}

function openLiveSocket() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/live?device=${encodeURIComponent(live.device)}`);
  ws.binaryType = 'arraybuffer';
  live.ws = ws;
  live.next = 0;
  ws.addEventListener('message', (ev) => {
    if (typeof ev.data === 'string') {
      try {
        const m = JSON.parse(ev.data);
        if (m.type === 'live') live.rate = m.sample_rate;
      } catch {}
      return;
    }
    playChunk(new Int16Array(ev.data));
  });
  ws.addEventListener('close', () => {
    if (live.ws !== ws) return;
    live.ws = null;
    if (live.wanted) setTimeout(() => live.wanted && !live.ws && openLiveSocket(), 2000);
    renderLive();
  });
  ws.addEventListener('open', renderLive);
}

function playChunk(pcm) {
  const ctx = live.ctx;
  if (!ctx || pcm.length === 0) return;
  const buf = ctx.createBuffer(1, pcm.length, live.rate); // the browser resamples to its own rate
  const ch = buf.getChannelData(0);
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i] / 32768;
    ch[i] = v;
    sum += v * v;
  }
  live.level = Math.sqrt(sum / pcm.length);

  const now = ctx.currentTime;
  if (live.next < now + 0.02 || live.next > now + LIVE_MAX_LAG_S) live.next = now + LIVE_BUFFER_S;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start(live.next);
  live.next += buf.duration;
}

function stopLive() {
  live.wanted = false;
  const ws = live.ws;
  live.ws = null;
  if (ws) ws.close();
  live.level = 0;
  live.device = null;
  renderLive();
}

function renderLive() {
  const d = currentDevice();
  const btn = $('live-btn');
  const listening = live.wanted && d && live.device === d.device_id;
  btn.textContent = listening ? '■ Stop listening' : '🔊 Listen live';
  btn.classList.toggle('listening', !!listening);
  btn.disabled = !d;
  let status = '';
  if (listening) {
    if (!live.ws || live.ws.readyState !== WebSocket.OPEN) status = 'connecting…';
    else if (!d.streaming) status = 'waiting for audio…';
    else status = `live · ${Math.max(0, Math.round((live.next - live.ctx.currentTime) * 1000))} ms behind`;
  }
  $('live-status').textContent = status;
}

$('live-btn').addEventListener('click', () => {
  const d = currentDevice();
  if (!d) return;
  if (live.wanted && live.device === d.device_id) stopLive();
  else startLive(d.device_id);
});

(function meterLoop() {
  // Decay the level so the bar falls when audio stops.
  if (!live.ws) live.level *= 0.8;
  const db = live.level > 0 ? 20 * Math.log10(live.level) : -90;
  $('live-meter').style.width = `${Math.max(0, Math.min(100, ((db + 60) / 60) * 100)).toFixed(1)}%`;
  requestAnimationFrame(meterLoop);
})();

// ------------------------------------------------------------ live link

let socket = null;
let retry = 0;
const RETRY_DELAYS = [1000, 2000, 5000, 10000];

function setLink(st, text) {
  $('link').dataset.state = st;
  $('link-text').textContent = text;
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${proto}://${location.host}/ws`);
  setLink('connecting', 'Connecting');

  socket.addEventListener('open', () => {
    retry = 0;
    setLink('live', 'Live');
  });

  socket.addEventListener('message', (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    switch (msg.type) {
      case 'snapshot':
        state.server = { ...msg.server, receivedAt: Date.now() };
        $('logout').hidden = state.server.auth !== 'login';
        state.devices = new Map(msg.devices.map((d) => [d.device_id, d]));
        state.recordings = msg.recordings;
        state.totalRecordings = msg.total;
        state.storage = msg.storage;
        render();
        break;
      case 'status': {
        state.devices.set(msg.device_id, msg);
        renderTabs();
        if (msg.device_id === (currentDevice() || {}).device_id) renderDevice();
        // Keep the live row's duration ticking.
        if (msg.current_recording) renderRecordings();
        break;
      }
      case 'recordings':
        state.recordings = msg.recordings;
        state.totalRecordings = msg.total;
        state.storage = msg.storage;
        renderStorage();
        renderRecordings();
        break;
    }
  });

  socket.addEventListener('close', async () => {
    // A closed socket may mean the session expired: go to the login page if so.
    try {
      const r = await fetch('/api/devices', { cache: 'no-store' });
      if (r.status === 401) {
        location.href = '/login';
        return;
      }
    } catch {
      /* server unreachable: keep retrying */
    }
    const delay = RETRY_DELAYS[Math.min(retry++, RETRY_DELAYS.length - 1)];
    setLink('down', `Reconnecting in ${delay / 1000}s`);
    setTimeout(connect, delay);
  });
}

setInterval(() => {
  renderRelativeTimes();
  renderLive();
}, 500);
connect();
