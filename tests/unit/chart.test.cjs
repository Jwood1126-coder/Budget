'use strict';
// Tests for BudgetUI.chart.cashChart: the HTML string it returns for both modes. The UI files are
// plain IIFEs that attach to globalThis, so they load in node after the engine core. All names,
// months and amounts are invented.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadEngine, SRC } = require('../load-engine.cjs');

loadEngine({ only: ['core.js'] });
require(path.join(SRC, 'ui/core.js'));
require(path.join(SRC, 'ui/components.js'));
require(path.join(SRC, 'ui/chart.js'));
const UI = globalThis.BudgetUI;
const { cashChart, attach } = UI.chart;

function monthsFrom(start, count) {
  const out = [];
  let [y, m] = start.split('-').map(Number);
  for (let i = 0; i < count; i++) { out.push(y + '-' + String(m).padStart(2, '0')); m++; if (m > 12) { m = 1; y++; } }
  return out;
}

const MONTHS = monthsFrom('2025-10', 18); // Oct 2025 .. Mar 2027
const PLAN = '2026-10';
const statusOf = m => (m >= PLAN ? 'projected' : 'recorded');
const combinedVals = MONTHS.map((m, i) => 300000 + i * 15000);
const base = {
  id: 'cc-test', title: 'Money through the joint account', months: MONTHS, todayMonth: '2026-09', planStart: PLAN,
  lines: [
    { key: 'combined', name: 'Combined cash', role: 'combined', points: MONTHS.map((m, i) => ({ month: m, cents: combinedVals[i], status: statusOf(m) })) },
    { key: 'checking', name: 'Joint checking', role: 'account', points: MONTHS.map((m, i) => ({ month: m, cents: 100000 + i * 5000, status: statusOf(m) })) },
    { key: 'savings', name: 'Joint savings', role: 'account', points: MONTHS.map((m, i) => ({ month: m, cents: 200000 + i * 10000, status: statusOf(m) })) },
  ],
  columns: {
    in: [
      { key: 'p1', name: 'Rowan → joint', values: MONTHS.map(() => 300000) },
      { key: 'p2', name: 'Quinn → joint', values: MONTHS.map(() => 250000) },
      { key: 'in-other', name: 'Other', values: MONTHS.map(() => 10000) },
    ],
    out: [
      { key: 'cards', name: 'Cards', values: MONTHS.map(() => 260000) },
      { key: 'bills', name: 'Mortgage & bills', values: MONTHS.map(() => 190000) },
      { key: 'to-savings', name: 'To savings', values: MONTHS.map(() => 60000) },
      { key: 'out-other', name: 'Other', values: MONTHS.map(() => 20000) },
    ],
  },
  net: { key: 'net', name: 'Net', values: MONTHS.map(() => 30000) },
};

const modelOf = html => {
  const m = html.match(/<script type="application\/json" class="cc-model">([\s\S]*?)<\/script>/);
  assert.ok(m, 'chart carries its tooltip model');
  return JSON.parse(m[1]);
};
const attrsOf = (html, re) => [...html.matchAll(re)].map(m => m[1]);
const xLabels = html => [...html.matchAll(/<text class="axis cc-xlab" x="([\d.]+)"[^>]*>([^<]*)<\/text>/g)].map(m => [Number(m[1]), m[2]]);
const yTicks = html => attrsOf(html, /<text class="axis cc-ylab"[^>]*>([^<]*)<\/text>/g);
const tbodyRows = html => {
  const body = html.match(/<tbody>([\s\S]*?)<\/tbody>/);
  return body ? (body[1].match(/<tr[\s>]/g) || []).length : 0;
};
const svgOf = html => html.match(/<svg class="cc-svg"[\s\S]*?<\/svg>/)[0];
const pathsWith = (html, cls) => [...svgOf(html).matchAll(new RegExp(`<path class="([^"]*\\b${cls}\\b[^"]*)" d="([^"]*)"`, 'g'))].map(m => ({ cls: m[1], d: m[2] }));
const pointsOf = d => [...d.matchAll(/[ML]([\d.]+) ([\d.]+)/g)].map(m => [Number(m[1]), Number(m[2])]);

