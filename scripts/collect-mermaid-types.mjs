#!/usr/bin/env node
/**
 * Offline check of the Mermaid support matrix (no network).
 *
 * 1. Reads the registered diagram-type list from the *shipped* mermaid
 *    distribution, so the matrix is derived from the locked build rather than from
 *    a hand-written list copied from an older version;
 * 2. requires a committed fixture for every registered type
 *    (`registered - fixtures = ∅`) plus a fixture for every declared layout;
 * 3. runs the shipped `detectType()` over every fixture and requires it to be
 *    detected as the type it claims (the negative `---` fixture must be rejected);
 * 4. rewrites `fixtures/mermaid/diagram-support.json` when run with `--write`.
 *
 * This validates the *static* matrix. It is not a rendering test: whether each
 * diagram actually draws is what the user verifies after downloading the APK.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const supportPath = path.join(repoRoot, 'fixtures/mermaid/diagram-support.json');
const write = process.argv.includes('--write');
const check = process.argv.includes('--check') || !write;

function fail(message) {
  console.error(`[mermaid-check] FAIL ${message}`);
  process.exitCode = 1;
}

const support = JSON.parse(await readFile(supportPath, 'utf8'));

const module = await import(
  path.join(repoRoot, 'web/node_modules/mermaid/dist/mermaid.esm.min.mjs')
);
const api = module.default;
api.initialize({ startOnLoad: false, securityLevel: 'strict' });

const registered = api
  .getRegisteredDiagramsMetadata()
  .map((entry) => entry.id)
  .sort();

const declared = new Set(support.registeredTypes ?? []);
const covered = new Set((support.fixtureCoverage ?? []).map((entry) => entry.id));

const missingFixtures = registered.filter((id) => !covered.has(id));
const staleFixtures = [...covered].filter((id) => !registered.includes(id));

for (const id of missingFixtures) fail(`registered type without a fixture: ${id}`);
for (const id of staleFixtures) fail(`fixture for an unregistered type: ${id}`);
if (declared.size > 0) {
  for (const id of registered) {
    if (!declared.has(id)) fail(`diagram-support.json is out of date, missing ${id}`);
  }
}

let detected = 0;
for (const entry of support.fixtureCoverage ?? []) {
  const source = await readFile(path.join(repoRoot, entry.fixture), 'utf8');
  if (entry.negative) {
    let unexpected = null;
    try {
      unexpected = api.detectType(source);
    } catch {
      unexpected = null;
    }
    if (unexpected !== null && unexpected !== id(entry)) {
      fail(`negative fixture ${entry.fixture} was detected as '${unexpected}'`);
    }
    continue;
  }
  let actual = null;
  try {
    actual = api.detectType(source);
  } catch (error) {
    fail(`fixture ${entry.fixture} is not parseable by the shipped engine: ${error.message}`);
    continue;
  }
  if (actual !== entry.id) {
    fail(`fixture ${entry.fixture} detected as '${actual}', expected '${entry.id}'`);
    continue;
  }
  detected += 1;
}

function id(entry) {
  return entry.id;
}

// Layout engines that must be reachable locally.
const layouts = ['dagre', 'elk'];
const layoutFixtures = (support.fixtureCoverage ?? []).filter((entry) =>
  (entry.layouts ?? []).length > 0,
);
for (const layout of layouts) {
  const covered = layoutFixtures.some((entry) => (entry.layouts ?? []).includes(layout));
  if (!covered) {
    fail(`no fixture declares layout '${layout}'`);
  }
}

const summary = {
  engineVersionTag: support.engineVersionTag,
  registeredTypes: registered.length,
  fixtures: (support.fixtureCoverage ?? []).length,
  detected,
  layouts,
};
console.log(`[mermaid-check] ${JSON.stringify(summary)}`);

if (write) {
  support.registeredTypes = registered;
  await writeFile(supportPath, `${JSON.stringify(support, null, 2)}\n`, 'utf8');
  console.log('[mermaid-check] diagram-support.json updated');
}

if (check && process.exitCode === 1) {
  console.error('[mermaid-check] matrix incomplete');
}
