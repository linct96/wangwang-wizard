const CF = 'https://api.cloudflare.com/client/v4'
const RELEASE = 'https://api.github.com/repos/linct96/wangwang/releases/latest'
type Env = { ASSETS: Fetcher; WANGWANG_RELEASE_API?: string }
async function api(path: string, token: string, init: RequestInit = {}) {
  const r = await fetch(`${CF}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers } })
  const d = await r.json() as any
  if (!r.ok || !d.success) throw new Error(d.errors?.[0]?.message || `Cloudflare API ${r.status}`)
  return d.result
}
async function untarGzip(data: ArrayBuffer) {
  const bytes = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()), files: Record<string, Uint8Array> = {}
  for (let p = 0; p + 512 <= bytes.length;) { const size = parseInt(new TextDecoder().decode(bytes.slice(p + 124, p + 136)).replace(/\0/g, '').trim() || '0', 8); const name = new TextDecoder().decode(bytes.slice(p, p + 100)).replace(/\0.*$/, ''); if (!name) break; files[name.replace(/^wangwang-v[^/]+\//, '')] = bytes.slice(p + 512, p + 512 + size); p += 512 + Math.ceil(size / 512) * 512 }
  return files
}
async function deploy(request: Request, env: Env) {
  const form = await request.formData(), token = String(form.get('token') || '').trim()
  const name = (String(form.get('workerName') || 'wangwang').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 28) || 'wangwang')
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
        const redirectRes = await fetch('https://github.com/linct96/wangwang/releases/latest', {
          method: 'GET',
          redirect: 'manual',
          headers: { 'User-Agent': 'wangwang-wizard' },
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
          headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'wangwang-wizard' },
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
      const archiveRes = await fetch(downloadUrl, {
        headers: { 'User-Agent': 'wangwang-wizard' },
      })
      if (!archiveRes.ok) throw new Error(`下载部署包失败 (HTTP ${archiveRes.status})`)
      const files = await untarGzip(await archiveRes.arrayBuffer())
      const decode = (n: string) => new TextDecoder().decode(files[n])
      const worker = decode('worker.js'), assets = JSON.parse(decode('assets.json')), manifest = JSON.parse(decode('manifest.json'))
      if (!manifest || !worker) throw new Error('Wangwang Release 缺少部署文件')


      const dbs = await api(`/accounts/${account.id}/d1/database?per_page=100`, token), db = dbs.find((x: any) => x.name === `${name}-db`) || await api(`/accounts/${account.id}/d1/database`, token, { method: 'POST', body: JSON.stringify({ name: `${name}-db` }) })
      const kvs = await api(`/accounts/${account.id}/storage/kv/namespaces?per_page=100`, token), kv = kvs.find((x: any) => x.title === `${name}-config-cache`) || await api(`/accounts/${account.id}/storage/kv/namespaces`, token, { method: 'POST', body: JSON.stringify({ title: `${name}-config-cache` }) })
      const queues = await api(`/accounts/${account.id}/queues`, token); if (!queues.find((x: any) => x.queue_name === `${name}-jobs`)) await api(`/accounts/${account.id}/queues`, token, { method: 'POST', body: JSON.stringify({ queue_name: `${name}-jobs` }) })
      emit('success', 'D1、KV、Queue 已准备')
      const entries = Object.entries(assets as Record<string, string>), m: Record<string, { hash: string; size: number }> = {}
      for (const [p, b64] of entries) { const bytes = Uint8Array.from(atob(b64), x => x.charCodeAt(0)); const hash = [...new Uint8Array(await crypto.subtle.digest('MD5', bytes))].map(x => x.toString(16).padStart(2, '0')).join(''); m[p] = { hash, size: bytes.length } }
      const session = await api(`/accounts/${account.id}/workers/scripts/${name}/assets-upload-session`, token, { method: 'POST', body: JSON.stringify({ manifest: m }) })
      for (const [p, b64] of entries) { const body = new FormData(); body.append(m[p].hash, b64); await api(`/accounts/${account.id}/workers/assets/upload?base64=true`, session.jwt, { method: 'POST', body }) }
      const metadata = { main_module: 'worker.js', compatibility_date: '2026-08-26', assets: { jwt: session.jwt }, bindings: [{ type: 'd1', name: 'DB', id: db.uuid }, { type: 'kv_namespace', name: 'CONFIG_CACHE', namespace_id: kv.id }, { type: 'queue', name: 'JOBS', queue_name: `${name}-jobs` }, { type: 'assets', name: 'ASSETS' }] }
      const upload = new FormData(); upload.append('metadata', JSON.stringify(metadata)); upload.append('worker.js', new Blob([worker], { type: 'application/javascript+module' }), 'worker.js'); await api(`/accounts/${account.id}/workers/scripts/${name}`, token, { method: 'PUT', body: upload })
      emit('success', 'Worker 上传完成'); emit('complete', JSON.stringify({ url: `https://${name}.${account.name}.workers.dev` }))
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

