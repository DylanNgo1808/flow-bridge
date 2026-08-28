const assert = require('node:assert/strict');
const path = require('node:path');

const {
  isOmniModelKey,
  normalizeVideoResolution,
  injectOmniResolution,
  extractGenerateOptions,
  summarizeGenerateBody,
  OMNI_DEFAULT_RESOLUTION,
} = require(path.join(__dirname, '..', 'extension', 'flow_payload.js'));

assert.equal(isOmniModelKey('abra_i2v_8s'), true);
assert.equal(isOmniModelKey('veo_3_1_i2v_lite'), false);
assert.equal(normalizeVideoResolution('360p'), 'VIDEO_RESOLUTION_360P');
assert.equal(normalizeVideoResolution('VIDEO_RESOLUTION_720P'), 'VIDEO_RESOLUTION_720P');
assert.equal(OMNI_DEFAULT_RESOLUTION, 'VIDEO_RESOLUTION_360P');

const injected = injectOmniResolution({
  requests: [{ videoModelKey: 'abra_i2v_8s', aspectRatio: 'VIDEO_ASPECT_RATIO_LANDSCAPE' }],
});
assert.equal(injected.requests[0].resolution, undefined);
assert.equal(injected.requests[0].videoResolution, undefined);

const alreadySet = injectOmniResolution({
  requests: [{ videoModelKey: 'abra_i2v_8s', videoResolution: 'VIDEO_RESOLUTION_720P' }],
});
assert.equal(alreadySet.requests[0].videoResolution, 'VIDEO_RESOLUTION_720P');

const veo = injectOmniResolution({
  requests: [{ videoModelKey: 'veo_3_1_i2v_lite' }],
});
assert.equal(veo.requests[0].videoResolution, undefined);

const opts = extractGenerateOptions({
  requests: [
    {
      videoModelKey: 'abra_i2v_8s',
      videoResolution: 'VIDEO_RESOLUTION_360P',
      aspectRatio: 'VIDEO_ASPECT_RATIO_LANDSCAPE',
    },
  ],
});
assert.equal(opts.modelLabel, 'Omni 1.1 Flash');
assert.equal(opts.resolutionLabel, '360p');
assert.equal(opts.durationS, 8);
assert.equal(opts.count, 1);
assert.equal(
  summarizeGenerateBody({
    requests: [
      { videoModelKey: 'abra_i2v_8s', videoResolution: 'VIDEO_RESOLUTION_360P' },
      { videoModelKey: 'abra_i2v_8s', videoResolution: 'VIDEO_RESOLUTION_360P' },
    ],
  }),
  'Omni 1.1 Flash · 360p · 8s · x2',
);

const fromSuffix = extractGenerateOptions({
  requests: [{
    videoModelKey: 'abra_r2v_6s_360p',
    aspectRatio: 'VIDEO_ASPECT_RATIO_PORTRAIT',
    referenceLikenesses: [{ likenessId: 'f53ba86c-dbc2-2a85-0000-000000000000' }],
  }],
});
assert.equal(fromSuffix.resolutionLabel, '360p');
assert.equal(fromSuffix.durationS, 6);
assert.deepEqual(fromSuffix.likenessHints, ['referenceLikenesses']);

const sevenTwenty = extractGenerateOptions({
  requests: [{ videoModelKey: 'abra_r2v_6s' }],
});
assert.equal(sevenTwenty.resolutionLabel, null);
assert.equal(sevenTwenty.durationS, 6);

console.log('Flow payload Omni 1.1 helpers passed');
