#!/usr/bin/env node
/**
 * Collects the exactly-needed offline runtime files from node_modules.
 *
 * Only the files that the packaged engines actually load at run time are copied:
 *
 *  * `mathjax/tex-svg.js` - TeX input + SVG output with the default
 *    `mathjax-newcm` font data inlined by the component itself;
 *  * `mathjax/input/tex/extensions/*.js` - the `[tex]/...` components (mhchem and
 *    friends) that the component loads on demand as classic scripts;
 *  * `@mathjax/mathjax-newcm-font/svg/dynamic/*.js` - the dynamic glyph data. These
 *    files are classic scripts that call
 *    `MathJax._.output.fonts["mathjax-newcm"].svg_ts.MathJaxNewcmFont.dynamicSetup`,
 *    so they attach to the inlined font instance and need no module loader;
 *  * `@mathjax/mathjax-mhchem-font-extension/svg.js` - the glyphs mhchem arrows use;
 *  * `mermaid/dist/mermaid.esm.min.mjs` plus its lazy `chunks/mermaid.esm.min`
 *    chunks - the complete ESM distribution (not the Tiny build).
 *
 * Everything else in node_modules stays out of the APK: no source maps, no
 * duplicate builds, no test fixtures, no example sites.
 */
import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

export async function sha256File(file) {
  const data = await readFile(file);
  return createHash('sha256').update(data).digest('hex');
}

async function listFiles(root, filter = () => true) {
  const out = [];
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && filter(full)) {
        out.push(full);
      }
    }
  }
  await walk(root);
  return out.sort();
}

