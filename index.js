/**
 * dsh-provider-clone — Host half.
 *
 * A "provider clone" is a second pi-ai route that points at the same upstream
 * as an existing catalog provider but carries its own credential reference.
 * DSH addresses models by `provider/model`, so two routes show up as two
 * groups in the model picker and can be switched per session with `/model`.
 *
 * The Models page cannot offer a clone as a dormant catalog preset: a route
 * pi-ai's catalog does not ship must be fully declared (api, baseURL, models),
 * and the add-provider card writes only a credential reference. This plugin
 * therefore materializes a complete profile into the `llm-pi-ai` settings
 * document as soon as a clone is defined; the clone then appears as an
 * ordinary provider row whose API key field is ready to fill.
 *
 * Clones are defined in this plugin's own config:
 *
 *   clones:
 *     opencode-go-2:
 *       source: opencode-go
 *       displayName: OpenCode Go（备用）
 *
 * The browser half writes that config through the settings Remote; this half
 * reconciles the pi-ai profiles on `loader/volatile-update`.
 *
 * Build-time imports are deliberately avoided: a workspace plugin installed as
 * a link resolves bare specifiers against its checkout, not the profile, so
 * schemastery and the pi-ai catalog are resolved from DSH's own profile
 * `node_modules` at runtime.
 *
 * @module dsh-provider-clone
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import { pathToFileURL } from 'node:url'

/** Stable plugin name. */
export const name = 'dsh-provider-clone'

/** The pi-ai settings section this plugin materializes profiles into. */
const PI_AI_NS = 'llm-pi-ai'

/** Wire protocols a hand-declared route may name. */
const SUPPORTED_APIS = new Set(['openai-completions', 'openai-responses', 'anthropic-messages'])

/**
 * Credential reference a clone's key is stored under. Mirrors the Models
 * page's own derivation so its card and this plugin agree on the name.
 * @param {string} provider - clone route id.
 * @returns {string} the reference name, e.g. `OPENCODE_GO_2_API_KEY`.
 */
