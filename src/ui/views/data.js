'use strict';
// Placeholder: replaced by the full Data view.
(function (root) {
  const UI = root.BudgetUI;
  UI.views = UI.views || {};
  UI.views.data = { title: 'Data', render: () => UI.c.pageHeader({ title: 'Data' }) + UI.c.empty('This view is being built.') };
})(typeof globalThis !== 'undefined' ? globalThis : this);
