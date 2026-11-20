import { MediaGalleryBuilder, MediaGalleryItemBuilder } from 'discord.js'

export function images(text) {
  const urls = [...(text || '').matchAll(/<img[^>]*src="([^"]+)"[^>]*>|!\[[^\]]*\]\(([^)\s]+)[^)]*\)/gi)]
  return urls.map(match => match[1] || match[2]).filter(url => url.startsWith('http')).slice(0, 10)
}

export function gallery(urls) {
  return new MediaGalleryBuilder().addItems(urls.map(url => new MediaGalleryItemBuilder().setURL(url)))
}

export function quote(text) {
  const body = (text || '').replace(/<img[^>]*>|!\[[^\]]*\]\([^)]*\)/gi, '').split('\n').filter(line => !/^co-authored-by:/i.test(line)).join('\n').trim().slice(0, 300)
  return body ? '\n' + body.split('\n').map(line => `> ${line}`).join('\n') : ''
}

export function by(user, verb, time) {
  return `[${user.login}](https://github.com/${user.login}) ${verb} <t:${Math.floor(new Date(time) / 1000)}:R>`
}