export function deriveKeyRef(provider) {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

/**
 * Node module roots a runtime import may resolve from. The profile directory
 * is authoritative; the remaining roots are fallbacks for a bare boot.
 * @returns {string[]} candidate `node_modules` directories.
 */
function moduleRoots() {
  const roots = []
  const add = (dir) => {
    if (typeof dir === 'string' && dir.length > 0 && !roots.includes(dir)) roots.push(dir)
  }
  if (process.env.DSH_PROFILE_DIR) add(path.join(process.env.DSH_PROFILE_DIR, 'node_modules'))
  if (process.env.DSH_HOME) add(path.join(process.env.DSH_HOME, 'profiles', 'node_modules'))
  // A profile-launched Host does not always carry the shell-only DSH_* values,
  // so the default home and every installed profile are also searched. The
  // shared profile node_modules is where DSH hoists schemastery and pi-ai.
  const home = path.join(os.homedir(), '.dsh')
  const profiles = path.join(home, 'profiles')
  add(path.join(profiles, 'node_modules'))
  try {
    for (const entry of fs.readdirSync(profiles, { withFileTypes: true })) {
      if (entry.isDirectory()) add(path.join(profiles, entry.name, 'node_modules'))
    }
  } catch {}
  for (const start of [process.cwd(), path.dirname(new URL(import.meta.url).pathname)]) {
    let dir = start
    for (let depth = 0; depth < 8; depth += 1) {
      add(path.join(dir, 'node_modules'))
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return roots
}

/** @param {string} pkg - package name. @returns {string | undefined} its directory. */
function packageDir(pkg) {
  for (const root of moduleRoots()) {
    const dir = path.join(root, ...pkg.split('/'))
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir
  }
  return undefined
}

/**
 * Import schemastery from wherever DSH keeps it.
 * @returns {Promise<any>} the schema factory (`z`).
 */
async function loadSchemastery() {
  try {
    const mod = await import('@deepseek-ai/schemastery')
    return mod.default ?? mod
  } catch {}
  const dir = packageDir('@deepseek-ai/schemastery')
  if (dir === undefined) throw new Error('dsh-provider-clone: cannot locate @deepseek-ai/schemastery')
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  const entry = manifest.exports?.['.']?.import ?? manifest.module ?? manifest.main
  const mod = await import(pathToFileURL(path.join(dir, entry)).href)
  return mod.default ?? mod
}

/**
 * Import the installed pi-ai model catalog.
 * @returns {Promise<{ getBuiltinModels: (provider: string) => any[] }>} catalog access.
 */
async function loadCatalog() {
  try {
    return await import('@earendil-works/pi-ai/providers/all')
  } catch {}
  const dir = packageDir('@earendil-works/pi-ai')
  if (dir === undefined) throw new Error('dsh-provider-clone: cannot locate @earendil-works/pi-ai')
  return import(pathToFileURL(path.join(dir, 'dist', 'providers', 'all.js')).href)
}

const z = await loadSchemastery()

/** The installed catalog is loaded on first use so a catalog problem cannot
 * keep the settings surface itself from mounting. */
let catalogPromise
function catalogModule() {
  catalogPromise ??= loadCatalog()
  return catalogPromise
}

/** Whether a candidate route id is safe for a pi-ai settings key and a credential ref. */
const ROUTE_ID = /^[a-z0-9][a-z0-9-]*$/

/** Plugin configuration: the clones the user defined in the Models page. */
export const Config = z.object({
  clones: z.dict(z.object({
    source: z.string().default(''),
    displayName: z.string().default(''),
    models: z.array(z.string()).default([]),
  })).default({}).volatile(),
})

/** Read a possibly reactive configuration value. */
function read(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
}

/** Append-only diagnostics for a feature whose failures never reach a UI. */
const LOG_PATH = path.join(
  process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'),
  'logs',
  'provider-clone.log',
)

/**
 * Append one diagnostic line, rotating once past half a megabyte. Best effort:
 * a log failure must never change plugin behavior.
 * @param {string} level - short level label.
 * @param {string} message - line content.
 */
function logLine(level, message) {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true })
    try {
      if (fs.statSync(LOG_PATH).size > 512 * 1024) fs.writeFileSync(LOG_PATH, '')
    } catch {}
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} [${level}] ${message}\n`)
  } catch {}
}

/**
 * Translate a catalog thinking-level map into this harness's reasoning
 * efforts. `null` entries are levels pi-ai marks unsupported, and a declared
 * level must carry the wire spelling to send.
 * @param {Record<string, string | null> | undefined} map - pi-ai capability map.
 * @param {boolean | undefined} reasoning - catalog reasoning flag.
 * @returns {Record<string, string> | false | undefined} configured efforts.
 */
export function reasoningEffortsOf(map, reasoning) {
  if (map === undefined || map === null) return reasoning === false ? false : undefined
  const efforts = {}
  for (const [level, wire] of Object.entries(map)) {
    if (typeof wire === 'string' && wire.length > 0) efforts[level] = wire
  }
  if (Object.keys(efforts).length > 0) return efforts
  return reasoning === true ? undefined : false
}

/** Fixed protocol order: route naming and tie-breaks stay deterministic. */
const PROTOCOL_ORDER = ['openai-completions', 'openai-responses', 'anthropic-messages']

/**
 * Compat switches a hand-declared route may set, per protocol. The catalog's
 * entries also carry withheld switches (session affinity, cache control and
 * similar) that only the installed catalog provider can own; copying those
 * would make the profile invalid, so they are dropped here.
 */
const OFFERED_COMPAT = {
  'openai-completions': new Set([
    'supportsStore', 'supportsDeveloperRole', 'supportsReasoningEffort', 'supportsUsageInStreaming',
    'supportsFinishReason', 'maxTokensField', 'requiresToolResultName', 'requiresAssistantAfterToolResult',
    'requiresThinkingAsText', 'requiresReasoningContentOnAssistantMessages', 'thinkingFormat',
    'chatTemplateKwargs', 'chatTemplateArgs', 'supportsThinkingTokenBudget', 'thinkingTokenBudgetField',
    'vllmPriority', 'supportsStrictMode', 'cacheControlFormat', 'supportsLongCacheRetention',
  ]),
  'openai-responses': new Set([
    'supportsDeveloperRole', 'supportsMaxOutputTokens', 'supportsStrictMode', 'supportsLongCacheRetention',
  ]),
  'anthropic-messages': new Set([
    'supportsEagerToolInputStreaming', 'supportsLongCacheRetention', 'supportsCacheControlOnTools',
    'supportsTemperature', 'forceAdaptiveThinking', 'allowEmptySignature', 'supportsStrictTools',
  ]),
}

/** Short route-id suffix and a language-neutral label for each protocol. */
const PROTOCOL_META = {
  'openai-completions': { suffix: 'completions', label: 'Chat Completions' },
  'openai-responses': { suffix: 'responses', label: 'Responses' },
  'anthropic-messages': { suffix: 'anthropic', label: 'Anthropic Messages' },
}

/**
 * One catalog model as this harness's model profile, with the source's own
 * overrides winning field by field.
 * @param {any} base - catalog model.
 * @param {any} own - the source profile's entry for the same id, if any.
 * @returns {object} a model profile.
 */
function modelProfile(base, own, api) {
  const model = {
    id: base.id,
    name: own?.name ?? base.name,
    contextWindow: own?.contextWindow ?? base.contextWindow,
    maxTokens: own?.maxTokens ?? base.maxTokens,
  }
  const input = Array.isArray(own?.input) && own.input.length > 0 ? own.input : base.input
  if (Array.isArray(input) && input.length > 0) model.input = [...input]
  const efforts = own?.reasoningEfforts !== undefined
    ? own.reasoningEfforts
    : reasoningEffortsOf(base.thinkingLevelMap, base.reasoning)
  if (efforts !== undefined) model.reasoningEfforts = efforts
  const offered = OFFERED_COMPAT[api]
  const merged = base.compat === undefined && own?.compat === undefined
    ? undefined
    : { ...base.compat, ...own?.compat }
  const compat = merged === undefined
    ? undefined
    : Object.fromEntries(Object.entries(merged).filter(([field]) => offered?.has(field) === true))
  if (compat !== undefined && Object.keys(compat).length > 0) model.compat = compat
  return Object.fromEntries(Object.entries(model).filter(([, value]) => value !== undefined))
}

/**
 * A route id derived from the clone id and a protocol suffix, avoiding ids the
 * source section or an earlier route in this pass already uses.
 * @param {string} base - clone route id.
 * @param {string} suffix - protocol suffix.
 * @param {Set<string>} taken - ids already in use; mutated.
 * @returns {string} a free route id.
 */
function suffixedRouteId(base, suffix, taken) {
  const stem = `${base}-${suffix}`
  let id = stem
  let index = 2
  while (taken.has(id)) {
    id = `${stem}-${index}`
    index += 1
  }
  taken.add(id)
  return id
}

/**
 * Build the pi-ai profiles for one clone.
 *
 * A hand-declared route speaks exactly one protocol, while a catalog provider
 * can dispatch several. The selected models are therefore grouped by protocol
 * and each group becomes its own route: the primary group keeps the clone id,
 * and the others get a protocol suffix. Every route of one clone shares the
 * clone's credential reference, so one stored key serves the whole group.
 *
 * The source profile's explicit fields win; anything it leaves to the catalog
 * (endpoint, protocol, capacities, compat) is filled from the installed
 * catalog entry, because a route the catalog does not ship gets no catalog
 * defaults at request time.
 *
 * @param {object} request - clone facts.
 * @param {string} request.id - clone route id (the primary route keeps it).
 * @param {string} request.source - catalog provider id to copy.
 * @param {string} request.displayName - selector label for the clone.
 * @param {object | undefined} request.sourceProfile - the source's stored profile, if any.
 * @param {Map<string, any>} request.catalog - catalog models of the source, by id.
 * @param {readonly string[] | undefined} request.models - selected model ids; empty means the source's effective set.
 * @param {Set<string>} [request.taken] - route ids already in use; mutated.
 * @returns {{ routes: Array<{ id: string, api: string, profile: object, modelCount: number }>, skipped: number }} the generated routes.
 * @throws {Error} when no selected model can be served.
 */
export function buildCloneRoutes({ id, source, displayName, sourceProfile, catalog, models, taken = new Set() }) {
  if (!ROUTE_ID.test(id)) throw new Error(`route id "${id}" must be lowercase letters, digits and hyphens`)
  if (!catalog || catalog.size === 0) {
    throw new Error(`provider "${source}" is not described by the installed pi-ai catalog`)
  }
  const configured = Array.isArray(sourceProfile?.models) ? sourceProfile.models : []
  const overrides = sourceProfile?.modelOverrides ?? {}
  const requested = Array.isArray(models) && models.length > 0
    ? models
    : configured.length > 0
      ? configured.map(model => model.id)
      : [...catalog.keys()]
  const entries = []
  const seen = new Set()
  let skipped = 0
  for (const modelId of requested) {
    if (typeof modelId !== 'string' || modelId.length === 0 || seen.has(modelId)) continue
    seen.add(modelId)
    const base = catalog.get(modelId)
    if (base === undefined) { skipped += 1; continue }
    const own = configured.find(model => model.id === modelId) ?? overrides[modelId]
    entries.push({ base, own })
  }
  if (entries.length === 0) {
    throw new Error(`provider "${source}" has no selected model the installed catalog describes`)
  }
  // A source route that pins its protocol applies it to every model it serves,
  // so a faithful clone does the same. Otherwise each model keeps its catalog
  // protocol and the selection splits into one route per protocol.
  const pinned = typeof sourceProfile?.api === 'string' && SUPPORTED_APIS.has(sourceProfile.api)
    ? sourceProfile.api
    : undefined
  const groups = new Map()
  for (const entry of entries) {
    const api = pinned ?? entry.base.api
    if (!SUPPORTED_APIS.has(api)) { skipped += 1; continue }
    if (!groups.has(api)) groups.set(api, [])
    groups.get(api).push(entry)
  }
  if (groups.size === 0) {
    throw new Error(`provider "${source}" has no selected model on a supported protocol`)
  }
  const ordered = [...groups.entries()].sort((left, right) => (
    right[1].length - left[1].length
    || PROTOCOL_ORDER.indexOf(left[0]) - PROTOCOL_ORDER.indexOf(right[0])
  ))
  const baseLabel = typeof displayName === 'string' && displayName.length > 0 ? displayName : source
  const keyRef = deriveKeyRef(id)
  const routes = []
  ordered.forEach(([api, group], index) => {
    const primary = index === 0
    const routeId = primary ? id : suffixedRouteId(id, PROTOCOL_META[api].suffix, taken)
    const baseURL = sourceProfile?.baseURL ?? group[0].base.baseUrl
    if (typeof baseURL !== 'string' || baseURL.length === 0) {
      throw new Error(`provider "${source}" has no base URL to copy`)
    }
    routes.push({
      id: routeId,
      api,
      modelCount: group.length,
      profile: {
        displayName: primary ? baseLabel : `${baseLabel} · ${PROTOCOL_META[api].label}`,
        apiKeyEnv: keyRef,
        api,
        baseURL,
        models: group.map(({ base, own }) => modelProfile(base, own, api)),
      },
    })
  })
  taken.add(id)
  return { routes, skipped }
}

/**
 * Read one namespace descriptor.
 * @param {object} settings - settings service.
 * @param {string} ns - namespace id.
 * @returns {any | undefined} descriptor.
 */
function descriptorOf(settings, ns) {
  return settings.describe({ redactSecrets: true }).find(entry => entry.ns === ns)
}

/**
 * Write one clone profile into the pi-ai section, retrying a conflicting
 * revision.
 * @param {object} settings - settings service.
 * @param {string} id - route id.
 * @param {object} profile - profile to store.
 * @param {number} attempts - remaining attempts.
 * @returns {Promise<boolean>} whether the write landed.
 */
async function writeProfile(settings, id, profile, attempts = 4) {
  let lastMessage = ''
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const descriptor = descriptorOf(settings, PI_AI_NS)
    if (descriptor === undefined) {
      logLine('warn', `write ${id}: llm-pi-ai descriptor missing`)
      return false
    }
    try {
      await settings.mutate(PI_AI_NS, [{ op: 'set', path: ['providers', id], value: profile }], descriptor.revision)
      logLine('info', `write ${id}: ok (revision ${descriptor.revision}, attempt ${attempt + 1}/${attempts})`)
      return true
    } catch (error) {
      lastMessage = error instanceof Error ? error.message : String(error)
      logLine('warn', `write ${id}: attempt ${attempt + 1}/${attempts} failed: ${lastMessage}`)
      if (!/conflict|timed out waiting for the writer lock|nested/i.test(lastMessage)) return false
      await new Promise(resolve => setTimeout(resolve, 150))
    }
  }
  logLine('error', `write ${id}: gave up: ${lastMessage}`)
  return false
}

/**
 * Remove one route profile from the pi-ai section, retrying a conflicting
 * revision or a temporary writer-lock/nested-transaction refusal.
 * @param {object} settings - settings service.
 * @param {string} id - route id.
 * @param {number} attempts - remaining attempts.
 * @returns {Promise<boolean>} whether the removal landed.
 */
async function removeProfile(settings, id, attempts = 3) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const descriptor = descriptorOf(settings, PI_AI_NS)
    if (descriptor === undefined) return false
    try {
      await settings.mutate(PI_AI_NS, [{ op: 'unset', path: ['providers', id] }], descriptor.revision)
      logLine('info', `remove ${id}: ok`)
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logLine('warn', `remove ${id}: attempt ${attempt + 1}/${attempts} failed: ${message}`)
      if (!/conflict|timed out waiting for the writer lock|nested/i.test(message)) return false
      await new Promise(resolve => setTimeout(resolve, 150))
    }
  }
  return false
}

// ── opencode session header shim ───────────────────────────────────────────
// Hand-declared routes to opencode.ai never pass through pi-ai's opencode
// provider wrapper, so they miss the per-conversation routing header the
// gateway requires. The shim adds it only to opencode.ai requests, using the
// session id the agent loop already stamps on every model request.

const HEADER = 'x-opencode-session'
const URL_MARKER = 'opencode.ai'
const sessionContext = new AsyncLocalStorage()
let originalFetch
let shimmedFetch
let shimInstalled = false

/**
 * Run `fn` with one session id visible to the fetch shim.
 * @param {string} sessionId - session identity.
 * @param {() => any} fn - work to run.
 * @returns {any} fn's result.
 */
export function runInSession(sessionId, fn) {
  return sessionContext.run(String(sessionId), fn)
}

/**
 * Wrap an async iterable so every downstream await (including the request
 * fetch) runs inside the session context.
 * @param {AsyncIterable<any>} iterable - model stream.
 * @param {string} sessionId - session identity.
 * @returns {AsyncIterable<any>} the wrapped stream.
 */
export function withSession(iterable, sessionId) {
  const id = String(sessionId)
  const inner = iterable[Symbol.asyncIterator]()
  const step = (method, value) => runInSession(id, () => {
    const fn = inner[method]
    return typeof fn === 'function' ? fn.call(inner, value) : Promise.resolve({ done: true })
  })
  return {
    next: () => step('next'),
    return: value => step('return', value),
    throw: error => step('throw', error),
    [Symbol.asyncIterator]() { return this },
  }
}

/** Extract a request URL from fetch arguments. */
function requestUrlOf(input) {
  if (typeof input === 'string') return input
  if (typeof URL !== 'undefined' && input instanceof URL) return input.href
  if (input !== null && typeof input === 'object' && typeof input.url === 'string') return input.url
  return undefined
}

/** Merge headers from a Request/init pair without dropping either set. */
function mergedHeaders(input, init) {
  const headers = input !== null && typeof input === 'object' && input.headers instanceof Headers
    ? new Headers(input.headers)
    : new Headers(init?.headers)
  return headers
}

/**
 * Build the fetch wrapper: adds the routing header only when a session context
 * exists and the request targets opencode.ai.
 * @param {typeof fetch} realFetch - original implementation.
 * @returns {typeof fetch} the wrapper.
 */
export function wrapFetch(realFetch) {
  return function providerCloneFetch(input, init) {
    const sessionId = sessionContext.getStore()
    if (sessionId === undefined) return realFetch(input, init)
    const url = requestUrlOf(input)
    if (url === undefined || !url.toLowerCase().includes(URL_MARKER)) return realFetch(input, init)
    const headers = mergedHeaders(input, init)
    headers.set(HEADER, sessionId)
    return realFetch(input, init === undefined ? { headers } : { ...init, headers })
  }
}

/** Install the global fetch wrapper once per process. */
function installFetchShim(logger) {
  if (shimInstalled || typeof globalThis.fetch !== 'function') return
  originalFetch = globalThis.fetch
  shimmedFetch = wrapFetch(originalFetch)
  globalThis.fetch = shimmedFetch
  shimInstalled = true
  logger?.debug?.(`dsh-provider-clone: ${HEADER} shim installed`)
}

/** Restore the original fetch when this plugin unloads. */
function restoreFetchShim() {
  if (!shimInstalled) return
  if (globalThis.fetch === shimmedFetch) globalThis.fetch = originalFetch
  shimInstalled = false
  originalFetch = undefined
  shimmedFetch = undefined
}

// ── plugin ─────────────────────────────────────────────────────────────────

/** The plugin depends on the Host settings section it writes through. */
export const inject = ['settings']

/**
 * Reconcile clone definitions into pi-ai profiles and keep them current.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
 * @param {any} config - this plugin's live configuration.
 */
export function apply(ctx, config) {
  // The clones form is written by the Models page, not by a generated page.
  ctx.effect(() => ctx.settings.configure({ auto: false }, ctx.fiber), 'dsh-provider-clone: settings page policy')

  const settings = ctx.settings
  const settingsNs = ctx.fiber.entry?.options.id ?? name
  let lastFingerprint
  let firstPass = true
  let running = false
  let rerun = false

  /**
   * Reconcile clone definitions into pi-ai profiles.
   *
   * `config` writes (or refreshes) every clone in response to this plugin's
   * own settings changing. `ensure` writes only the profiles that are absent,
   * which is how a start-up ordering race, a missed event, or a transient
   * write failure heals without overwriting edits made in the Models page.
   *
   * @param {'config' | 'ensure'} mode - reconciliation source.
   */
  const reconcile = async (mode = 'config') => {
    if (running) { rerun = true; return }
    running = true
    try {
      const clones = read(config.clones) ?? {}
      const fingerprint = JSON.stringify(clones)
      if (mode === 'config' && fingerprint === lastFingerprint) return
      const first = firstPass
      firstPass = false
      const descriptor = descriptorOf(settings, PI_AI_NS)
      if (descriptor === undefined) {
        logLine('warn', `reconcile(${mode}): llm-pi-ai section is not mounted`)
        return
      }
      const sourceProfiles = descriptor.value?.providers ?? {}
      let catalogApi
      try {
        catalogApi = await catalogModule()
      } catch (error) {
        logLine('warn', `reconcile(${mode}): pi-ai catalog unavailable: ${error instanceof Error ? error.message : String(error)}`)
        return
      }
      const ids = Object.keys(clones)
      if (ids.length > 0) logLine('info', `reconcile(${mode}): ${fingerprint}`)
      let failed = false
      const taken = new Set(Object.keys(sourceProfiles))
      for (const [id, definition] of Object.entries(clones)) {
        if (id === PI_AI_NS || !ROUTE_ID.test(id)) {
          logLine('warn', `skip clone "${id}": invalid route id`)
          continue
        }
        const source = typeof definition?.source === 'string' ? definition.source : ''
        if (source.length === 0) {
          logLine('warn', `skip clone "${id}": no source provider`)
          continue
        }
        try {
          const catalogModels = catalogApi.getBuiltinModels(source)
          const catalog = new Map(catalogModels.map(model => [model.id, model]))
          // Routes of this clone already share its credential reference. They
          // must not count as foreign ids, or every regeneration would grow a
          // new suffix; they are removed individually when no longer produced.
          const ref = deriveKeyRef(id)
          const existingGroup = Object.entries(sourceProfiles)
            .filter(([, profile]) => profile?.apiKeyEnv === ref)
            .map(([routeId]) => routeId)
          const takenForClone = new Set([...taken].filter(routeId => !existingGroup.includes(routeId)))
          const built = buildCloneRoutes({
            id,
            source,
            displayName: typeof definition?.displayName === 'string' ? definition.displayName : '',
            sourceProfile: sourceProfiles[source],
            catalog,
            models: Array.isArray(definition?.models) ? definition.models : [],
            taken: takenForClone,
          })
          for (const route of built.routes) taken.add(route.id)
          const summary = built.routes.map(route => `${route.id}:${route.api}/${route.modelCount}`).join(', ')
          logLine('info', `build ${id} <- ${source}: ${summary} skipped=${built.skipped}`)
          // A changed selection drops the routes it no longer produces.
          for (const routeId of existingGroup) {
            if (!built.routes.some(route => route.id === routeId)) await removeProfile(settings, routeId)
          }
          for (const route of built.routes) {
            const existing = sourceProfiles[route.id]
            // A restart adopts what is already stored, so edits made in the
            // Models page (keys, capacities) survive; a configured change
            // regenerates the profile instead.
            if (mode === 'ensure' && existing !== undefined) continue
            if (mode === 'config' && first && existing !== undefined) continue
            const wrote = await writeProfile(settings, route.id, route.profile)
            if (!wrote) {
              failed = true
              logLine('error', `clone ${id}: route ${route.id} was not written`)
            }
          }
          if (built.skipped > 0) logLine('info', `clone ${id}: skipped ${built.skipped} model(s) the catalog does not describe`)
        } catch (error) {
          failed = true
          const message = error instanceof Error ? error.message : String(error)
          logLine('error', `clone ${id} <- ${source}: ${message}`)
        }
      }
      if (mode === 'config') lastFingerprint = failed ? undefined : fingerprint
    } catch (error) {
      logLine('error', `reconcile failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    } finally {
      running = false
      if (rerun) { rerun = false; void reconcile('ensure') }
    }
  }

  ctx.effect(() => {
    installFetchShim(ctx.logger)
    return () => restoreFetchShim()
  }, 'dsh-provider-clone: opencode session header shim')

  ctx.on('llm/stream', (options, next) => {
    const sessionId = options?.sessionId
    if (sessionId === undefined || sessionId === '') return next()
    return withSession(next(), sessionId)
  }, { global: true, prepend: true })

  /**
   * Reconcile from a context that is outside any settings transaction.
   *
   * A settings edit runs inside `hmr.runExclusive()`, that queue rejects a
   * nested transaction, and `loader/volatile-update` is emitted from the middle
   * of the outer edit — so writing to another namespace from its listener
   * fails with "HMR transactions cannot be nested". A timer created inside
   * that listener would inherit the same async context even after the edit
   * finishes, so the pump is created here, at activation, and listeners only
   * leave a request behind.
   */
  let pendingMode
  let pumpTimer
  const pump = () => {
    const mode = pendingMode
    if (mode === undefined) return
    pendingMode = undefined
    void reconcile(mode)
  }
  ctx.effect(() => {
    pumpTimer = setInterval(pump, 250)
    pumpTimer.unref?.()
    return () => {
      clearInterval(pumpTimer)
      pumpTimer = undefined
    }
  }, 'dsh-provider-clone: reconcile pump')
  const schedule = (mode) => {
    if (mode === 'config' || pendingMode === undefined) pendingMode = mode
  }

  // Our own settings change is the primary trigger. The adapter and timer
  // paths cover plugin start-up ordering and transient write failures.
  ctx.on('loader/volatile-update', () => { schedule('config') })
  ctx.on('llm/adapters-updated', () => { schedule('ensure') })
  for (const delay of [1500, 5000, 15000]) {
    ctx.effect(() => {
      const timer = setTimeout(() => { void reconcile('ensure') }, delay)
      return () => clearTimeout(timer)
    }, `dsh-provider-clone: ensure after ${delay}ms`)
  }

  logLine('info', `apply: settings section "${settingsNs}", clones=${JSON.stringify(read(config.clones) ?? {})}`)
  schedule('config')
  ctx.logger.debug?.(`dsh-provider-clone: active as settings section "${settingsNs}"`)
}
