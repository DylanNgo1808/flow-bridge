/**
 * Flow Kit — Chrome Extension Background Service Worker
 *
 * Connects to local Python agent via WebSocket (agent runs WS server).
 * Captures bearer token, solves reCAPTCHA, proxies API calls through browser.
 */

importScripts('flow_payload.js', 'request_log.js');

const AGENT_WS_URL = 'ws://127.0.0.1:18765';
// NOTE: This is a browser-restricted public API key — safe to ship in extension bundles.
const API_KEY = 'AIzaSyBtrm0o5ab1c-Ec8ZuLcGt3oJAA5VWt3pY';

// Google moved Flow from labs.google/fx/tools/flow → flow.google.com.
const FLOW_HOME_URL = 'https://flow.google.com/';
const FLOW_TAB_URLS = [
  'https://flow.google.com/*',
  'https://labs.google/fx/tools/flow*',
  'https://labs.google/fx/*/tools/flow*',
];

function isFlowPageUrl(url) {
  if (!url) return false;
  return (
    url.startsWith('https://flow.google.com/') ||
    url.startsWith('https://labs.google/')
  );
}

let ws = null;
let flowKey = null;
let callbackSecret = null;  // Auth secret for HTTP callback, received from server on WS connect
let state = 'off'; // off | idle | running
let manualDisconnect = false;
let manualDisconnectRevision = 0;
let metrics = {
  tokenCapturedAt: null,
  requestCount: 0,   // captcha-consuming requests only (gen image/video/upscale)
  successCount: 0,
  failedCount: 0,
  lastError: null,
};

// ─── URL → Log Type Classifier ─────────────────────────────

// Visible log types — only these appear in the request log
const _VISIBLE_TYPES = new Set(['GEN_IMG', 'GEN_VID', 'GEN_VID_REF', 'UPSCALE', 'TRACKING', 'URL_REFRESH']);
// These Flow calls return 200 when the job is *accepted*, not when the clip exists.
const _ASYNC_SUBMIT_TYPES = new Set(['GEN_VID', 'GEN_VID_REF', 'UPSCALE']);

function _classifyApiUrl(url) {
  if (url.includes('uploadImage'))                     return 'UPLOAD';
  if (url.includes('batchGenerateImages'))              return 'GEN_IMG';
  if (url.includes('UpsampleVideo'))                   return 'UPSCALE';
  if (url.includes('ReferenceImages'))                 return 'GEN_VID_REF';
  if (url.includes('batchAsyncGenerateVideo'))          return 'GEN_VID';
  if (url.includes('batchCheckAsync'))                  return 'POLL';
  if (url.includes('upsampleImage'))                   return 'UPS_IMG';
  if (url.includes('/media/'))                         return 'MEDIA';
  if (url.includes('/credits'))                        return 'CREDITS';
  return 'API';
}

let lastFlowGenerate = null;

function rememberFlowGenerate(opts) {
  if (!opts || (!opts.videoModelKey && !opts.videoResolution && !opts.requestKeys)) return;
  lastFlowGenerate = opts;
  chrome.storage.local.set({ lastFlowGenerate: opts }).catch(() => {});
  sendToAgent({ type: 'flow_generate_capture', capture: opts });
  broadcastStatus();
}

// ─── Request Log ────────────────────────────────────────────

let requestLog = [];

function addRequestLog(entry) {
  requestLog.unshift(entry);
  if (requestLog.length > 100) requestLog.pop();
  broadcastRequestLog();
}

function updateRequestLog(id, updates) {
  const entry = requestLog.find((e) => e.id === id);
  if (entry) Object.assign(entry, updates);
  broadcastRequestLog();
}

function _completeAsyncEntry(entry, updates) {
  if (!entry) return false;
  if (entry.status === 'success' || entry.status === 'failed') return false;
  Object.assign(entry, updates);
  if (updates.status === 'success') {
    metrics.successCount++;
    metrics.lastError = null;
  } else if (updates.status === 'failed') {
    metrics.failedCount++;
    metrics.lastError = updates.error || 'VIDEO_FAILED';
  }
  return true;
}

function _markAsyncJobs(names, updates, mediaIds) {
  let hit = false;
  for (const entry of requestLog) {
    if (!_ASYNC_SUBMIT_TYPES.has(entry.type)) continue;
    if (entryMatchesSnapshot(entry, { names, mediaIds })) {
      if (_completeAsyncEntry(entry, updates)) hit = true;
    }
  }
  if (!hit) {
    const pending = requestLog.filter(
      (e) => _ASYNC_SUBMIT_TYPES.has(e.type) && e.status === 'processing',
    );
    // Only guess when a single clip is in-flight — concurrent Omni jobs
    // would otherwise all inherit the first poll result.
    if (pending.length === 1 && ((names && names.length) || (mediaIds && mediaIds.length))) {
      if (_completeAsyncEntry(pending[0], updates)) hit = true;
    }
  }
  if (hit) {
    chrome.storage.local.set({ metrics });
    broadcastStatus();
    broadcastRequestLog();
  }
}