async function copyFiles(sourceRoot, targetRoot, files) {
  let bytes = 0;
  for (const file of files) {
    const relative = path.relative(sourceRoot, file);
    const target = path.join(targetRoot, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(file, target);
    bytes += (await stat(target)).size;
  }
  return bytes;
}

/**
 * @param {object} options
 * @param {string} options.nodeModules
 * @param {string} options.distDir
 * @returns {Promise<{files: string[], bytes: number, groups: Record<string, number>, aliases: Record<string,string>}>}
 */
export async function collectVendor({ nodeModules, distDir }) {
  const vendorDir = path.join(distDir, 'vendor');
  await rm(vendorDir, { recursive: true, force: true });

  const groups = {};
  const all = [];

  // --- MathJax -------------------------------------------------------------
  const mathjaxRoot = path.join(nodeModules, 'mathjax');
  if (!existsSync(mathjaxRoot)) {
    throw new Error('mathjax is not installed; run `npm ci --prefix web` first');
  }
  const mathjaxTarget = path.join(vendorDir, 'mathjax');
  const mathjaxCore = [path.join(mathjaxRoot, 'tex-svg.js')];
  const mathjaxExtensions = await listFiles(
    path.join(mathjaxRoot, 'input/tex/extensions'),
    (file) => file.endsWith('.js') && !file.endsWith('.map'),
  );
  groups.mathjaxCore = await copyFiles(mathjaxRoot, mathjaxTarget, mathjaxCore);
  groups.mathjaxTexExtensions = await copyFiles(mathjaxRoot, mathjaxTarget, mathjaxExtensions);
  all.push(...mathjaxCore.map((file) => path.join(mathjaxTarget, path.relative(mathjaxRoot, file))));
  all.push(
    ...mathjaxExtensions.map((file) => path.join(mathjaxTarget, path.relative(mathjaxRoot, file))),
  );

  // --- MathJax font data ---------------------------------------------------
  const fontsTarget = path.join(vendorDir, 'fonts');
  const newcmRoot = path.join(nodeModules, '@mathjax/mathjax-newcm-font');
  const newcmDynamic = await listFiles(
    path.join(newcmRoot, 'svg/dynamic'),
    (file) => file.endsWith('.js') && !file.endsWith('.map'),
  );
  groups.mathjaxFontDynamic = await copyFiles(newcmRoot, path.join(fontsTarget, 'mathjax-newcm-font'), newcmDynamic);
  all.push(
    ...newcmDynamic.map((file) =>
      path.join(fontsTarget, 'mathjax-newcm-font', path.relative(newcmRoot, file)),
    ),
  );

  const mhchemFontRoot = path.join(nodeModules, '@mathjax/mathjax-mhchem-font-extension');
  const mhchemFontFiles = [path.join(mhchemFontRoot, 'svg.js')].filter((file) => existsSync(file));
  groups.mathjaxMhchemFont = await copyFiles(
    mhchemFontRoot,
    path.join(fontsTarget, 'mathjax-mhchem-font-extension'),
    mhchemFontFiles,
  );
  all.push(
    ...mhchemFontFiles.map((file) =>
      path.join(fontsTarget, 'mathjax-mhchem-font-extension', path.relative(mhchemFontRoot, file)),
    ),
  );

  // --- Mermaid (full ESM distribution) ------------------------------------
  const mermaidRoot = path.join(nodeModules, 'mermaid/dist');
  const mermaidTarget = path.join(vendorDir, 'mermaid');
  const mermaidChunks = await listFiles(
    path.join(mermaidRoot, 'chunks/mermaid.esm.min'),
    (file) => file.endsWith('.mjs'),
  );
  const mermaidEntry = [path.join(mermaidRoot, 'mermaid.esm.min.mjs')];
  groups.mermaidEntry = await copyFiles(mermaidRoot, mermaidTarget, mermaidEntry);
  groups.mermaidChunks = await copyFiles(mermaidRoot, mermaidTarget, mermaidChunks);
  all.push(...mermaidEntry.map((file) => path.join(mermaidTarget, path.relative(mermaidRoot, file))));
  all.push(...mermaidChunks.map((file) => path.join(mermaidTarget, path.relative(mermaidRoot, file))));

  // --- Aliases -------------------------------------------------------------
  // The upstream font dynamic data can be spelled with or without the package's
  // `js/` segment depending on how the component resolves its `dynamicPrefix`.
  // One physical copy is shipped and the extra spellings are mapped onto it by the
  // native asset router, so no megabytes are duplicated inside the APK.
  const aliases = {};
  for (const file of newcmDynamic) {
    const relative = path.relative(newcmRoot, file).split(path.sep).join('/');
    const canonical = `vendor/fonts/mathjax-newcm-font/${relative}`;
    const fileName = path.basename(relative);
    aliases[`vendor/mathjax/svg/dynamic/${fileName}`] = canonical;
    aliases[`svg/dynamic/${fileName}`] = canonical;
    aliases[`vendor/fonts/mathjax-newcm-font/js/${relative}`] = canonical;
  }
  aliases['vendor/fonts/mathjax-mhchem-font-extension/js/svg.js'] =
    'vendor/fonts/mathjax-mhchem-font-extension/svg.js';
  aliases['vendor/mathjax/mathjax-mhchem-font-extension/svg.js'] =
    'vendor/fonts/mathjax-mhchem-font-extension/svg.js';

  let bytes = 0;
  for (const file of all) bytes += (await stat(file)).size;

  return { files: all, bytes, groups, aliases };
}

export async function writeVendorManifest(distDir, extra = {}) {
  const files = await listFiles(distDir, (file) => !file.endsWith('vendor-manifest.json'));
  const entries = [];
  for (const file of files) {
    const relative = path.relative(distDir, file).split(path.sep).join('/');
    entries.push({
      path: relative,
      bytes: (await stat(file)).size,
      sha256: await sha256File(file),
    });
  }
  return entries;
}

export { listFiles };

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await collectVendor({
    nodeModules: path.resolve('web/node_modules'),
    distDir: path.resolve('web/dist'),
  });
  await writeFile(
    '/tmp/collect-vendor.json',
    JSON.stringify({ groups: result.groups, aliases: Object.keys(result.aliases).length }, null, 2),
  );
  console.log(`collected ${result.files.length} vendor files (${(result.bytes / 1048576).toFixed(2)} MiB)`);
}
