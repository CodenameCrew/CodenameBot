import { ctx } from './ctx.js'

const etags = new Map()

export async function gh(path) {
  const url = `https://api.github.com${path}`
  const cached = etags.get(url)
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'cne-bot' }
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  if (cached) headers['if-none-match'] = cached.etag

  const res = await fetch(url, { headers })
  if (res.status === 304) return cached.data
  if (res.status === 403 || res.status === 429) {
    const retryAfter = res.headers.get('retry-after')
    if (retryAfter) ctx.rateLimitedUntil = Date.now() + Number(retryAfter) * 1000
    else if (res.headers.get('x-ratelimit-remaining') === '0') ctx.rateLimitedUntil = Number(res.headers.get('x-ratelimit-reset')) * 1000
  }
  if (!res.ok) throw new Error(`github ${res.status} on ${path}: ${(await res.text()).slice(0, 200)}`)

  const data = await res.json()
  if (res.headers.get('etag')) etags.set(url, { etag: res.headers.get('etag'), data })
  return data
}
