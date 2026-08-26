const API = '/proxy'
const $ = (id) => document.getElementById(id)

const tokenInput = $('token')
const toggleTokenBtn = $('toggle-token')
const eyeIcon = $('eye-icon')
const eyeOffIcon = $('eye-off-icon')
const accountsBtn = $('accounts')
const resourcePanel = $('resource-panel')
const accountNameInput = $('account-name')
const nameInput = $('name')
const provisionBtn = $('provision')
const outputEl = $('output')

let selectedAccountId = ''

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
  log(`✗ 错误: ${msg}`)
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

accountsBtn.dataset.label = '开始'
provisionBtn.dataset.label = '一键部署'

accountsBtn.addEventListener('click', async () => {
  const token = tokenInput.value.trim()
  if (!token) return showError('请先输入有效的 Cloudflare API Token')

  setBusy(accountsBtn, true, '正在验证...')
  outputEl.textContent = '●●● 正在连接 Cloudflare 验证 Token...'

  try {
    const accounts = await cfRequest('/accounts?per_page=50')
    if (!accounts.length) throw new Error('当前 Token 未关联任何 Cloudflare 账户')

    selectedAccountId = accounts[0].id
    accountNameInput.value = accounts[0].name

    log(`✓ 验证成功，当前账户: ${accounts[0].name}`)
    resourcePanel.classList.remove('hidden')
  } catch (err) {
    showError(err)
  } finally {
    setBusy(accountsBtn, false)
  }
})

provisionBtn.addEventListener('click', async () => {
  const accountId = selectedAccountId
  const name = sanitizeName(nameInput.value)

  if (!accountId) return showError('未获取到有效的账户信息')

  setBusy(provisionBtn, true, '正在部署...')
  log(`\n● 开始检查并部署 [${name}] 所需资源...`)

  try {
    const response = await fetch('/api/deploy', { method: 'POST', body: (() => { const form = new FormData(); form.set('token', tokenInput.value.trim()); form.set('workerName', name); return form })() })
    if (!response.ok || !response.body) throw new Error(`部署接口返回 HTTP ${response.status}`)
    const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        if (!line.trim()) continue
        const item = JSON.parse(line)
        if (item.type === 'complete') {
          try {
            const payload = typeof item.message === 'string' ? JSON.parse(item.message) : item.message
            if (payload.url) log(`🎉 部署成功！访问地址: ${payload.url}`)
          } catch (_) {
            log(`🎉 部署完成: ${item.message}`)
          }
        } else {
          log(`${item.type === 'error' ? '✗' : item.type === 'success' ? '✓' : '●'} ${item.message}`)
        }
      }
    }
  } catch (err) {
    showError(err)
  } finally {
    setBusy(provisionBtn, false)
  }
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



