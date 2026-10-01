'use strict';
// Placeholder: replaced by the full Budget view.
(function (root) {
  const UI = root.BudgetUI;
  UI.views = UI.views || {};
  UI.views.budget = { title: 'Budget', render: () => UI.c.pageHeader({ title: 'Budget' }) + UI.c.empty('This view is being built.') };
})(typeof globalThis !== 'undefined' ? globalThis : this);
