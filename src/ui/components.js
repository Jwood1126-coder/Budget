'use strict';
/*
 * Reusable HTML-string components. Every component escapes its inputs. Charts always ship
 * with a table alternative and keyboard/hover readouts (see app.js tooltip handling):
 *   - marks carry data-tip-title / data-tip-rows, read by the shared tooltip
 *   - line charts are one tab stop; arrow keys move the crosshair
 * Colours come from CSS custom properties (--series-1..3, status tokens) so light/dark
 * themes stay consistent.
 */
(function (root) {
  const UI = root.BudgetUI || (root.BudgetUI = {});
  const { esc, attrs } = UI.dom;
  const fmt = UI.fmt;

  // ------------------------------------------------------------------ layout bits
  function pageHeader({ title, eyebrow, subtitle, actions = '', id = 'page-title' }) {
    return `<header class="page-header">
      <div class="page-header-text">
        ${eyebrow ? `<p class="eyebrow">${esc(eyebrow)}</p>` : ''}
        <h1 id="${esc(id)}" tabindex="-1">${esc(title)}</h1>
        ${subtitle ? `<p class="page-subtitle">${subtitle}</p>` : ''}
      </div>
      ${actions ? `<div class="page-actions">${actions}</div>` : ''}
    </header>`;
  }

  /** items: [{ label, href? }] — the last item is the current location. */
  function breadcrumbs(items) {
    if (!items || items.length < 2) return '';
    return `<nav class="breadcrumbs" aria-label="Breadcrumb"><ol>${items.map((it, i) => {
      const last = i === items.length - 1;
      return `<li>${last || !it.href ? `<span${last ? ' aria-current="page"' : ''}>${esc(it.label)}</span>` : `<a href="${esc(it.href)}">${esc(it.label)}</a>`}</li>`;
    }).join('')}</ol></nav>`;
  }

  function card(body, { title, subtitle, actions = '', cls = '', id, headingLevel = 2 } = {}) {
    const h = 'h' + headingLevel;
    return `<section class="card ${esc(cls)}"${id ? ` id="${esc(id)}"` : ''}${title ? ` aria-labelledby="${esc((id || UI.dom.domId('card', title)) + '-h')}"` : ''}>
      ${title ? `<div class="card-head"><div><${h} id="${esc((id || UI.dom.domId('card', title)) + '-h')}">${esc(title)}</${h}>${subtitle ? `<p class="card-sub">${subtitle}</p>` : ''}</div>${actions ? `<div class="card-actions">${actions}</div>` : ''}</div>` : ''}
      ${body}
    </section>`;
  }

  const TONE_ICON = { good: '✓', warn: '!', bad: '!', info: 'i', neutral: '' };
  /** Status badge: never colour alone — tone adds an icon, text carries meaning. */
  function badge(text, tone = 'neutral', { title } = {}) {
    const icon = TONE_ICON[tone] || '';
    return `<span class="badge badge-${esc(tone)}"${title ? ` title="${esc(title)}"` : ''}>${icon ? `<span class="badge-icon" aria-hidden="true">${icon}</span>` : ''}${esc(text)}</span>`;
  }

  function notice({ tone = 'info', title, body = '', actions = '' }) {
    return `<div class="notice notice-${esc(tone)}" role="${tone === 'bad' ? 'alert' : 'note'}">
      <span class="notice-icon" aria-hidden="true">${TONE_ICON[tone] || 'i'}</span>
      <div class="notice-body">${title ? `<strong>${esc(title)}</strong>` : ''}${body ? `<div>${body}</div>` : ''}${actions ? `<div class="notice-actions">${actions}</div>` : ''}</div>
    </div>`;
  }

  /** A headline figure. `value` is pre-formatted text; `href` makes the whole tile a link. */
  function metric({ label, value, sub = '', tone = '', href, status }) {
    const inner = `<span class="metric-label">${esc(label)}</span>
      <span class="metric-value ${tone ? 'tone-' + esc(tone) : ''}">${esc(value)}</span>
      ${status ? `<span class="metric-status">${status}</span>` : ''}
      ${sub ? `<span class="metric-sub">${sub}</span>` : ''}`;
    return href ? `<a class="metric metric-link" href="${esc(href)}">${inner}</a>` : `<div class="metric">${inner}</div>`;
  }

  function empty(message, action = '') {
    return `<div class="empty"><p>${message}</p>${action}</div>`;
  }

  function disclosure(summary, body, { open = false, cls = '', id } = {}) {
    return `<details class="disclosure ${esc(cls)}"${id ? ` id="${esc(id)}"` : ''}${open ? ' open' : ''}><summary>${summary}</summary><div class="disclosure-body">${body}</div></details>`;
  }

  /** Radio-group style toggle. Changing it fires data-action with data-value. */
  function segmented({ label, name, options, value, action, hideLabel = false }) {
    return `<fieldset class="segmented" role="radiogroup">
      <legend class="${hideLabel ? 'sr-only' : 'segmented-legend'}">${esc(label)}</legend>
      <div class="segmented-options">${options.map(o => {
        const id = UI.dom.domId(name, o.value);
        return `<input type="radio" id="${esc(id)}" name="${esc(name)}" value="${esc(o.value)}"${String(o.value) === String(value) ? ' checked' : ''} data-action="${esc(action)}" data-value="${esc(o.value)}"><label for="${esc(id)}">${esc(o.label)}</label>`;
      }).join('')}</div>
    </fieldset>`;
  }

  function button(label, { action, variant = 'secondary', data = {}, type = 'button', disabled = false, ariaLabel, cls = '', id } = {}) {
    const dataAttrs = Object.fromEntries(Object.entries(data).map(([k, v]) => ['data-' + k, v]));
    return `<button${attrs({ id, type, class: `btn btn-${variant} ${cls}`.trim(), 'data-action': action, disabled, 'aria-label': ariaLabel, ...dataAttrs })}>${esc(label)}</button>`;
  }

  function linkButton(label, href, { variant = 'secondary', cls = '' } = {}) {
    return `<a class="btn btn-${esc(variant)} ${esc(cls)}" href="${esc(href)}">${esc(label)}</a>`;
  }

  // ------------------------------------------------------------------ tables
  /**
   * columns: [{ key, label, align: 'left'|'right', html?: (row) => string, text?: (row) => string, cls? }]
   * rows: data objects. Cells use column.html (trusted, already-escaped markup) or escaped column.text / row[key].
   */
  function table({ columns, rows, caption, footer = null, emptyText = 'Nothing to show.', cls = '', rowAttrs }) {
    if (!rows.length) return empty(esc(emptyText));
    const head = columns.map(c => `<th scope="col" class="${c.align === 'right' ? 'num' : ''} ${esc(c.cls || '')}">${esc(c.label)}</th>`).join('');
    const body = rows.map(r => `<tr${rowAttrs ? attrs(rowAttrs(r)) : ''}>${columns.map((c, i) => {
      const content = c.html ? c.html(r) : esc(c.text ? c.text(r) : r[c.key]);
      const tag = i === 0 ? 'th scope="row"' : 'td';
      return `<${tag} class="${c.align === 'right' ? 'num' : ''} ${esc(c.cls || '')}">${content}</${i === 0 ? 'th' : 'td'}>`;
    }).join('')}</tr>`).join('');
    const foot = footer ? `<tfoot><tr>${columns.map((c, i) => {
      const v = footer[c.key];
      const tag = i === 0 ? 'th scope="row"' : 'td';
      return `<${tag} class="${c.align === 'right' ? 'num' : ''}">${v === undefined ? '' : v}</${i === 0 ? 'th' : 'td'}>`;
    }).join('')}</tr></tfoot>` : '';
    return `<div class="table-wrap" tabindex="0" role="region" aria-label="${esc(caption || 'Table')}"><table class="table ${esc(cls)}">${caption ? `<caption class="sr-only">${esc(caption)}</caption>` : ''}<thead><tr>${head}</tr></thead><tbody>${body}</tbody>${foot}</table></div>`;
  }

  // ------------------------------------------------------------------ bar list
  /**
   * Horizontal bars with an optional reference marker (e.g. usual average).
   * items: [{ label, value (cents), href?, sub?, reference?: cents, referenceLabel?, badge? }]
   * The list itself is readable text, so it doubles as its own table alternative.
   */
  function barList({ items, label = 'Amounts', format = v => fmt.money(v, { whole: true }), referenceName = 'Usual' }) {
    if (!items.length) return empty('Nothing to show for this selection.');
    const max = Math.max(1, ...items.map(i => Math.max(Math.abs(i.value || 0), Math.abs(i.reference || 0))));
    return `<ul class="bar-list" aria-label="${esc(label)}">${items.map(it => {
      const width = Math.max(0, Math.min(100, (Math.abs(it.value || 0) / max) * 100));
      const ref = it.reference !== undefined && it.reference !== null && it.reference > 0 ? Math.min(100, (it.reference / max) * 100) : null;
      const name = it.href ? `<a href="${esc(it.href)}">${esc(it.label)}</a>` : `<span>${esc(it.label)}</span>`;
      const tipRows = [[it.label, format(it.value)], ...(ref !== null ? [[referenceName, format(it.reference)]] : [])];
      return `<li class="bar-row">
        <div class="bar-text"><span class="bar-name">${name}${it.sub ? `<small>${it.sub}</small>` : ''}</span><span class="bar-value">${esc(format(it.value))}${it.badge || ''}</span></div>
        <div class="bar-track" aria-hidden="true" data-tip-title="${esc(it.label)}" data-tip-rows="${esc(JSON.stringify(tipRows))}">
          <div class="bar-fill${it.value < 0 ? ' negative' : ''}" style="width:${width.toFixed(2)}%"></div>
          ${ref !== null ? `<div class="bar-ref" style="left:${ref.toFixed(2)}%"></div>` : ''}
        </div>
      </li>`;
    }).join('')}</ul>${items.some(i => i.reference > 0) ? `<p class="legend-line"><span class="key key-bar" aria-hidden="true"></span>Selected period <span class="key key-ref" aria-hidden="true"></span>${esc(referenceName)}</p>` : ''}`;
  }

  // ------------------------------------------------------------------ charts
  /** Phones get a narrower drawing so axis text is not scaled down to an unreadable size. */
  function isNarrow() { return typeof root.innerWidth === 'number' && root.innerWidth < 640; }

  function niceStep(range, targetTicks = 4) {
    const raw = range / Math.max(1, targetTicks);
    const mag = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1))));
    const norm = raw / mag;
    const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
    return step * mag;
  }
  function ticks(min, max, targetTicks = 4) {
    if (min === max) { max = min + 100; }
    const step = niceStep(max - min, targetTicks);
    const start = Math.floor(min / step) * step;
    const out = [];
    for (let v = start; v <= max + step * 0.001; v += step) out.push(Math.round(v));
    if (out[out.length - 1] < max) out.push(out[out.length - 1] + step);
    return out;
  }
  const compactMoney = cents => {
    if (cents === null || cents === undefined) return '';
    const d = cents / 100, a = Math.abs(d);
    const s = a >= 1e6 ? (a / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : a >= 1e3 ? (a / 1e3).toFixed(a >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'k' : a.toFixed(0);
    return (d < 0 ? '−$' : '$') + s;
  };

  /**
   * Line chart for monthly series (e.g. cumulative cash change per scenario).
   * series: [{ name, values: (cents|null)[] }] (max 3; colours --series-1..3 in this order)
   * labels: month strings, same length as values. Null values break the line.
   */
  /**
   * Line chart over months. series: [{ name, values: cents|null[], cls?, noEndLabel? }].
   * With `projectFrom` (index of the first projected month) the lines turn dashed after the last
   * actual month, a "Today" line marks the switch and tooltips/table rows say "projected".
   */
  function lineChart({ id, title, description = '', series, labels, format = v => fmt.money(v, { whole: true }), tableCaption, projectFrom = null, nowLabel = 'Today' }) {
    const narrow = isNarrow();
    const tiny = narrow && root.innerWidth < 400;
    const W = tiny ? 360 : narrow ? 420 : 760, H = narrow ? 240 : 260, padL = narrow ? 46 : 64, padR = narrow ? 58 : 96, padT = 16, padB = 32;
    const all = series.flatMap(s => s.values).filter(v => v !== null && v !== undefined);
    if (!all.length || !labels.length) return empty('Not enough known values to draw this chart yet.');
    const t = ticks(Math.min(0, ...all), Math.max(0, ...all));
    const min = t[0], max = t[t.length - 1];
    const x = i => padL + (labels.length === 1 ? (W - padL - padR) / 2 : (i / (labels.length - 1)) * (W - padL - padR));
    const y = v => padT + (1 - (v - min) / (max - min || 1)) * (H - padT - padB);
    const projecting = Number.isInteger(projectFrom) && projectFrom > 0 && projectFrom < labels.length;
    const isProjected = i => projecting && i >= projectFrom;
    const grid = t.map(v => `<line class="grid${v === 0 ? ' zero' : ''}" x1="${padL}" x2="${W - padR}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text class="axis" x="${padL - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${esc(compactMoney(v))}</text>`).join('');
    const every = Math.max(1, Math.ceil(labels.length / (narrow ? 4 : 8)));
    // Show evenly spaced labels; the last label replaces a near neighbour instead of colliding with it.
    const showX = i => i === labels.length - 1 || (i % every === 0 && labels.length - 1 - i >= every);
    const xlab = labels.map((m, i) => showX(i) ? `<text class="axis" x="${x(i).toFixed(1)}" y="${H - 10}" text-anchor="middle">${esc(fmt.month(m))}</text>` : '').join('');
    const clsOf = (s, si) => s.cls || 'series-' + (si + 1);
    const pathOf = (values, from, to) => {
      let d = '', pen = false;
      for (let i = from; i <= to; i++) {
        const v = values[i];
        if (v === null || v === undefined) { pen = false; continue; }
        d += (pen ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1) + ' ';
        pen = true;
      }
      return d.trim();
    };
    const ends = [];
    const lines = series.map((s, si) => {
      const cls = clsOf(s, si);
      const last = labels.length - 1;
      const solid = projecting ? pathOf(s.values, 0, projectFrom - 1) : pathOf(s.values, 0, last);
      const dashed = projecting ? pathOf(s.values, projectFrom - 1, last) : '';
      const lastIdx = s.values.map((v, i) => (v === null || v === undefined ? -1 : i)).filter(i => i >= 0).pop();
      if (lastIdx !== undefined && !s.noEndLabel) ends.push({ si, cls, x: x(lastIdx), y: y(s.values[lastIdx]), v: s.values[lastIdx] });
      return (solid ? `<path class="line ${esc(cls)}" d="${solid}"/>` : '') + (dashed ? `<path class="line is-projected ${esc(cls)}" d="${dashed}"/>` : '');
    }).join('');
    // End labels are nudged apart so lines ending close together stay readable.
    ends.sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 13) ends[i].y = ends[i - 1].y + 13;
    const endMarks = ends.map(e => `<circle class="end-dot ${esc(e.cls)}" cx="${e.x.toFixed(1)}" cy="${y(e.v).toFixed(1)}" r="4.5"/><text class="end-label" x="${(e.x + 9).toFixed(1)}" y="${(e.y + 4).toFixed(1)}">${esc(compactMoney(e.v))}</text>`).join('');
    const now = projecting ? `<rect class="projection-zone" x="${x(projectFrom - 1).toFixed(1)}" y="${padT}" width="${(W - padR - x(projectFrom - 1)).toFixed(1)}" height="${H - padT - padB}"/>
        <line class="now-line" x1="${x(projectFrom - 1).toFixed(1)}" x2="${x(projectFrom - 1).toFixed(1)}" y1="${padT}" y2="${H - padB}"/>
        <text class="now-label" x="${(x(projectFrom - 1) + 4).toFixed(1)}" y="${padT + 10}">${esc(nowLabel)}</text>` : '';
    const monthTitle = i => fmt.monthLong(labels[i]) + (isProjected(i) ? ' · projected' : '');
    const points = labels.map((m, i) => JSON.stringify({ x: x(i), title: monthTitle(i), rows: series.map((s, si) => [s.name, format(s.values[i] ?? null), clsOf(s, si)]) }));
    const legend = series.length > 1 || projecting ? `<ul class="chart-legend">${series.map((s, si) => `<li><span class="key key-line ${esc(clsOf(s, si))}" aria-hidden="true"></span>${esc(s.name)}</li>`).join('')}${projecting ? '<li><span class="key key-line key-dashed" aria-hidden="true"></span>Dashed: projected</li>' : ''}</ul>` : '';
    const chartId = esc(id || UI.dom.domId('chart', title));
    const summary = series.map(s => {
      const known = s.values.filter(v => v !== null && v !== undefined);
      return `${s.name}: ends at ${format(known[known.length - 1] ?? null)}, lowest ${format(known.length ? Math.min(...known) : null)}`;
    }).join('. ');
    const tableRows = labels.map((m, i) => ({ month: fmt.month(m) + (isProjected(i) ? ' (projected)' : ''), ...Object.fromEntries(series.map((s, si) => ['s' + si, format(s.values[i] ?? null)])) }));
    return `<figure class="chart" id="${chartId}">
      ${legend}
      <svg class="line-chart" viewBox="0 0 ${W} ${H}" role="img" tabindex="0" aria-label="${esc(title + '. ' + (projecting ? 'Actual months, then projected months after ' + fmt.month(labels[projectFrom - 1]) + '. ' : '') + summary + '. Use left and right arrow keys to read each month; a table follows.')}" data-chart="line" data-points="${esc('[' + points.join(',') + ']')}" data-plot="${padT},${H - padB}">
        ${now}${grid}${xlab}${lines}${endMarks}
        <line class="crosshair" x1="0" x2="0" y1="${padT}" y2="${H - padB}" visibility="hidden"/>
        <rect class="hit" x="${padL}" y="${padT}" width="${W - padL - padR}" height="${H - padT - padB}"/>
      </svg>
      ${description ? `<figcaption>${description}</figcaption>` : ''}
      <details class="chart-table"><summary>Show as a table</summary>${table({ caption: tableCaption || title, columns: [{ key: 'month', label: 'Month' }, ...series.map((s, si) => ({ key: 's' + si, label: s.name, align: 'right' }))], rows: tableRows })}</details>
    </figure>`;
  }

  /**
   * Column chart for one monthly series (e.g. spending by month). Negative values hang below zero.
   * items: [{ label (month), value: cents|null, href?, note? }]
   */
  function columnChart({ title, items, format = v => fmt.money(v, { whole: true }), highlight }) {
    const vals = items.map(i => i.value).filter(v => v !== null && v !== undefined);
    if (!vals.length) return empty('No known values to chart yet.');
    const narrow = isNarrow();
    const W = narrow ? 420 : 760, H = narrow ? 220 : 220, padL = narrow ? 44 : 60, padR = 12, padT = 18, padB = 30;
    const t = ticks(Math.min(0, ...vals), Math.max(0, ...vals));
    const min = t[0], max = t[t.length - 1];
    const y = v => padT + (1 - (v - min) / (max - min || 1)) * (H - padT - padB);
    const band = (W - padL - padR) / items.length;
    const bw = Math.max(4, Math.min(24, band * 0.6));
    const grid = t.map(v => `<line class="grid${v === 0 ? ' zero' : ''}" x1="${padL}" x2="${W - padR}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text class="axis" x="${padL - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${esc(compactMoney(v))}</text>`).join('');
    const every = Math.max(1, Math.ceil(items.length / (narrow ? 6 : 12)));
    let yearShown = null;
    const cols = items.map((it, i) => {
      const cx = padL + band * i + band / 2;
      const shown = i % every === 0 || i === items.length - 1;
      let text = fmt.month(it.label);
      if (shown) {
        // Print the year only when it changes from the previous printed label.
        const year = String(it.label).slice(0, 4);
        if (year === yearShown) text = text.replace(/ \d{4}$/, '');
        yearShown = year;
      }
      const label = shown ? `<text class="axis" x="${cx.toFixed(1)}" y="${H - 10}" text-anchor="middle">${esc(text)}</text>` : '';
      if (it.value === null || it.value === undefined) return label;
      const top = Math.min(y(it.value), y(0)), h = Math.max(1, Math.abs(y(it.value) - y(0)));
      const r = Math.min(4, h / 2), neg = it.value < 0;
      // Rounded data end, square at the baseline.
      const path = neg
        ? `M${(cx - bw / 2).toFixed(1)} ${top.toFixed(1)}h${bw.toFixed(1)}v${(h - r).toFixed(1)}q0 ${r} ${-r} ${r}h${(-(bw - 2 * r)).toFixed(1)}q${-r} 0 ${-r} ${-r}z`
        : `M${(cx - bw / 2).toFixed(1)} ${(top + h).toFixed(1)}v${(-(h - r)).toFixed(1)}q0 ${-r} ${r} ${-r}h${(bw - 2 * r).toFixed(1)}q${r} 0 ${r} ${r}v${(h - r).toFixed(1)}z`;
      const tip = esc(JSON.stringify([[title, format(it.value)], ...(it.note ? [['', it.note]] : [])]));
      const mark = `<path class="column${highlight === it.label ? ' is-highlight' : ''}${it.muted ? ' is-muted' : ''}" d="${path}"/>`;
      const hit = `<rect class="hit-col" x="${(cx - band / 2).toFixed(1)}" y="${padT}" width="${band.toFixed(1)}" height="${H - padT - padB}" data-tip-title="${esc(fmt.monthLong(it.label))}" data-tip-rows="${tip}"/>`;
      return it.href ? `<a href="${esc(it.href)}" tabindex="-1" aria-label="${esc(fmt.monthLong(it.label) + ': ' + format(it.value))}">${mark}${hit}</a>${label}` : mark + hit + label;
    }).join('');
    return `<figure class="chart">
      <svg class="column-chart" viewBox="0 0 ${W} ${H}" role="group" aria-label="${esc(title)}">${grid}${cols}</svg>
      <details class="chart-table"><summary>Show as a table</summary>${table({ caption: title, columns: [{ key: 'm', label: 'Month' }, { key: 'v', label: title, align: 'right' }, { key: 'n', label: 'Note' }], rows: items.map(it => ({ m: fmt.monthLong(it.label), v: format(it.value ?? null), n: it.note || '' })) })}</details>
    </figure>`;
  }

  /**
   * Stacked columns over months: each column stacks `stacks` (positive parts up from zero,
   * negative parts down), with the stack's total printed above it. An optional `side` series is a
   * narrower column beside each stack (e.g. money nobody is assigned to: shown apart, never added
   * in). `stacks[i].hatched` (cents per month, part of that segment) is drawn striped and named
   * `hatchedName` in the legend, tooltip and table. Null = not known (no column).
   * stacks: [{ name, cls, values: (cents|null)[], hatched?: (cents|null)[] }]; side: { name, cls, values } | null
   */
  function stackedColumnChart({ id, title, labels, stacks, side = null, totalName = 'Total', format = v => fmt.money(v, { whole: true }), tableCaption, hatchedName = 'provisional', summary = '' }) {
    const known = v => v !== null && v !== undefined;
    const n = labels.length;
    if (!n || !stacks.some(s => s.values.some(known)) && !(side && side.values.some(known))) return empty('Not enough known values to draw this chart yet.');
    const narrow = isNarrow();
    const W = narrow ? 420 : 760, H = narrow ? 240 : 250, padL = narrow ? 46 : 60, padR = 12, padT = 22, padB = 30;
    const totals = labels.map((m, i) => (stacks.some(s => known(s.values[i])) ? stacks.reduce((sum, s) => sum + (known(s.values[i]) ? s.values[i] : 0), 0) : null));
    let lo = 0, hi = 0;
    labels.forEach((m, i) => {
      let up = 0, down = 0;
      for (const s of stacks) { const v = s.values[i]; if (known(v)) { if (v >= 0) up += v; else down += v; } }
      const sv = side && known(side.values[i]) ? side.values[i] : 0;
      lo = Math.min(lo, down, sv); hi = Math.max(hi, up, sv);
    });
    const t = ticks(lo, hi);
    const min = t[0], max = t[t.length - 1];
    const y = v => padT + (1 - (v - min) / (max - min || 1)) * (H - padT - padB);
    const band = (W - padL - padR) / n;
    const group = Math.min(44, band * 0.74);
    const bw = side ? group * 0.68 : Math.min(28, band * 0.6);
    const sw = side ? group * 0.26 : 0;
    const pid = esc((id || UI.dom.domId('stack', title)) + '-hatch');
    const grid = t.map(v => `<line class="grid${v === 0 ? ' zero' : ''}" x1="${padL}" x2="${W - padR}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text class="axis" x="${padL - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${esc(compactMoney(v))}</text>`).join('');
    const every = Math.max(1, Math.ceil(n / (narrow ? 6 : 12)));
    const showTotals = n <= (narrow ? 6 : 14);
    let yearShown = null;
    const hasHatch = stacks.some(s => (s.hatched || []).some(v => known(v) && v !== 0));
    const rect = (x, y1, y2, w, cls, extra = '') => `<rect class="${cls}" x="${x.toFixed(1)}" y="${Math.min(y1, y2).toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(1, Math.abs(y2 - y1)).toFixed(1)}"${extra}/>`;
    const cols = labels.map((m, i) => {
      const cx = padL + band * i + band / 2;
      const x0 = side ? cx - group / 2 : cx - bw / 2;
      let out = '';
      let up = 0, down = 0;
      for (const s of stacks) {
        const v = s.values[i];
        if (!known(v) || v === 0) continue;
        const from = v >= 0 ? up : down, to = from + v;
        out += rect(x0, y(from), y(to), bw, 'seg ' + s.cls);
        const h = s.hatched && known(s.hatched[i]) ? s.hatched[i] : 0;
        if (h) out += rect(x0, y(to), y(to - h), bw, 'hatch-overlay', ` fill="url(#${pid})"`);
        if (v >= 0) up = to; else down = to;
      }
      if (side && known(side.values[i]) && side.values[i] !== 0) out += rect(x0 + bw + group * 0.06, y(0), y(side.values[i]), sw, 'seg side ' + side.cls);
      if (showTotals && known(totals[i])) out += `<text class="col-total" x="${(x0 + bw / 2).toFixed(1)}" y="${(y(Math.max(0, up)) - 5).toFixed(1)}" text-anchor="middle">${esc(compactMoney(totals[i]))}</text>`;
      const shown = i % every === 0 || i === n - 1;
      let text = fmt.month(m);
      if (shown) {
        const year = String(m).slice(0, 4);
        if (year === yearShown) text = text.replace(/ \d{4}$/, '');
        yearShown = year;
      }
      const label = shown ? `<text class="axis" x="${cx.toFixed(1)}" y="${H - 10}" text-anchor="middle">${esc(text)}</text>` : '';
      const rows = stacks.map(s => {
        const v = s.values[i], h = s.hatched && known(s.hatched[i]) ? s.hatched[i] : 0;
        return [s.name, format(known(v) ? v : null) + (h ? ' (' + format(h) + ' ' + hatchedName + ')' : ''), s.cls];
      });
      if (stacks.length > 1) rows.push([totalName, format(totals[i])]);
      if (side) rows.push([side.name, format(known(side.values[i]) ? side.values[i] : null), side.cls]);
      const hit = `<rect class="hit-col" x="${(cx - band / 2).toFixed(1)}" y="${padT}" width="${band.toFixed(1)}" height="${H - padT - padB}" data-tip-title="${esc(fmt.monthLong(m))}" data-tip-rows="${esc(JSON.stringify(rows))}"/>`;
      return out + hit + label;
    }).join('');
    const legend = `<ul class="chart-legend">${stacks.map(s => `<li><span class="key key-swatch ${esc(s.cls)}" aria-hidden="true"></span>${esc(s.name)}</li>`).join('')}${side ? `<li><span class="key key-swatch ${esc(side.cls)}" aria-hidden="true"></span>${esc(side.name)} (beside, not added in)</li>` : ''}${hasHatch ? `<li><span class="key key-swatch is-hatched" aria-hidden="true"></span>Striped: ${esc(hatchedName)}</li>` : ''}</ul>`;
    const cols2 = [{ key: 'm', label: 'Month' }, ...stacks.map((s, si) => ({ key: 's' + si, label: s.name, align: 'right' })), ...(stacks.length > 1 ? [{ key: 'tot', label: totalName, align: 'right' }] : []), ...(side ? [{ key: 'side', label: side.name, align: 'right' }] : [])];
    const tableRows = labels.map((m, i) => {
      const r = { m: fmt.monthLong(m) };
      stacks.forEach((s, si) => {
        const v = s.values[i], h = s.hatched && known(s.hatched[i]) ? s.hatched[i] : 0;
        r['s' + si] = format(known(v) ? v : null) + (h ? ' (' + format(h) + ' ' + hatchedName + ')' : '');
      });
      r.tot = format(totals[i]);
      if (side) r.side = format(known(side.values[i]) ? side.values[i] : null);
      return r;
    });
    const sum = vals => vals.filter(known).reduce((a, b) => a + b, 0);
    const footer = { m: 'Total' };
    stacks.forEach((s, si) => { footer['s' + si] = esc(format(sum(s.values))); });
    footer.tot = esc(format(sum(totals)));
    if (side) footer.side = esc(format(sum(side.values)));
    return `<figure class="chart" id="${esc(id || UI.dom.domId('stack', title))}">
      ${legend}
      <svg class="column-chart stacked-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title + '. ' + (summary || '') + ' A table follows.')}">
        <defs><pattern id="${pid}" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)"><rect class="hatch" width="2.5" height="6"/></pattern></defs>
        ${grid}${cols}
      </svg>
      ${summary ? `<figcaption class="fine">${esc(summary)}</figcaption>` : ''}
      <details class="chart-table"><summary>Show as a table</summary>${table({ caption: tableCaption || title, columns: cols2, rows: tableRows, footer })}</details>
    </figure>`;
  }

  // ------------------------------------------------------------------ form fields
  /** Extra attributes for bound fields: data-message (toast text, enables Undo) and data-* pairs. */
  function extraAttrs(message, data) {
    const out = {};
    if (message) out['data-message'] = message;
    for (const [k, v] of Object.entries(data || {})) out['data-' + k] = v;
    return attrs(out);
  }
  /**
   * Money input bound to a state path. Value in cents (null = unknown, shown as empty).
   * The app parses dollars on change and validates; errors render into #<id>-error.
   */
  function moneyField({ id, label, path, cents, help = '', placeholder = 'Unknown', status, allowNegative = false, compact = false, message, data }) {
    const fid = id || UI.dom.domId('f', path);
    return `<div class="field${compact ? ' field-compact' : ''}">
      <label for="${esc(fid)}">${esc(label)}${status ? ' ' + status : ''}</label>
      <div class="input-money"><span aria-hidden="true">$</span><input id="${esc(fid)}" type="text" inputmode="decimal" autocomplete="off" data-bind="${esc(path)}" data-type="money"${allowNegative ? ' data-allow-negative="1"' : ''}${extraAttrs(message, data)} value="${esc(UI.dom.centsToInput(cents))}" placeholder="${esc(placeholder)}" aria-describedby="${esc(fid)}-help ${esc(fid)}-error"></div>
      <p class="field-help" id="${esc(fid)}-help">${help}</p>
      <p class="field-error" id="${esc(fid)}-error" role="alert" hidden></p>
    </div>`;
  }

  function selectField({ id, label, path, value, options, help = '', status, action, message, data }) {
    const fid = id || UI.dom.domId('f', path || label);
    return `<div class="field">
      <label for="${esc(fid)}">${esc(label)}${status ? ' ' + status : ''}</label>
      <select id="${esc(fid)}"${path ? ` data-bind="${esc(path)}" data-type="select"` : ''}${action ? ` data-action="${esc(action)}"` : ''}${extraAttrs(message, data)} aria-describedby="${esc(fid)}-help ${esc(fid)}-error">
        ${options.map(o => `<option value="${esc(o.value)}"${String(o.value) === String(value ?? '') ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}
      </select>
      <p class="field-help" id="${esc(fid)}-help">${help}</p>
      <p class="field-error" id="${esc(fid)}-error" role="alert" hidden></p>
    </div>`;
  }

  function monthField({ id, label, path, value, help = '', min, max, message, data }) {
    const fid = id || UI.dom.domId('f', path);
    return `<div class="field">
      <label for="${esc(fid)}">${esc(label)}</label>
      <input id="${esc(fid)}" type="month" data-bind="${esc(path)}" data-type="month"${extraAttrs(message, data)} value="${esc(value || '')}"${min ? ` min="${esc(min)}"` : ''}${max ? ` max="${esc(max)}"` : ''} placeholder="YYYY-MM" aria-describedby="${esc(fid)}-help ${esc(fid)}-error">
      <p class="field-help" id="${esc(fid)}-help">${help}</p>
      <p class="field-error" id="${esc(fid)}-error" role="alert" hidden></p>
    </div>`;
  }

  function textField({ id, label, path, value, help = '', maxlength = 80, type = 'text', dataType = 'text', placeholder = '', message, data }) {
    const fid = id || UI.dom.domId('f', path);
    return `<div class="field">
      <label for="${esc(fid)}">${esc(label)}</label>
      <input id="${esc(fid)}" type="${esc(type)}" data-bind="${esc(path)}" data-type="${esc(dataType)}"${extraAttrs(message, data)} value="${esc(value ?? '')}" maxlength="${maxlength}" placeholder="${esc(placeholder)}" aria-describedby="${esc(fid)}-help ${esc(fid)}-error">
      <p class="field-help" id="${esc(fid)}-help">${help}</p>
      <p class="field-error" id="${esc(fid)}-error" role="alert" hidden></p>
    </div>`;
  }

  /** Small status label for an input's certainty. */
  function certainty(status) {
    const map = {
      confirmed: ['Confirmed', 'good'], statement: ['From statement', 'good'], observed: ['Observed in data', 'info'],
      estimate: ['Estimate', 'warn'], approximate: ['Approximate', 'warn'], planned: ['Planned', 'info'],
      illustrative: ['Illustrative', 'warn'], unknown: ['Unknown', 'bad'], displayed: ['As displayed', 'info'],
      info: ['Information', 'info'], needs_info: ['Needs details', 'warn'], on_track: ['On track', 'good'], short: ['Short', 'bad'],
      missing: ['Missing', 'bad'], assumed: ['Assumed', 'warn'],
    };
    const [text, tone] = map[status] || [status, 'neutral'];
    return badge(text, tone);
  }

  UI.c = {
    pageHeader, breadcrumbs, card, badge, notice, metric, empty, disclosure, segmented, button, linkButton,
    table, barList, lineChart, columnChart, stackedColumnChart, moneyField, selectField, monthField, textField, certainty, compactMoney, ticks,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