function _applyProjectSnapshotToLog(payload) {
  const items = projectSnapshotTerminals(payload);
  if (!items.length) return;
  let hit = false;
  for (const item of items) {
    for (const entry of requestLog) {
      if (!_ASYNC_SUBMIT_TYPES.has(entry.type)) continue;
      if (!entryMatchesSnapshot(entry, item)) continue;
      if (_completeAsyncEntry(entry, { status: item.status, error: item.error })) {
        hit = true;
      }
    }
  }
  if (hit) {
    chrome.storage.local.set({ metrics });
    broadcastStatus();
    broadcastRequestLog();
  }
}

function broadcastRequestLog() {
  chrome.runtime.sendMessage({ type: 'REQUEST_LOG_UPDATE', log: requestLog }).catch(() => {});
}

// ─── Startup ────────────────────────────────────────────────

let initializationPromise = null;

chrome.runtime.onInstalled.addListener(() => {
  void ensureInitialized();
});
chrome.runtime.onStartup.addListener(() => {
  void ensureInitialized();
});
chrome.alarms.onAlarm.addListener(async (alarm) => {
  await ensureInitialized();
  if (alarm.name === 'reconnect') connectToAgent();
  if (alarm.name === 'keepAlive') keepAlive();
  if (alarm.name === 'token-refresh') {
    // Refresh runs even while the agent is down so the key does not expire,
    // but never after the operator hit Disconnect — it can open a Flow tab.
    if (!manualDisconnect) await captureTokenFromFlowTab();
  }
});

function ensureInitialized() {
  if (!initializationPromise) {
    initializationPromise = initialize().catch((error) => {
      initializationPromise = null;
      console.warn('[FlowAgent] Initialization failed', error);
    });
  }
  return initializationPromise;
}

async function initialize() {
  const preferenceRevision = manualDisconnectRevision;
  const data = await chrome.storage.local.get(['flowKey', 'metrics', 'callbackSecret', 'lastFlowGenerate', 'manualDisconnect']);
  // A user action during the read takes precedence over its stored snapshot.
  if (manualDisconnectRevision === preferenceRevision) {
    manualDisconnect = data.manualDisconnect === true;
  }
  if (data.flowKey) flowKey = data.flowKey;
  if (data.metrics) Object.assign(metrics, data.metrics);
  if (data.callbackSecret) callbackSecret = data.callbackSecret;
  if (data.lastFlowGenerate) lastFlowGenerate = data.lastFlowGenerate;
  if (chrome.sidePanel?.setPanelBehavior) {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
  connectToAgent();
  try {
    await chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 });
  } catch (error) {
    console.warn('[FlowAgent] Failed to arm keepAlive alarm', error);
  }
  // Token refresh is independent of the agent connection: the Flow key expires
  // on Google's clock, not ours. Preserve its deadline across worker restarts.
  try {
    if (!await chrome.alarms.get('token-refresh')) {
      await chrome.alarms.create('token-refresh', { periodInMinutes: 45 });
    }
  } catch (error) {
    console.warn('[FlowAgent] Failed to arm token-refresh alarm', error);
  }
}

// MV3 workers can be suspended and restarted without onStartup firing.
// Rehydrate the persisted Flow key on every worker start.
void ensureInitialized();

// ─── Token Capture ──────────────────────────────────────────

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (!details?.requestHeaders?.length) return;
    const authHeader = details.requestHeaders.find(
      (h) => h.name?.toLowerCase() === 'authorization',
    );
    const value = authHeader?.value || '';
    if (!value.startsWith('Bearer ya29.')) return;

    const token = value.replace(/^Bearer\s+/i, '').trim();
    if (!token) return;

    // Always update — even if same token string, refresh the timestamp
    flowKey = token;
    metrics.tokenCapturedAt = Date.now();
    chrome.storage.local.set({ flowKey, metrics });
    console.log('[FlowAgent] Bearer token captured');

    // Notify agent
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'token_captured', flowKey }));
    }
  },
  { urls: ['https://aisandbox-pa.googleapis.com/*', 'https://labs.google/*', 'https://flow.google.com/*'] },
  ['requestHeaders', 'extraHeaders'],
);

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    try {
      if (details.method !== 'POST') return;
      const url = details.url || '';
      if (!url.includes('batchAsyncGenerateVideo') && !url.includes('batchGenerateImages')) return;
      const bytes = details.requestBody?.raw?.[0]?.bytes;
      if (!bytes) return;
      const text = new TextDecoder('utf-8').decode(bytes);
      const body = JSON.parse(text);
      const opts = extractGenerateOptions(body, url);
      if (opts) rememberFlowGenerate(opts);
    } catch {
      /* ignore malformed page bodies */
    }
  },
  { urls: ['https://aisandbox-pa.googleapis.com/*'] },
  ['requestBody'],
);

let _openingFlowTab = false;

