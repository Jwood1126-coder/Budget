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
  assert.match(html, /key key-line key-dashed[^>]*><\/span>Plan \(estimate\)/);
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

test('assumed points: dotted, never touched by a solid or dashed path, keyed, and named in readout, table and summary', () => {
  const months = monthsFrom('2026-05', 8); // May .. Dec 2026, plan from Oct
  const note = 'Assumes nothing moved between Oct 1 and Oct 2, 2026 (not in your data).';
  // Jun is assumed between two reconstructed months; Aug -> Sep -> Oct runs reconstructed, assumed, projected.
  const st = ['reconstructed', 'assumed', 'reconstructed', 'reconstructed', 'assumed', 'projected', 'projected', 'projected'];
  const vals = [400000, 410000, 405000, 398000, 401000, 395000, 390000, 385000];
  const html = cashChart({
    id: 'assumed', title: 'Assumed days', mode: 'balance', months, todayMonth: '2026-10', planStart: '2026-10',
    lines: [
      { key: 'combined', name: 'Combined cash', role: 'combined', points: months.map((m, i) => ({ month: m, cents: vals[i], status: st[i], note: st[i] === 'assumed' ? note : undefined })) },
      { key: 'chk', name: 'Joint checking', role: 'account', points: months.map((m, i) => ({ month: m, cents: vals[i] - 100000, status: st[i], illustrative: st[i] === 'projected', note: st[i] === 'assumed' ? note : undefined })) },
    ],
  });
  const model = modelOf(html);
  const xs = model.months.map(m => m.x);
  const assumedIdx = st.map((v, i) => (v === 'assumed' ? i : -1)).filter(i => i >= 0);
  assert.deepEqual(assumedIdx, [1, 4]);
  const dotted = pathsWith(html, 'is-assumed');
  assert.ok(dotted.length >= 2, 'assumed runs are drawn with their own dotted class');
  for (const i of assumedIdx) assert.ok(dotted.some(p => pointsOf(p.d).some(q => q[0] === xs[i])), 'month ' + months[i] + ' is on a dotted path');
  // No other path (solid or dashed) touches an assumed point: the transitions on both sides stay dotted.
  const others = pathsWith(html, 'line').filter(p => !/is-assumed/.test(p.cls));
  for (const p of others) for (const i of assumedIdx) assert.ok(!pointsOf(p.d).some(q => q[0] === xs[i]), p.cls + ' touches ' + months[i]);
  // reconstructed -> assumed -> reconstructed: May..Jul is one dotted run; Sep -> Oct (assumed -> projected) is dotted too.
  const runOf = p => pointsOf(p.d).map(q => xs.indexOf(q[0]));
  assert.deepEqual(dotted.filter(p => /series-1/.test(p.cls)).map(runOf), [[0, 1, 2], [3, 4, 5]]);
  const dashed = pathsWith(html, 'is-projected').filter(p => /series-1/.test(p.cls)).map(runOf);
  assert.deepEqual(dashed, [[5, 6, 7]], 'the dashed plan starts at the first plan month, not at the assumed one');
  const solid = pathsWith(html, 'line').filter(p => /series-1/.test(p.cls) && !/is-(assumed|projected|gap)/.test(p.cls)).map(runOf);
  assert.deepEqual(solid, [[2, 3]], 'only Jul -> Aug is solid');
  // Legend key only when assumed points exist.
  assert.match(html, /<span class="key key-line cc-key-dotted" aria-hidden="true"><\/span>Assumed \(days without data\)/);
  assert.doesNotMatch(cashChart({ ...base, mode: 'balance' }), /Assumed \(days without data\)/);
  // Readout: status and the note.
  const sep = model.months[4];
  assert.equal(sep.p, 'Assumed');
  assert.equal(sep.rows[0].s, 'Assumed');
  assert.equal(sep.rows[0].note, note);
  assert.equal(model.months[3].p, 'Actual');
  // Table twin: the status column says Assumed and the note is there.
  assert.match(html, new RegExp('<th scope="row" class=" ">Sep 2026</th><td class=" ">Assumed</td><td class="num ">\\$4,010</td><td class="num ">\\$3,010</td><td class=" ">' + note.replace(/[().]/g, '\\$&') + '</td></tr>'), 'one note, not repeated per line');
  assert.match(html, /<th scope="row" class=" ">Aug 2026<\/th><td class=" ">Reconstructed<\/td>/);
  // The screen-reader summary says so.
  assert.match(html, /2 months are assumed: worked out across days your data does not cover \(dotted\)\./);
});

