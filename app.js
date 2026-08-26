const API = '/proxy'
const $ = (id) => document.getElementById(id)

const tokenInput = $('token')
const toggleTokenBtn = $('toggle-token')
const eyeIcon = $('eye-icon')
const eyeOffIcon = $('eye-off-icon')
const accountsBtn = $('accounts')
const resourcePanel = $('resource-panel')
const accountSelect = $('account')
const nameInput = $('name')
const provisionBtn = $('provision')
const resultPanel = $('result')
const outputEl = $('output')
const errorEl = $('error')
const copyBtn = $('copy')
const downloadBtn = $('download')
const genPrivateLinkBtn = $('gen-private-link')

let generatedConfig = ''

function sanitizeName(raw) {
  return raw.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 28) || 'wangwang'
}

toggleTokenBtn.addEventListener('click', () => {
  const isPassword = tokenInput.type === 'password'
  tokenInput.type = isPassword ? 'text' : 'password'
  eyeIcon.classList.toggle('hidden', isPassword)
  eyeOffIcon.classList.toggle('hidden', !isPassword)
})

function log(message) {
  outputEl.textContent += `\n${message}`
  outputEl.scrollTop = outputEl.scrollHeight
}

function showError(err) {
  const msg = err instanceof Error ? err.message : String(err)
  errorEl.textContent = msg
  errorEl.classList.remove('hidden')
  log(`✗ 错误: ${msg}`)
}

function clearError() {
  errorEl.classList.add('hidden')
  errorEl.textContent = ''
}

function setBusy(btn, isBusy, text) {
  btn.disabled = isBusy
  btn.textContent = isBusy ? text : btn.dataset.label
}

async function cfRequest(path, init = {}) {
  const token = tokenInput.value.trim()
  if (!token) throw new Error('请输入 Cloudflare API Token')

  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  })

  const data = await response.json()
  if (!response.ok || !data.success) {
    throw new Error(data.errors?.[0]?.message || `HTTP ${response.status}`)
  }
  return data.result
}

accountsBtn.dataset.label = '验证 Token 并查询账户'
provisionBtn.dataset.label = '一键创建 D1 / KV / Queue'

accountsBtn.addEventListener('click', async () => {
  clearError()
  const token = tokenInput.value.trim()
  if (!token) return showError('请先输入有效的 Cloudflare API Token')

  setBusy(accountsBtn, true, '正在查询...')
  outputEl.textContent = '●●● 正在连接 Cloudflare API...'

  try {
    const accounts = await cfRequest('/accounts?per_page=50')
    if (!accounts.length) throw new Error('当前 Token 未关联任何 Cloudflare 账户')

    accountSelect.replaceChildren(
      ...accounts.map((item) => {
        const opt = document.createElement('option')
        opt.value = item.id
        opt.textContent = `${item.name} (${item.id})`
        return opt
      })
    )

    log(`✓ 验证成功，找到 ${accounts.length} 个账户: ${accounts[0].name}`)
    resourcePanel.classList.remove('hidden')
  } catch (err) {
    showError(err)
  } finally {
    setBusy(accountsBtn, false)
  }
})