async function captureTokenFromFlowTab() {
  const tabs = await chrome.tabs.query({
    url: FLOW_TAB_URLS,
  });
  if (manualDisconnect) return;
  if (!tabs.length) {
    if (_openingFlowTab) {
      console.log('[FlowAgent] Flow tab already opening, skipping');
      return;
    }
    _openingFlowTab = true;
    try {
      console.log('[FlowAgent] No Flow tab found — opening one in background');
      await chrome.tabs.create({ url: FLOW_HOME_URL, active: false });
      await sleep(3000);
      const retryTabs = await chrome.tabs.query({
        url: FLOW_TAB_URLS,
      });
      const openedTab = await pickFlowTab(retryTabs);
      if (!openedTab) {
        console.log('[FlowAgent] Flow tab not ready yet after open');
        return;
      }
      await chrome.scripting.executeScript({
        target: { tabId: openedTab.id },
        files: ['content.js'],
      });
      console.log('[FlowAgent] Token refresh triggered on newly opened Flow tab');
    } catch (e) {
      console.error('[FlowAgent] Token refresh failed after opening tab:', e);
    } finally {
      _openingFlowTab = false;
    }
    return;
  }
  try {
    const tab = await pickFlowTab(tabs);
    if (!tab) {
      console.log('[FlowAgent] Flow tab discarded and could not be revived');
      return;
    }
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js'],
    });
    console.log('[FlowAgent] Token refresh triggered on Flow tab');
  } catch (e) {
    console.error('[FlowAgent] Token refresh failed:', e);
  }
}

// ─── Service Worker Keep-Alive ──────────────────────
// Chrome terminates an MV3 worker after 30s idle, and separately when a fetch()
// transfers no bytes for 30s (crbug.com/40283184). The 'keepAlive' alarm cannot
// prevent either: an alarm only revives a worker that already died, and the
// in-flight request is gone with it. Pulsing a chrome.* API resets the idle
// timer while a request is actually running, which is the documented
// workaround. Ref-counted because up to MAX_CONCURRENT_REQUESTS run at once.

const KEEPALIVE_PULSE_MS = 20000; // < 30s idle timeout, with slack
let keepAliveDepth = 0;
let keepAliveTimer = null;

function beginKeepAlive() {
  keepAliveDepth++;
  if (keepAliveTimer !== null) return;
  keepAliveTimer = setInterval(() => {
    // Any chrome.* call resets the idle timer; getPlatformInfo is the cheapest.
    chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError);
  }, KEEPALIVE_PULSE_MS);
}

function endKeepAlive() {
  if (keepAliveDepth > 0) keepAliveDepth--;
  if (keepAliveDepth === 0 && keepAliveTimer !== null) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

// The badge tracks the same bracket as the pulse. It used to be written by each
// handler individually, so with MAX_CONCURRENT_REQUESTS in flight the first one
// to finish reported 'idle' while the others were still running.
//
// Dropping to idle the instant the socket goes quiet was still wrong for what
// the badge is read for. A video generation is one api_request to submit and
// then a status poll every VIDEO_POLL_INTERVAL (10s) for several minutes, so a
// literal reading blinked ~40 times per clip while the work never stopped.
// Holding 'running' across a gap longer than one poll cycle makes the badge mean
// "there is work in progress", at the cost of reporting done up to
// IDLE_LINGER_MS late.
const IDLE_LINGER_MS = 15000; // > VIDEO_POLL_INTERVAL (10s), so polls do not gap
let idleLingerTimer = null;

function cancelIdleLinger() {
  if (idleLingerTimer !== null) {
    clearTimeout(idleLingerTimer);
    idleLingerTimer = null;
  }
}

async function withKeepAlive(fn) {
  cancelIdleLinger();
  beginKeepAlive();
  if (keepAliveDepth === 1 && state !== 'running') setState('running');
  try {
    return await fn();
  } finally {
    endKeepAlive();
    if (keepAliveDepth === 0) {
      cancelIdleLinger();
      idleLingerTimer = setTimeout(() => {
        idleLingerTimer = null;
        // Re-check: work may have arrived while the linger was pending.
        if (keepAliveDepth === 0 && state === 'running') setState('idle');
      }, IDLE_LINGER_MS);
    }
  }
}

// ─── WebSocket to Agent ─────────────────────────────────────

function connectToAgent() {
  if (manualDisconnect) return;
  if (ws?.readyState === WebSocket.CONNECTING) return;
  if (ws?.readyState === WebSocket.OPEN) return;

  try {
    ws = new WebSocket(AGENT_WS_URL);
  } catch (e) {
    console.error('[FlowAgent] WS connect error:', e);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log('[FlowAgent] Connected to agent');
    chrome.alarms.clear('reconnect');
    // A reconnect mid-batch must not claim idle while requests are in flight.
    setState(keepAliveDepth > 0 ? 'running' : 'idle');

    // Send current state + resend token if we have one
    ws.send(JSON.stringify({
      type: 'extension_ready',
      flowKeyPresent: !!flowKey,
      tokenAge: flowKey && metrics.tokenCapturedAt ? Date.now() - metrics.tokenCapturedAt : null,
    }));
    if (flowKey) {
      ws.send(JSON.stringify({ type: 'token_captured', flowKey }));
    }
  };

  ws.onmessage = async ({ data }) => {
    try {
      const msg = JSON.parse(data);

      if (msg.method === 'api_request') {
        await withKeepAlive(() => handleApiRequest(msg));
      } else if (msg.method === 'trpc_request') {
        await withKeepAlive(() => handleTrpcRequest(msg));
      } else if (msg.method === 'solve_captcha') {
        await withKeepAlive(() => handleSolveCaptcha(msg));
      } else if (msg.method === 'get_status') {
        sendToAgent({
          id: msg.id,
          result: {
            state,
            flowKeyPresent: !!flowKey,
            manualDisconnect,
            tokenAge: metrics.tokenCapturedAt ? Date.now() - metrics.tokenCapturedAt : null,
            metrics,
          },
        });
      } else if (msg.type === 'callback_secret') {
        callbackSecret = msg.secret;
        chrome.storage.local.set({ callbackSecret: msg.secret });
        console.log('[FlowAgent] Received callback secret');
      } else if (msg.type === 'pong') {
        // keepalive response
      }
    } catch (e) {
      console.error('[FlowAgent] Message error:', e);
    }
  };

  ws.onclose = () => {
    cancelIdleLinger();
    setState('off');
    if (!manualDisconnect) scheduleReconnect();
  };

  ws.onerror = () => {
    // Expected when the agent is down or reconnecting. Do not console.error —
    // Chrome treats SW console.error as the red Errors badge on chrome://extensions.
    metrics.lastError = 'WS_ERROR';
    chrome.storage.local.set({ metrics });
  };
}

function scheduleReconnect() {
  chrome.alarms.create('reconnect', { delayInMinutes: 0.083 }); // ~5s
}

function keepAlive() {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'ping' }));
  } else {
    connectToAgent();
  }
}

