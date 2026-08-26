const CF = 'https://api.cloudflare.com/client/v4'
const RELEASE = 'https://api.github.com/repos/linct96/wangwang/releases/latest'
type Env = { ASSETS: Fetcher; WANGWANG_RELEASE_API?: string }
async function api(path: string, token: string, init: RequestInit = {}) {
  const r = await fetch(`${CF}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers } })
  const d = await r.json() as any
  if (!r.ok || !d.success) throw new Error(d.errors?.[0]?.message || `Cloudflare API ${r.status}`)
  return d.result
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
      const release = await (await fetch(env.WANGWANG_RELEASE_API || RELEASE, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'wangwang-wizard' } })).json() as any
      const get = (n: string) => release.assets?.find((x: any) => x.name === n)?.browser_download_url
      const [worker, assets, manifest] = await Promise.all([fetch(get('worker.js')).then(r => r.text()), fetch(get('assets.json')).then(r => r.json()), fetch(get('manifest.json')).then(r => r.json())])
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
export default { async fetch(request: Request, env: Env) { const u = new URL(request.url); if (u.pathname === '/api/deploy' && request.method === 'POST') return deploy(request, env); return env.ASSETS.fetch(request) } }
