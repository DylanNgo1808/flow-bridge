/**
 * Chrome discards backgrounded tabs to reclaim memory. A discarded tab still
 * appears in chrome.tabs.query, but cross-context calls into it — sendMessage,
 * executeScript — fail. Both paths that reach into the Flow tab run against a
 * tab this extension opened in the background itself, so this is the normal
 * case on a long-running session, not an edge case.
 *
 * When it happens during solveCaptcha the failure surfaces as CONTENT_TIMEOUT,
 * which the worker charges to the reCAPTCHA retry budget — a dead tab looks
 * exactly like a captcha the site refused.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const extensionDir = path.join(__dirname, '..', 'extension');
const source = fs.readFileSync(path.join(extensionDir, 'background.js'), 'utf8');

const lifecycleListeners = { alarm: [], installed: [], startup: [], message: [] };
const sockets = [];
const reloaded = [];
const scripted = [];
const messagedTabs = [];
let tabState = [];
let tabsCreated = 0;
let onReload = (tab) => { tab.discarded = false; };
// Tabs whose page has finished lazy-loading window.grecaptcha.enterprise.
const grecaptchaTabs = new Set();
// Tabs whose readiness probe never answers — a page stuck loading.
const hangingProbes = new Set();
let onGet = () => {};
const flowTab = (id, discarded) => ({ id, discarded, status: 'complete', url: 'https://flow.google.com/' });

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  constructor(url) { this.url = url; this.readyState = FakeWebSocket.CONNECTING; this.messages = []; sockets.push(this); }
  send(m) { this.messages.push(JSON.parse(m)); }
}

function event(bucket) {
  return { addListener(l) { if (bucket) bucket.push(l); } };
}

const chrome = {
  action: { setBadgeBackgroundColor() {}, setBadgeText() {} },
  sidePanel: { setPanelBehavior: async () => {} },
  alarms: { clear() {}, create() {}, get: async () => null, onAlarm: event(lifecycleListeners.alarm) },
  runtime: {
    lastError: null,
    getPlatformInfo(cb) { if (cb) cb({ os: 'mac' }); },
    onInstalled: event(lifecycleListeners.installed),
    onMessage: event(lifecycleListeners.message),
    onStartup: event(lifecycleListeners.startup),
    sendMessage: async () => {},
  },
  scripting: {
    executeScript: async ({ target, world }) => {
      const tab = tabState.find(t => t.id === target.tabId);
      if (!tab || tab.discarded) throw new Error('No tab with id: ' + target.tabId);
      // A MAIN-world call is the grecaptcha readiness probe, not an injection —
      // keep it out of `scripted`, which tracks content.js injections.
      if (world === 'MAIN') {
        if (hangingProbes.has(target.tabId)) return new Promise(() => {});
        return [{ result: grecaptchaTabs.has(target.tabId) }];
      }
      scripted.push(target.tabId);
      return [{ result: null }];
    },
  },
  storage: { local: { async get() { return { flowKey: 'k' }; }, async set() {} } },
  tabs: {
    create: async () => { tabsCreated += 1; return {}; },
    query: async () => tabState,
    get: async (id) => {
      onGet(id);
      const tab = tabState.find(t => t.id === id);
      if (!tab) throw new Error('No tab with id: ' + id);
      return { ...tab };
    },
    reload: async (id) => {
      reloaded.push(id);
      const tab = tabState.find(t => t.id === id);
      if (tab) onReload(tab);
    },
    sendMessage: async (id) => {
      const tab = tabState.find(t => t.id === id);
      if (!tab || tab.discarded) throw new Error('No tab with id: ' + id);
      messagedTabs.push(id);
      return { token: 'captcha-token' };
    },
    update: async () => {},
  },
  webRequest: { onBeforeSendHeaders: event(), onBeforeRequest: event() },
};

const context = vm.createContext({
  URL,
  WebSocket: FakeWebSocket,
  chrome,
  importScripts(...files) {
    for (const f of files) vm.runInContext(fs.readFileSync(path.join(extensionDir, f), 'utf8'), context, { filename: f });
  },
  clearInterval() {}, clearTimeout(t) { clearTimeout(t); },
  console: { log() {}, warn() {}, error() {} },
  fetch: async () => ({ ok: true, status: 200 }),
  navigator: { userAgent: 'FlowkitTabReviveTest/1.0' },
  setInterval() { return 1; },
  // Collapse sleep() to near-zero but leave the long guard timeouts alone, and
  // unref them so a pending 30s captcha guard cannot hold the process open.
  setTimeout(fn, ms) {
    const long = ms >= 10000;
    const t = setTimeout(fn, long ? ms : 1);
    // Only the long guards get unref'd: a pending 30s captcha timeout must not
    // hold the process open, but a collapsed sleep() still has to fire.
    if (long && t.unref) t.unref();
    return t;
  },
});

vm.runInContext(source, context, { filename: 'background.js' });

setImmediate(async () => {
  await Promise.resolve();
  await Promise.resolve();

  // ── solveCaptcha against a discarded tab ────────────────────────────────
  tabState = [flowTab(7, true)];
  reloaded.length = 0;
  messagedTabs.length = 0;

  const result = await vm.runInContext(
    "solveCaptcha('req-1', 'VIDEO_GENERATION')", context);

  assert.deepEqual(reloaded, [7],
    'a discarded Flow tab must be reloaded before the captcha request is sent');
  assert.deepEqual(messagedTabs, [7],
    'the captcha request must reach the revived tab');
  assert.equal(result.token, 'captcha-token',
    `a discarded tab must not surface as a captcha failure; got ${JSON.stringify(result)}`);
  assert.equal(tabsCreated, 0,
    'reviving an existing tab must not also open a new one');

  // ── a live tab must not be reloaded ─────────────────────────────────────
  tabState = [flowTab(9, false)];
  reloaded.length = 0;
  messagedTabs.length = 0;
  await vm.runInContext("solveCaptcha('req-2', 'IMAGE_GENERATION')", context);
  assert.deepEqual(reloaded, [], 'a live tab must never be reloaded — that would drop page state');
  assert.deepEqual(messagedTabs, [9]);

  // ── prefer a live tab over a discarded one ──────────────────────────────
  tabState = [flowTab(11, true), flowTab(12, false)];
  reloaded.length = 0;
  messagedTabs.length = 0;
  await vm.runInContext("solveCaptcha('req-3', 'IMAGE_GENERATION')", context);
  assert.deepEqual(reloaded, [], 'with a live tab available there is nothing to revive');
  assert.deepEqual(messagedTabs, [12], 'the live tab must be preferred');

  // ── prefer the tab that actually has grecaptcha ─────────────────────────
  // "status: complete" is the document, not the captcha library: the Flow app
  // lazy-loads grecaptcha long after load, and a backgrounded tab's throttled
  // timers stretch that out. Picking the first merely-loaded tab sent captcha
  // work to a tab that could only answer "grecaptcha not available".
  tabState = [flowTab(13, false), flowTab(14, false)];
  reloaded.length = 0;
  messagedTabs.length = 0;
  grecaptchaTabs.add(14);
  await vm.runInContext("solveCaptcha('req-3b', 'IMAGE_GENERATION')", context);
  assert.deepEqual(messagedTabs, [14],
    'the tab with grecaptcha loaded must win over the merely-loaded first tab');
  grecaptchaTabs.clear();

  // With none ready, the first candidate still gets the work — injected.js does
  // the waiting, inside the captcha timeout budget.
  tabState = [flowTab(15, false), flowTab(16, false)];
  messagedTabs.length = 0;
  await vm.runInContext("solveCaptcha('req-3c', 'IMAGE_GENERATION')", context);
  assert.deepEqual(messagedTabs, [15],
    'with no ready tab, fall back to the first candidate rather than failing');

  // A candidate whose probe never answers must not hide the ready tab behind it.
  tabState = [flowTab(17, false), flowTab(18, false)];
  messagedTabs.length = 0;
  hangingProbes.add(17);
  grecaptchaTabs.add(18);
  await vm.runInContext("solveCaptcha('req-3d', 'IMAGE_GENERATION')", context);
  assert.deepEqual(messagedTabs, [18],
    'a stalled probe must time out, not block selection of a ready tab');
  hangingProbes.clear();
  grecaptchaTabs.clear();

  // ── token refresh against a discarded tab ───────────────────────────────
  tabState = [flowTab(21, true)];
  reloaded.length = 0;
  scripted.length = 0;
  await vm.runInContext('captureTokenFromFlowTab()', context);
  assert.deepEqual(reloaded, [21],
    'token refresh must revive a discarded tab before injecting the content script');
  assert.deepEqual(scripted, [21]);

  // A tab revived by reload can be discarded again before the first check.
  tabState = [flowTab(31, true)];
  reloaded.length = 0;
  messagedTabs.length = 0;
  onGet = () => { tabState[0].discarded = true; };
  const rediscarded = await vm.runInContext("solveCaptcha('req-4', 'IMAGE_GENERATION')", context);
  assert.deepEqual(reloaded, [31]);
  assert.equal(rediscarded.error, 'FLOW_TAB_DISCARDED');
  assert.deepEqual(messagedTabs, [], 'a re-discarded tab must not receive captcha work');

  // Reload need not clear discarded immediately; readiness takes several checks.
  tabState = [flowTab(41, true)];
  onReload = () => {};
  let checks = 0;
  onGet = () => {
    checks += 1;
    tabState[0].discarded = checks < 3;
    tabState[0].status = checks < 4 ? 'loading' : 'complete';
  };
  const delayed = await vm.runInContext("solveCaptcha('req-5', 'IMAGE_GENERATION')", context);
  assert.equal(checks, 4, 'wait for both undiscarded and loaded before returning');
  assert.equal(delayed.token, 'captcha-token');
  assert.deepEqual(messagedTabs, [41]);

  // A permanently discarded candidate must not hide the next usable candidate.
  tabState = [flowTab(51, true), flowTab(52, true)];
  reloaded.length = 0;
  messagedTabs.length = 0;
  onReload = (tab) => { if (tab.id === 52) tab.discarded = false; };
  onGet = () => {};
  const fallback = await vm.runInContext("solveCaptcha('req-6', 'IMAGE_GENERATION')", context);
  assert.deepEqual(reloaded, [51, 52]);
  assert.deepEqual(messagedTabs, [52]);
  assert.equal(fallback.token, 'captcha-token');

  // Closing a tab during reload must fall through to the next candidate.
  tabState = [flowTab(61, true), flowTab(62, true)];
  reloaded.length = 0;
  scripted.length = 0;
  onReload = (tab) => { tab.discarded = false; };
  onGet = (id) => { if (id === 61) tabState = tabState.filter(t => t.id !== id); };
  await vm.runInContext('captureTokenFromFlowTab()', context);
  assert.deepEqual(reloaded, [61, 62]);
  assert.deepEqual(scripted, [62], 'token refresh must skip the closed tab');

  // Navigation away during revival makes the tab unusable even after loading.
  tabState = [flowTab(71, true)];
  messagedTabs.length = 0;
  onGet = () => { tabState[0].url = 'https://labs.google/fx/tools/other'; };
  const navigated = await vm.runInContext("solveCaptcha('req-7', 'IMAGE_GENERATION')", context);
  assert.equal(navigated.error, 'FLOW_TAB_DISCARDED');
  assert.deepEqual(messagedTabs, [], 'only a Flow URL may receive captcha work');

  // An unrevivable tab must also be kept out of the token injection path.
  tabState = [flowTab(81, true)];
  scripted.length = 0;
  onReload = () => {};
  onGet = () => {};
  await vm.runInContext('captureTokenFromFlowTab()', context);
  assert.deepEqual(scripted, [], 'never inject into a still-discarded tab');

  console.log('Flow Bridge discarded-tab revival test passed');
});