function sendToAgent(msg) {
  // API responses (with msg.id) go via HTTP — immune to WS disconnect
  if (msg.id) {
    fetch('http://127.0.0.1:8100/api/ext/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg),
    }).catch(() => {
      // HTTP failed — fallback to WS
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    });
    return;
  }
  // Non-response messages (ping, status) or no secret yet — use WS
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// ─── reCAPTCHA Solving ──────────────────────────────────────

async function requestCaptchaFromTab(tabId, requestId, pageAction) {
  try {
    return await chrome.tabs.sendMessage(tabId, {
      type: 'GET_CAPTCHA',
      requestId,
      pageAction,
    });
  } catch (error) {
    const msg = error?.message || '';
    const shouldInject =
      msg.includes('Receiving end does not exist') ||
      msg.includes('Could not establish connection');
    if (!shouldInject) throw error;

    // Inject content script and retry
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });
    await sleep(200);
    return await chrome.tabs.sendMessage(tabId, {
      type: 'GET_CAPTCHA',
      requestId,
      pageAction,
    });
  }
}

/** True when the enterprise reCAPTCHA library is actually callable in a tab.
 *  chrome.tabs "status: complete" only means the document finished — the Flow
 *  app lazy-loads grecaptcha well after that, so "complete" is not readiness.
 *
 *  The probe is bounded twice over, because it runs before solveCaptcha starts
 *  its 30s race and would otherwise extend that budget instead of fitting in
 *  it: injectImmediately skips executeScript's default wait for document idle,
 *  which on a still-loading tab blocks until the page settles, and the timeout
 *  keeps one unresponsive candidate from hiding a ready one behind it.
 */
async function grecaptchaReady(tabId, timeout = 1500) {
  try {
    const [res] = await Promise.race([
      chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        injectImmediately: true,
        func: () => !!window.grecaptcha?.enterprise?.execute,
      }),
      sleep(timeout).then(() => [{ result: false }]),
    ]);
    return !!res?.result;
  } catch {
    // Tab closed, discarded mid-probe, or not scriptable — treat as not ready.
    return false;
  }
}

/** Pick a usable Flow tab, waking a discarded one if that is all there is.
 *  Chrome auto-discards backgrounded tabs to reclaim memory, and this extension
 *  opens its Flow tab in the background itself, so this is the ordinary case on
 *  a long session. A discarded tab still comes back from chrome.tabs.query, but
 *  sendMessage and executeScript into it throw "No tab with id". During
 *  solveCaptcha that surfaces as CONTENT_TIMEOUT, which the worker then charges
 *  to the reCAPTCHA retry budget — a dead tab is indistinguishable from a
 *  refused captcha. A reload re-hydrates it.
 *
 *  With requireCaptcha, a tab that already has grecaptcha is preferred over one
 *  that merely finished loading: a hydrated but backgrounded tab has throttled
 *  timers and can take far longer than the page load to expose
 *  window.grecaptcha.enterprise, so "status: complete" picked the wrong tab when
 *  a ready one was sitting right next to it. Waiting for it is left to
 *  injected.js, which already does so inside the captcha timeout budget —
 *  waiting here would stack on top of that budget instead.
 */
