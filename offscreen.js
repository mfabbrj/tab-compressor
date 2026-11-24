// Motore audio: cattura la scheda e la fa passare per
// ingresso -> compressore -> makeup -> limiter -> uscita (con bypass e meter).

let params = null;
const sessions = new Map();     // tabId -> sessione
const makeupCache = new Map();  // makeup automatico del DynamicsCompressor, misurato

const dbToGain = db => Math.pow(10, db / 20);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== 'offscreen') return false;
  handle(msg).then(r => sendResponse(r ?? { ok: true }),
                   e => sendResponse({ error: e?.message || String(e) }));
  return true;
});

async function handle(msg) {
  switch (msg.type) {
    case 'start':  return start(msg.tabId, msg.streamId, msg.params);
    case 'stop':   stop(msg.tabId); return { ok: true };
    case 'params':
      params = msg.params;
      await Promise.all([...sessions.values()].map(s => apply(s, false)));
      return { ok: true };
    case 'status': return { active: sessions.has(msg.tabId) };
    case 'count':  return { count: sessions.size };
    case 'meters': return meters(msg.tabId);
  }
  return { error: 'Messaggio sconosciuto' };
}

async function start(tabId, streamId, p) {
  if (sessions.has(tabId)) stop(tabId);
  params = p;

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: false
  });

  const ctx = new AudioContext({ latencyHint: 'interactive' });
  const src = ctx.createMediaStreamSource(stream);

  const s = {
    tabId, ctx, stream, src,
    inAn: ctx.createAnalyser(),
    comp: ctx.createDynamicsCompressor(),
    compFix: ctx.createGain(),   // annulla il makeup automatico del nodo
    makeup: ctx.createGain(),    // makeup scelto dall'utente
    lim: ctx.createDynamicsCompressor(),
    limFix: ctx.createGain(),
    wet: ctx.createGain(),
    dry: ctx.createGain(),
    outAn: ctx.createAnalyser(),
    buf: new Float32Array(2048)
  };
  s.inAn.fftSize = 2048;
  s.outAn.fftSize = 2048;

  src.connect(s.inAn);
  src.connect(s.dry).connect(s.outAn);
  src.connect(s.comp).connect(s.compFix).connect(s.makeup)
     .connect(s.lim).connect(s.limFix).connect(s.wet).connect(s.outAn);
  s.outAn.connect(ctx.destination);

  sessions.set(tabId, s);
  stream.getAudioTracks()[0]?.addEventListener('ended', () => stop(tabId));

  await apply(s, true);
  return { ok: true };
}

function stop(tabId) {
  const s = sessions.get(tabId);
  if (!s) return;
  sessions.delete(tabId);
  s.stream.getTracks().forEach(t => t.stop());
  s.ctx.close().catch(() => {});
  chrome.runtime.sendMessage({ target: 'background', type: 'session-ended', tabId, remaining: sessions.size })
    .catch(() => {});
}

async function apply(s, immediate) {
  const p = params;
  if (!p) return;
  const t = s.ctx.currentTime;
  const set = (param, v) => immediate ? param.setValueAtTime(v, t) : param.setTargetAtTime(v, t, 0.015);

  // Compressore
  set(s.comp.threshold, p.threshold);
  set(s.comp.ratio, p.ratio);
  set(s.comp.knee, p.knee);
  set(s.comp.attack, p.attack / 1000);
  set(s.comp.release, p.release / 1000);
  set(s.makeup.gain, dbToGain(p.makeup));

  // Limiter (ratio massima consentita dalla Web Audio API = 20)
  const limT = p.limiter ? p.ceiling : 0;
  const limR = p.limiter ? 20 : 1;
  set(s.lim.threshold, limT);
  set(s.lim.ratio, limR);
  set(s.lim.knee, 0);
  set(s.lim.attack, 0.001);
  set(s.lim.release, p.limRelease / 1000);

  // Bypass
  set(s.wet.gain, p.bypass ? 0 : 1);
  set(s.dry.gain, p.bypass ? 1 : 0);

  // Il DynamicsCompressorNode applica un makeup automatico: lo misuriamo e lo annulliamo,
  // così il makeup è solo quello impostato dall'utente e il ceiling resta un ceiling.
  const [cm, lm] = await Promise.all([
    measureMakeup(p.threshold, p.knee, p.ratio),
    measureMakeup(limT, 0, limR)
  ]);
  set(s.compFix.gain, 1 / cm);
  set(s.limFix.gain, 1 / lm);
}

async function measureMakeup(threshold, knee, ratio) {
  const key = `${threshold}|${knee}|${ratio}`;
  if (makeupCache.has(key)) return makeupCache.get(key);

  const sr = 22050;
  const oc = new OfflineAudioContext(1, Math.round(sr * 0.3), sr);
  const osc = oc.createOscillator();
  osc.frequency.value = 441;
  const amp = 3e-5; // ~ -90 dBFS: sotto qualsiasi threshold => guadagno = solo makeup
  const g = oc.createGain();
  g.gain.value = amp;
  const c = oc.createDynamicsCompressor();
  c.threshold.value = threshold;
  c.knee.value = knee;
  c.ratio.value = ratio;
  c.attack.value = 0.003;
  c.release.value = 0.1;
  osc.connect(g).connect(c).connect(oc.destination);
  osc.start();

  const buf = await oc.startRendering();
  const d = buf.getChannelData(0);
  const from = Math.round(sr * 0.15);
  let sum = 0;
  for (let i = from; i < d.length; i++) sum += d[i] * d[i];
  const rms = Math.sqrt(sum / (d.length - from));
  let gain = rms / (amp / Math.SQRT2);
  if (!isFinite(gain) || gain < 0.01 || gain > 100) gain = 1;

  makeupCache.set(key, gain);
  return gain;
}

function peakDb(an, buf) {
  an.getFloatTimeDomainData(buf);
  let m = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = Math.abs(buf[i]);
    if (v > m) m = v;
  }
  return m > 0 ? 20 * Math.log10(m) : -120;
}

function meters(tabId) {
  const s = sessions.get(tabId);
  if (!s) return { active: false };
  return {
    active: true,
    inDb: peakDb(s.inAn, s.buf),
    outDb: peakDb(s.outAn, s.buf),
    grComp: params?.bypass ? 0 : s.comp.reduction,
    grLim: params?.bypass || !params?.limiter ? 0 : s.lim.reduction
  };
}
