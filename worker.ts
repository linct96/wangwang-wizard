const CF_API = 'https://api.cloudflare.com/client/v4'

export default {
  async fetch(request: Request, env: { ASSETS: Fetcher }): Promise<Response> {
    const url = new URL(request.url)

    // Proxy Cloudflare API requests to bypass browser CORS restrictions
    if (url.pathname.startsWith('/proxy/')) {
      const targetPath = url.pathname.replace(/^\/proxy/, '')
      const targetUrl = `${CF_API}${targetPath}${url.search}`

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

    // Serve static assets
    return env.ASSETS.fetch(request)
  },
}