async function pickFlowTab(tabs, { requireCaptcha = false } = {}) {
  const candidates = tabs.filter((t) => !t.discarded);

  if (!candidates.length) {
    for (const stale of tabs) {
      try {
        await chrome.tabs.reload(stale.id);
        for (let check = 0; check < 10; check++) {
          await sleep(500);
          const tab = await chrome.tabs.get(stale.id);
          if (!tab || !/^https:\/\/(flow\.google\.com\/|labs\.google\/fx\/(?:[^/]+\/)?tools\/flow)/.test(tab.url || '')) break;
          if (!tab.discarded && tab.status === 'complete') {
            candidates.push(tab);
            break;
          }
        }
      } catch {
        // The tab may have closed mid-reload; try the next candidate.
      }
      if (candidates.length) break;
    }
  }

  if (!candidates.length) return null;
  if (!requireCaptcha) return candidates[0];

  for (const tab of candidates) {
    if (await grecaptchaReady(tab.id)) return tab;
  }
  // None ready yet — hand back the best candidate and let injected.js wait.
  return candidates[0];
}

async function solveCaptcha(requestId, captchaAction) {
  const tabs = await chrome.tabs.query({
    url: FLOW_TAB_URLS,
  });

  if (!tabs.length) {
    // Auto-open Flow tab and wait briefly before returning error
    try {
      await chrome.tabs.create({ url: FLOW_HOME_URL, active: false });
      await sleep(3000);
      // Retry tab query after opening
      const retryTabs = await chrome.tabs.query({
        url: FLOW_TAB_URLS,
      });
      const openedTab = await pickFlowTab(retryTabs, { requireCaptcha: true });
      if (!openedTab) return { error: 'NO_FLOW_TAB' };
      const resp = await Promise.race([
        requestCaptchaFromTab(openedTab.id, requestId, captchaAction),
        new Promise((_, rej) => setTimeout(() => rej(new Error('CAPTCHA_TIMEOUT')), 30000)),
      ]);
      return resp;
    } catch (e) {
      return { error: e.message || 'NO_FLOW_TAB' };
    }
  }

  try {
    const tab = await pickFlowTab(tabs, { requireCaptcha: true });
    if (!tab) return { error: 'FLOW_TAB_DISCARDED' };
    const resp = await Promise.race([
      requestCaptchaFromTab(tab.id, requestId, captchaAction),
      new Promise((_, rej) => setTimeout(() => rej(new Error('CAPTCHA_TIMEOUT')), 30000)),
    ]);
    return resp;
  } catch (e) {
    return { error: e.message };
  }
}

async function handleSolveCaptcha(msg) {
  const { id, params } = msg;
  const result = await solveCaptcha(id, params?.captchaAction || 'VIDEO_GENERATION');

  // Standalone captcha solve counts as captcha-consuming
  metrics.requestCount++;
  if (result?.token) {
    metrics.successCount++;
  } else {
    metrics.failedCount++;
    metrics.lastError = result?.error || 'NO_TOKEN';
  }
  chrome.storage.local.set({ metrics });

  sendToAgent({ id, result });
}

// ─── API Request Proxy ──────────────────────────────────────

async function handleTrpcRequest(msg) {
  const { id, params } = msg;
  const { url, method = 'POST', headers = {}, body, responseMode = 'json' } = params;

  if (!isFlowPageUrl(url)) {
    sendToAgent({ id, error: 'INVALID_TRPC_URL' });
    return;
  }

  // TRPC calls don't consume captcha — don't count in metrics

  const logId = id;
  const logType = url.includes('createProject') ? 'CREATE_PROJECT' : 'TRPC';
  // TRPC calls are silent — don't show in request log

  const fetchHeaders = { 'Content-Type': 'application/json', ...headers };
  if (flowKey) {
    fetchHeaders['authorization'] = `Bearer ${flowKey}`;
  }

  try {
    const resp = await fetch(url, {
      method,
      headers: fetchHeaders,
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'include',
    });
    let data;
    if (responseMode === 'url') {
      // fetch() has already followed the authenticated Flow redirect. Return
      // only the final signed URL and cancel the body so large videos are not
      // buffered in the extension or copied through the WebSocket bridge.
      data = {
        url: resp.url,
        contentType: resp.headers.get('content-type'),
      };
      await resp.body?.cancel();
    } else {
      data = await resp.json();
      if (resp.ok) _applyProjectSnapshotToLog(data);
    }
    chrome.storage.local.set({ metrics });
    updateRequestLog(logId, { status: 'success' });
    sendToAgent({ id, status: resp.status, data });
  } catch (e) {
    console.error('[FlowAgent] tRPC request failed:', e);
    chrome.storage.local.set({ metrics });
    updateRequestLog(logId, { status: 'failed', error: e.message || 'TRPC_FETCH_FAILED' });
    sendToAgent({ id, error: e.message || 'TRPC_FETCH_FAILED' });
  }
}

