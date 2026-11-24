const DEFAULTS = {
  threshold: -24, ratio: 4, knee: 6, attack: 10, release: 250, makeup: 0,
  limiter: true, ceiling: -1, limRelease: 100, bypass: false
};

const PRESETS = {
  leggero: { threshold: -18, ratio: 2,  knee: 10, attack: 20, release: 250, makeup: 2,  limiter: true, ceiling: -1,   limRelease: 100 },
  voce:    { threshold: -28, ratio: 4,  knee: 8,  attack: 5,  release: 150, makeup: 7,  limiter: true, ceiling: -1,   limRelease: 80 },
  musica:  { threshold: -20, ratio: 2.5,knee: 6,  attack: 30, release: 300, makeup: 3,  limiter: true, ceiling: -0.5, limRelease: 120 },
  notte:   { threshold: -40, ratio: 8,  knee: 12, attack: 3,  release: 300, makeup: 14, limiter: true, ceiling: -2,   limRelease: 80 },
  limiter: { threshold: 0,   ratio: 1,  knee: 0,  attack: 10, release: 250, makeup: 6,  limiter: true, ceiling: -1,   limRelease: 60 },
  default: { ...DEFAULTS }
};

const COMP = [
  { id: 'threshold', label: 'Threshold', min: -60, max: 0,   step: 0.5, fmt: v => `${v.toFixed(1)} dB` },
  { id: 'ratio',     label: 'Ratio',     min: 1,   max: 20,  step: 0.1, fmt: v => v >= 20 ? '∞:1 (20)' : `${v.toFixed(1)}:1` },
  { id: 'knee',      label: 'Knee',      min: 0,   max: 40,  step: 0.5, fmt: v => `${v.toFixed(1)} dB` },
  { id: 'attack',    label: 'Attack',    min: 0,   max: 500, step: 0.5, fmt: v => `${v.toFixed(1)} ms` },
  { id: 'release',   label: 'Release',   min: 10,  max: 1000,step: 5,   fmt: v => `${v.toFixed(0)} ms` },
  { id: 'makeup',    label: 'Makeup',    min: 0,   max: 24,  step: 0.5, fmt: v => `+${v.toFixed(1)} dB` }
];
const LIM = [
  { id: 'ceiling',    label: 'Ceiling', min: -12, max: 0,   step: 0.1, fmt: v => `${v.toFixed(1)} dB` },
  { id: 'limRelease', label: 'Release', min: 10,  max: 500, step: 5,   fmt: v => `${v.toFixed(0)} ms` }
];

const $ = id => document.getElementById(id);
let params = { ...DEFAULTS };
let tab = null;
let active = false;
const inputs = {};

// ---------- UI ----------
function buildControls(list, container) {
  for (const c of list) {
    const row = document.createElement('div');
    row.className = 'ctl';
    row.innerHTML = `<label for="${c.id}">${c.label}</label>
      <input type="range" id="${c.id}" min="${c.min}" max="${c.max}" step="${c.step}">
      <output id="${c.id}Out"></output>`;
    container.appendChild(row);
    const input = row.querySelector('input');
    const out = row.querySelector('output');
    inputs[c.id] = { input, out, c, row };
    input.addEventListener('input', () => { params[c.id] = parseFloat(input.value); render(); changed(); });
    input.addEventListener('dblclick', () => { params[c.id] = DEFAULTS[c.id]; render(); changed(); });
  }
}

function render() {
  for (const { input, out, c } of Object.values(inputs)) {
    input.value = params[c.id];
    out.textContent = c.fmt(params[c.id]);
  }
  $('limiter').checked = params.limiter;
  $('bypass').checked = params.bypass;
  for (const id of ['ceiling', 'limRelease']) inputs[id].row.classList.toggle('disabled', !params.limiter);
  drawCurve();
}

