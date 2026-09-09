/**
 * Injected into MAIN world on Flow pages — has access to window.grecaptcha.
 * Also intercepts TRPC fetch responses for media URLs and project snapshots.
 */
const SITE_KEY = '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV';

// ─── TRPC Response Monitor ─────────────────────────────────
// Monkey-patch fetch to intercept TRPC responses containing media URLs.
// Fresh signed GCS URLs are extracted and forwarded to the agent.

const _originalFetch = window.fetch;
window.fetch = async function (...args) {
  const response = await _originalFetch.apply(this, args);
  try {
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
    // Only intercept TRPC calls on labs.google that return project/flow data
    const isTrpc = url.includes('/fx/api/trpc/') || url.includes('/api/trpc/');
    if (isTrpc && response.ok) {
      const clone = response.clone();
      clone.text().then(text => {
        const isProject = url.includes('projectInitialData') || url.includes('flow.project');
        const hasMedia = text.includes('storage.googleapis.com/ai-sandbox-videofx/')
          || text.includes('mediaGenerationStatus');
        if (isProject || hasMedia) {
          window.dispatchEvent(new CustomEvent('TRPC_MEDIA_URLS', {
            detail: { url, body: text },
          }));
        }
      }).catch(() => {});
    }
    if (url.includes('aisandbox-pa.googleapis.com') && (
      url.includes('batchAsyncGenerateVideo') || url.includes('batchGenerateImages')
    )) {
      try {
        const init = args[1] || {};
        const raw = init.body;
        if (typeof raw === 'string' && raw.includes('videoModelKey')) {
          window.dispatchEvent(new CustomEvent('FLOW_GENERATE_CAPTURE', {
            detail: { url, body: raw },
          }));
        }
      } catch {}
    }
  } catch {}
  return response;
};


window.addEventListener('GET_CAPTCHA', async ({ detail }) => {
  const { requestId, pageAction } = detail;
  try {
    await waitForGrecaptcha();
    const token = await window.grecaptcha.enterprise.execute(SITE_KEY, {
      action: pageAction,
    });
    window.dispatchEvent(new CustomEvent('CAPTCHA_RESULT', {
      detail: { requestId, token },
    }));
  } catch (e) {
    window.dispatchEvent(new CustomEvent('CAPTCHA_RESULT', {
      detail: { requestId, error: e.message },
    }));
  }
});

// 20s, not 10s: a backgrounded Flow tab has its timers throttled, so both this
// poll and the page's own lazy load of grecaptcha stretch out. Must stay under
// content.js's CONTENT_TIMEOUT (25s), which is itself under background.js's
// CAPTCHA_TIMEOUT (30s) — the innermost wait has to lose the race, or the outer
// timeouts mask the real reason with a generic timeout.
function waitForGrecaptcha(timeout = 20000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (window.grecaptcha?.enterprise?.execute) return resolve();
      if (Date.now() - start > timeout) return reject(new Error('grecaptcha not available'));
      setTimeout(check, 200);
    };
    check();
  });
}
