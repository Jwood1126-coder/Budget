'use strict';
// ESLint flat config: `npm run lint`. Only two rules, no plugins and no shared configs, so linting
// adds no dependency to the project: no-undef (a misspelt or missing name) and no-unused-vars
// (dead locals; unused arguments and caught errors are allowed).
//
// The globals are listed here instead of coming from the `globals` package. src/ runs in the
// browser (each file is an IIFE on globalThis.BudgetEngine / BudgetUI); tools/ and tests/ run in
// Node; tests/browser also holds page.evaluate() callbacks, which run in the page.

const PROJECT = ['BudgetEngine', 'BudgetUI', 'globalThis'];

const BROWSER = [
  'window', 'self', 'document', 'navigator', 'location', 'history', 'screen',
  'localStorage', 'sessionStorage', 'Storage', 'console',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame',
  'queueMicrotask', 'structuredClone', 'matchMedia', 'getComputedStyle', 'performance', 'crypto', 'fetch',
  'innerWidth', 'innerHeight', 'scrollX', 'scrollY', 'scrollTo', 'devicePixelRatio',
  'alert', 'confirm', 'prompt', 'atob', 'btoa',
  'URL', 'URLSearchParams', 'Blob', 'File', 'FileReader', 'FormData', 'TextEncoder', 'TextDecoder', 'DOMParser', 'CSS',
  'AbortController', 'MutationObserver', 'ResizeObserver', 'IntersectionObserver',
  'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'FocusEvent', 'InputEvent',
  'HashChangeEvent', 'PopStateEvent', 'StorageEvent', 'DOMException',
  'Node', 'NodeFilter', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLTextAreaElement',
  'HTMLDetailsElement', 'SVGElement',
];

const NODE = [
  'require', 'module', 'exports', '__dirname', '__filename', 'process', 'Buffer', 'global', 'console',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate',
  'queueMicrotask', 'structuredClone', 'performance', 'fetch', 'AbortController',
  'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder',
];

const globalsOf = (...lists) => Object.fromEntries(lists.flat().map(name => [name, 'readonly']));

const rules = {
  'no-undef': 'error',
  'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
};

module.exports = [
  { ignores: ['dist/**', 'private/**', 'data/**', 'node_modules/**', 'test-results/**'] },
  {
    files: ['src/**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'script', globals: globalsOf(PROJECT, BROWSER) },
    rules,
  },
  {
    files: ['tools/**/*.cjs', 'tests/**/*.cjs', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'commonjs', globals: globalsOf(PROJECT, NODE) },
    rules,
  },
  {
    files: ['tests/browser/**/*.cjs'],
    languageOptions: { globals: globalsOf(PROJECT, NODE, BROWSER) },
  },
];
