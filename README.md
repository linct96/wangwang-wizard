# Wangwang Wizard

独立的纯静态 Cloudflare 部署向导。Token 只在浏览器内存中使用，页面直接请求 Cloudflare API，不经过 Wangwang Worker。

## Cloudflare Workers Builds

```text
Root directory: /
Build command: pnpm run build
Deploy command: npx wrangler deploy
```

部署后绑定 `wizard.wangwang.works.dev`。
