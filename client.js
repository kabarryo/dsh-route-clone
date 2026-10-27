/**
 * dsh-provider-clone — Client half.
 *
 * Adds a "route clone" panel to the Models settings page footer: pick a
 * catalog provider preset, pick the models to copy, name the copy, and create
 * it. The Host half turns the selection into one complete `llm-pi-ai` route per
 * protocol, all sharing the clone's credential reference; the copy then shows
 * up as ordinary provider rows where its API key is entered.
 *
 * A route clone is not a new pi-ai catalog preset: the catalog is keyed by
 * provider id, and a new id cannot inherit the catalog provider object. The
 * panel copies the connection and model facts instead.
 */
window.__ModuleLoader__.load({
  id: 'dsh-provider-clone',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const NS = 'provider-clone'
    const PI_AI = 'llm-pi-ai'

    const DICTS = {
      zh: {
        title: '路由克隆',
        intro: '选择来源预设与要复制的模型，生成独立凭据的路由组；跨协议的模型会自动拆成多条路由。这不是新增 pi-ai 目录预设。',
        source: '来源预设',
        chooseSource: '请选择供应商预设',
        copySuffix: '副本',
        name: '克隆名称',
        namePlaceholder: '例如：OpenCode Go（备用）',
        models: '选择模型',
        modelsHint: '跨协议模型会自动拆成多条路由，同组共用一个 API Key。',
        searchModels: '搜索模型',
        selectAll: '全选',
        selectNone: '清空',
        selected: '已选',
        noModels: '该预设没有可选模型。',
        modelsLoading: '正在读取模型…',
        needModels: '至少选择一个模型。',
        create: '创建克隆',
        creating: '正在创建…',
        empty: '还没有克隆。',
        delete: '删除',
        deleting: '删除中…',
        routeId: '路由 ID',
        keyRef: '凭据引用',
        active: '已激活',
        pending: '等待激活',
        created: '已创建',
        createdHint: '请在上方新增的路由行中填入 API Key（同组共用）。',
        pendingHint: '配置已写入，但路由尚未激活；请刷新页面或查看 Host 日志。',
        failed: '操作失败：',
        noSources: '没有可复制的提供商预设。',
        loading: '加载中…',
        deleteHint: '删除会同时移除该组的全部路由，但不会删除已存储的 API Key。',
        routes: '路由',
        modelCount: '个模型',
        keyShared: '同组共用此引用',
      },
      en: {
        title: 'Route Clone',
        intro: 'Pick a source preset and the models to copy; the result is a route group with its own credential. Models on different protocols are split into separate routes. This does not add a pi-ai catalog preset.',
        source: 'Source preset',
        chooseSource: 'Choose a provider preset',
        copySuffix: 'copy',
        name: 'Clone name',
        namePlaceholder: 'e.g. OpenCode Go (backup)',
        models: 'Models',
        modelsHint: 'Models on different protocols become separate routes sharing one API key.',
        searchModels: 'Search models',
        selectAll: 'Select all',
        selectNone: 'Clear',
        selected: 'selected',
        noModels: 'This preset lists no models.',
        modelsLoading: 'Reading models…',
        needModels: 'Select at least one model.',
        create: 'Create clone',
        creating: 'Creating…',
        empty: 'No clones yet.',
        delete: 'Delete',
        deleting: 'Deleting…',
        routeId: 'Route ID',
        keyRef: 'Credential reference',
        active: 'Active',
        pending: 'Pending activation',
        created: 'Created',
        createdHint: 'Enter an API key in the new route rows above (shared by the group).',
        pendingHint: 'Configuration was written, but the routes are not active yet; refresh the page or check the Host log.',
        failed: 'Failed: ',
        noSources: 'No provider presets available to copy.',
        loading: 'Loading…',
        deleteHint: 'Deleting removes every route of this group but leaves the stored API key in place.',
        routes: 'Routes',
        modelCount: 'model(s)',
        keyShared: 'shared by this group',
      },
    }

    const css = {
      panel: {
        marginTop: '16px',
        padding: '14px 16px 12px',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '10px',
        background: 'var(--dsw-alias-bg-layer-2)',
      },
      title: { margin: '0 0 4px', fontSize: '13px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      intro: { margin: '0 0 12px', fontSize: '12px', lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)' },
      form: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' },
      select: controlStyle(),
      input: { ...controlStyle(), minWidth: '200px', flex: '1 1 200px' },
      search: { ...controlStyle(), width: '100%', marginBottom: '6px' },
      primary: {
        height: '28px',
        padding: '0 12px',
        border: 0,
        borderRadius: '6px',
        background: 'var(--dsw-alias-brand-primary)',
        color: '#fff',
        fontSize: '12px',
        cursor: 'pointer',
      },
      models: { marginTop: '12px' },
      modelsHead: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px' },
      modelsTitle: { fontSize: '12px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      hint: { fontSize: '11px', lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)' },
      modelList: {
        maxHeight: '220px',
        overflow: 'auto',
        margin: 0,
        padding: '4px 6px',
        listStyle: 'none',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '6px',
        background: 'var(--dsw-alias-bg-base)',
      },
      modelRow: { display: 'flex', alignItems: 'baseline', gap: '8px', padding: '3px 2px', fontSize: '12px', color: 'var(--dsw-alias-label-primary)' },
      modelId: { color: 'var(--dsw-alias-label-secondary)', fontSize: '11px', overflowWrap: 'anywhere' },
      list: { margin: '12px 0 0', padding: 0, listStyle: 'none' },
      item: { display: 'flex', gap: '10px', alignItems: 'flex-start', padding: '8px 0', borderTop: '1px solid var(--dsw-alias-border-l1)' },
      itemMain: { flex: 1, minWidth: 0 },
      itemTitle: { fontSize: '12px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      itemMeta: { marginTop: '2px', fontSize: '11px', lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)', overflowWrap: 'anywhere' },
      linkButton: {
        border: 0,
        background: 'transparent',
        padding: 0,
        fontSize: '11px',
        color: 'var(--dsw-alias-label-secondary)',
        cursor: 'pointer',
      },
      status: { marginTop: '10px', fontSize: '12px', lineHeight: 1.5 },
      ok: { color: 'var(--dsw-alias-state-success-primary)' },
      warn: { color: 'var(--dsw-alias-state-warn-primary)' },
      error: { color: 'var(--dsw-alias-state-error-primary)' },
      dot: { display: 'inline-block', width: '6px', height: '6px', borderRadius: '50%', marginRight: '5px', verticalAlign: 'middle' },
      smallButton: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '5px',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: '11px',
        padding: '1px 6px',
        cursor: 'pointer',
      },
    }

    function controlStyle() {
      return {
        height: '28px',
        boxSizing: 'border-box',
        padding: '0 8px',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '6px',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        fontSize: '12px',
      }
    }

    const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

    /** Credential reference the Host derives for a clone route, mirrored for display. */
    function keyRefOf(provider) {
      return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
    }

    /** A route id not already used by any known provider. */
    function uniqueRouteId(source, taken) {
      const stem = source.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'clone'
      let index = 2
      let candidate = `${stem}-${index}`
      while (taken.has(candidate)) {
        index += 1
        candidate = `${stem}-${index}`
      }
      return candidate
    }

    function findNamespace(described, ns) {
      return described.namespaces.find((entry) => entry.ns === ns)
    }

    /**
     * Apply path operations to one namespace, retrying a stale revision.
     * Every retry re-reads the namespace, so the write is fenced against
     * whatever the Host committed in between.
     */
    async function mutateSettings(ctx, ns, ops, attempts = 3) {
      let last
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const described = await ctx.remote.settings.describe()
        if (!described.ok) return described
        const view = findNamespace(described.value, ns)
        if (view === undefined) {
          return { ok: false, error: { message: `${ns} settings section is not mounted` } }
        }
        const written = await ctx.remote.settings.mutate(ns, ops, view.revision)
        if (written.ok) return written
        last = written
        if (!/conflict/i.test(written.error.message)) return written
      }
      return last
    }

    function panel(ctx) {
      const t = ctx.locale.bind(NS)

      function Panel() {
        const [sources, setSources] = useState([])
        const [clones, setClones] = useState({})
        const [piProviders, setPiProviders] = useState({})
        const [activeIds, setActiveIds] = useState(() => new Set())
        const [catalogModels, setCatalogModels] = useState([])
        const [selected, setSelected] = useState(() => new Set())
        const [modelsLoading, setModelsLoading] = useState(false)
        const [modelQuery, setModelQuery] = useState('')
        const [loading, setLoading] = useState(true)
        const [busy, setBusy] = useState(false)
        const [source, setSource] = useState('')
        const [name, setName] = useState('')
        const [status, setStatus] = useState(null)

        const load = useCallback(async () => {
          try {
            const [described, configurable, registered] = await Promise.all([
              ctx.remote.settings.describe(),
              ctx.remote.llm.listConfigurableProviders(),
              ctx.remote.llm.listProviders(),
            ])
            if (!described.ok) {
              setStatus({ kind: 'error', text: described.error.message })
              return
            }
            if (described.value === undefined || !Array.isArray(described.value.namespaces)) {
              setStatus({ kind: 'error', text: 'settings describe returned no namespaces' })
              return
            }
            const view = findNamespace(described.value, NS)
            const defs = (view?.value && typeof view.value === 'object' && view.value.clones) || {}
            setClones(defs)
            const pi = findNamespace(described.value, PI_AI)
            setPiProviders((pi?.value && typeof pi.value === 'object' && pi.value.providers) || {})
            if (configurable.ok && Array.isArray(configurable.value)) {
              setSources(configurable.value.filter((entry) => entry.settingsNs === PI_AI && entry.declared !== true))
            }
            if (registered.ok && Array.isArray(registered.value)) {
              setActiveIds(new Set(registered.value.map((entry) => entry.id)))
            }
          } catch (error) {
            setStatus({ kind: 'error', text: `${t('failed')}${error instanceof Error ? error.message : String(error)}` })
          } finally {
            setLoading(false)
          }
        }, [])

        useEffect(() => {
          void load()
          const disposers = [
            ctx.remote.$on('settings/document-updated', () => { void load() }),
            ctx.remote.$on('llm/adapters-updated', () => { void load() }),
          ]
          return () => { for (const dispose of disposers) dispose() }
        }, [load])

        // Reading models is a catalog lookup for a preset: no network request
        // and no key. Selection starts as the full catalog; the user narrows it.
        useEffect(() => {
          let cancelled = false
          if (source.length === 0) {
            setCatalogModels([])
            setSelected(new Set())
            return () => { cancelled = true }
          }
          setModelsLoading(true)
          setModelQuery('')
          void (async () => {
            try {
              const found = await ctx.remote.llm.discoverModels(PI_AI, { provider: source })
              if (cancelled) return
              if (!found.ok) {
                setCatalogModels([])
                setSelected(new Set())
                setStatus({ kind: 'error', text: `${t('failed')}${found.error.message}` })
                return
              }
              setCatalogModels(found.value)
              setSelected(new Set())
            } catch (error) {
              if (!cancelled) setStatus({ kind: 'error', text: `${t('failed')}${error instanceof Error ? error.message : String(error)}` })
            } finally {
              if (!cancelled) setModelsLoading(false)
            }
          })()
          return () => { cancelled = true }
        }, [source])

        const options = useMemo(() => {
          return sources
            .filter((entry) => clones[entry.provider] === undefined)
            .map((entry) => ({ value: entry.provider, label: `${entry.displayName || entry.provider} · ${entry.provider}` }))
        }, [sources, clones])

        const sourceLabel = useCallback((id) => {
          const entry = sources.find((candidate) => candidate.provider === id)
          return entry === undefined ? id : (entry.displayName || id)
        }, [sources])

        /** The next free `${source}-副本N`, counted among clones of this source. */
        const nextCloneName = useCallback((id, cloneMap) => {
          const same = Object.values(cloneMap ?? {}).filter((definition) => definition?.source === id)
          const used = new Set(same.map((definition) => definition?.displayName))
          let index = same.length + 1
          let candidate = `${sourceLabel(id)}-${t('copySuffix')}${index}`
          while (used.has(candidate)) {
            index += 1
            candidate = `${sourceLabel(id)}-${t('copySuffix')}${index}`
          }
          return candidate
        }, [sourceLabel, t])

        // Keep the latest clone map and name calculator available to the
        // source-change effect without making that effect run on every refresh
        // and overwrite a name the user is typing.
        const clonesRef = useRef(clones)
        useEffect(() => { clonesRef.current = clones }, [clones])
        const nextCloneNameRef = useRef(nextCloneName)
        useEffect(() => { nextCloneNameRef.current = nextCloneName }, [nextCloneName])

        useEffect(() => {
          if (source.length === 0) {
            setName('')
            return
          }
          setName(nextCloneNameRef.current(source, clonesRef.current))
        }, [source])

        const visibleModels = useMemo(() => {
          const query = modelQuery.trim().toLowerCase()
          if (query.length === 0) return catalogModels
          return catalogModels.filter((model) => (
            model.id.toLowerCase().includes(query)
            || (model.name ?? '').toLowerCase().includes(query)
          ))
        }, [catalogModels, modelQuery])

        const toggle = (id) => {
          setSelected((current) => {
            const next = new Set(current)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
          })
        }

        const groupRoutes = (id) => {
          const ref = keyRefOf(id)
          return Object.entries(piProviders)
            .filter(([, profile]) => profile?.apiKeyEnv === ref)
            .map(([routeId, profile]) => ({ id: routeId, api: profile?.api ?? '', models: Array.isArray(profile?.models) ? profile.models.length : 0 }))
        }

        const create = async () => {
          if (busy || source.length === 0) return
          if (selected.size === 0) {
            setStatus({ kind: 'error', text: t('needModels') })
            return
          }
          setBusy(true)
          setStatus(null)
          try {
            const taken = new Set([
              ...sources.map((entry) => entry.provider),
              ...activeIds,
              ...Object.keys(clones),
            ])
            const id = uniqueRouteId(source, taken)
            const label = (name.trim() || `${source} 副本`).slice(0, 80)
            const written = await mutateSettings(ctx, NS, [{
              op: 'set',
              path: ['clones', id],
              value: { source, displayName: label, models: [...selected] },
            }])
            if (!written.ok) throw new Error(written.error.message)
            // The Host builds the profiles on the settings update; wait for the
            // primary route to register rather than claiming success early.
            let live = false
            for (let attempt = 0; attempt < 14; attempt += 1) {
              await sleep(300)
              const registered = await ctx.remote.llm.listProviders()
              if (registered.ok && registered.value.some((entry) => entry.id === id)) { live = true; break }
            }
            await load()
            const after = await ctx.remote.settings.describe()
            let routeIds = []
            if (after.ok) {
              const pi = findNamespace(after.value, PI_AI)
              const ref = keyRefOf(id)
              routeIds = Object.entries(pi?.value?.providers ?? {})
                .filter(([, profile]) => profile?.apiKeyEnv === ref)
                .map(([routeId]) => routeId)
            }
            const afterOwn = after.ok ? findNamespace(after.value, NS) : undefined
            setName(nextCloneName(source, afterOwn?.value?.clones ?? {}))
            const detail = routeIds.length > 0 ? ` (${routeIds.join(', ')})` : ''
            setStatus(live
              ? { kind: 'ok', text: `${t('created')} ${id}${detail} · ${t('createdHint')} ${keyRefOf(id)}` }
              : { kind: 'warn', text: `${t('created')} ${id}${detail} · ${t('pendingHint')}` })
          } catch (error) {
            setStatus({ kind: 'error', text: `${t('failed')}${error instanceof Error ? error.message : String(error)}` })
          } finally {
            setBusy(false)
          }
        }

        const remove = async (id) => {
          if (busy) return
          setBusy(true)
          setStatus(null)
          try {
            const ref = keyRefOf(id)
            const described = await ctx.remote.settings.describe()
            const pi = described.ok ? findNamespace(described.value, PI_AI) : undefined
            const routeIds = Object.entries(pi?.value?.providers ?? {})
              .filter(([, profile]) => profile?.apiKeyEnv === ref)
              .map(([routeId]) => routeId)
            const removed = await mutateSettings(ctx, NS, [{ op: 'unset', path: ['clones', id] }])
            if (!removed.ok) throw new Error(removed.error.message)
            for (const routeId of routeIds) {
              const cleared = await mutateSettings(ctx, PI_AI, [{ op: 'unset', path: ['providers', routeId] }])
              if (!cleared.ok && !/not.*(found|mounted)/i.test(cleared.error.message)) {
                throw new Error(cleared.error.message)
              }
            }
            await load()
          } catch (error) {
            setStatus({ kind: 'error', text: `${t('failed')}${error instanceof Error ? error.message : String(error)}` })
          } finally {
            setBusy(false)
          }
        }

        const rows = Object.entries(clones)
        return h('section', { style: css.panel, 'aria-label': t('title') },
          h('h3', { style: css.title }, t('title')),
          h('p', { style: css.intro }, t('intro')),
          loading
            ? h('p', { style: css.intro }, t('loading'))
            : options.length === 0
              ? h('p', { style: css.intro }, t('noSources'))
              : h('div', { style: css.form },
                h('label', { style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } },
                  t('source'),
                  h('select', {
                    style: css.select,
                    value: source,
                    disabled: busy,
                    onChange: (event) => { setSource(event.target.value) },
                  }, [
                    h('option', { key: '', value: '', disabled: true }, t('chooseSource')),
                    ...options.map((option) => h('option', { key: option.value, value: option.value }, option.label)),
                  ]),
                ),
                h('input', {
                  style: css.input,
                  value: name,
                  disabled: busy,
                  placeholder: source.length === 0 ? t('chooseSource') : t('namePlaceholder'),
                  'aria-label': t('name'),
                  onChange: (event) => { setName(event.target.value) },
                  onKeyDown: (event) => { if (event.key === 'Enter') void create() },
                }),
                h('button', {
                  type: 'button',
                  style: { ...css.primary, opacity: busy || selected.size === 0 ? 0.5 : 1, cursor: busy ? 'default' : 'pointer' },
                  disabled: busy || selected.size === 0,
                  onClick: () => { void create() },
                }, busy ? t('creating') : t('create')),
              ),
          options.length === 0 || loading || source.length === 0
            ? null
            : h('div', { style: css.models },
              h('div', { style: css.modelsHead },
                h('span', { style: css.modelsTitle }, t('models')),
                h('span', { style: css.hint }, `${t('selected')} ${selected.size}/${catalogModels.length}`),
                h('button', { type: 'button', style: css.smallButton, disabled: busy || modelsLoading, onClick: () => { setSelected(new Set(catalogModels.map((model) => model.id))) } }, t('selectAll')),
                h('button', { type: 'button', style: css.smallButton, disabled: busy || modelsLoading, onClick: () => { setSelected(new Set()) } }, t('selectNone')),
              ),
              h('input', {
                style: css.search,
                value: modelQuery,
                placeholder: t('searchModels'),
                'aria-label': t('searchModels'),
                onChange: (event) => { setModelQuery(event.target.value) },
              }),
              modelsLoading
                ? h('p', { style: css.hint }, t('modelsLoading'))
                : catalogModels.length === 0
                  ? h('p', { style: css.hint }, t('noModels'))
                  : h('ul', { style: css.modelList },
                    visibleModels.map((model) => h('li', { key: model.id, style: css.modelRow },
                      h('input', {
                        type: 'checkbox',
                        checked: selected.has(model.id),
                        disabled: busy,
                        onChange: () => { toggle(model.id) },
                      }),
                      h('span', null, model.name || model.id),
                      h('span', { style: css.modelId }, model.id),
                    )),
                  ),
              h('p', { style: { ...css.hint, margin: '6px 0 0' } }, t('modelsHint')),
            ),
          rows.length > 0
            ? h('ul', { style: css.list }, rows.map(([id, definition]) => {
              const routes = groupRoutes(id)
              const liveCount = routes.filter((route) => activeIds.has(route.id)).length
              const live = routes.length > 0 && liveCount === routes.length
              const configured = Array.isArray(definition.models) ? definition.models.length : 0
              return h('li', { key: id, style: css.item },
                h('div', { style: css.itemMain },
                  h('div', { style: css.itemTitle },
                    h('span', {
                      style: { ...css.dot, background: live ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-idle-primary)' },
                    }),
                    definition.displayName || id,
                    h('span', { style: { marginLeft: '6px', fontWeight: 400, color: 'var(--dsw-alias-label-secondary)' } }, `· ${live ? t('active') : t('pending')}`),
                  ),
                  h('div', { style: css.itemMeta },
                    `${t('routeId')}: ${id} · ${t('source')}: ${definition.source}`
                    + (configured > 0 ? ` · ${configured} ${t('modelCount')}` : '')),
                  routes.length === 0
                    ? h('div', { style: css.itemMeta }, `${t('routes')}: —`)
                    : h('div', { style: css.itemMeta },
                      `${t('routes')}: `,
                      routes.map((route, index) => {
                        const on = activeIds.has(route.id)
                        return h('span', { key: route.id },
                          h('span', { style: { ...css.dot, background: on ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-idle-primary)' } }),
                          `${route.id} (${route.api}, ${route.models})`,
                          index === routes.length - 1 ? '' : ' · ',
                        )
                      }),
                    ),
                  h('div', { style: css.itemMeta },
                    `${t('keyRef')}: ${keyRefOf(id)} · ${t('keyShared')}`),
                ),
                h('button', {
                  type: 'button',
                  style: { ...css.linkButton, color: 'var(--dsw-alias-state-error-primary)' },
                  disabled: busy,
                  onClick: () => { void remove(id) },
                }, busy ? t('deleting') : t('delete')),
              )
            }))
            : h('p', { style: css.intro }, t('empty')),
          rows.length > 0 ? h('p', { style: { ...css.intro, margin: '8px 0 0', fontSize: '11px' } }, t('deleteHint')) : null,
          status === null
            ? null
            : h('p', { style: { ...css.status, ...(status.kind === 'ok' ? css.ok : status.kind === 'warn' ? css.warn : css.error) }, role: 'status' }, status.text),
        )
      }

      return Panel
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, DICTS), 'dsh-provider-clone: copy dictionaries')
      ctx.slots.inject('settings.models.footer', () => ctx.slots.register({
        name: 'settings.models.footer',
        id: 'provider-clone',
        order: 20,
      }, panel(ctx)))
    }

    return {
      inject: ['slots', 'locale', 'remote', 'remote.settings', 'remote.llm'],
      apply,
    }
  },
})