async function handleApiRequest(msg) {
  const { id, params } = msg;
  const { url, method, headers, body, captchaAction } = params;

  if (!url) {
    sendToAgent({ id, error: 'MISSING_URL' });
    return;
  }

  if (!url.startsWith('https://aisandbox-pa.googleapis.com/')) {
    sendToAgent({ id, error: 'INVALID_URL' });
    return;
  }

  const hasCaptcha = !!captchaAction;
  if (hasCaptcha) metrics.requestCount++;

  const logId = id;
  const logType = _classifyApiUrl(url);
  if (_VISIBLE_TYPES.has(logType)) {
    const payloadSummary = summarizeGenerateBody(body) || (body ? JSON.stringify(body).slice(0, 200) : null);
    addRequestLog({ id: logId, type: logType, time: new Date().toISOString(), status: 'processing', error: null, outputUrl: null, url, payloadSummary });
  }

  try {
    // Step 1: Solve captcha if needed
    let captchaToken = null;
    if (captchaAction) {
      const captchaResult = await solveCaptcha(id, captchaAction);
      captchaToken = captchaResult?.token || null;
      if (!captchaToken) {
        // Cannot proceed without captcha — API will 403
        const err = captchaResult?.error || 'CAPTCHA_FAILED';
        console.error(`[FlowAgent] Captcha failed for ${captchaAction}: ${err}`);
        sendToAgent({ id, status: 403, error: `CAPTCHA_FAILED: ${err}` });
        if (hasCaptcha) { metrics.failedCount++; metrics.lastError = `CAPTCHA_FAILED: ${err}`; }
        chrome.storage.local.set({ metrics });
        updateRequestLog(logId, { status: 'failed', error: `CAPTCHA_FAILED: ${err}` });
        return;
      }
    }

    // Step 2: Inject captcha token + Omni 1.1 resolution (360p/720p)
    let finalBody = body;
    if (finalBody) {
      finalBody = JSON.parse(JSON.stringify(finalBody)); // deep clone
      if (captchaToken) {
        if (finalBody.clientContext?.recaptchaContext) {
          finalBody.clientContext.recaptchaContext.token = captchaToken;
        }
        if (finalBody.requests && Array.isArray(finalBody.requests)) {
          for (const req of finalBody.requests) {
            if (req.clientContext?.recaptchaContext) {
              req.clientContext.recaptchaContext.token = captchaToken;
            }
          }
        }
      }
      const capturedRes = lastFlowGenerate?.videoResolution || lastFlowGenerate?.resolutionLabel;
      injectOmniResolution(finalBody, capturedRes || OMNI_DEFAULT_RESOLUTION);
      const sent = extractGenerateOptions(finalBody, url);
      if (sent) rememberFlowGenerate(sent);
    }

    // Step 3: Use flowKey for auth
    const activeFlowKey = flowKey;
    if (!activeFlowKey) {
      sendToAgent({ id, status: 503, error: 'NO_FLOW_KEY' });
      if (hasCaptcha) { metrics.failedCount++; metrics.lastError = 'NO_FLOW_KEY'; }
      chrome.storage.local.set({ metrics });
      updateRequestLog(logId, { status: 'failed', error: 'NO_FLOW_KEY' });
      return;
    }

    const fetchHeaders = { ...(headers || {}) };
    fetchHeaders['authorization'] = `Bearer ${activeFlowKey}`;

    // Step 4: Make the API call from browser context
    const response = await fetch(url, {
      method: method || 'POST',
      headers: fetchHeaders,
      credentials: 'include',
      body: method === 'GET' ? undefined : JSON.stringify(finalBody),
    });

    let responseData;
    const responseText = await response.text();
    try {
      responseData = JSON.parse(responseText);
    } catch {
      responseData = responseText;
    }

    sendToAgent({
      id,
      status: response.status,
      data: responseData,
    });

    const responseSummary = responseText ? responseText.slice(0, 300) : null;
    const ids = generateIdsFromPayload(responseData);
    if (response.ok) {
      if (_ASYNC_SUBMIT_TYPES.has(logType)) {
        const terminal = opsTerminalStatus(responseData);
        const asyncMeta = { httpStatus: response.status, responseSummary, opNames: ids.names, mediaIds: ids.mediaIds };
        if (terminal === 'success') {
          if (hasCaptcha) { metrics.successCount++; metrics.lastError = null; }
          updateRequestLog(logId, { status: 'success', ...asyncMeta });
        } else if (terminal === 'failed') {
          if (hasCaptcha) { metrics.failedCount++; metrics.lastError = 'VIDEO_FAILED'; }
          updateRequestLog(logId, { status: 'failed', error: 'VIDEO_FAILED', ...asyncMeta });
        } else {
          // 200 = accepted / still rendering. Do not badge as done.
          updateRequestLog(logId, { status: 'processing', ...asyncMeta });
        }
      } else if (logType === 'POLL') {
        const terminal = opsTerminalStatus(responseData);
        const fromBody = generateIdsFromPayload(body);
        const names = ids.names.length ? ids.names : fromBody.names;
        const mediaIds = ids.mediaIds.length ? ids.mediaIds : fromBody.mediaIds;
        if (terminal === 'success') {
          _markAsyncJobs(names, { status: 'success' }, mediaIds);
        } else if (terminal === 'failed') {
          _markAsyncJobs(names, { status: 'failed', error: 'VIDEO_FAILED' }, mediaIds);
        }
      } else {
        if (hasCaptcha) { metrics.successCount++; metrics.lastError = null; }
        updateRequestLog(logId, { status: 'success', httpStatus: response.status, responseSummary });
      }
    } else {
      if (hasCaptcha) { metrics.failedCount++; metrics.lastError = `API_${response.status}`; }
      updateRequestLog(logId, { status: 'failed', error: `API_${response.status}`, httpStatus: response.status, responseSummary });
      if (_ASYNC_SUBMIT_TYPES.has(logType)) {
        updateRequestLog(logId, { opNames: ids.names, mediaIds: ids.mediaIds });
      }
    }
  } catch (e) {
    sendToAgent({
      id,
      status: 500,
      error: e.message || 'API_REQUEST_FAILED',
    });
    if (hasCaptcha) { metrics.failedCount++; metrics.lastError = e.message; }
    updateRequestLog(logId, { status: 'failed', error: e.message || 'API_REQUEST_FAILED' });
  }

  chrome.storage.local.set({ metrics });
}

