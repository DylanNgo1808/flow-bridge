/**
 * Regression test for MV3 service-worker survival.
 *
 * Chrome terminates an MV3 worker after 30s idle, and separately when a fetch()
 * transfers no bytes for 30s (crbug.com/40283184). An alarm cannot prevent
 * either — it only revives a worker that already died, taking the in-flight
 * request with it. The worker must pulse a chrome.* API for as long as a
 * request is actually running.
 *
 * Also covers the token-refresh alarm lifecycle: the Flow key expires on
 * Google's clock, so refreshing it must not be tied to the agent connection.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const extensionDir = path.join(__dirname, '..', 'extension');
const source = fs.readFileSync(path.join(extensionDir, 'background.js'), 'utf8');

const lifecycleListeners = { alarm: [], installed: [], startup: [], message: [] };
const alarms = new Map();
const sockets = [];
const platformInfoCalls = [];
let intervalSeq = 0;
let timeoutSeq = 0;
const timeouts = new Map();
const intervals = new Map();

// Fire the pending idle-linger timer (IDLE_LINGER_MS = 15000).
function fireLinger() {
  const pending = [...timeouts.entries()].filter(([, t]) => t.ms === 15000);
  assert.equal(pending.length, 1, `expected exactly one pending idle linger, got ${pending.length}`);
  const [id, timer] = pending[0];
  timeouts.delete(id);
  timer.fn();
}
let tabsCreated = 0;
const stored = { flowKey: 'persisted-flow-key' };
let queryTabs = async () => [];

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.messages = [];
    sockets.push(this);
  }
  close() { this.readyState = 3; if (this.onclose) this.onclose(); }
  send(message) { this.messages.push(JSON.parse(message)); }
}

function event(bucket) {
  return { addListener(listener) { if (bucket) bucket.push(listener); } };
}

// Never resolves — stands in for a Flow call that has sent no bytes yet.
let releasePendingFetch;
const pendingFetch = new Promise((resolve) => { releasePendingFetch = resolve; });
let releaseSecondFetch;
const secondFetch = new Promise((resolve) => { releaseSecondFetch = resolve; });
let flowFetchCount = 0;

const IDLE_BADGE = '\u25cf';
const RUNNING_BADGE = '\u25b6';
const badgeWrites = [];
const chrome = {
  action: { setBadgeBackgroundColor() {}, setBadgeText({ text }) { badgeWrites.push(text); } },
  sidePanel: { setPanelBehavior: async () => {} },
  alarms: {
    async get(name) { return alarms.get(name); },
    clear(name) { alarms.delete(name); },
    create(name, opts) { alarms.set(name, opts); },
    onAlarm: event(lifecycleListeners.alarm),
  },
  runtime: {
    lastError: null,
    getPlatformInfo(cb) { platformInfoCalls.push(Date.now()); if (cb) cb({ os: 'mac' }); },
    onInstalled: event(lifecycleListeners.installed),
    onMessage: event(lifecycleListeners.message),
    onStartup: event(lifecycleListeners.startup),
    sendMessage: async () => {},
  },
  scripting: { executeScript: async () => {} },
  storage: { local: { async get() { return { ...stored }; }, async set(data) { Object.assign(stored, data); } } },
  tabs: {
    create: async () => { tabsCreated += 1; return {}; },
    query: (...args) => queryTabs(...args),
    sendMessage: async () => {},
    update: async () => {},
  },
  webRequest: { onBeforeSendHeaders: event(), onBeforeRequest: event() },
};

function startWorker() {
const context = vm.createContext({
  URL,
  WebSocket: FakeWebSocket,
  chrome,
  importScripts(...files) {
    for (const file of files) {
      vm.runInContext(fs.readFileSync(path.join(extensionDir, file), 'utf8'), context, { filename: file });
    }
  },
  clearInterval(id) { intervals.delete(id); },
  clearTimeout(id) { timeouts.delete(id); },
  console: { log() {}, warn() {}, error() {} },
  fetch: async (url) => {
    // The agent callback must still work; only the Flow call hangs.
    if (String(url).includes('127.0.0.1')) return { ok: true, status: 200 };
    flowFetchCount += 1;
    await (flowFetchCount === 1 ? pendingFetch : secondFetch);
    return { ok: true, status: 200, text: async () => '{}', headers: { get: () => null } };
  },
  navigator: { userAgent: 'FlowkitKeepAliveTest/1.0' },
  setInterval(fn, ms) { intervals.set(++intervalSeq, { fn, ms }); return intervalSeq; },
  setTimeout(fn, ms) { timeouts.set(++timeoutSeq, { fn, ms }); return timeoutSeq; },
});


vm.runInContext(source, context, { filename: 'background.js' });
return context;
}

const context = startWorker();

setImmediate(async () => {
  await Promise.resolve();
  await Promise.resolve();

  // ── token-refresh alarm lifecycle ────────────────────────────────────────
  assert.ok(alarms.has('token-refresh'),
    'token refresh must be armed at worker init, not only once the agent connects');

  const socket = sockets[0];
  socket.readyState = FakeWebSocket.OPEN;
  socket.onopen();
  const periodAfterConnect = alarms.get('token-refresh').periodInMinutes;

  socket.readyState = 3;
  socket.onclose();
  assert.ok(alarms.has('token-refresh'),
    'losing the agent must not disarm token refresh — the key expires regardless');

  socket.onopen();
  assert.equal(alarms.get('token-refresh').periodInMinutes, periodAfterConnect,
    'a reconnect must not restart the refresh period, or a flapping agent starves it');

  // ── keep-alive pulse around a long request ───────────────────────────────
  const intervalsBefore = intervals.size;
  badgeWrites.length = 0;
  const inflight = socket.onmessage({
    data: JSON.stringify({
      id: 'req-1',
      method: 'api_request',
      params: { url: 'https://aisandbox-pa.googleapis.com/v1/video:x', method: 'POST', body: {} },
    }),
  });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(intervals.size, intervalsBefore + 1,
    'a request in flight must start a keep-alive pulse');
  const pulse = [...intervals.values()].at(-1);
  assert.ok(pulse.ms < 30000,
    `pulse must fire inside the 30s idle window, got ${pulse.ms}ms`);

  const callsBefore = platformInfoCalls.length;
  pulse.fn();
  assert.equal(platformInfoCalls.length, callsBefore + 1,
    'the pulse must call a chrome.* API — that is what resets the idle timer');

  // A second request overlaps the first — MAX_CONCURRENT_REQUESTS is 5, so this
  // is the normal case, not an edge case.
  const second = socket.onmessage({
    data: JSON.stringify({
      id: 'req-2',
      method: 'api_request',
      params: { url: 'https://aisandbox-pa.googleapis.com/v1/video:y', method: 'POST', body: {} },
    }),
  });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(intervals.size, intervalsBefore + 1,
    'a second concurrent request must share the one pulse, not start another');
  assert.deepEqual(badgeWrites, [RUNNING_BADGE],
    `each concurrent request must not rewrite the badge — every write broadcasts a
     STATUS_PUSH that makes the side panel refetch; saw ${JSON.stringify(badgeWrites)}`);

  badgeWrites.length = 0;
  releasePendingFetch();
  await inflight;

  assert.ok(!badgeWrites.includes(IDLE_BADGE),
    `finishing one of two concurrent requests must not report idle; saw ${JSON.stringify(badgeWrites)}`);
  assert.equal(intervals.size, intervalsBefore + 1,
    'the pulse must survive while the second request is still running');

  releaseSecondFetch();
  await second;

  assert.ok(!badgeWrites.includes(IDLE_BADGE),
    'a poll gap shorter than the linger must not report idle — that is the flicker');

  fireLinger();
  assert.ok(badgeWrites.includes(IDLE_BADGE),
    'the badge must reach idle once the linger elapses with no new work');
  assert.equal(intervals.size, intervalsBefore,
    'the pulse must stop once the last request finishes, not leak');

  // Restarts must preserve the exact alarm, including its scheduled deadline.
  const originalAlarm = alarms.get('token-refresh');
  assert.equal(originalAlarm.periodInMinutes, 45);
  const restarted = startWorker();
  await vm.runInContext('ensureInitialized()', restarted);
  assert.strictEqual(alarms.get('token-refresh'), originalAlarm);

  // Disconnect during tabs.query must prevent the subsequent tab creation.
  let releaseQuery;
  queryTabs = () => new Promise(resolve => { releaseQuery = resolve; });
  const capture = vm.runInContext('captureTokenFromFlowTab()', restarted);
  lifecycleListeners.message.at(-1)({ type: 'DISCONNECT' }, {}, () => {});
  assert.equal(stored.manualDisconnect, true);
  releaseQuery([]);
  await capture;
  assert.equal(tabsCreated, 0);

  // A fresh worker must restore the preference before attempting a connection.
  queryTabs = async () => [];
  const socketsBeforeRestart = sockets.length;
  const disconnectedWorker = startWorker();
  await vm.runInContext('ensureInitialized()', disconnectedWorker);
  assert.equal(sockets.length, socketsBeforeRestart);
  await lifecycleListeners.alarm.at(-1)({ name: 'token-refresh' });
  assert.equal(tabsCreated, 0);
  assert.strictEqual(alarms.get('token-refresh'), originalAlarm);

  lifecycleListeners.message.at(-1)({ type: 'RECONNECT' }, {}, () => {});
  assert.equal(stored.manualDisconnect, false);
  assert.equal(sockets.length, socketsBeforeRestart + 1);
  const reconnectedWorker = startWorker();
  await vm.runInContext('ensureInitialized()', reconnectedWorker);
  assert.equal(sockets.length, socketsBeforeRestart + 2);

  // User actions during a pending startup read must beat its stale snapshot.
  const originalGet = chrome.storage.local.get;
  for (const [snapshot, action, expected] of [
    [undefined, 'DISCONNECT', true],
    [false, 'DISCONNECT', true],
    [true, 'RECONNECT', false],
  ]) {
    stored.manualDisconnect = snapshot;
    let releaseRead;
    chrome.storage.local.get = () => new Promise(resolve => {
      const data = { ...stored };
      releaseRead = () => resolve(data);
    });
    const socketsBefore = sockets.length;
    const startingWorker = startWorker();
    let response;
    lifecycleListeners.message.at(-1)({ type: action }, {}, value => { response = value; });
    assert.equal(response.ok, true);
    assert.equal(stored.manualDisconnect, expected);
    releaseRead();
    await vm.runInContext('ensureInitialized()', startingWorker);
    assert.equal(vm.runInContext('manualDisconnect', startingWorker), expected,
      `${action} must survive the stale startup snapshot`);
    assert.equal(sockets.length, socketsBefore + (expected ? 0 : 1));
    if (expected) {
      await lifecycleListeners.alarm.at(-1)({ name: 'token-refresh' });
      assert.equal(tabsCreated, 0);
    }
  }
  chrome.storage.local.get = originalGet;

  console.log('Flow Bridge MV3 keep-alive + token-refresh lifecycle test passed');
});
