/**
 * Flow generate payload helpers — shared by the service worker and tests.
 * Omni 1.1 Flash (Aug 2026) adds videoResolution (360p/720p) and 1–4 takes.
 */
(function (root) {
  const OMNI_DEFAULT_RESOLUTION = 'VIDEO_RESOLUTION_360P';

  function isOmniModelKey(key) {
    return typeof key === 'string' && key.startsWith('abra_');
  }

  function normalizeVideoResolution(value) {
    if (value == null || value === '') return null;
    const raw = String(value).trim();
    const compact = raw.toUpperCase().replace(/[\s_-]/g, '');
    if (compact === 'VIDEORESOLUTION360P' || compact === '360P') return 'VIDEO_RESOLUTION_360P';
    if (compact === 'VIDEORESOLUTION720P' || compact === '720P') return 'VIDEO_RESOLUTION_720P';
    if (compact === 'VIDEORESOLUTION1080P' || compact === '1080P') return 'VIDEO_RESOLUTION_1080P';
    if (compact === 'VIDEORESOLUTION4K' || compact === '4K' || compact === '2160P') {
      return 'VIDEO_RESOLUTION_4K';
    }
    if (raw.startsWith('VIDEO_RESOLUTION_')) return raw;
    return null;
  }

  function resolutionLabel(value) {
    const n = normalizeVideoResolution(value);
    if (n === 'VIDEO_RESOLUTION_360P') return '360p';
    if (n === 'VIDEO_RESOLUTION_720P') return '720p';
    if (n === 'VIDEO_RESOLUTION_1080P') return '1080p';
    if (n === 'VIDEO_RESOLUTION_4K') return '4K';
    return null;
  }

  function labelVideoModel(key) {
    if (!key) return null;
    if (key.startsWith('abra_')) return 'Omni 1.1 Flash';
    if (key.includes('lite_low_priority')) return 'Veo 3.1 Lite Low Priority';
    if (key.includes('lite')) return 'Veo 3.1 Lite';
    if (key.includes('ultra_relaxed')) return 'Veo 3.1 Low Priority';
    if (key.includes('ultra')) return 'Veo 3.1 Fast Ultra';
    if (key.includes('veo_3_1')) return 'Veo 3.1';
    if (key.includes('veo_3_0')) return 'Veo 3.0';
    return key;
  }

  function durationFromModelKey(key) {
    if (typeof key !== 'string') return null;
    const m = key.match(/_(\d+)s(?:_|$)/);
    return m ? Number(m[1]) : null;
  }

  function resolutionFromModelKey(key) {
    // Live Flow encodes 360p as a suffix on videoModelKey (abra_r2v_6s_360p).
    // 720p is the unsuffixed key. outputSpec / videoResolution 400 on generate.
    if (typeof key !== 'string') return null;
    if (key.endsWith('_360p')) return 'VIDEO_RESOLUTION_360P';
    return null;
  }

  function requestResolution(req) {
    if (!req || typeof req !== 'object') return null;
    return req.videoResolution || req.resolution || resolutionFromModelKey(req.videoModelKey) || null;
  }

  function extractGenerateOptions(body, url) {
    if (!body || typeof body !== 'object') return null;
    const reqs = Array.isArray(body.requests) ? body.requests : [];
    const first = reqs[0] && typeof reqs[0] === 'object' ? reqs[0] : {};
    const videoModelKey = first.videoModelKey || '';
    if (!videoModelKey && !url) return null;
    const videoResolution = requestResolution(first)
      || body.videoResolution
      || body.resolution
      || null;
    const parts = first?.textInput?.structuredPrompt?.parts
      || first?.structuredPrompt?.parts
      || [];
    const partKinds = Array.isArray(parts)
      ? parts.map((p) => (p && typeof p === 'object' ? Object.keys(p) : []))
      : [];
    const requestKeys = Object.keys(first);
    const likenessHints = requestKeys.filter((k) => /likeness|mention|chip|avatar|audio/i.test(k));
    return {
      url: url || null,
      videoModelKey,
      modelLabel: labelVideoModel(videoModelKey),
      videoResolution,
      resolutionLabel: resolutionLabel(videoResolution),
      aspectRatio: first.aspectRatio || null,
      durationS: durationFromModelKey(videoModelKey),
      count: reqs.length || 1,
      requestKeys,
      partKinds,
      likenessHints,
      capturedAt: Date.now(),
    };
  }

  function injectOmniResolution(body, fallback) {
    // Flow rejects unknown request fields (`videoResolution`, `resolution`).
    // Capture 360p/720p from the live Flow UI; do not invent wire keys.
    return body;
  }

  function summarizeGenerateBody(body) {
    const opts = extractGenerateOptions(body);
    if (!opts) return null;
    const bits = [];
    if (opts.modelLabel) bits.push(opts.modelLabel);
    if (opts.resolutionLabel) bits.push(opts.resolutionLabel);
    if (opts.durationS) bits.push(`${opts.durationS}s`);
    if (opts.count > 1) bits.push(`x${opts.count}`);
    else if (opts.videoModelKey) bits.push(opts.videoModelKey);
    return bits.join(' · ') || null;
  }

  const api = {
    OMNI_DEFAULT_RESOLUTION,
    isOmniModelKey,
    normalizeVideoResolution,
    resolutionLabel,
    labelVideoModel,
    durationFromModelKey,
    resolutionFromModelKey,
    extractGenerateOptions,
    injectOmniResolution,
    summarizeGenerateBody,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    Object.assign(root, api);
  }
})(typeof self !== 'undefined' ? self : globalThis);