test('both modes put the same months at the same x positions', () => {
  const a = cashChart({ ...base, mode: 'balance' });
  const b = cashChart({ ...base, mode: 'flows' });
  const ma = modelOf(a), mb = modelOf(b);
  assert.equal(ma.months.length, MONTHS.length);
  assert.deepEqual(ma.months.map(m => m.x), mb.months.map(m => m.x));
  assert.deepEqual(xLabels(a), xLabels(b));
  assert.equal(ma.padL, mb.padL);
  assert.equal(ma.padR, mb.padR);
  assert.equal(ma.band, mb.band);
  // The plan band starts at the same x in both modes.
  const band = h => h.match(/<rect class="cc-plan-band" x="([\d.]+)"/)[1];
  assert.equal(band(a), band(b));
  // Each mode names its unit.
  assert.match(a, /Balance, \$ at month end/);
  assert.match(b, /Flows, \$ per month/);
});

test('balance mode: plan months are dashed, actual months solid, and the dash starts at the last actual point', () => {
  const html = cashChart({ ...base, mode: 'balance' });
  const model = modelOf(html);
  const lastActual = MONTHS.indexOf('2026-09');
  const projected = pathsWith(html, 'is-projected').filter(p => /series-1/.test(p.cls));
  assert.equal(projected.length, 1);
  const pts = pointsOf(projected[0].d);
  assert.equal(pts[0][0], model.months[lastActual].x, 'dashed segment joins the last actual point');
  assert.equal(pts.length, MONTHS.length - lastActual);
  const solid = pathsWith(html, 'line').filter(p => /series-1/.test(p.cls) && !/is-projected|is-gap/.test(p.cls));
  assert.equal(solid.length, 1);
  assert.equal(pointsOf(solid[0].d).length, lastActual + 1);
  // Label, not only colour: a dashed key and "Plan" text.
  assert.match(html, /key key-line key-dashed[^>]*><\/span>Plan \(projected\)/);
  assert.match(html, /class="cc-marker-label cc-plan-label"[^>]*>Plan<\/text>/);
  assert.match(html, /class="cc-marker-label cc-today-label"[^>]*>Today<\/text>/);
  assert.equal(model.months[lastActual + 1].p, 'Plan');
  assert.equal(model.months[lastActual].p, 'Actual');
});

test('flows mode: plan months are hatched and actual months are solid; in above the axis, out below', () => {
  const html = cashChart({ ...base, mode: 'flows' });
  const model = modelOf(html);
  const planIdx = MONTHS.indexOf(PLAN);
  const planX = Number(html.match(/<rect class="cc-plan-band" x="([\d.]+)"/)[1]);
  const hatches = pathsWith(html, 'cc-seg-hatch');
  // Seven series, every plan month has all seven segments, each with its hatch overlay.
  assert.equal(hatches.length, 7 * (MONTHS.length - planIdx));
  for (const h of hatches) assert.ok(pointsOf(h.d.replace(/^M/, 'M'))[0][0] >= planX - 0.1, 'hatch only in plan months');
  assert.match(html, /<pattern id="cc-test-hatch"/);
  assert.match(html, /fill="url\(#cc-test-hatch\)"/);
  assert.match(html, /key key-swatch is-hatched[^>]*><\/span>Plan \(striped\)/);
  // Stacking direction: segments of in-series sit above the zero line, out-series below.
  const zeroY = Number(html.match(/<line class="grid zero cc-zero[^"]*"[^>]*y1="([\d.]+)"/)[1]);
  const segTops = key => {
    const g = svgOf(html).match(new RegExp(`data-cc-series="${key}">([\\s\\S]*?)</g>`))[1];
    return [...g.matchAll(/<path class="seg [^"]*" d="M[\d.]+ ([\d.]+)/g)].map(m => Number(m[1]));
  };
  for (const y of segTops('p1')) assert.ok(y < zeroY, 'money in above the axis');
  for (const y of segTops('cards')) assert.ok(y > zeroY, 'money out below the axis');
  // Tooltip rows: in-total, out-total and net.
  const rows = model.months[0].rows;
  assert.deepEqual(rows.filter(r => /total|net/.test(r.g || '')).map(r => [r.g, r.v]), [['in-total', '$5,600'], ['out-total', '$5,300'], ['net', '+$300']]);
  assert.equal(model.months[0].p, 'Actual');
  assert.equal(model.months[planIdx].p, 'Plan');
});

