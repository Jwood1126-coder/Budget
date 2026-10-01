#!/usr/bin/env node
'use strict';
/*
 * Assemble the app into one self-contained HTML file.
 *
 *   node tools/build.cjs            -> private build if private/budget-data.json exists, else sample
 *   node tools/build.cjs --sample   -> always the synthetic sample (safe to share)
 *   node tools/build.cjs --empty    -> no embedded transactions (load files in the browser)
 *   node tools/build.cjs --out path -> write somewhere other than dist/index.html
 *   node tools/build.cjs --sample --view spending --out dist/dev-spending/index.html
 *                                   -> developer build: only that view's real source, other views stubbed
 *
 * Data sources, in order of preference for a private build:
 *   dataset: private/budget-data.json, then the earlier app's data/budget-data.json (legacy v1)
 *   profile: private/household-profile.json
 * The sample build always uses fixtures/sample-data.json + fixtures/sample-profile.json.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

function parseArgs(argv) {
  const args = { sample: false, empty: false, out: null, view: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sample') args.sample = true;
    else if (a === '--empty') args.empty = true;
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--view') args.view = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error('Unknown option: ' + a);
  }
  return args;
}

function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Embed JSON inside <script type="application/json"> without allowing it to close the tag. */
function safeJSON(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function pickSources(args) {
  const sample = {
    kind: 'sample',
    dataset: path.join(ROOT, 'fixtures/sample-data.json'),
    profile: path.join(ROOT, 'fixtures/sample-profile.json'),
  };
  if (args.sample) return sample;
  const privateData = [path.join(ROOT, 'private/budget-data.json'), path.join(ROOT, 'data/budget-data.json')].find(f => fs.existsSync(f));
  const privateProfile = path.join(ROOT, 'private/household-profile.json');
  if (args.empty) {
    return { kind: 'empty', dataset: null, profile: fs.existsSync(privateProfile) ? privateProfile : sample.profile };
  }
  if (!privateData && !fs.existsSync(privateProfile)) return sample;
  return {
    kind: 'private',
    dataset: privateData || null,
    profile: fs.existsSync(privateProfile) ? privateProfile : sample.profile,
  };
}

function build(args) {
  const manifest = readJSON(path.join(SRC, 'manifest.json'));
  const sources = pickSources(args);
  const js = [...manifest.engine, ...manifest.ui].map(rel => {
    const file = path.join(SRC, rel);
    if (!fs.existsSync(file)) throw new Error('Missing source file listed in src/manifest.json: ' + rel);
    const m = rel.match(/^ui\/views\/(\w+)\.js$/);
    if (args.view && m && m[1] !== args.view && m[1] !== 'overview') {
      // Developer isolation: another view still being edited cannot break this build.
      return `/* ---- ${rel} (stubbed) ---- */\n(function(){var UI=globalThis.BudgetUI;UI.views=UI.views||{};UI.views.${m[1]}={title:'${m[1]}',render:function(){return UI.c.pageHeader({title:'${m[1]}'})+UI.c.empty('Stubbed in this developer build.');}};})();`;
    }
    return '/* ---- ' + rel + ' ---- */\n' + fs.readFileSync(file, 'utf8');
  }).join('\n');
  const css = manifest.css.map(rel => {
    const file = path.join(SRC, rel);
    return fs.existsSync(file) ? '/* ---- ' + rel + ' ---- */\n' + fs.readFileSync(file, 'utf8') : '';
  }).join('\n');

  const dataset = sources.dataset ? readJSON(sources.dataset) : null;
  const profile = readJSON(sources.profile);
  const buildInfo = {
    kind: sources.kind,
    datasetFile: sources.dataset ? path.relative(ROOT, sources.dataset) : null,
    profileFile: path.relative(ROOT, sources.profile),
    isSynthetic: sources.kind === 'sample',
  };

  let html = fs.readFileSync(path.join(SRC, 'layout.html'), 'utf8');
  const replacements = {
    '__STYLE__': css,
    '__SCRIPT__': js.replace(/<\/script/gi, '<\\/script'),
    '__DATA__': safeJSON(dataset),
    '__PROFILE__': safeJSON(profile),
    '__BUILD__': safeJSON(buildInfo),
  };
  for (const token of Object.keys(replacements)) {
    if (!html.includes(token)) throw new Error('layout.html is missing placeholder ' + token);
  }
  // Single pass so inserted code is never re-scanned for placeholders.
  html = html.replace(/__(STYLE|SCRIPT|DATA|PROFILE|BUILD)__/g, token => replacements[token]);

  const out = args.out ? path.resolve(args.out) : path.join(ROOT, 'dist/index.html');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html);
  const size = Buffer.byteLength(html);
  console.log(`Built ${path.relative(process.cwd(), out)} (${size.toLocaleString('en-US')} bytes) — ${sources.kind} data`);
  if (sources.kind !== 'sample') {
    console.log('PRIVATE BUILD: this file embeds your household profile' + (dataset ? ' and every imported transaction' : '') + '.');
    console.log('Keep it on your own devices. Do not commit, upload or publish it.');
  }
  return { out, sources };
}

if (require.main === module) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^[\s\S]*?\/\*/, '').replace(/^ \* ?/gm, ''));
      process.exit(0);
    }
    build(args);
  } catch (err) {
    console.error('Build failed: ' + err.message);
    process.exit(1);
  }
}

module.exports = { build, safeJSON, pickSources };
