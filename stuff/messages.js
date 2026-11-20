import {MessageFlags, ButtonBuilder, ButtonStyle,ContainerBuilder, SectionBuilder, TextDisplayBuilder, ThumbnailBuilder, SeparatorBuilder} from 'discord.js'
import { config, tracked, dryRun, noCommentGuilds, allChannels, save } from './config.js'
import { ctx } from './ctx.js'
import { gh } from './github.js'
import { images, gallery, quote } from './format.js'

async function send(payload, kind) {
  const ids = {}
  if (dryRun) {
    console.log(JSON.stringify(payload, null, 2))
    return ids
  }
  const routed = config.routes[kind] ?? []
  const guilds = []
  for (const channelId of new Set([...routed, ...config.channels])) {
    try {
      const channel = await ctx.client.channels.fetch(channelId)
      if (routed.includes(channelId)) guilds.push(channel.guildId)
      else if (guilds.includes(channel.guildId) || (kind === 'comments' && noCommentGuilds.includes(channel.guildId))) continue
      ids[channelId] = (await channel.send(payload)).id
    } catch (err) {
      console.log(`send failed in ${channelId}: ${err.message}`)
    }
  }
  return ids
}

async function render(entry) {
  const { base } = entry
  const container = new ContainerBuilder()
  if (base.color) container.setAccentColor(base.color)
  container.addSectionComponents(new SectionBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(base.header)).setThumbnailAccessory(new ThumbnailBuilder().setURL(base.avatar)))
  container.addSeparatorComponents(new SeparatorBuilder())
  for (const block of base.blocks) container.addTextDisplayComponents(new TextDisplayBuilder().setContent(block))
  if (base.images?.length) container.addMediaGalleryComponents(gallery(base.images))

  entry.finished = true
  if (entry.prState) return { components: [container], flags: MessageFlags.IsComponentsV2 }

  const { workflows } = await gh(`/repos/${ctx.repo}/actions/workflows?per_page=100`)
  const builds = tracked.filter(({ name }) => workflows.some(workflow => workflow.name === name))
  if (!builds.length) return { components: [container], flags: MessageFlags.IsComponentsV2 }

  const { workflow_runs: runs } = await gh(`/repos/${ctx.repo}/actions/runs?head_sha=${entry.sha}&per_page=100`)
  const matched = builds.map(({ name }) => runs.find(run => run.name === name))
  const lines = matched.map((run, i) => {
    const status = run?.status !== 'completed' ? '' : run.conclusion === 'success' ? '✅' : '❌'
    return '- ' + [status, builds[i].emoji, builds[i].name].filter(Boolean).join(' ')
  })
  const newest = matched.filter(Boolean).sort((a, b) => b.created_at.localeCompare(a.created_at))[0]
  entry.finished = matched.every(run => run?.status === 'completed')

  container.addSeparatorComponents(new SeparatorBuilder())
  container.addSectionComponents(new SectionBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(['**Workflow runs:**', ...lines].join('\n'))).setButtonAccessory(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Go to workflow run').setURL(newest?.html_url ?? base.link)))

  return { components: [container], flags: MessageFlags.IsComponentsV2 }
}

export async function post(key, kind, sha, base, prState) {
  const entry = { sha, base, prState, createdAt: Date.now() }
  const payload = await render(entry)
  entry.messageIds = await send(payload, kind)
  entry.rendered = JSON.stringify(payload)
  ctx.state.messages[key] = entry
  save()
}

export async function update(key) {
  const entry = ctx.state.messages[key]
  const payload = await render(entry)
  const json = JSON.stringify(payload)
  if (json === entry.rendered) return
  entry.messageIds ??= { [config.channels[0]]: entry.messageId }
  if (dryRun) console.log(`edit ${key}`, JSON.stringify(payload, null, 2))
  else for (const [channelId, messageId] of Object.entries(entry.messageIds)) {
    if (!allChannels().includes(channelId)) continue
    try {
      const channel = await ctx.client.channels.fetch(channelId)
      await channel.messages.edit(messageId, payload)
    } catch (err) {
      console.log(`edit failed in ${channelId}: ${err.message}`)
    }
  }
  entry.rendered = json
}

export function buildCard({ user, action, heading = ctx.repoName, title, url, body, footer, color, emoji }) {
  const container = new ContainerBuilder()
  if (color) container.setAccentColor(color)
  container.addSectionComponents(new SectionBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(`${user ? `*${[user.login, action].filter(Boolean).join(' ')}*\n` : ''}## \`${heading}\`\n${emoji ? emoji + ' ' : ''}**[${title}](${url})**`)).setThumbnailAccessory(new ThumbnailBuilder().setURL(user?.avatar_url ?? ctx.repoInfo.owner.avatar_url)))
  if (footer) {
    container.addSeparatorComponents(new SeparatorBuilder())
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`${quote(body)}\n-# *${footer}*`.trim()))
    if (images(body).length) container.addMediaGalleryComponents(gallery(images(body)))
  }
  return { components: [container], flags: MessageFlags.IsComponentsV2 }
}

export async function notify(options) {
  await send(buildCard(options), options.kind)
}
