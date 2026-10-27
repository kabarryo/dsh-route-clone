/**
 * Host-half smoke test: apply() with a fake context materializes one clone
 * profile into the pi-ai settings section without a live Harness.
 *
 * Run with: node tests/host.test.mjs
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { apply, deriveKeyRef, buildCloneRoutes } from '../index.js'

const writes = []
let revision = 1
const piValue = {
  providers: {
    'opencode-go': {
      apiKeyEnv: 'OPENCODE_GO_API_KEY',
      models: [{ id: 'deepseek-v4.1-flash', name: 'go-DeepSeek V4.1 Flash', contextWindow: 1000000, maxTokens: 384000, input: ['text', 'image'] }],
    },
  },
}
const descriptors = [
  { ns: 'llm-pi-ai', revision: 1, value: piValue, base: {}, user: {} },
  { ns: 'provider-clone', revision: 3, value: { clones: {} }, base: {}, user: {} },
]

const settings = {
  configure() { return () => {} },
  describe() { return descriptors.map((entry) => ({ ...entry, revision: entry.ns === 'llm-pi-ai' ? revision : entry.revision })) },
  async mutate(ns, ops, expected) {
    if (ns !== 'llm-pi-ai') throw new Error(`unexpected namespace ${ns}`)
    if (expected !== revision) throw new Error(`settings/conflict: expected ${String(expected)}, current ${revision}`)
    writes.push(ops)
    for (const op of ops) {
      if (op.op === 'set' && op.path[0] === 'providers') {
        piValue.providers[op.path[1]] = op.value
      }
    }
    revision += 1
  },
}

const listeners = new Map()
const ctx = {
  settings,
  fiber: { entry: { options: { id: 'provider-clone' } } },
  logger: { debug() {}, info() {}, warn: (...args) => console.warn(...args), error() {} },
  effect(fn) { return fn() },
  on(event, listener) { listeners.set(event, listener); return () => {} },
}

const config = { clones: { get: () => ({ 'opencode-go-2': { source: 'opencode-go', displayName: 'OpenCode Go 备用', models: ['deepseek-v4.1-flash', 'minimax-m3'] } }) } }
apply(ctx, config)
await new Promise((resolve) => { setTimeout(resolve, 700) })

assert.equal(writes.length, 2, 'one profile per protocol')
const primary = piValue.providers['opencode-go-2']
assert.equal(primary.api, 'openai-completions')
assert.equal(primary.baseURL, 'https://opencode.ai/zen/go/v1')
assert.equal(primary.apiKeyEnv, deriveKeyRef('opencode-go-2'))
assert.equal(primary.models.length, 1)
assert.equal(primary.models[0].id, 'deepseek-v4.1-flash')
assert.equal(primary.models[0].compat.thinkingFormat, 'deepseek')
const anthropic = piValue.providers['opencode-go-2-anthropic']
assert.equal(anthropic.api, 'anthropic-messages')
assert.equal(anthropic.baseURL, 'https://opencode.ai/zen/go')
assert.equal(anthropic.apiKeyEnv, deriveKeyRef('opencode-go-2'))
assert.equal(anthropic.models[0].id, 'minimax-m3')

// A second pass with unchanged config must not rewrite.
await new Promise((resolve) => { setTimeout(resolve, 400) })
listeners.get('loader/volatile-update')()
await new Promise((resolve) => { setTimeout(resolve, 400) })
assert.equal(writes.length, 2, 'unchanged config is not rewritten')

// A selection spanning protocols splits into one route per protocol, all
// sharing the clone's credential reference.
const dshHome = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const catalogFile = path.join(dshHome, 'profiles/node_modules/@earendil-works/pi-ai/dist/providers/all.js')
const catalog = new Map((await import(pathToFileURL(catalogFile).href)).getBuiltinModels('opencode-go').map(m => [m.id, m]))
const split = buildCloneRoutes({
  id: 'opencode-go-3',
  source: 'opencode-go',
  displayName: '备二',
  sourceProfile: undefined,
  catalog,
  models: ['deepseek-v4.1-flash', 'minimax-m3', 'gpt-5.6-luna'],
})
assert.equal(split.routes.length, 3)
assert.deepEqual(split.routes.map(route => route.api).sort(), ['anthropic-messages', 'openai-completions', 'openai-responses'])
assert.ok(split.routes.every(route => route.profile.apiKeyEnv === deriveKeyRef('opencode-go-3')))
assert.equal(new Set(split.routes.map(route => route.id)).size, 3)
const responses = split.routes.find(route => route.api === 'openai-responses')
assert.equal(responses.profile.models[0].compat, undefined, 'withheld compat must not be copied')

// Building from an unsupported (catalog-less) source fails loudly.
assert.throws(() => buildCloneRoutes({
  id: 'x-2', source: 'nope', displayName: '', sourceProfile: undefined, catalog: new Map(),
}), /not described by the installed pi-ai catalog/)

console.log('host test ok')