test('a series listed in hidden carries the hidden class, and hiding changes no computed value', () => {
  const shown = cashChart({ ...base, mode: 'balance' });
  const hidden = cashChart({ ...base, mode: 'balance', hidden: ['savings'] });
  assert.match(hidden, /<g class="cc-series series-3 cc-line-series is-hidden" data-cc-series="savings">/);
  assert.doesNotMatch(hidden, /data-cc-series="combined"[^>]*is-hidden|is-hidden" data-cc-series="combined"/);
  assert.match(hidden, /data-cc-key="savings" aria-pressed="false"/);
  assert.match(hidden, /data-cc-key="combined" aria-pressed="true"/);
  assert.match(hidden, /data-hidden="\[&quot;savings&quot;\]"/);
  // Same scale, same tooltip model, same table: hiding is not excluding.
  assert.deepEqual(yTicks(hidden), yTicks(shown));
  assert.deepEqual(modelOf(hidden), modelOf(shown));
  const table = h => h.match(/<details class="chart-table[\s\S]*<\/details>/)[0];
  assert.equal(table(hidden), table(shown));

  const flows = cashChart({ ...base, mode: 'flows', hidden: ['cards', 'net'] });
  assert.match(flows, /<g class="cc-series series-5 cc-col-series is-hidden" data-cc-series="cards">/);
  assert.match(flows, /<g class="cc-series series-net cc-net is-hidden" data-cc-series="net">/);
  assert.deepEqual(yTicks(flows), yTicks(cashChart({ ...base, mode: 'flows' })));
});

test('negative values emphasise the zero line; positive-only balances do not', () => {
  const positive = cashChart({ ...base, mode: 'balance' });
  assert.doesNotMatch(positive, /is-emph/);
  assert.doesNotMatch(positive, /cc-zero-over/);
  const months = monthsFrom('2026-05', 8);
  const vals = [120000, 40000, -31000, -12000, 15000, 50000, 90000, 120000];
  const negative = cashChart({
    id: 'neg', title: 'Tight months', mode: 'balance', months, todayMonth: '2026-08', planStart: '2026-09',
    lines: [{ key: 'combined', name: 'Combined cash', role: 'combined', points: months.map((m, i) => ({ month: m, cents: vals[i], status: m >= '2026-09' ? 'projected' : 'recorded' })) }],
  });
  assert.match(negative, /<line class="grid zero cc-zero is-emph"/);
  assert.match(negative, /<line class="cc-zero-over"/);
  assert.ok(yTicks(negative).some(t => t.startsWith('−$')), 'axis reaches below zero');
  // The line dips below the zero line honestly.
  const zeroY = Number(negative.match(/<line class="cc-zero-over"[^>]*y1="([\d.]+)"/)[1]);
  const ys = pathsWith(negative, 'series-1').flatMap(p => pointsOf(p.d)).map(p => p[1]);
  assert.ok(Math.max(...ys) > zeroY);
  // The lowest point is labelled and named in the summary.
  assert.match(negative, /class="cc-low-label"[^>]*>Low −\$310<\/text>/);
  assert.match(negative, /lowest −\$310 in Jul 2026/);
  // Flows always cross zero (out is drawn below it).
  assert.match(cashChart({ ...base, mode: 'flows' }), /is-emph/);
});

test('gap points: a dotted segment, a visible break and a note in the tooltip', () => {
  const months = monthsFrom('2026-01', 6);
  const pts = [
    { month: '2026-01', cents: 100000, status: 'recorded' },
    { month: '2026-02', cents: 110000, status: 'reconstructed' },
    { month: '2026-03', cents: null, status: 'gap', note: 'No statement for March' },
    { month: '2026-04', cents: 125000, status: 'recorded' },
    { month: '2026-05', cents: 128000, status: 'gap', note: 'Estimated from card files' },
    { month: '2026-06', cents: 131000, status: 'recorded' },
  ];
  const html = cashChart({ id: 'gap', title: 'Gaps', mode: 'balance', months, todayMonth: '2026-06', planStart: '2026-07', lines: [{ key: 'combined', name: 'Combined cash', role: 'combined', points: pts }] });
  const model = modelOf(html);
  const gaps = pathsWith(html, 'is-gap');
  const xs = model.months.map(m => m.x);
  // Dotted: the bridge Feb -> Apr over the unknown March (no point drawn at March), then the two
  // segments touching the estimated May. They touch at April, so they form one dotted path.
  assert.equal(gaps.length, 1);
  assert.deepEqual(pointsOf(gaps[0].d).map(p => p[0]), [xs[1], xs[3], xs[4], xs[5]]);
  const solid = pathsWith(html, 'line').filter(q => !/is-gap/.test(q.cls));
  assert.deepEqual(solid.map(q => pointsOf(q.d).map(p => p[0])), [[xs[0], xs[1]]]);
  // No solid line passes through March.
  for (const p of pathsWith(html, 'line').filter(q => !/is-gap/.test(q.cls))) assert.ok(!pointsOf(p.d).some(q => q[0] === xs[2]));
  const march = model.months[2].rows[0];
  assert.equal(march.v, 'No data');
  assert.equal(march.s, 'Gap');
  assert.equal(march.note, 'No statement for March');
  assert.equal(model.months[4].rows[0].s, 'Gap');
  assert.equal(model.months[1].rows[0].s, 'Reconstructed');
  assert.match(html, /cc-key-dotted[^>]*><\/span>Gap in the data/);
  assert.match(html, /2 months with a gap in the data/);
  // The table says so too.
  assert.match(html, /<th scope="row" class=" ">Mar 2026<\/th><td class=" ">Gap<\/td><td class="num ">No data<\/td><td class=" ">No statement for March<\/td>/);
});

test('null values are skipped, never drawn as zero', () => {
  const months = monthsFrom('2026-01', 5);
  const html = cashChart({
    id: 'nulls', title: 'Nulls', mode: 'balance', months, planStart: '2026-06',
    lines: [{ key: 'combined', name: 'Combined cash', role: 'combined', points: [
      { month: '2026-01', cents: 500000, status: 'recorded' },
      { month: '2026-02', cents: 520000, status: 'recorded' },
      { month: '2026-03', cents: null, status: 'recorded' },
      { month: '2026-04', cents: 540000, status: 'recorded' },
      { month: '2026-05', cents: 560000, status: 'recorded' },
    ] }],
  });
  const model = modelOf(html);
  const lines = pathsWith(html, 'line');
  assert.equal(lines.length, 2, 'the line breaks at the unknown month');
  assert.equal(pathsWith(html, 'is-gap').length, 0, 'an unknown month without a gap status is not bridged');
  const all = lines.flatMap(p => pointsOf(p.d));
  assert.ok(!all.some(p => p[0] === model.months[2].x));
  assert.equal(model.dots.combined[2], null);
  assert.equal(model.months[2].rows[0].v, 'No data');

  // Flows: a null value draws no segment for that month and the column total ignores it.
  const fm = monthsFrom('2026-01', 3);
  const flows = cashChart({ id: 'fn', title: 'F', mode: 'flows', months: fm, columns: {
    in: [{ key: 'a', name: 'A', values: [100000, null, 100000] }],
    out: [{ key: 'b', name: 'B', values: [50000, null, 60000] }],
  } });
  const fmodel = modelOf(flows);
  const segXs = [...svgOf(flows).matchAll(/<path class="seg [^"]*" d="M([\d.]+) /g)].map(m => Number(m[1]));
  assert.equal(segXs.length, 4);
  const halfBar = Math.min(24, fmodel.band * 0.62) / 2;
  assert.ok(!segXs.some(x => Math.abs(x + halfBar - fmodel.months[1].x) < 0.2), 'no column in the unknown month');
  assert.equal(fmodel.months[1].s, 'Gap');
  assert.equal(fmodel.months[1].rows.find(r => r.g === 'net').v, 'No data');
});

test('the table twin has one row per month, a status column and the same numbers', () => {
  for (const mode of ['balance', 'flows']) {
    const html = cashChart({ ...base, mode, tableCaption: 'Joint account by month' });
    assert.equal(tbodyRows(html), MONTHS.length, mode);
    assert.match(html, /<details class="chart-table cc-table-twin" id="cc-test-table"><summary>Show as a table<\/summary>/);
    assert.match(html, /<th scope="col" class=" ">Status<\/th>/);
    assert.match(html, /<caption class="sr-only">Joint account by month<\/caption>/);
  }
  const balance = cashChart({ ...base, mode: 'balance' });
  assert.match(balance, /<th scope="row" class=" ">Oct 2025<\/th><td class=" ">Recorded<\/td><td class="num ">\$3,000<\/td><td class="num ">\$1,000<\/td><td class="num ">\$2,000<\/td>/);
  const flows = cashChart({ ...base, mode: 'flows' });
  assert.match(flows, /Total in<\/th>/);
  assert.match(flows, /<td class="num ">\$5,600<\/td>.*?<td class="num ">\$5,300<\/td><td class="num ">\+\$300<\/td>/);
});

test('output never contains NaN or undefined, for full, sparse and odd input', () => {
  const cases = [
    { ...base, mode: 'balance' },
    { ...base, mode: 'flows' },
    { ...base, mode: 'flows', net: null, columns: { in: base.columns.in, out: [] } },
    { ...base, mode: 'balance', todayMonth: '2030-01', planStart: null },
    { ...base, mode: 'balance', months: ['2026-01'], todayMonth: '2026-01', planStart: '2026-01' },
    { id: 'x', title: 'Empty', mode: 'balance', months: [] },
    { id: 'y', title: 'All unknown', mode: 'balance', months: ['2026-01', '2026-02'], lines: [{ key: 'a', name: 'A', points: [{ month: '2026-01', cents: null, status: 'gap' }] }] },
    { id: 'z', title: 'No columns', mode: 'flows', months: ['2026-01'], columns: null },
    { id: 'w', title: 'Bad values', mode: 'flows', months: ['2026-01', '2026-02'], columns: { in: [{ key: 'a', name: 'A', values: [NaN, 'x'] }], out: [{ key: 'b', name: 'B', values: [Infinity, 5000] }] } },
  ];
  for (const spec of cases) {
    const html = cashChart(spec);
    assert.equal(typeof html, 'string');
    assert.doesNotMatch(html, /NaN|undefined|Infinity/, spec.title);
  }
  assert.doesNotMatch(cashChart(cases[5]), /data-chart=/, 'an empty chart is not wired');
  assert.match(cashChart(cases[5]), /No months to show yet/);
  assert.match(cashChart(cases[6]), /Not enough known values/);
});

test('month labels: every month up to 13, then calendar steps with January always labelled with its year', () => {
  const short = cashChart({ ...base, mode: 'balance', months: base.months.slice(0, 12) });
  assert.equal(xLabels(short).length, 12);
  const long = cashChart({ ...base, mode: 'balance' });
  const labels = xLabels(long).map(l => l[1]);
  assert.deepEqual(labels, ['Oct', 'Jan', 'Apr', 'Jul', 'Oct', 'Jan']);
  const years = attrsOf(long, /<text class="axis cc-year"[^>]*>(\d{4})<\/text>/g);
  assert.deepEqual(years, ['2025', '2026', '2027'], 'first label and every January carry the year');
});

test('narrow screens get their own taller drawing and fewer month labels', () => {
  const before = globalThis.innerWidth;
  try {
    globalThis.innerWidth = 390;
    const narrow = cashChart({ ...base, mode: 'balance', months: monthsFrom('2025-10', 12), lines: [] });
    assert.match(cashChart({ ...base, mode: 'balance' }), /viewBox="0 0 360 300"/);
    assert.ok(narrow.includes('No months') || narrow.includes('Not enough'), 'empty without lines');
    const html = cashChart({ ...base, mode: 'balance', months: base.months.slice(0, 12) });
    assert.ok(xLabels(html).length < 12);
    assert.doesNotMatch(html, /preserveAspectRatio/);
  } finally {
    if (before === undefined) delete globalThis.innerWidth; else globalThis.innerWidth = before;
  }
  assert.match(cashChart({ ...base, mode: 'balance' }), /viewBox="0 0 960 360"/);
});

test('text is escaped everywhere, and the tooltip model cannot close its script tag', () => {
  const evil = '<img src=x onerror=alert(1)>"\'';
  const html = cashChart({
    ...base, mode: 'balance', title: evil, caption: evil, tableCaption: evil,
    lines: [{ key: 'a"b', name: evil + '</script>', role: 'combined', points: base.lines[0].points.map(p => ({ ...p, note: '</script><b>' })) }],
  });
  assert.doesNotMatch(html, /<img/);
  assert.equal((html.match(/<\/script>/g) || []).length, 1, 'only the model block closes a script tag');
  const json = html.match(/<script type="application\/json" class="cc-model">([\s\S]*?)<\/script>/)[1];
  assert.doesNotMatch(json, /</);
  assert.equal(modelOf(html).months[0].rows[0].n, evil + '</script>');
  assert.match(html, /data-cc-key="a&quot;b"/);
});

test('accessibility: focusable plot with a summary label, a live region and pressed-state legend chips', () => {
  const html = cashChart({ ...base, mode: 'balance', hidden: ['checking'] });
  const label = html.match(/<div class="cc-plot" id="cc-test-plot" tabindex="0" role="img" aria-label="([^"]*)"/);
  assert.ok(label, 'plot is one focusable image with a label');
  assert.match(label[1], /^Money through the joint account\. Balance, \$ at month end, Oct 2025 to Mar 2027\. Months from Oct 2026 are the plan\. Combined cash from \$3,000 in Oct 2025 to \$5,550 projected in Mar 2027; lowest \$3,000 in Oct 2025\./);
  assert.match(label[1], /arrow keys/);
  assert.match(html, /aria-live="polite" data-cc-live/);
  assert.match(html, /<svg class="cc-svg"[^>]*aria-hidden="true"/);
  assert.match(html, /<button type="button" class="cc-chip" id="[^"]+" data-cc-key="checking" aria-pressed="false">/);
  assert.match(html, /role="group" aria-label="Series in Money through the joint account: press to show or hide"/);
  const flows = cashChart({ ...base, mode: 'flows' });
  assert.match(flows, /In actual months, money in averaged \$5,600 and money out \$5,300 a month; the plan has \$5,600 in and \$5,300 out a month\./);
});