// ─── State & Popup ──────────────────────────────────────────

function setState(newState) {
  state = newState;
  const badges = { idle: '●', running: '▶', off: '○' };
  const colors = { idle: '#22c55e', running: '#f59e0b', off: '#6b7280' };
  chrome.action.setBadgeText({ text: badges[state] || '' });
  chrome.action.setBadgeBackgroundColor({ color: colors[state] || '#000' });
  broadcastStatus();
}

function broadcastStatus() {
  chrome.runtime.sendMessage({ type: 'STATUS_PUSH' }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, _, reply) => {
  if (msg.type === 'STATUS') {
    reply({
      connected: ws?.readyState === WebSocket.OPEN,
      agentConnected: ws?.readyState === WebSocket.OPEN,
      flowKeyPresent: !!flowKey,
      manualDisconnect,
      tokenAge: metrics.tokenCapturedAt ? Date.now() - metrics.tokenCapturedAt : null,
      metrics: {
        requestCount: metrics.requestCount,
        successCount: metrics.successCount,
        failedCount: metrics.failedCount,
        lastError: metrics.lastError,
      },
      state,
      flowGenerate: lastFlowGenerate,
    });
  }

  if (msg.type === 'DISCONNECT') {
    manualDisconnectRevision++;
    manualDisconnect = true;
    chrome.storage.local.set({ manualDisconnect });
    if (ws) ws.close();
    reply({ ok: true });
    return true;
  }

  if (msg.type === 'RECONNECT') {
    manualDisconnectRevision++;
    manualDisconnect = false;
    chrome.storage.local.set({ manualDisconnect });
    connectToAgent();
    reply({ ok: true });
    return true;
  }

  if (msg.type === 'REQUEST_LOG') {
    reply({ log: requestLog });
    return true;
  }

  if (msg.type === 'OPEN_FLOW_TAB') {
    chrome.tabs.query({
      url: FLOW_TAB_URLS,
    }).then((tabs) => {
      if (tabs.length) {
        chrome.tabs.update(tabs[0].id, { active: true });
        reply({ ok: true, tabId: tabs[0].id });
      } else {
        chrome.tabs.create({ url: FLOW_HOME_URL })
          .then((tab) => reply({ ok: true, tabId: tab.id }))
          .catch((e) => reply({ error: e.message }));
      }
    }).catch((e) => reply({ error: e.message }));
    return true;
  }

  if (msg.type === 'REFRESH_TOKEN') {
    captureTokenFromFlowTab()
      .then(() => reply({ ok: true }))
      .catch((e) => reply({ error: e.message }));
    return true;
  }

  if (msg.type === 'TEST_CAPTCHA') {
    solveCaptcha(`test-${Date.now()}`, msg.pageAction || 'IMAGE_GENERATION')
      .then((r) => reply(r))
      .catch((e) => reply({ error: e.message }));
    return true;
  }

  if (msg.type === 'TRPC_MEDIA_URLS') {
    handleTrpcMediaUrls(msg.trpcUrl, msg.body);
    reply({ ok: true });
    return true;
  }

  if (msg.type === 'FLOW_GENERATE_CAPTURE') {
    const opts = msg.options || extractGenerateOptions(msg.body, msg.url);
    if (opts && msg.body && typeof msg.body === 'object') {
      const first = Array.isArray(msg.body.requests) ? (msg.body.requests[0] || {}) : {};
      const parts = first?.textInput?.structuredPrompt?.parts
        || first?.structuredPrompt?.parts
        || [];
      opts.bodyKeys = Object.keys(msg.body);
      opts.requestKeys = Object.keys(first);
      opts.parts = parts.map((p) => {
        if (!p || typeof p !== 'object') return p;
        const copy = {};
        for (const [k, v] of Object.entries(p)) {
          copy[k] = (typeof v === 'string' && /bytes$/i.test(k))
            ? `<${k} ${v.length} chars>`
            : v;
        }
        return copy;
      });
    }
    if (opts) rememberFlowGenerate(opts);
    reply({ ok: true });
    return true;
  }

  return true;
});

// ─── TRPC Media URL Extractor ──────────────────────────────

