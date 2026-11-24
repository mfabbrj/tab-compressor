// Service worker: gestisce il documento offscreen (dove gira l'AudioContext) e il badge.

const OFFSCREEN_URL = 'offscreen.html';
let creating = null;

async function hasOffscreen() {
  const ctxs = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
  });
  return ctxs.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (!creating) {
    creating = chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['USER_MEDIA'],
      justification: "Elaborazione dell'audio della scheda (compressore / limiter)"
    }).finally(() => { creating = null; });
  }
  await creating;
}

function toOffscreen(msg) {
  return chrome.runtime.sendMessage({ target: 'offscreen', ...msg });
}

async function setBadge(tabId, on) {
  try {
    await chrome.action.setBadgeText({ tabId, text: on ? 'ON' : '' });
    if (on) await chrome.action.setBadgeBackgroundColor({ tabId, color: '#16a34a' });
  } catch (_) { /* scheda chiusa */ }
}

async function maybeCloseOffscreen() {
  // piccola attesa per non chiudere il documento se l'utente sta riattivando subito
  await new Promise(r => setTimeout(r, 1500));
  if (!(await hasOffscreen())) return;
  try {
    const r = await toOffscreen({ type: 'count' });
    if (r && r.count === 0) await chrome.offscreen.closeDocument();
  } catch (_) { /* ignorato */ }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== 'background') return false;

  (async () => {
    switch (msg.type) {
      case 'start': {
        await ensureOffscreen();
        const r = await toOffscreen({ type: 'start', tabId: msg.tabId, streamId: msg.streamId, params: msg.params });
        if (r && r.ok) await setBadge(msg.tabId, true);
        return r;
      }
      case 'stop': {
        if (await hasOffscreen()) await toOffscreen({ type: 'stop', tabId: msg.tabId });
        await setBadge(msg.tabId, false);
        return { ok: true };
      }
      case 'session-ended': {
        await setBadge(msg.tabId, false);
        if (msg.remaining === 0) maybeCloseOffscreen();
        return { ok: true };
      }
    }
    return { error: 'Messaggio sconosciuto' };
  })().then(sendResponse, e => sendResponse({ error: e?.message || String(e) }));

  return true;
});

chrome.tabs.onRemoved.addListener(async tabId => {
  if (await hasOffscreen()) toOffscreen({ type: 'stop', tabId }).catch(() => {});
});
