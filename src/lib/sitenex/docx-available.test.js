// docx must resolve from INSIDE the project, or contracts work locally and 500 on Railway.
//
//   node --test src/lib/sitenex/docx-available.test.js
//
// `require('docx')` succeeding proves nothing about the deploy: Node walks up every parent node_modules and
// then the global prefix, so a package installed globally on a laptop satisfies the require and is simply
// absent in the container. The thing to assert is WHERE it resolved from, plus that it is declared in
// package.json — resolving today from a stale node_modules while being absent from the manifest fails the
// next clean install.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '../../..');

test('docx resolves from inside the project, not from a global install', () => {
  let resolved;
  try { resolved = require.resolve('docx'); }
  catch (e) { assert.fail(`docx is not installed: ${e.code}. Run: npm install docx --save`); }
  const inside = path.join(ROOT, 'node_modules') + path.sep;
  assert.ok(resolved.startsWith(inside),
    `docx resolved to ${resolved}, which is OUTSIDE ${inside} — it would be missing on Railway`);
});

test('and it is declared in package.json dependencies, so a clean install gets it', () => {
  // The half resolution cannot prove: node_modules may hold it while the manifest does not, in which case it
  // works here and the container never installs it.
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.dependencies && pkg.dependencies.docx,
    'docx must be in dependencies — contracts are generated in production');
  assert.ok(!(pkg.devDependencies || {}).docx, 'docx in devDependencies would be pruned in production');
});

test('the exports the contract renderer actually uses are present', () => {
  // A major version that renamed an export would otherwise fail at the moment somebody downloads a contract.
  const d = require('docx');
  const need = ['Document', 'Packer', 'Paragraph', 'TextRun', 'Table', 'TableRow', 'TableCell',
                'HeadingLevel', 'AlignmentType', 'WidthType', 'BorderStyle'];
  const missing = need.filter(k => !(k in d));
  assert.deepEqual(missing, [], `docx is missing exports this code uses: ${missing.join(', ')}`);
});

test('Packer really produces a .docx buffer — the library works, not merely loads', async () => {
  const { Document, Packer, Paragraph, TextRun } = require('docx');
  const doc = new Document({ sections: [{ children: [new Paragraph({ children: [new TextRun('probe')] })] }] });
  const buf = await Packer.toBuffer(doc);
  assert.ok(Buffer.isBuffer(buf) && buf.length > 0, 'Packer returned no bytes');
  // A .docx is a zip, and every zip starts PK\x03\x04. Asserting the magic bytes rather than a length means a
  // future version returning a string or a stream fails here instead of in somebody's browser.
  assert.equal(buf.subarray(0, 4).toString('hex'), '504b0304', 'not a zip — a .docx must start with PK');
});
