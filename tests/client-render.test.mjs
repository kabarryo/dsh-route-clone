/**
 * Client-half render smoke test without a browser: load client.js in a VM with
 * a fake module loader, register the panel through a fake slot/locale/remote
 * context, and render it with react-dom/server. Catches syntax, hook, and
 * initial-render defects; the Remote paths are exercised by the Host test.
 *
 * Run with: node tests/client-render.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const dshHome = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const requireFromProfile = createRequire(path.join(dshHome, 'profiles', 'package.json'))
const React = requireFromProfile('react')
const { renderToString } = requireFromProfile('react-dom/server')

let loaded
const sandbox = {
  window: { __ModuleLoader__: { load: (definition) => { loaded = definition } } },
  console,
  setTimeout,
  clearTimeout,
  URL,
}
vm.runInNewContext(fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8'), sandbox)
assert.equal(loaded.id, 'dsh-route-clone')

const module = loaded.factory((id) => {
  if (id === 'react') return React
  throw new Error(`unexpected require: ${id}`)
})
assert.equal(typeof module.apply, 'function')
assert.equal(module.inject.join(','), 'slots,locale,remote,remote.settings,remote.llm')

let registered
const dictionaries = new Map()
const ctx = {
  effect(fn) { return fn() },
  locale: {
    register(ns, dicts) { dictionaries.set(ns, dicts); return () => {} },
    bind(ns) { return (key) => dictionaries.get(ns)?.zh?.[key] ?? key },
  },
  slots: {
    inject(key, callback) { callback(); return () => {} },
    register(options, component) { registered = { options, component }; return () => {} },
  },
  remote: {
    $on() { return () => {} },
    settings: { describe: async () => ({ ok: true, value: { namespaces: [], writable: true } }) },
    llm: { listProviders: async () => ({ ok: true, value: [] }), listConfigurableProviders: async () => ({ ok: true, value: [] }) },
  },
}

module.apply(ctx)
assert.equal(registered.options.name, 'settings.models.footer')
assert.equal(registered.options.id, 'route-clone')

const html = renderToString(React.createElement(registered.component, {}))
assert.match(html, /路由克隆/)
assert.match(html, /加载中/)

console.log('client render test ok')