test('colours follow the entity: defaults by role and order, explicit cls wins, Other is muted', () => {
  const html = cashChart({ ...base, mode: 'balance' });
  assert.match(html, /data-cc-series="combined"/);
  assert.match(html, /<g class="cc-series series-1 cc-line-series" data-cc-series="combined">/);
  assert.match(html, /<g class="cc-series series-2 cc-line-series" data-cc-series="checking">/);
  assert.match(html, /<g class="cc-series series-3 cc-line-series" data-cc-series="savings">/);
  const flows = cashChart({ ...base, mode: 'flows' });
  for (const [key, cls] of [['p1', 'series-1'], ['p2', 'series-2'], ['in-other', 'series-muted'], ['cards', 'series-5'], ['bills', 'series-4'], ['to-savings', 'series-3'], ['out-other', 'series-muted']]) {
    assert.match(flows, new RegExp(`<g class="cc-series ${cls} cc-col-series" data-cc-series="${key}">`), key);
  }
  const custom = cashChart({ ...base, mode: 'flows', columns: { in: [{ key: 'p1', name: 'A', cls: 'series-3', values: [1000] }], out: [] } });
  assert.match(custom, /<g class="cc-series series-3 cc-col-series" data-cc-series="p1">/);
});

test('attach is safe without a DOM and is exposed for app.js', () => {
  assert.equal(typeof attach, 'function');
  assert.doesNotThrow(() => attach(null));
  assert.doesNotThrow(() => attach({}));
});