provisionBtn.addEventListener('click', async () => {
  clearError()
  const accountId = accountSelect.value
  const name = sanitizeName(nameInput.value)

  if (!accountId) return showError('请选择有效的账户')

  setBusy(provisionBtn, true, '正在创建资源...')
  log(`● 正在为 [${name}] 创建 Cloudflare 资源...`)

  try {
    // 1. D1
    const db = await cfRequest(`/accounts/${accountId}/d1/database`, {
      method: 'POST',
      body: JSON.stringify({ name: `${name}-db` }),
    })
    log(`✓ D1 数据库已创建: ${db.name}`)

    // 2. KV
    const kv = await cfRequest(`/accounts/${accountId}/storage/kv/namespaces`, {
      method: 'POST',
      body: JSON.stringify({ title: `${name}-config-cache` }),
    })
    log(`✓ KV 命名空间已创建: ${name}-config-cache`)

    // 3. Queues
    const queue = await cfRequest(`/accounts/${accountId}/queues`, {
      method: 'POST',
      body: JSON.stringify({ queue_name: `${name}-jobs` }),
    })
    log(`✓ 消息队列已创建: ${queue.queue_name || `${name}-jobs`}`)

    const configObj = {
      d1_databases: [{ binding: 'DB', database_name: db.name, database_id: db.uuid }],
      kv_namespaces: [{ binding: 'CONFIG_CACHE', id: kv.id }],
      queues: {
        producers: [{ binding: 'JOBS', queue: queue.queue_name || `${name}-jobs` }],
        consumers: [{ queue: queue.queue_name || `${name}-jobs` }],
      },
    }

    generatedConfig = JSON.stringify(configObj, null, 2)
    log(`\n🎉 资源创建完成！配置如下：\n${generatedConfig}`)
    resultPanel.classList.remove('hidden')
  } catch (err) {
    showError(err)
  } finally {
    setBusy(provisionBtn, false)
  }
})

copyBtn.addEventListener('click', async () => {
  if (!generatedConfig) return
  await navigator.clipboard.writeText(generatedConfig)
  copyBtn.textContent = '已复制'
  setTimeout(() => (copyBtn.textContent = '复制配置'), 2000)
})

downloadBtn.addEventListener('click', () => {
  if (!generatedConfig) return
  const blob = new Blob([generatedConfig], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'wrangler.resources.json'
  a.click()
  URL.revokeObjectURL(url)
})

genPrivateLinkBtn.addEventListener('click', async () => {
  const token = tokenInput.value.trim()
  if (!token) return showError('请先输入 Token')
  const url = new URL(window.location.href)
  url.hash = `token=${encodeURIComponent(token)}`
  await navigator.clipboard.writeText(url.href)
  genPrivateLinkBtn.textContent = '链接已复制'
  setTimeout(() => (genPrivateLinkBtn.textContent = '复制私有链接'), 2000)
})

// Theme Management
const toggleThemeBtn = $('toggle-theme')
const themeSun = $('theme-sun')
const themeMoon = $('theme-moon')

function updateThemeUI(theme) {
  document.documentElement.setAttribute('data-theme', theme)
  localStorage.setItem('theme', theme)
  const isLight = theme === 'light'
  if (themeSun) themeSun.classList.toggle('hidden', isLight)
  if (themeMoon) themeMoon.classList.toggle('hidden', !isLight)
}

if (toggleThemeBtn) {
  toggleThemeBtn.addEventListener('click', () => {
    const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark'
    const nextTheme = currentTheme === 'light' ? 'dark' : 'light'
    updateThemeUI(nextTheme)
  })
}

// Initialize Token Link & URL Token
window.addEventListener('DOMContentLoaded', () => {
  const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark'
  updateThemeUI(currentTheme)

  const permissions = [
    { key: 'd1', type: 'edit' },
    { key: 'workers_kv_storage', type: 'edit' },
    { key: 'workers_queues', type: 'edit' },
    { key: 'workers_scripts', type: 'edit' },
    { key: 'account_settings', type: 'read' },
    { key: 'user_details', type: 'read' },
  ]

  const tokenUrl = new URL('https://dash.cloudflare.com/profile/api-tokens')
  tokenUrl.searchParams.set('permissionGroupKeys', JSON.stringify(permissions))
  tokenUrl.searchParams.set('accountId', '*')
  tokenUrl.searchParams.set('name', 'Wangwang-Wizard')

  const tokenLinkEl = $('tokenTemplate')
  if (tokenLinkEl) tokenLinkEl.href = tokenUrl.href

  let tokenFromUrl = ''
  if (window.location.hash) {
    tokenFromUrl = new URLSearchParams(window.location.hash.slice(1)).get('token')
  }
  if (!tokenFromUrl) {
    tokenFromUrl = new URLSearchParams(window.location.search).get('token')
  }

  if (tokenFromUrl) {
    tokenInput.value = tokenFromUrl
    accountsBtn.click()
  }
})