function setPower(on) {
  active = on;
  const b = $('power');
  b.textContent = on ? 'ON' : 'OFF';
  b.classList.toggle('on', on);
  b.title = on ? 'Disattiva sulla scheda corrente' : 'Attiva sulla scheda corrente';
  if (!on) resetMeters();
}

function showError(msg) {
  const e = $('error');
  e.hidden = !msg;
  e.textContent = msg || '';
}

// ---------- Curva di trasferimento (approssimata come la Web Audio API) ----------
function transfer(x) {
  const T = params.threshold, K = params.knee, R = params.ratio;
  let y;
  if (params.bypass) return x;
  if (x <= T) y = x;
  else if (K > 0 && x < T + K) y = x + (1 / R - 1) * (x - T) ** 2 / (2 * K);
  else {
    const yk = K > 0 ? T + K + (1 / R - 1) * K / 2 : T;
    y = yk + (x - T - K) / R;
  }
  y += params.makeup;
  if (params.limiter && y > params.ceiling) y = params.ceiling + (y - params.ceiling) / 20;
  return y;
}

let liveIn = -120;
function drawCurve() {
  const cv = $('curve');
  const dpr = window.devicePixelRatio || 1;
  const W = 200, H = 150;
  if (cv.width !== W * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);

  const MIN = -60, pad = 4;
  const px = db => pad + (db - MIN) / -MIN * (W - 2 * pad);
  const py = db => H - pad - (Math.max(MIN, Math.min(6, db)) - MIN) / (6 - MIN) * (H - 2 * pad);

  // griglia
  g.strokeStyle = '#2c313b'; g.lineWidth = 1; g.font = '9px system-ui'; g.fillStyle = '#5d6575';
  for (let d = -48; d <= 0; d += 12) {
    g.beginPath(); g.moveTo(px(d) + .5, pad); g.lineTo(px(d) + .5, H - pad); g.stroke();
    g.beginPath(); g.moveTo(pad, py(d) + .5); g.lineTo(W - pad, py(d) + .5); g.stroke();
    g.fillText(d, px(d) + 2, H - 6);
  }
  // diagonale 1:1
  g.strokeStyle = '#3a404c'; g.setLineDash([3, 3]);
  g.beginPath(); g.moveTo(px(MIN), py(MIN)); g.lineTo(px(0), py(0)); g.stroke();
  g.setLineDash([]);

  // threshold e ceiling
  g.strokeStyle = 'rgba(245,158,11,.5)';
  g.beginPath(); g.moveTo(px(params.threshold) + .5, pad); g.lineTo(px(params.threshold) + .5, H - pad); g.stroke();
  if (params.limiter) {
    g.strokeStyle = 'rgba(239,68,68,.6)';
    g.beginPath(); g.moveTo(pad, py(params.ceiling) + .5); g.lineTo(W - pad, py(params.ceiling) + .5); g.stroke();
  }

  // curva
  g.strokeStyle = params.bypass ? '#8b93a3' : '#f59e0b'; g.lineWidth = 2;
  g.beginPath();
  for (let x = MIN; x <= 0; x += 0.5) {
    const X = px(x), Y = py(transfer(x));
    x === MIN ? g.moveTo(X, Y) : g.lineTo(X, Y);
  }
  g.stroke();

  // punto live
  if (active && liveIn > MIN) {
    const x = Math.min(0, liveIn);
    g.fillStyle = '#22c55e';
    g.beginPath(); g.arc(px(x), py(transfer(x)), 3.5, 0, Math.PI * 2); g.fill();
  }
}

// ---------- Meter ----------
const pct = (db, min = -60) => Math.max(0, Math.min(100, (db - min) / -min * 100));
const grPct = db => Math.max(0, Math.min(100, -db / 24 * 100)); // scala GR 0..24 dB
let held = { in: -120, out: -120, gr: 0, lim: 0 };

function setBar(id, p) { $(id).style.setProperty('--h', p + '%'); }

