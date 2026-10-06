'use strict';
/*
 * Hash routing: '#/view?key=value&…'. Every drilldown level is its own URL, so the browser's
 * Back/Forward buttons, bookmarks and reloads all work. Views never read location directly;
 * they receive { view, params } and build links with href().
 * Retired views (REDIRECTS) parse as the view that replaced them, with `redirectFrom` set, so the
 * app can rewrite the address: #/forecast is now the Overview.
 */
(function (root) {
  const UI = root.BudgetUI || (root.BudgetUI = {});

  const VIEWS = ['overview', 'spending', 'budget', 'review', 'data'];
  const DEFAULT = 'overview';
  /** Retired views and the view that replaced each. */
  const REDIRECTS = { forecast: 'overview' };

  function parse(hash) {
    const raw = String(hash || '').replace(/^#\/?/, '');
    const [path, query = ''] = raw.split('?');
    const redirectFrom = Object.prototype.hasOwnProperty.call(REDIRECTS, path) ? path : null;
    const view = redirectFrom ? REDIRECTS[path] : VIEWS.includes(path) ? path : DEFAULT;
    const params = {};
    for (const part of query.split('&')) {
      if (!part) continue;
      const i = part.indexOf('=');
      const k = decodeURIComponent(i === -1 ? part : part.slice(0, i));
      const v = i === -1 ? '' : decodeURIComponent(part.slice(i + 1).replace(/\+/g, ' '));
      if (k) params[k] = v;
    }
    return { view, params, known: VIEWS.includes(path), redirectFrom };
  }

  /** Build '#/view?…' omitting empty params. Param order is preserved for stable URLs. */
  function href(view, params = {}) {
    const q = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
      .join('&');
    return '#/' + view + (q ? '?' + q : '');
  }

  function current() { return parse(root.location ? root.location.hash : ''); }

  function go(view, params, { replace = false } = {}) {
    const target = href(view, params);
    if (!root.location) return;
    if (replace) root.history.replaceState(null, '', target);
    else if (root.location.hash !== target) root.location.hash = target;
    if (replace) root.dispatchEvent(new HashChangeEvent('hashchange'));
  }

  UI.router = { VIEWS, DEFAULT, REDIRECTS, parse, href, current, go };
})(typeof globalThis !== 'undefined' ? globalThis : this);