function handleTrpcMediaUrls(trpcUrl, bodyText) {
  try {
    try {
      _applyProjectSnapshotToLog(JSON.parse(bodyText));
    } catch {
      /* body is not always JSON */
    }
    // Extract all fresh GCS signed URLs
    const urlRegex = /https:\/\/storage\.googleapis\.com\/ai-sandbox-videofx\/(?:image|video)\/[0-9a-f-]{36}\?[^"'\s]+/g;
    const matches = bodyText.match(urlRegex) || [];
    if (!matches.length) return;

    // Deduplicate and parse
    const urlMap = {};
    for (const rawUrl of matches) {
      // Unescape JSON-escaped URLs
      const url = rawUrl.replace(/\\u0026/g, '&').replace(/\\/g, '');
      const mediaMatch = url.match(/\/(image|video)\/([0-9a-f-]{36})\?/);
      if (mediaMatch) {
        const [, mediaType, mediaId] = mediaMatch;
        // Keep last occurrence (freshest)
        urlMap[mediaId] = { mediaType, url, mediaId };
      }
    }

    const entries = Object.values(urlMap);
    if (!entries.length) return;

    console.log(`[FlowAgent] Captured ${entries.length} fresh media URLs from TRPC`);
    // URL refresh is silent — don't show in request log

    // Forward to agent for DB update
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'media_urls_refresh',
        urls: entries,
      }));
    }
  } catch (e) {
    console.error('[FlowAgent] Failed to extract TRPC media URLs:', e);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Human-like Telemetry ──────────────────────────────────
// Periodically send tracking events to Google's analytics endpoints
// to mimic normal browser behavior.

const _UA = navigator.userAgent;
let _telemetrySessionId = `;${Date.now()}`;

function _rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function _buildBatchLogPayload() {
  const events = [];
  const types = ['FLOW_IMAGE_LATENCY', 'FLOW_VIDEO_LATENCY'];
  const count = _rand(1, 3);
  for (let i = 0; i < count; i++) {
    events.push({
      event: types[_rand(0, types.length - 1)],
      eventProperties: [
        { key: 'CURRENT_TIME_MS', doubleValue: Date.now() },
        { key: 'DURATION_MS', doubleValue: _rand(150, 800) },
        { key: 'USER_AGENT', stringValue: _UA },
        { key: 'IS_DESKTOP', booleanValue: true },
      ],
      eventMetadata: { sessionId: _telemetrySessionId },
      eventTime: new Date().toISOString(),
    });
  }
  return { appEvents: events };
}

function _buildFrontendEventsPayload() {
  const eventTypes = [
    'FLOW_IMAGE_LATENCY', 'FLOW_VIDEO_LATENCY', 'GRID_SCROLL_DEPTH',
    'FLOW_PROJECT_OPEN', 'FLOW_SCENE_VIEW',
  ];
  const count = _rand(1, 4);
  const events = [];
  for (let i = 0; i < count; i++) {
    const et = eventTypes[_rand(0, eventTypes.length - 1)];
    const params = {
      USER_AGENT: { '@type': 'type.googleapis.com/google.protobuf.StringValue', value: _UA },
      IS_DESKTOP: { '@type': 'type.googleapis.com/google.protobuf.StringValue', value: 'true' },
    };
    if (et.includes('LATENCY')) {
      params.CURRENT_TIME_MS = { '@type': 'type.googleapis.com/google.protobuf.StringValue', value: String(Date.now()) };
      params.DURATION_MS = { '@type': 'type.googleapis.com/google.protobuf.StringValue', value: String(_rand(100, 600)) };
    }
    if (et === 'GRID_SCROLL_DEPTH') {
      params.MEDIA_GENERATION_PAYGATE_TIER = { '@type': 'type.googleapis.com/google.protobuf.StringValue', value: 'PAYGATE_TIER_TWO' };
    }
    events.push({
      eventType: et,
      metadata: {
        sessionId: _telemetrySessionId,
        createTime: new Date().toISOString(),
        additionalParams: params,
      },
    });
  }
  return { events };
}

async function sendTelemetry() {
  if (!flowKey || state === 'off') return;

  const headers = {
    'Content-Type': 'text/plain;charset=UTF-8',
    'authorization': `Bearer ${flowKey}`,
  };

  // Telemetry is silent — don't show in request log
  try {
    if (Math.random() < 0.5) {
      await fetch(`https://aisandbox-pa.googleapis.com/v1:batchLog`, {
        method: 'POST', headers, credentials: 'include',
        body: JSON.stringify(_buildBatchLogPayload()),
      });
    } else {
      await fetch(`https://aisandbox-pa.googleapis.com/v1/flow:batchLogFrontendEvents`, {
        method: 'POST', headers, credentials: 'include',
        body: JSON.stringify(_buildFrontendEventsPayload()),
      });
    }
  } catch {}
}

// Send telemetry at random intervals (45-120s) to look organic
function scheduleTelemetry() {
  const delay = _rand(45, 120) * 1000;
  setTimeout(async () => {
    await sendTelemetry();
    scheduleTelemetry(); // reschedule with new random interval
  }, delay);
}

// Refresh session ID every ~30min like a real user
setInterval(() => { _telemetrySessionId = `;${Date.now()}`; }, _rand(25, 35) * 60 * 1000);

scheduleTelemetry();

console.log('[FlowAgent] Extension loaded');
