const CF = 'https://api.cloudflare.com/client/v4'
const RELEASE = 'https://api.github.com/repos/linct96/wangwang/releases/latest'
type Env = { ASSETS: Fetcher; WANGWANG_RELEASE_API?: string }
async function api(path: string, token: string, init: RequestInit = {}, envelope = false) {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  if (init.body instanceof FormData) headers.delete('Content-Type')
  else if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const r = await fetch(`${CF}${path}`, { ...init, headers })
  const d = await r.json() as any
  if (!r.ok || !d.success) throw new Error(d.errors?.[0]?.message || `Cloudflare API ${r.status}`)
  return envelope ? d : d.result
}
async function listAll(path: string, token: string) {
  const result: any[] = []
  for (let page = 1; ; page += 1) {
    const data = await api(`${path}&page=${page}`, token, {}, true)
    result.push(...(data.result || []))
    if (!data.result_info || page >= data.result_info.total_pages || !data.result.length) return result
  }
}
function assetContentType(path: string) {
  if (path.endsWith('.js')) return 'text/javascript; charset=UTF-8'
  if (path.endsWith('.css')) return 'text/css; charset=UTF-8'
  if (path.endsWith('.html')) return 'text/html; charset=UTF-8'
  if (path.endsWith('.svg')) return 'image/svg+xml'
  if (path.endsWith('.json')) return 'application/json; charset=UTF-8'
  if (path.endsWith('.ico')) return 'image/x-icon'
  return 'application/octet-stream'
}
async function applyMigrations(accountId: string, databaseId: string, files: Record<string, Uint8Array>, manifest: any, token: string) {
  const dir = `${String(manifest.migrationsDir || 'migrations').replace(/\/+$/, '')}/`
  const migrations = Object.keys(files).filter((name) => name.startsWith(dir) && name.endsWith('.sql')).sort()
  if (!migrations.length) throw new Error('部署包缺少 D1 migration 文件')
  const query = (sql: string) => api(`/accounts/${accountId}/d1/database/${databaseId}/query`, token, { method: 'POST', body: JSON.stringify({ sql }) })
  await query('CREATE TABLE IF NOT EXISTS "d1_migrations" (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);')
  const applied = new Set(((await query('SELECT name FROM "d1_migrations" ORDER BY id'))?.[0]?.results || []).map((row: any) => row.name))
  for (const path of migrations) {
    const name = path.slice(dir.length)
    if (applied.has(name)) continue
    const sql = new TextDecoder().decode(files[path]).replace(/;\s*$/, '')
    await query(`${sql}; INSERT INTO "d1_migrations" (name) VALUES ('${name.replace(/'/g, "''")}');`)
  }
}
async function untarGzip(data: ArrayBuffer) {
  const bytes = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()), files: Record<string, Uint8Array> = {}
  for (let p = 0; p + 512 <= bytes.length;) { const size = parseInt(new TextDecoder().decode(bytes.slice(p + 124, p + 136)).replace(/\0/g, '').trim() || '0', 8); const name = new TextDecoder().decode(bytes.slice(p, p + 100)).replace(/\0.*$/, ''); if (!name) break; files[name.replace(/^wangwang-v[^/]+\//, '')] = bytes.slice(p + 512, p + 512 + size); p += 512 + Math.ceil(size / 512) * 512 }
  return files
}
async function deploy(request: Request, env: Env) {
  const form = await request.formData(), token = String(form.get('token') || '').trim()
  const name = (String(form.get('workerName') || 'wangwang').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 28) || 'wangwang')
  const forceRecreate = String(form.get('forceRecreate') || '').toLowerCase() === 'true'
  if (!token) throw new Error('请输入 Cloudflare API Token')
  return new Response(new ReadableStream({ async start(c) {
    const emit = (type: string, message: string) => c.enqueue(new TextEncoder().encode(JSON.stringify({ type, message }) + '\n'))
    try {
      emit('info', '验证 Cloudflare Token...')
      const account = (await api('/accounts?per_page=1', token))?.[0]
      if (!account) throw new Error('Token 未关联 Cloudflare 账户')
      emit('info', '正在获取 Wangwang 最新版本发布包...')
      let downloadUrl = ''
      let tag = ''

      // 1. 优先通过 GitHub Releases 302 重定向解析最新 tag（完全不消耗 GitHub API 速率配额，避免 429）
      try {
        const redirectRes = await fetch(`https://github.com/linct96/wangwang/releases/latest?_=${Date.now()}`, {
          method: 'GET',
          redirect: 'manual',
          headers: { 'User-Agent': 'wangwang-wizard', 'Cache-Control': 'no-cache' },
        })
        const loc = redirectRes.headers.get('location') || ''
        if (loc) {
          tag = loc.split('/').pop()?.trim() || ''
          if (tag) {
            downloadUrl = `https://github.com/linct96/wangwang/releases/download/${tag}/wangwang-deploy-${tag}.tar.gz`
          }
        }
      } catch (_) {}

      // 2. 备用：若重定向未获取到，则通过 API 获取
      if (!downloadUrl) {
        const releaseRes = await fetch(env.WANGWANG_RELEASE_API || RELEASE, {
          headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'wangwang-wizard', 'Cache-Control': 'no-cache' },
        })
        if (!releaseRes.ok) {
          throw new Error(`无法获取 GitHub 发布包 (HTTP ${releaseRes.status})，请确认 linct96/wangwang 仓库已发布 Release`)
        }
        const release = await releaseRes.json() as any
        tag = release.tag_name || 'latest'
        const targetArchiveName = `wangwang-deploy-v${String(release.tag_name || '').replace(/^v/, '')}.tar.gz`
        downloadUrl = release.assets?.find((x: any) => x.name === targetArchiveName || (x.name.startsWith('wangwang-deploy-') && x.name.endsWith('.tar.gz')))?.browser_download_url || ''
      }

      if (!downloadUrl) {
        throw new Error(`未找到匹配的部署包 wangwang-deploy-*.tar.gz`)
      }

      emit('info', `正在下载部署包 (${tag || 'latest'})...`)
      const archiveRes = await fetch(`${downloadUrl}${downloadUrl.includes('?') ? '&' : '?'}_=${Date.now()}`, {
        headers: { 'User-Agent': 'wangwang-wizard', 'Cache-Control': 'no-cache' },
      })
      if (!archiveRes.ok) throw new Error(`下载部署包失败 (HTTP ${archiveRes.status})`)
      const archive = await archiveRes.arrayBuffer()
      const expected = await (await fetch(`${downloadUrl}.sha256?_=${Date.now()}`, { headers: { 'User-Agent': 'wangwang-wizard', 'Cache-Control': 'no-cache' } })).text()
      const actual = [...new Uint8Array(await crypto.subtle.digest('SHA-256', archive))].map((x) => x.toString(16).padStart(2, '0')).join('')
      if (expected.trim().split(/\s+/)[0].toLowerCase() !== actual) throw new Error('部署包 SHA-256 校验失败')
      const files = await untarGzip(archive)
      const decode = (n: string) => new TextDecoder().decode(files[n])
      const worker = decode('worker.js'), assets = JSON.parse(decode('assets.json')), manifest = JSON.parse(decode('manifest.json'))
      if (!manifest || !worker) throw new Error('Wangwang Release 缺少部署文件')


      const dbName = `${name}-db`, kvTitle = `${name}-KV`, queueName = `${name}-jobs`
      const dbs = await listAll(`/accounts/${account.id}/d1/database?per_page=100`, token)
      const kvs = await listAll(`/accounts/${account.id}/storage/kv/namespaces?per_page=100`, token)
      const queues = await listAll(`/accounts/${account.id}/queues?per_page=100`, token)
      if (forceRecreate) {
        emit('info', '正在删除同名 Worker、D1、KV、Queue...')
        // Worker 作为 Queue Consumer 时必须先解除绑定，才能删除 Worker。
        await Promise.all((queues || []).map(async (q: any) => {
          const consumers = await api(`/accounts/${account.id}/queues/${encodeURIComponent(q.queue_id)}/consumers`, token)
          const matches = (consumers || []).filter((c: any) => c.type === 'worker' && c.script_name === name)
          await Promise.all(matches.map((c: any) => api(`/accounts/${account.id}/queues/${encodeURIComponent(q.queue_id)}/consumers/${encodeURIComponent(c.consumer_id)}`, token, { method: 'DELETE' })))
          let cleared = !matches.length
          for (let i = 0; i < 10 && !cleared; i++) {
            const remaining = await api(`/accounts/${account.id}/queues/${encodeURIComponent(q.queue_id)}/consumers`, token)
            cleared = !(remaining || []).some((c: any) => c.type === 'worker' && c.script_name === name)
            if (cleared) break
            await new Promise((resolve) => setTimeout(resolve, 1000))
          }
          if (!cleared) throw new Error(`Queue ${q.queue_name || q.queue_id} 的 Worker Consumer 解绑未完成，请稍后重试`)
        }))
        await api(`/accounts/${account.id}/workers/scripts/${encodeURIComponent(name)}`, token, { method: 'DELETE' })
        await Promise.all((queues || []).filter((x: any) => x.queue_name === queueName).map((x: any) => api(`/accounts/${account.id}/queues/${encodeURIComponent(x.queue_id)}`, token, { method: 'DELETE' })))
        await Promise.all((kvs || []).filter((x: any) => x.title === kvTitle).map((x: any) => api(`/accounts/${account.id}/storage/kv/namespaces/${encodeURIComponent(x.id)}`, token, { method: 'DELETE' })))
        await Promise.all((dbs || []).filter((x: any) => x.name === dbName).map((x: any) => api(`/accounts/${account.id}/d1/database/${encodeURIComponent(x.uuid)}`, token, { method: 'DELETE' })))
        emit('success', '同名资源已删除，正在重新创建...')
      }
      const db = (!forceRecreate && dbs.find((x: any) => x.name === dbName)) || await api(`/accounts/${account.id}/d1/database`, token, { method: 'POST', body: JSON.stringify({ name: dbName }) })
      const kv = (!forceRecreate && kvs.find((x: any) => x.title === kvTitle)) || await api(`/accounts/${account.id}/storage/kv/namespaces`, token, { method: 'POST', body: JSON.stringify({ title: kvTitle }) })
      const queue = (!forceRecreate && queues.find((x: any) => x.queue_name === queueName)) || await api(`/accounts/${account.id}/queues`, token, { method: 'POST', body: JSON.stringify({ queue_name: queueName }) })
      emit('info', '正在应用 D1 数据库迁移...')
      await applyMigrations(account.id, db.uuid, files, manifest, token)
      emit('success', 'D1、KV、Queue 已准备')
      const entries = Object.entries(assets as Record<string, string>), m: Record<string, { hash: string; size: number }> = {}
      for (const [p, b64] of entries) { const bytes = Uint8Array.from(atob(b64), x => x.charCodeAt(0)); const hash = [...new Uint8Array(await crypto.subtle.digest('MD5', bytes))].map(x => x.toString(16).padStart(2, '0')).join(''); m[p] = { hash, size: bytes.length } }
      const session = await api(`/accounts/${account.id}/workers/scripts/${name}/assets-upload-session`, token, { method: 'POST', body: JSON.stringify({ manifest: m }) })
      let assetsJwt = session.jwt
      const assetsByHash = new Map(entries.map(([p, b64]) => [m[p].hash, { b64, type: assetContentType(p) }]))
      for (const bucket of session.buckets || []) {
        const body = new FormData()
        for (const hash of bucket) {
          const asset = assetsByHash.get(hash)
          if (asset) body.append(hash, new Blob([asset.b64], { type: asset.type }))
        }
        const uploaded = await api(`/accounts/${account.id}/workers/assets/upload?base64=true`, assetsJwt, { method: 'POST', body })
        assetsJwt = uploaded?.jwt || assetsJwt
      }
      const metadata = { main_module: 'worker.js', compatibility_date: '2026-08-26', assets: { jwt: assetsJwt, config: { not_found_handling: 'single-page-application' }, run_worker_first: true, serve_directly: false }, bindings: [{ type: 'd1', name: 'DB', id: db.uuid }, { type: 'kv_namespace', name: 'KV', namespace_id: kv.id }, { type: 'queue', name: 'JOBS', queue_name: `${name}-jobs` }, { type: 'assets', name: 'ASSETS' }] }
      const upload = new FormData(); upload.append('metadata', JSON.stringify(metadata)); upload.append('worker.js', new Blob([worker], { type: 'application/javascript+module' }), 'worker.js'); await api(`/accounts/${account.id}/workers/scripts/${name}`, token, { method: 'PUT', body: upload })
      const consumers = await api(`/accounts/${account.id}/queues/${encodeURIComponent(queue.queue_id)}/consumers`, token)
      const consumer = consumers[0]
      if (consumer?.type === 'http_pull') throw new Error(`Queue 已配置 HTTP Pull Consumer，无法绑定 Worker；请先删除该 Consumer (${consumer.consumer_id})`)
      const consumerBody = JSON.stringify({ script_name: name, type: 'worker', settings: { batch_size: 1, max_wait_time_ms: 1000, max_retries: 3 } })
      await api(`/accounts/${account.id}/queues/${encodeURIComponent(queue.queue_id)}/consumers${consumer ? `/${encodeURIComponent(consumer.consumer_id)}` : ''}`, token, { method: consumer ? 'PUT' : 'POST', body: consumerBody })
      emit('success', 'Queue Consumer 已配置')
      let url = '', urlMessage = ''
      try {
        const state = await api(`/accounts/${account.id}/workers/scripts/${name}/subdomain`, token, { method: 'POST', body: JSON.stringify({ enabled: true }) })
        if (!state?.enabled) throw new Error('Cloudflare 未确认 workers.dev 已开启')
        const subdomain = (await api(`/accounts/${account.id}/workers/subdomain`, token))?.subdomain
        if (subdomain) url = `https://${name}.${subdomain}.workers.dev`
        else urlMessage = 'Worker 已部署，但当前账户未返回 workers.dev 子域名'
      } catch (e) {
        urlMessage = `Worker 已部署，但 workers.dev 自动开启失败：${e instanceof Error ? e.message : String(e)}`
      }
      emit('success', 'Worker 上传完成')
      emit('complete', JSON.stringify({ url, message: urlMessage }))
    } catch (e) { emit('error', e instanceof Error ? e.message : String(e)) } c.close()
  } }), { headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' } })
}
export default {
  async fetch(request: Request, env: Env) {
    const u = new URL(request.url)

    // 1. One-click deploy endpoint
    if (u.pathname === '/api/deploy' && request.method === 'POST') {
      return deploy(request, env)
    }

    // 2. Proxy Cloudflare API requests for frontend
    if (u.pathname.startsWith('/cfproxy/')) {
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            'Access-Control-Max-Age': '86400',
          },
        })
      }

      const targetPath = u.pathname.replace(/^\/cfproxy/, '')
      const targetUrl = `${CF}${targetPath}${u.search}`

      const headers = new Headers(request.headers)
      headers.set('Host', 'api.cloudflare.com')

      const res = await fetch(targetUrl, {
        method: request.method,
        headers,
        body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
      })

      const resHeaders = new Headers(res.headers)
      resHeaders.set('Access-Control-Allow-Origin', '*')
      resHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS')
      resHeaders.set('Access-Control-Allow-Headers', 'Content-Type, Authorization')

      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers: resHeaders,
      })
    }

    // 3. Static assets
    return env.ASSETS.fetch(request)
  },
}
