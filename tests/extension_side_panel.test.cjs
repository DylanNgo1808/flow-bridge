const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, 'extension', 'manifest.json'), 'utf8'),
);

assert.equal(manifest.side_panel.default_path, 'ui/index.html');
assert.equal(manifest.action.default_popup, undefined);
assert.ok(manifest.permissions.includes('sidePanel'));

const htmlPath = path.join(root, 'extension', 'ui', 'index.html');
assert.ok(fs.existsSync(htmlPath), 'built side panel html must exist');
const html = fs.readFileSync(htmlPath, 'utf8');
assert.match(html, /assets\/index\.js/);
assert.match(html, /assets\/index\.css/);
assert.doesNotMatch(html, /crossorigin/);

console.log('Flow Bridge side panel manifest + build contract passed');
