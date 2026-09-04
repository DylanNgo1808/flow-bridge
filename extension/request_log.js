/**
 * Request-log helpers — shared by the service worker and tests.
 *
 * Omni / workflow-backed jobs complete via flow.projectInitialData, not the
 * legacy batchCheckAsync operations poller. These helpers extract ids from
 * generate responses and terminal statuses from project snapshots.
 */
(function (root) {
  function unwrapDataRoot(payload) {
    if (!payload || typeof payload !== 'object') return {};
    if (payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)) {
      return payload.data;
    }
    return payload;
  }

  function pushUnique(arr, value) {
    if (typeof value === 'string' && value && !arr.includes(value)) arr.push(value);
  }

  function generateIdsFromPayload(payload) {
    const root = unwrapDataRoot(payload);
    const names = [];
    const mediaIds = [];

    for (const op of root.operations || []) {
      pushUnique(names, op?.operation?.name);
      pushUnique(mediaIds, op?.operation?.metadata?.video?.mediaId);
      pushUnique(mediaIds, op?.operation?.metadata?.primaryMediaId);
      pushUnique(mediaIds, op?._primary_media_id);
    }
    for (const wf of root.workflows || []) {
      pushUnique(names, wf?.name);
      pushUnique(mediaIds, wf?.metadata?.primaryMediaId);
      pushUnique(mediaIds, wf?.primaryMediaId);
      pushUnique(mediaIds, wf?.primary_media_id);
    }
    for (const media of root.media || []) {
      pushUnique(mediaIds, media?.name);
      pushUnique(names, media?.workflowId);
    }
    return { names, mediaIds };
  }

  function classifyGenerationStatus(status) {
    if (typeof status !== 'string' || !status) return 'processing';
    if (status === 'MEDIA_GENERATION_STATUS_SUCCESSFUL') return 'success';
    if (status.endsWith('FAILED') || status.endsWith('CANCELLED')) return 'failed';
    return 'processing';
  }

  function opsTerminalStatus(payload) {
    const root = unwrapDataRoot(payload);
    const ops = root.operations || [];
    if (!ops.length) return null;
    const classified = ops.map((op) => classifyGenerationStatus(op?.status));
    if (classified.every((s) => s === 'success')) return 'success';
    if (classified.some((s) => s === 'failed')) return 'failed';
    return 'processing';
  }

  function unwrapProjectContents(payload) {
    if (!payload) return null;
    if (Array.isArray(payload)) {
      for (const item of payload) {
        const found = unwrapProjectContents(item);
        if (found) return found;
      }
      return null;
    }
    if (typeof payload !== 'object') return null;
    const json =
      payload.result?.data?.json
      || payload.data?.result?.data?.json
      || payload.json
      || payload;
    if (!json || typeof json !== 'object') return null;
    if (json.projectContents && typeof json.projectContents === 'object') {
      return json.projectContents;
    }
    if (Array.isArray(json.media) || Array.isArray(json.workflows)) return json;
    return null;
  }

  function projectSnapshotTerminals(payload) {
    const contents = unwrapProjectContents(payload);
    if (!contents) return [];
    const media = Array.isArray(contents.media) ? contents.media : [];
    const workflows = Array.isArray(contents.workflows) ? contents.workflows : [];
    const wfNameByMedia = {};
    for (const wf of workflows) {
      const mid = wf?.metadata?.primaryMediaId || wf?.primaryMediaId;
      if (typeof wf?.name === 'string' && typeof mid === 'string') {
        wfNameByMedia[mid] = wf.name;
      }
    }

    const items = [];
    for (const item of media) {
      const gen = item?.mediaMetadata?.mediaStatus?.mediaGenerationStatus;
      const status = classifyGenerationStatus(gen);
      if (status === 'processing') continue;
      const names = [];
      const mediaIds = [];
      pushUnique(names, item?.workflowId);
      pushUnique(mediaIds, item?.name);
      pushUnique(names, item?.name && wfNameByMedia[item.name]);
      items.push({
        names,
        mediaIds,
        status,
        error: status === 'failed' ? (gen || 'VIDEO_FAILED') : null,
      });
    }
    return items;
  }

  function entryMatchesSnapshot(entry, item) {
    if (!entry || !item) return false;
    const nameSet = new Set(item.names || []);
    const mediaSet = new Set(item.mediaIds || []);
    if ((entry.opNames || []).some((name) => nameSet.has(name))) return true;
    if ((entry.mediaIds || []).some((id) => mediaSet.has(id))) return true;
    return false;
  }

  const api = {
    generateIdsFromPayload,
    opsTerminalStatus,
    unwrapProjectContents,
    projectSnapshotTerminals,
    classifyGenerationStatus,
    entryMatchesSnapshot,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    Object.assign(root, api);
  }
})(typeof self !== 'undefined' ? self : globalThis);
