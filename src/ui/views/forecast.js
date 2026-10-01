'use strict';
// Placeholder: replaced by the full Forecast view.
(function (root) {
  const UI = root.BudgetUI;
  UI.views = UI.views || {};
  UI.views.forecast = { title: 'Forecast', render: () => UI.c.pageHeader({ title: 'Forecast' }) + UI.c.empty('This view is being built.') };
})(typeof globalThis !== 'undefined' ? globalThis : this);
