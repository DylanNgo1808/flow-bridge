const assert = require('node:assert/strict');
const path = require('node:path');

const {
  generateIdsFromPayload,
  opsTerminalStatus,
  projectSnapshotTerminals,
  entryMatchesSnapshot,
} = require(path.join(__dirname, '..', 'extension', 'request_log.js'));

const submit = {
  data: {
    operations: [
      {
        operation: { name: 'operation-looking-handle' },
        status: 'MEDIA_GENERATION_STATUS_PENDING',
      },
    ],
    workflows: [
      {
        name: 'workflow-1',
        metadata: { primaryMediaId: 'media-1' },
      },
    ],
  },
};

const ids = generateIdsFromPayload(submit);
assert.deepEqual(ids.names, ['operation-looking-handle', 'workflow-1']);
assert.deepEqual(ids.mediaIds, ['media-1']);
assert.equal(opsTerminalStatus(submit), 'processing');

const snapshot = {
  result: {
    data: {
      json: {
        projectContents: {
          workflows: [
            {
              name: 'workflow-1',
              projectId: 'project-1',
              metadata: { primaryMediaId: 'media-1' },
            },
          ],
          media: [
            {
              name: 'media-1',
              workflowId: 'workflow-1',
              mediaMetadata: {
                mediaStatus: { mediaGenerationStatus: 'MEDIA_GENERATION_STATUS_SUCCESSFUL' },
              },
            },
            {
              name: 'media-pending',
              workflowId: 'workflow-pending',
              mediaMetadata: {
                mediaStatus: { mediaGenerationStatus: 'MEDIA_GENERATION_STATUS_PENDING' },
              },
            },
          ],
        },
      },
    },
  },
};

const terminals = projectSnapshotTerminals(snapshot);
assert.equal(terminals.length, 1);
assert.equal(terminals[0].status, 'success');
assert.ok(terminals[0].names.includes('workflow-1'));
assert.ok(terminals[0].mediaIds.includes('media-1'));

const pendingEntry = {
  type: 'GEN_VID',
  status: 'processing',
  opNames: ids.names,
  mediaIds: ids.mediaIds,
};
assert.equal(entryMatchesSnapshot(pendingEntry, terminals[0]), true);
assert.equal(
  entryMatchesSnapshot({ type: 'GEN_VID', status: 'processing', opNames: ['other'] }, terminals[0]),
  false,
);

const failedSnapshot = {
  projectContents: {
    media: [
      {
        name: 'media-2',
        workflowId: 'workflow-2',
        mediaMetadata: {
          mediaStatus: { mediaGenerationStatus: 'MEDIA_GENERATION_STATUS_FAILED' },
        },
      },
    ],
  },
};
const failed = projectSnapshotTerminals(failedSnapshot);
assert.equal(failed[0].status, 'failed');
assert.equal(opsTerminalStatus({ operations: [] }), null);
assert.equal(
  opsTerminalStatus({
    operations: [{ status: 'MEDIA_GENERATION_STATUS_SUCCESSFUL' }],
  }),
  'success',
);

console.log('Extension request-log Omni snapshot helpers passed');
