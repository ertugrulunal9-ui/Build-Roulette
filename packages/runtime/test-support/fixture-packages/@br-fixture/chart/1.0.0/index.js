// A chart.js-like package (T-040 fixture): a module-level registry that only works as
// one instance (chart.js: "\"category\" is not a registered scale").
const registry = new Map();
export const VERSION = '1.0.0';
export function register(name, value) {
  registry.set(name, value);
}
export function lookup(name) {
  return registry.has(name) ? registry.get(name) : null;
}