test('illustrative points say so after their status in the readout and the table', () => {
  const months = monthsFrom('2026-09', 3);
  const html = cashChart({
    id: 'ill', title: 'Illustrative', mode: 'balance', months, todayMonth: '2026-09', planStart: '2026-10',
    lines: [
      { key: 'combined', name: 'Combined cash', role: 'combined', points: months.map((m, i) => ({ month: m, cents: 500000 + i * 1000, status: i ? 'projected' : 'reconstructed' })) },
      { key: 'chk', name: 'Joint checking', role: 'account', points: months.map((m, i) => ({ month: m, cents: 200000 + i * 1000, status: i ? 'projected' : 'reconstructed', illustrative: i > 0 })) },
    ],
  });
  const model = modelOf(html);
  assert.equal(model.months[1].rows[0].s, 'Projected', 'the combined line is not illustrative');
  assert.equal(model.months[1].rows[1].s, 'Projected (illustrative)');
  assert.equal(model.months[0].rows[1].s, 'Reconstructed');
  assert.match(html, /<th scope="row" class=" ">Oct 2026<\/th><td class=" ">Projected<\/td><td class="num ">\$5,010<\/td><td class="num ">\$2,010 \(illustrative\)<\/td>/);
  assert.match(html, /<th scope="row" class=" ">Sep 2026<\/th><td class=" ">Reconstructed<\/td><td class="num ">\$5,000<\/td><td class="num ">\$2,000<\/td>/);
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

// ------------------------------------------------------------------ baseline plan (ghost line)
const ghostVals = MONTHS.map((m, i) => (m >= '2026-09' ? 420000 + i * 20000 : null)); // known from today on
const withGhost = (extra = {}) => cashChart({
  ...base, mode: 'balance',
  lines: [...base.lines, { key: 'baseline', role: 'ghost', points: MONTHS.map((m, i) => ({ month: m, cents: ghostVals[i] })) }],
  ...extra,
});

test('baseline plan: a thin muted dashed line behind the others, with no dots or end label', () => {
  const html = withGhost();
  const svg = svgOf(html);
  const model = modelOf(html);
  assert.match(svg, /<g class="cc-series series-ghost cc-ghost" data-cc-series="baseline">/);
  const ghost = pathsWith(html, 'cc-ghost-line');
  assert.equal(ghost.length, 1);
  assert.equal(ghost[0].cls, 'line cc-ghost-line series-ghost');
  // Nothing drawn where the baseline has no value: the path starts at today.
  const pts = pointsOf(ghost[0].d);
  const todayIdx = MONTHS.indexOf('2026-09');
  assert.equal(pts[0][0], model.months[todayIdx].x);
  assert.equal(pts.length, MONTHS.length - todayIdx);
  // Behind every other line.
  assert.ok(svg.indexOf('data-cc-series="baseline"') < svg.indexOf('data-cc-series="checking"'));
  assert.ok(svg.indexOf('data-cc-series="baseline"') < svg.indexOf('data-cc-series="combined"'));
  // No dots, no end label, no hover dot.
  const group = svg.match(/<g class="cc-series series-ghost cc-ghost" data-cc-series="baseline">([\s\S]*?)<\/g>/)[1];
  assert.doesNotMatch(group, /<circle|<text/);
  assert.doesNotMatch(svg, /cc-dot[^>]*data-cc-series="baseline"/);
  assert.equal(model.dots.baseline, undefined);
  assert.equal((svg.match(/class="end-label cc-end-label"/g) || []).length, 3, 'end labels only on the three real lines');
  // The real lines keep their colours (the ghost takes none).
  assert.match(html, /<g class="cc-series series-2 cc-line-series" data-cc-series="checking">/);
  assert.match(html, /<g class="cc-series series-3 cc-line-series" data-cc-series="savings">/);
});

test('baseline plan: legend chip, readout row in plan months only, table column', () => {
  const html = withGhost();
  const model = modelOf(html);
  assert.match(html, /data-cc-key="baseline" aria-pressed="true"><span class="key key-line series-ghost" aria-hidden="true"><\/span><span class="cc-chip-name">Baseline plan<\/span>/);
  // Toggleable like any series.
  const hidden = withGhost({ hidden: ['baseline'] });
  assert.match(hidden, /<g class="cc-series series-ghost cc-ghost is-hidden" data-cc-series="baseline">/);
  assert.match(hidden, /data-cc-key="baseline" aria-pressed="false"/);
  // Readout: right under the combined row, only in projected months.
  const planIdx = MONTHS.indexOf(PLAN);
  const rows = model.months[planIdx].rows;
  assert.deepEqual(rows.slice(0, 2).map(r => r.k), ['combined', 'baseline']);
  assert.deepEqual(rows[1], { k: 'baseline', g: 'ghost', n: 'Baseline plan', v: '$' + (ghostVals[planIdx] / 100).toLocaleString('en-US'), c: 'key-line series-ghost' });
  const todayIdx = MONTHS.indexOf('2026-09');
  assert.ok(!model.months[todayIdx].rows.some(r => r.k === 'baseline'), 'not in an actual month, even with a value');
  assert.ok(!model.months[0].rows.some(r => r.k === 'baseline'));
  assert.equal(model.groups.baseline, 'ghost');
  // Table twin: its own column, a dash where it has no value.
  assert.match(html, /<th scope="col" class="num ">Baseline plan<\/th>/);
  assert.match(html, /<th scope="row" class=" ">Oct 2025<\/th><td class=" ">Recorded<\/td><td class="num ">\$3,000<\/td><td class="num ">\$1,000<\/td><td class="num ">\$2,000<\/td><td class="num ">—<\/td><\/tr>/);
  assert.match(html, new RegExp(`<th scope="row" class=" ">Oct 2026</th><td class=" ">Projected</td>(<td class="num ">[^<]*</td>){3}<td class="num ">\\$${(ghostVals[planIdx] / 100).toLocaleString('en-US')}</td></tr>`));
});

test('baseline plan: widens the scale to its own values only; zero emphasis, low point and summary ignore it', () => {
  const months = monthsFrom('2026-05', 8);
  const real = [120000, 90000, 80000, 70000, 60000, 50000, 40000, 30000];
  const ghost = [null, null, null, 70000, 20000, -40000, -90000, -150000];
  const spec = ghostLine => ({
    id: 'gz', title: 'Ghost below zero', mode: 'balance', months, todayMonth: '2026-08', planStart: '2026-09',
    lines: [
      { key: 'combined', name: 'Combined cash', role: 'combined', points: months.map((m, i) => ({ month: m, cents: real[i], status: m >= '2026-09' ? 'projected' : 'recorded' })) },
      ...(ghostLine ? [{ key: 'ghost', role: 'ghost', name: 'Baseline plan', points: months.map((m, i) => ({ month: m, cents: ghost[i] })) }] : []),
    ],
  });
  const html = cashChart(spec(true));
  const plain = cashChart(spec(false));
  // The scale reaches the baseline's lowest value...
  assert.ok(yTicks(html).some(t => t.startsWith('−$')), 'axis reaches below zero for the baseline');
  const ys = pathsWith(html, 'cc-ghost-line').flatMap(p => pointsOf(p.d)).map(p => p[1]);
  const plotBottom = Number(html.match(/<line class="crosshair cc-crosshair"[^>]*y2="([\d.]+)"/)[1]);
  assert.ok(Math.max(...ys) <= plotBottom + 0.1, 'the baseline stays inside the plot');
  // ...but only the real lines decide the zero emphasis, the low point and the summary.
  assert.doesNotMatch(html, /is-emph|cc-zero-over|cc-low-label/);
  const label = h => h.match(/role="img" aria-label="([^"]*)"/)[1];
  assert.equal(label(html), label(plain));
  assert.match(label(html), /lowest \$300 projected in Dec 2026/);
});

// ------------------------------------------------------------------ change markers
const MARKERS = [
  { month: '2026-11', label: 'Car seat', cents: -25000, kind: 'oneTime' },
  { month: '2026-11', label: 'Stroller', cents: -18000, kind: 'oneTime' },
  { month: '2027-01', label: 'Daycare', cents: -120000, kind: 'monthly' },
  { month: '2026-12', label: 'Raise', cents: 30000, kind: 'monthly' },
  { month: '2031-01', label: 'Out of range', kind: 'oneTime' },
];

test('markers: a lane above the plot with a dot, a short label and a rule to the axis; one per month; a faint band for monthly', () => {
  const html = cashChart({ ...base, mode: 'balance', markers: MARKERS });
  const plain = cashChart({ ...base, mode: 'balance' });
  const svg = svgOf(html);
  const model = modelOf(html);
  const x = m => model.months[MONTHS.indexOf(m)].x;
  const bottom = Number(html.match(/<line class="crosshair cc-crosshair"[^>]*y2="([\d.]+)"/)[1]);
  const top = Number(html.match(/<line class="crosshair cc-crosshair"[^>]*y1="([\d.]+)"/)[1]);
  // The plot moves down by the lane's height; the plot itself keeps its height.
  const plainTop = Number(plain.match(/<line class="crosshair cc-crosshair"[^>]*y1="([\d.]+)"/)[1]);
  const plainBottom = Number(plain.match(/<line class="crosshair cc-crosshair"[^>]*y2="([\d.]+)"/)[1]);
  assert.ok(top > plainTop, 'room for the lane above the plot');
  assert.ok(Math.abs((bottom - top) - (plainBottom - plainTop)) < 0.2, 'the plot keeps its height');
  assert.equal(model.padT, modelOf(plain).padT + (top - plainTop));
  // Two one-time changes in November: one dot, the first label and "+1".
  const nov = svg.match(/<g class="cc-ann cc-change is-oneTime" data-cc-change="2026-11">([\s\S]*?)<\/g>/);
  assert.ok(nov, 'november carries one marker');
  assert.match(nov[1], new RegExp(`<circle class="cc-ann-glyph" cx="${x('2026-11').toFixed(1)}"`));
  assert.match(nov[1], /<text class="cc-ann-label"[^>]*>Car seat \+1<\/text>/);
  const rule = nov[1].match(/<line class="cc-ann-rule" x1="([\d.]+)" x2="[\d.]+" y1="([\d.]+)" y2="([\d.]+)"/);
  assert.equal(Number(rule[1]), Number(x('2026-11').toFixed(1)));
  assert.ok(Number(rule[2]) < top && Number(rule[3]) === bottom, 'the rule runs from the lane to the axis');
  assert.equal((svg.match(/data-cc-change="2026-11"/g) || []).length, 1);
  // Monthly starts: a rounded square each, and one band from the first start to the right edge.
  for (const m of ['2026-12', '2027-01']) {
    const g = svg.match(new RegExp(`<g class="cc-ann cc-change is-monthly" data-cc-change="${m}">([\\s\\S]*?)</g>`));
    assert.ok(g, m);
    assert.match(g[1], /<rect class="cc-ann-glyph"/);
  }
  const bands = [...svg.matchAll(/<rect class="cc-change-band" x="([\d.]+)" y="[\d.]+" width="([\d.]+)"/g)];
  assert.equal(bands.length, 1);
  assert.equal(Number(bands[0][1]), x('2026-12'));
  assert.ok(Math.abs(Number(bands[0][1]) + Number(bands[0][2]) - (model.W - model.padR)) < 0.2, 'band runs to the right edge');
  // Out-of-range markers are ignored; the legend explains the glyphs.
  assert.doesNotMatch(html, /Out of range/);
  assert.match(html, /<span class="key cc-key-once" aria-hidden="true"><\/span>One-time/);
  assert.match(html, /<span class="key cc-key-monthly" aria-hidden="true"><\/span>Monthly from/);
  // Presentation only: scale and series model unchanged; without markers nothing is drawn.
  assert.deepEqual(yTicks(html), yTicks(plain));
  assert.deepEqual(modelOf(html).months.map(m => m.rows), modelOf(plain).months.map(m => m.rows));
  assert.doesNotMatch(plain, /cc-ann|cc-change|Planned changes|One-time/);
});

test('markers: labels never overlap (a second row, else left out with the dot kept); a shared pack names the month; goals get a diamond', () => {
  const crowd = MONTHS.slice(0, 5).map(m => ({ month: m, label: 'A long change name number ' + m, title: 'Full ' + m, kind: 'oneTime', cents: -1000 }));
  const html = cashChart({ ...base, mode: 'balance', markers: crowd.concat([
    { month: MONTHS[9], label: 'Diapers', pack: 'New baby', kind: 'monthly', cents: 8000 },
    { month: MONTHS[9], label: 'Formula', pack: 'New baby', kind: 'monthly', cents: 15000 },
    { month: MONTHS[10], label: 'Emergency cushion', title: 'Emergency cushion', kind: 'goal', cents: 1500000 },
  ]) });
  const svg = svgOf(html);
  const labels = [...svg.matchAll(/<text class="cc-ann-label" x="([\d.]+)" y="([\d.]+)" text-anchor="(start|end)">([^<]*)<\/text>/g)]
    .map(m => ({ x: Number(m[1]), y: Number(m[2]), anchor: m[3], text: m[4] }));
  const span = l => { const w = l.text.length * 5.9; return l.anchor === 'start' ? [l.x, l.x + w] : [l.x - w, l.x]; };
  for (const a of labels) for (const b of labels) {
    if (a === b || a.y !== b.y) continue;
    const [a0, a1] = span(a), [b0, b1] = span(b);
    assert.ok(a1 <= b0 || b1 <= a0, `“${a.text}” and “${b.text}” overlap`);
  }
  assert.ok(new Set(labels.map(l => l.y)).size <= 2, 'two rows at most');
  const W = modelOf(html).W;
  assert.ok(labels.every(l => span(l)[0] >= 0 && span(l)[1] <= W), 'every label inside the drawing');
  assert.equal((svg.match(/<g class="cc-ann /g) || []).length, 7, 'every month keeps its marker');
  assert.ok(labels.length < 7, 'what does not fit is left out');
  assert.ok(labels.some(l => l.text === 'New baby'), 'a month whose markers share a pack is named after it');
  const goal = svg.match(new RegExp(`<g class="cc-ann is-goal" data-cc-change="${MONTHS[10]}">([\\s\\S]*?)</g>`));
  assert.ok(goal && /<path class="cc-ann-glyph" d="M[\d.]+ [\d.]+L/.test(goal[1]), 'a goal is a diamond, not a change');
  const model = modelOf(html);
  assert.deepEqual(model.months[10].pc, ['Goal reached: Emergency cushion ($15,000)']);
  assert.deepEqual(model.months[0].pc, ['Planned: Full ' + MONTHS[0] + ' −$10 (one-time)'], 'the readout uses the full title');
  assert.match(html, /1 savings goal is reached in these months\./);
  assert.match(html, /<span class="key cc-key-goal" aria-hidden="true"><\/span>Goal reached/);
});

test('compare: a what-if line in its own colour and legend chip, in the readout and the table, never the low point or the summary line', () => {
  const months = MONTHS.slice(0, 8);
  const real = [120000, 90000, 80000, 70000, 60000, 50000, 40000, 30000];
  const what = [null, null, null, 70000, 40000, 10000, -20000, -50000];
  const html = cashChart({
    id: 'cmp', title: 'Compare', mode: 'balance', months, todayMonth: months[2], planStart: months[3],
    lines: [
      { key: 'combined', name: 'Combined cash', role: 'combined', points: months.map((m, i) => ({ month: m, cents: real[i], status: i >= 3 ? 'projected' : 'recorded' })) },
      { key: 'compare', name: 'New baby', role: 'compare', points: months.map((m, i) => ({ month: m, cents: what[i], status: what[i] === null ? null : 'projected' })) },
    ],
  });
  assert.match(html, /<g class="cc-series series-compare cc-compare" data-cc-series="compare">/);
  assert.ok(pathsWith(html, 'cc-compare-line').length >= 1);
  assert.match(html, /<button type="button" class="cc-chip"[^>]*data-cc-key="compare"[^>]*><span class="key key-line series-compare"/);
  assert.doesNotMatch(html, /is-emph|cc-low-label/, 'only the real lines decide the zero emphasis and the low point');
  const model = modelOf(html);
  assert.deepEqual(model.months[5].rows.map(r => [r.n, r.g || '', r.v]), [['Combined cash', '', '$500'], ['New baby', 'compare', '$100']]);
  assert.equal(model.months[1].rows.length, 1, 'no what-if row before the plan');
  assert.match(html, /<th scope="col"[^>]*>New baby<\/th>/);
  assert.match(html, /New baby, for comparison: −\$500 in [A-Z][a-z]+ \d{4}\./);
  assert.ok(yTicks(html).some(t => t.startsWith('−$')), 'the scale reaches the what-if');
});

test('change markers: readout lines, a Planned changes table column and a count in the summary, in every mode', () => {
  for (const mode of ['balance', 'flows']) {
    const html = cashChart({ ...base, mode, markers: MARKERS });
    const model = modelOf(html);
    assert.deepEqual(model.months[MONTHS.indexOf('2026-11')].pc, ['Planned: Car seat −$250 (one-time)', 'Planned: Stroller −$180 (one-time)'], mode);
    assert.deepEqual(model.months[MONTHS.indexOf('2026-12')].pc, ['Planned: Raise +$300 (monthly)']);
    assert.equal(model.months[0].pc, undefined);
    assert.match(html, /<th scope="col" class=" ">Planned changes<\/th>/);
    assert.match(html, /<td class=" ">Car seat −\$250 \(one-time\); Stroller −\$180 \(one-time\)<\/td><\/tr>/);
    assert.match(html, /4 planned changes are marked on the timeline\./);
    assert.match(svgOf(html), /data-cc-change="2027-01"/);
  }
  // A marker without an amount shows its label alone.
  const bare = modelOf(cashChart({ ...base, mode: 'balance', markers: [{ month: '2026-10', label: 'New phone plan', kind: 'monthly' }] }));
  assert.deepEqual(bare.months[MONTHS.indexOf('2026-10')].pc, ['Planned: New phone plan (monthly)']);
});

// ------------------------------------------------------------------ series colours
test('six distinct series colours: five out-flows (four coloured + Other) beside two in-flows, and series-6 in both themes', () => {
  const v = n => MONTHS.map(() => n);
  const flows = cashChart({ ...base, mode: 'flows', columns: {
    in: [{ key: 'p1', name: 'Rowan → joint', values: v(300000) }, { key: 'p2', name: 'Quinn → joint', values: v(250000) }],
    out: [
      { key: 'essentials', name: 'Essentials', values: v(200000) },
      { key: 'flexible', name: 'Flexible', values: v(120000) },
      { key: 'irregular', name: 'Irregular', values: v(50000) },
      { key: 'to-savings', name: 'To savings', values: v(60000) },
      { key: 'out-other', name: 'Other', values: v(20000) },
    ],
  } });
  const clsOf = key => flows.match(new RegExp(`<g class="cc-series (series-[\\w]+) cc-col-series" data-cc-series="${key}">`))[1];
  const outCls = ['essentials', 'flexible', 'irregular', 'to-savings'].map(clsOf);
  assert.deepEqual(outCls, ['series-5', 'series-4', 'series-3', 'series-6'], 'existing defaults kept; the fourth coloured out-flow takes series-6');
  assert.equal(clsOf('out-other'), 'series-muted');
  const all = [clsOf('p1'), clsOf('p2'), ...outCls];
  assert.equal(new Set(all).size, 6, 'six distinct colours: ' + all.join(', '));
  // Explicit classes win (the recommended mapping keeps To savings on series-3, like From savings).
  const explicit = cashChart({ ...base, mode: 'flows', columns: { in: [], out: [
    { key: 'essentials', name: 'Essentials', cls: 'series-5', values: v(1) }, { key: 'flexible', name: 'Flexible', cls: 'series-4', values: v(1) },
    { key: 'irregular', name: 'Irregular', cls: 'series-6', values: v(1) }, { key: 'to-savings', name: 'To savings', cls: 'series-3', values: v(1) },
    { key: 'out-other', name: 'Other', cls: 'series-muted', values: v(1) },
  ] } });
  assert.match(explicit, /<g class="cc-series series-6 cc-col-series" data-cc-series="irregular">/);
  assert.match(explicit, /data-cc-key="irregular" aria-pressed="true"><span class="key key-swatch series-6"/);
  // Trends lines follow the categorical order, one colour each.
  const six = ['a', 'b', 'c', 'd', 'e', 'f'].map((k, i) => ({ key: k, name: k.toUpperCase(), values: v(10000 * (i + 1)) }));
  const trends = cashChart({ ...base, mode: 'trends', trends: { series: six } });
  assert.deepEqual(six.map(s => trends.match(new RegExp(`<g class="cc-series (series-\\d) cc-trend-series" data-cc-series="${s.key}">`))[1]), ['series-1', 'series-2', 'series-3', 'series-4', 'series-5', 'series-6']);
  // The token and its uses exist in both themes.
  const css = require('node:fs').readFileSync(path.join(SRC, 'styles/chart.css'), 'utf8');
  assert.match(css, /^:root \{[^}]*--series-6: #[0-9a-f]{6};/m);
  assert.match(css, /prefers-color-scheme: dark\)[\s\S]*?:root:where\(:not\(\[data-theme="light"\]\)\) \{[^}]*--series-6: #[0-9a-f]{6};/);
  for (const sel of ['.key-line.series-6', '.key-swatch.series-6', '.chart .line.series-6', '.chart .end-dot.series-6', '.chart .seg.series-6']) assert.ok(css.includes(sel + ' {'), sel);
});

// ------------------------------------------------------------------ trends mode
const { movingAverage, linearTrend } = UI.chart.stats;
const reEsc = s => String(s).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg || ''} ${a} != ${b}`);

test('stats.movingAverage: trailing mean over n positions, nulls skipped, null before n positions', () => {
  assert.deepEqual(movingAverage([100, 200, 300, 400, 500], 3), [null, null, 200, 300, 400]);
  assert.deepEqual(movingAverage([100, null, 300, 500], 2), [null, 100, 300, 400], 'a null is skipped, not counted as zero');
  assert.deepEqual(movingAverage([null, null, 700], 2), [null, null, 700]);
  assert.deepEqual(movingAverage([5, null, null, 9], 2), [null, 5, null, 9], 'a window with no known value is null');
  assert.deepEqual(movingAverage([1, 2, 4], 6), [null, null, null], 'fewer than n months: all null');
  assert.deepEqual(movingAverage([1, 2, 4], 0), [null, null, null]);
  assert.deepEqual(movingAverage([1, 2], 1), [1, 2]);
  near(movingAverage([100, 101, 103], 3)[2], 304 / 3, 'unrounded number out');
  assert.deepEqual(movingAverage(null, 3), []);
});

test('stats.linearTrend: least squares over the known values, fitted at every position', () => {
  const exact = linearTrend([100, 200, 300, 400]);
  near(exact.slope, 100); near(exact.intercept, 100);
  assert.deepEqual(exact.fit.map(v => Math.round(v * 1e6) / 1e6), [100, 200, 300, 400]);
  // Nulls are ignored, and the fit still extends across them and past the end.
  const gappy = linearTrend([1000, null, 1400, 1300, null]);
  near(gappy.slope, 800 / 7, 'slope');
  near(gappy.intercept, 7300 / 7, 'intercept');
  assert.equal(gappy.fit.length, 5);
  near(gappy.fit[1], 7300 / 7 + 800 / 7);
  near(gappy.fit[4], 7300 / 7 + 4 * 800 / 7);
  const flat = linearTrend([5000, 5000, 5000]);
  near(flat.slope, 0); near(flat.intercept, 5000);
  for (const few of [[], [null, 7], [3]]) {
    const t = linearTrend(few);
    assert.equal(t.slope, null); assert.equal(t.intercept, null);
    assert.deepEqual(t.fit, few.map(() => null));
  }
});

const TREND_MONTHS = monthsFrom('2026-03', 10); // Mar 2026 .. Dec 2026; plan from Oct
const groceries = [60000, 64000, 62000, 70000, 68000, 74000, 72000, 80000, 82000, 84000];
const dining = [30000, 28000, null, 26000, 25000, 24000, 23000, 22000, 21000, 20000];
const trendSpec = (extra = {}) => ({
  id: 'tr', title: 'Spending by month', mode: 'trends', months: TREND_MONTHS, todayMonth: '2026-09', planStart: '2026-10',
  trends: { ma: 3, trend: true, series: [{ key: 'groc', name: 'Groceries', values: groceries }, { key: 'din', name: 'Dining', values: dining }] },
  ...extra,
});

test('trends mode: series, moving-average and trend lines with their own classes; plan months dashed', () => {
  const html = cashChart(trendSpec());
  const model = modelOf(html);
  const xs = model.months.map(m => m.x);
  const planIdx = TREND_MONTHS.indexOf('2026-10'), lastActual = planIdx - 1;
  assert.match(html, /Monthly, \$ per month/);
  assert.equal(model.mode, 'trends');
  assert.match(html, /<g class="cc-series series-1 cc-trend-series" data-cc-series="groc">/);
  const of = (cls, series) => pathsWith(html, cls).filter(p => new RegExp(`\\b${series}\\b`).test(p.cls));
  const main = pathsWith(html, 'series-1').filter(p => !/cc-ma-line|cc-trend-line/.test(p.cls));
  // Series: solid through the actual months, dashed from the last actual point.
  const solid = main.filter(p => !/is-projected/.test(p.cls)), dashed = main.filter(p => /is-projected/.test(p.cls));
  assert.equal(solid.length, 1); assert.equal(dashed.length, 1);
  assert.deepEqual(pointsOf(solid[0].d).map(p => p[0]), xs.slice(0, planIdx));
  assert.deepEqual(pointsOf(dashed[0].d).map(p => p[0]), xs.slice(lastActual));
  // Moving average: own class, starts at the third month, actual months only.
  const ma = of('cc-ma-line', 'series-1');
  assert.equal(ma.length, 1);
  assert.deepEqual(pointsOf(ma[0].d).map(p => p[0]), xs.slice(2, planIdx));
  assert.equal(ma[0].cls, 'line cc-ma-line series-1');
  // Trend: thin solid across the actual months, dotted across the plan.
  const trend = of('cc-trend-line', 'series-1');
  assert.deepEqual(trend.map(p => p.cls), ['line cc-trend-line series-1', 'line cc-trend-line is-extended series-1']);
  assert.deepEqual(pointsOf(trend[0].d).map(p => p[0]), [xs[0], xs[lastActual]]);
  assert.deepEqual(pointsOf(trend[1].d).map(p => p[0]), [xs[lastActual], xs[TREND_MONTHS.length - 1]]);
  // The fitted line is straight: equal steps per month on screen.
  const y0 = pointsOf(trend[0].d)[0][1], y1 = pointsOf(trend[0].d)[1][1], y2 = pointsOf(trend[1].d)[1][1];
  near(Math.round(((y1 - y0) / lastActual) * 10), Math.round(((y2 - y1) / (TREND_MONTHS.length - 1 - lastActual)) * 10));
  // A null month breaks the series line (no bridge) and the dining average skips it.
  const din = pathsWith(html, 'series-2').filter(p => !/cc-ma-line|cc-trend-line|is-projected/.test(p.cls));
  assert.ok(!din.flatMap(p => pointsOf(p.d)).some(p => p[0] === xs[2]), 'nothing drawn at the unknown month');
  // Legend: one chip per series (slope in its tooltip), and the MA and Trend keys.
  const slope = linearTrend(groceries.slice(0, planIdx)).slope;
  const slopeText = '+$' + Math.round(slope / 100) + '/mo';
  assert.match(html, new RegExp(`data-cc-key="groc" aria-pressed="true" title="Trend ${reEsc(slopeText)}"><span class="key key-line series-1"`));
  assert.match(html, /<span class="key key-line cc-key-ma cc-key-ink" aria-hidden="true"><\/span>MA 3<\/span>/);
  assert.match(html, /<span class="key key-line cc-key-trend cc-key-ink" aria-hidden="true"><\/span>Trend<\/span>/);
  assert.match(html, /<span class="key key-line key-dashed" aria-hidden="true"><\/span>Plan \(estimate\)/);
  // Same timeline as the other modes.
  const bal = modelOf(cashChart({ ...trendSpec(), mode: 'balance', lines: [{ key: 'c', name: 'C', role: 'combined', points: TREND_MONTHS.map((m, i) => ({ month: m, cents: groceries[i] })) }] }));
  assert.deepEqual(xs, bal.months.map(m => m.x));
});

test('trends mode: readout lists value, average and fit with the slope; table gets MA and trend columns', () => {
  const html = cashChart(trendSpec());
  const model = modelOf(html);
  const planIdx = TREND_MONTHS.indexOf('2026-10');
  const t = linearTrend(groceries.map((v, i) => (i < planIdx ? v : null)));
  const slopeText = '+$' + Math.round(t.slope / 100) + '/mo';
  const money = c => '$' + Math.round(c / 100).toLocaleString('en-US');
  // May (index 2): the first month with a 3-month average.
  const may = model.months[2].rows.filter(r => r.k === 'groc');
  assert.deepEqual(may.map(r => [r.g || 'value', r.n, r.v]), [
    ['value', 'Groceries', money(groceries[2])],
    ['ma', 'MA 3', money((groceries[0] + groceries[1] + groceries[2]) / 3)],
    ['trend', 'Trend', money(t.fit[2])],
  ]);
  assert.equal(may[0].s, 'trend ' + slopeText);
  // Before three months exist there is no average row.
  for (const i of [0, 1]) assert.ok(!model.months[i].rows.some(r => r.g === 'ma'), 'no MA in month ' + i);
  // Plan months: value and fit, no average (it uses actual months only).
  const dec = model.months[TREND_MONTHS.length - 1].rows.filter(r => r.k === 'groc');
  assert.deepEqual(dec.map(r => r.g || 'value'), ['value', 'trend']);
  assert.equal(dec[1].v, money(t.fit[TREND_MONTHS.length - 1]));
  assert.equal(model.months[TREND_MONTHS.length - 1].p, 'Plan');
  // Dining's slope is negative and says so.
  const dSlope = linearTrend(dining.map((v, i) => (i < planIdx ? v : null))).slope;
  assert.ok(dSlope < 0);
  assert.equal(model.months[0].rows.find(r => r.k === 'din').s, 'trend −$' + Math.abs(Math.round(dSlope / 100)) + '/mo');
  // Table twin.
  assert.match(html, /<th scope="col" class="num ">Groceries<\/th><th scope="col" class="num ">Groceries MA 3<\/th><th scope="col" class="num ">Groceries trend \(\+\$\d+\/mo\)<\/th><th scope="col" class="num ">Dining<\/th>/);
  assert.match(html, new RegExp(`<th scope="row" class=" ">Mar 2026</th><td class=" ">Recorded</td><td class="num ">${reEsc(money(groceries[0]))}</td><td class="num ">—</td><td class="num ">${reEsc(money(t.fit[0]))}</td>`));
  assert.equal(tbodyRows(html), TREND_MONTHS.length);
  // Summary.
  assert.match(html, new RegExp(`In actual months, Groceries averaged \\$[\\d,]+ a month \\(trend ${reEsc(slopeText)}\\); Dining averaged`));
  // Hiding a series hides its average and trend with it (one group), and changes nothing else.
  const hidden = cashChart(trendSpec({ hidden: ['groc'] }));
  assert.match(hidden, /<g class="cc-series series-1 cc-trend-series is-hidden" data-cc-series="groc">/);
  assert.deepEqual(modelOf(hidden), model);
});

test('trends mode: average and trend are optional; nothing extra drawn without them', () => {
  const html = cashChart(trendSpec({ trends: { series: [{ key: 'groc', name: 'Groceries', values: groceries }] } }));
  assert.doesNotMatch(html, /cc-ma-line|cc-trend-line|MA 3|>Trend<| title="Trend/);
  assert.doesNotMatch(html, /Groceries MA|Groceries trend/);
  assert.deepEqual(modelOf(html).months[5].rows.map(r => r.g || 'value'), ['value']);
  // MA 6 over ten months with plan from October: defined only for August and September.
  const six = modelOf(cashChart(trendSpec({ trends: { ma: 6, series: [{ key: 'groc', name: 'Groceries', values: groceries }] } })));
  assert.deepEqual(six.months.map(m => m.rows.some(r => r.g === 'ma')), [false, false, false, false, false, true, true, false, false, false]);
  // Empty or missing series: the empty state, never a broken chart.
  assert.match(cashChart(trendSpec({ trends: { series: [] } })), /Not enough known values/);
  assert.match(cashChart(trendSpec({ trends: null })), /Not enough known values/);
});

test('trends mode: a month-end series (unit atMonthEnd) is summarized by where it ended, a monthly one by its average', () => {
  const savings = [500000, 510000, 515000, 530000, 540000, 550000, 565000, 575000, 590000, 600000];
  const html = cashChart(trendSpec({ trends: { trend: true, series: [
    { key: 'groc', name: 'Groceries', values: groceries },
    { key: 'sav', name: 'Joint savings balance', unit: 'atMonthEnd', values: savings },
  ] } }));
  const planIdx = TREND_MONTHS.indexOf('2026-10');
  const label = html.match(/role="img" aria-label="([^"]*)"/)[1];
  const slope = linearTrend(savings.map((v, i) => (i < planIdx ? v : null))).slope;
  const money = c => '$' + Math.round(c / 100).toLocaleString('en-US');
  // September is the last actual month: the balance is read there, never averaged.
  assert.ok(label.includes(`Joint savings balance ended at ${money(savings[planIdx - 1])} in Sep 2026 (trend +${money(Math.round(slope / 100) * 100)}/mo)`), label);
  assert.ok(!/Joint savings balance averaged/.test(label), label);
  assert.match(label, /In actual months, Groceries averaged \$[\d,]+ a month \(trend \+\$\d+\/mo\); Joint savings balance ended at /);
  // Without a unit a series is a monthly amount, as before.
  assert.match(cashChart(trendSpec({ trends: { series: [{ key: 'sav', name: 'Joint savings balance', values: savings }] } })), /Joint savings balance averaged \$[\d,]+ a month/);
});

test('new options never print NaN or undefined', () => {
  const cases = [
    cashChart(trendSpec({ markers: MARKERS })),
    cashChart(trendSpec({ trends: { ma: 3, trend: true, series: [{ key: 'one', name: 'One point', values: [5000] }, { key: 'bad', name: 'Bad', values: [NaN, 'x', Infinity] }] } })),
    cashChart(trendSpec({ planStart: null, todayMonth: null })),
    withGhost({ markers: [{ month: '2026-01', label: '' }, null, { month: 'nope' }, { month: '2026-02', label: 'X', cents: NaN, kind: 'weird' }] }),
    cashChart({ ...base, mode: 'balance', lines: [{ key: 'g', role: 'ghost', points: [{ month: '2026-01', cents: null }] }] }),
  ];
  for (const html of cases) assert.doesNotMatch(html, /NaN|undefined|Infinity/);
});