function resetMeters() {
  held = { in: -120, out: -120, gr: 0, lim: 0 };
  ['mIn', 'mOut', 'mGr', 'mLim'].forEach(id => setBar(id, 0));
  $('vIn').textContent = $('vOut').textContent = $('vGr').textContent = '–';
  liveIn = -120;
  drawCurve();
}

let polling = false;
async function poll() {
  if (polling) return;
  polling = true;
  let last = 0;
  const loop = async now => {
    if (!active) { polling = false; return; }
    if (now - last > 50) {
      last = now;
      try {
        const m = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'meters', tabId: tab.id });
        if (m && m.active) {
          const decay = 1.2; // dB per frame
          held.in = Math.max(m.inDb, held.in - decay);
          held.out = Math.max(m.outDb, held.out - decay);
          held.gr = Math.min(m.grComp, held.gr + decay * 0.5);
          held.lim = Math.min(m.grLim, held.lim + decay * 0.5);
          setBar('mIn', pct(held.in));
          setBar('mOut', pct(held.out));
          setBar('mGr', grPct(held.gr));
          setBar('mLim', grPct(held.lim));
          $('vIn').textContent = held.in <= -90 ? '-∞' : held.in.toFixed(1);
          $('vOut').textContent = held.out <= -90 ? '-∞' : held.out.toFixed(1);
          $('vGr').textContent = (held.gr + held.lim).toFixed(1);
          liveIn = held.in;
          drawCurve();
        } else if (m && m.active === false) {
          setPower(false);
        }
      } catch (_) { /* offscreen non pronto */ }
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

// ---------- Comunicazione ----------
let pushTimer = null;
function changed() {
  chrome.storage.local.set({ params });
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    if (active) chrome.runtime.sendMessage({ target: 'offscreen', type: 'params', params }).catch(() => {});
  }, 25);
}

async function toggle() {
  showError('');
  const btn = $('power');
  btn.disabled = true;
  try {
    if (active) {
      await chrome.runtime.sendMessage({ target: 'background', type: 'stop', tabId: tab.id });
      setPower(false);
    } else {
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
      const r = await chrome.runtime.sendMessage({ target: 'background', type: 'start', tabId: tab.id, streamId, params });
      if (!r || r.error) throw new Error(r?.error || 'Avvio non riuscito');
      setPower(true);
      poll();
    }
  } catch (e) {
    let msg = e?.message || String(e);
    if (/active stream/i.test(msg)) msg = "Questa scheda è già catturata (da questa o un'altra estensione). Ricarica la scheda e riprova.";
    else if (/chrome:\/\/|Chrome pages|cannot be captured|not allowed/i.test(msg)) msg = 'Questa pagina non può essere catturata (pagine chrome://, Web Store, ecc.).';
    showError(msg);
  } finally {
    btn.disabled = false;
  }
}

// ---------- Init ----------
(async function init() {
  buildControls(COMP, $('compControls'));
  buildControls(LIM, $('limControls'));

  const stored = await chrome.storage.local.get('params');
  params = { ...DEFAULTS, ...(stored.params || {}) };
  render();

  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  $('tabTitle').textContent = tab?.title || '';

  $('limiter').addEventListener('change', e => { params.limiter = e.target.checked; render(); changed(); });
  $('bypass').addEventListener('change', e => { params.bypass = e.target.checked; render(); changed(); });
  $('preset').addEventListener('change', e => {
    const p = PRESETS[e.target.value];
    if (p) { params = { ...params, ...p, bypass: false }; render(); changed(); }
    e.target.value = '';
  });
  $('power').addEventListener('click', toggle);

  try {
    const s = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'status', tabId: tab.id });
    setPower(!!(s && s.active));
    if (active) {
      chrome.runtime.sendMessage({ target: 'offscreen', type: 'params', params }).catch(() => {});
      poll();
    }
  } catch (_) {
    setPower(false);
  }
})();
