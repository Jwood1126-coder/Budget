'use strict';
// Placeholder: replaced by the full Spending view.
(function (root) {
  const UI = root.BudgetUI;
  UI.views = UI.views || {};
  UI.views.spending = { title: 'Spending', render: () => UI.c.pageHeader({ title: 'Spending' }) + UI.c.empty('This view is being built.') };
})(typeof globalThis !== 'undefined' ? globalThis : this);
