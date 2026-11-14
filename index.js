import fs from 'fs'
import {
  Client, GatewayIntentBits, Events, MessageFlags, ButtonBuilder, ButtonStyle,
  SlashCommandBuilder, ChannelType, PermissionFlagsBits,
  ContainerBuilder, SectionBuilder, TextDisplayBuilder, ThumbnailBuilder, SeparatorBuilder,
  MediaGalleryBuilder, MediaGalleryItemBuilder
} from 'discord.js'

const envPath = new URL('.env', import.meta.url)
if (fs.existsSync(envPath)) process.loadEnvFile(envPath)

const statePath = new URL('state.json', import.meta.url)
const configPath = new URL('config.json', import.meta.url)

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
config.channels ??= []
config.routes ??= {}

const repos = config.repos ?? []
const excludedRepos = config.excludedRepos ?? []
const officialRepos = (config.officialRepos ?? []).map(name => name.toLowerCase())
const tracked = config.tracked ?? []
const pollMs = (config.pollSeconds || 30) * 1000
const dryRun = !!process.env.DRY_RUN
const allowedRoles = config.allowedRoles ?? []
const noCommentGuilds = config.noCommentGuilds ?? []
const kinds = {
  commits: 'Commits',
  officialPulls: 'Official pull requests',
  unofficialPulls: 'Unofficial pull requests',
  comments: 'Comments'
}
const day = 24 * 60 * 60 * 1000
const green = 0x238636
const red = 0xda3633
const purple = 0x8957e5
const gray = 0x6e7681
const yellow = 0xe3b341
const etags = new Map()

let store = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { repos: {} }
if (!store.repos) store = { repos: config.repo ? { [config.repo]: store } : {} }

let repo
let repoName
let repoUrl
let repoInfo
let state
let rateLimitedUntil = 0
let firstPoll = true
let client

function save() {
  fs.writeFileSync(statePath, JSON.stringify(store, null, 2))
}

function saveConfig() {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
}

function allChannels() {
  return [...new Set([...Object.values(config.routes).flat(), ...config.channels])]
}

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
      const channel = await client.channels.fetch(channelId)
      if (routed.includes(channelId)) guilds.push(channel.guildId)
      else if (guilds.includes(channel.guildId) || (kind === 'comments' && noCommentGuilds.includes(channel.guildId))) continue
      ids[channelId] = (await channel.send(payload)).id
    } catch (err) {
      console.log(`send failed in ${channelId}: ${err.message}`)
    }
  }
  return ids
}

async function gh(path) {
  const url = `https://api.github.com${path}`
  const cached = etags.get(url)
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'cne-bot' }
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  if (cached) headers['if-none-match'] = cached.etag

  const res = await fetch(url, { headers })
  if (res.status === 304) return cached.data
  if (res.status === 403 || res.status === 429) {
    const retryAfter = res.headers.get('retry-after')
    if (retryAfter) rateLimitedUntil = Date.now() + Number(retryAfter) * 1000
    else if (res.headers.get('x-ratelimit-remaining') === '0') rateLimitedUntil = Number(res.headers.get('x-ratelimit-reset')) * 1000
  }
  if (!res.ok) throw new Error(`github ${res.status} on ${path}: ${(await res.text()).slice(0, 200)}`)

  const data = await res.json()
  if (res.headers.get('etag')) etags.set(url, { etag: res.headers.get('etag'), data })
  return data
}

function images(text) {
  const urls = [...(text || '').matchAll(/<img[^>]*src="([^"]+)"[^>]*>|!\[[^\]]*\]\(([^)\s]+)[^)]*\)/gi)]
  return urls.map(match => match[1] || match[2]).filter(url => url.startsWith('http')).slice(0, 10)
}

function gallery(urls) {
  return new MediaGalleryBuilder().addItems(urls.map(url => new MediaGalleryItemBuilder().setURL(url)))
}

function quote(text) {
  const body = (text || '').replace(/<img[^>]*>|!\[[^\]]*\]\([^)]*\)/gi, '').split('\n').filter(line => !/^co-authored-by:/i.test(line)).join('\n').trim().slice(0, 300)
  return body ? '\n' + body.split('\n').map(line => `> ${line}`).join('\n') : ''
}

function by(user, verb, time) {
  return `[${user.login}](https://github.com/${user.login}) ${verb} <t:${Math.floor(new Date(time) / 1000)}:R>`
}

function prKind() {
  if (officialRepos.includes(repo.toLowerCase())) return 'officialPulls'
  if (repoInfo.fork) return 'unofficialPulls'
}

function prBase(pr) {
  const status = pr.merged_at ? ' · Merged' : pr.state === 'closed' ? ' · Closed' : ''
  return {
    color: pr.merged_at ? purple : pr.state === 'closed' ? red : green,
    avatar: pr.user.avatar_url,
    link: pr.html_url,
    images: images(pr.body),
    header: `*${pr.user.login} opened a pull request*\n## \`${repoName}/${pr.base.ref}\`\n**[Pull request #${pr.number}](${pr.html_url})**${status}`,
    blocks: [`**[${pr.title}](${pr.html_url})**${quote(pr.body)}\n-# *${by(pr.user, 'opened', pr.created_at)}*`]
  }
}

async function render(entry) {
  const { base } = entry
  const container = new ContainerBuilder()
  if (base.color) container.setAccentColor(base.color)
  container.addSectionComponents(new SectionBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(base.header))
    .setThumbnailAccessory(new ThumbnailBuilder().setURL(base.avatar)))
  container.addSeparatorComponents(new SeparatorBuilder())
  for (const block of base.blocks) container.addTextDisplayComponents(new TextDisplayBuilder().setContent(block))
  if (base.images?.length) container.addMediaGalleryComponents(gallery(base.images))

  entry.finished = true
  if (entry.prState) return { components: [container], flags: MessageFlags.IsComponentsV2 }

  const { workflows } = await gh(`/repos/${repo}/actions/workflows?per_page=100`)
  const builds = tracked.filter(({ name }) => workflows.some(workflow => workflow.name === name))
  if (!builds.length) return { components: [container], flags: MessageFlags.IsComponentsV2 }

  const { workflow_runs: runs } = await gh(`/repos/${repo}/actions/runs?head_sha=${entry.sha}&per_page=100`)
  const matched = builds.map(({ name }) => runs.find(run => run.name === name))
  const lines = matched.map((run, i) => {
    const status = run?.status !== 'completed' ? '' : run.conclusion === 'success' ? '✅' : '❌'
    return '- ' + [status, builds[i].emoji, builds[i].name].filter(Boolean).join(' ')
  })
  const newest = matched.filter(Boolean).sort((a, b) => b.created_at.localeCompare(a.created_at))[0]
  entry.finished = matched.every(run => run?.status === 'completed')

  container.addSeparatorComponents(new SeparatorBuilder())
  container.addSectionComponents(new SectionBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(['**Workflow runs:**', ...lines].join('\n')))
    .setButtonAccessory(new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel('Go to workflow run')
      .setURL(newest?.html_url ?? base.link)))

  return { components: [container], flags: MessageFlags.IsComponentsV2 }
}

async function post(key, kind, sha, base, prState) {
  const entry = { sha, base, prState, createdAt: Date.now() }
  const payload = await render(entry)
  entry.messageIds = await send(payload, kind)
  entry.rendered = JSON.stringify(payload)
  state.messages[key] = entry
  save()
}

async function update(key) {
  const entry = state.messages[key]
  const payload = await render(entry)
  const json = JSON.stringify(payload)
  if (json === entry.rendered) return
  entry.messageIds ??= { [config.channels[0]]: entry.messageId }
  if (dryRun) console.log(`edit ${key}`, JSON.stringify(payload, null, 2))
  else for (const [channelId, messageId] of Object.entries(entry.messageIds)) {
    if (!allChannels().includes(channelId)) continue
    try {
      const channel = await client.channels.fetch(channelId)
      await channel.messages.edit(messageId, payload)
    } catch (err) {
      console.log(`edit failed in ${channelId}: ${err.message}`)
    }
  }
  entry.rendered = json
}

async function notify({ user, action, heading = repoName, title, url, body, footer, color, kind, emoji }) {
  const container = new ContainerBuilder()
  if (color) container.setAccentColor(color)
  container.addSectionComponents(new SectionBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`${user ? `*${[user.login, action].filter(Boolean).join(' ')}*\n` : ''}## \`${heading}\`\n${emoji ? emoji + ' ' : ''}**[${title}](${url})**`))
    .setThumbnailAccessory(new ThumbnailBuilder().setURL(user?.avatar_url ?? repoInfo.owner.avatar_url)))
  if (footer) {
    container.addSeparatorComponents(new SeparatorBuilder())
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`${quote(body)}\n-# *${footer}*`.trim()))
    if (images(body).length) container.addMediaGalleryComponents(gallery(images(body)))
  }
  await send({ components: [container], flags: MessageFlags.IsComponentsV2 }, kind)
}

async function watched() {
  const names = []
  for (const entry of repos) {
    if (entry.includes('/')) {
      names.push(entry)
      continue
    }
    try {
      const owned = await gh(`/users/${entry}/repos?per_page=100`)
      names.push(...owned.map(r => r.full_name))
    } catch (err) {
      if (Date.now() < rateLimitedUntil) throw err
      console.log(`listing repos failed for ${entry}: ${err.message}`)
    }
  }
  const excluded = excludedRepos.map(name => name.toLowerCase())
  return names.filter(name => !excluded.includes(name.toLowerCase()))
}

async function poll() {
  for (const name of await watched()) {
    try {
      repoInfo = await gh(`/repos/${name}`)
      repo = repoInfo.full_name
      repoName = repoInfo.name
      repoUrl = repoInfo.html_url
      state = store.repos[repo]
      await pollRepo()
    } catch (err) {
      if (Date.now() < rateLimitedUntil) throw err
      console.log(`poll failed for ${name}: ${err.message}`)
    }
  }
  firstPoll = false
  save()
}

async function pollRepo() {
  const branches = await gh(`/repos/${repo}/branches?per_page=100`)
  const tags = await gh(`/repos/${repo}/tags?per_page=100`)
  const pulls = await gh(`/repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=100`)
  const allIssues = await gh(`/repos/${repo}/issues?state=all&sort=updated&direction=desc&per_page=100`)
  const comments = await gh(`/repos/${repo}/issues/comments?sort=created&direction=desc&per_page=100`)
  const reviewComments = await gh(`/repos/${repo}/pulls/comments?sort=created&direction=desc&per_page=100`)
  const releases = await gh(`/repos/${repo}/releases?per_page=20`)
  const { workflow_runs: runs } = await gh(`/repos/${repo}/actions/runs?per_page=50`)
  const events = await gh(`/repos/${repo}/events?per_page=100`)

  const heads = Object.fromEntries(branches
    .filter(b => !config.branch || b.name === config.branch)
    .map(b => [b.name, b.commit.sha]))
  const tagShas = Object.fromEntries(tags.map(t => [t.name, t.commit.sha]))
  const issues = allIssues.filter(issue => !issue.pull_request)
  const titles = Object.fromEntries([...allIssues, ...pulls].map(item => [item.number, item.title]))
  const since = new Date(state?.since)

  if (!state) {
    state = store.repos[repo] = {
      since: new Date().toISOString(),
      branches: heads,
      tags: tagShas,
      prs: Object.fromEntries(pulls.map(pr => [pr.number, pr.merged_at ? 'merged' : pr.state])),
      issues: Object.fromEntries(issues.map(issue => [issue.number, issue.state])),
      lastCommentId: Math.max(0, ...comments.map(c => c.id)),
      lastReviewCommentId: Math.max(0, ...reviewComments.map(c => c.id)),
      lastReleaseId: Math.max(0, ...releases.map(r => r.id)),
      runs: runs.filter(run => run.status === 'completed').map(run => `${run.id}-${run.run_attempt}`),
      events: events.map(e => e.id),
      messages: {}
    }
    save()
    console.log(`initialised ${repo}, watching ${Object.keys(heads).length} branch(es)`)
    return
  }

  for (const [kind, now, before, path] of [['Branch', heads, state.branches, 'tree'], ['Tag', tagShas, state.tags, 'releases/tag']]) {
    for (const name of Object.keys(now)) {
      if (name in before) continue
      await notify({ heading: `${repoName}/${name}`, title: `${kind} created`, url: `${repoUrl}/${path}/${name}`, color: green })
      before[name] = null
    }
    for (const name of Object.keys(before)) {
      if (name in now) continue
      await notify({ heading: `${repoName}/${name}`, title: `${kind} deleted`, url: `${repoUrl}/${kind === 'Tag' ? 'tags' : 'branches'}`, color: red })
      delete before[name]
    }
  }
  state.tags = tagShas
  save()

  for (const [name, sha] of Object.entries(heads)) {
    const old = state.branches[name]
    if (old === sha) continue

    let commits = []
    let count = 0
    let url
    let forced = false
    try {
      const compare = await gh(`/repos/${repo}/compare/${old ?? repoInfo.default_branch}...${sha}`)
      commits = compare.commits
      count = compare.total_commits
      url = compare.html_url
      forced = !!old && (compare.status === 'diverged' || compare.status === 'behind')
    } catch (err) {
      if (Date.now() < rateLimitedUntil) throw err
      if (old && err.message.includes(' 404 ')) forced = true
    }

    if (forced) {
      const head = await gh(`/repos/${repo}/commits/${sha}`)
      const push = events.find(e => e.type === 'PushEvent' && e.payload.head === sha)
      const user = push?.actor ?? head.author
      await notify({
        user,
        action: 'force pushed',
        heading: `${repoName}/${name}`,
        emoji: '⚠️',
        title: `Force pushed ${old.slice(0, 7)} → ${sha.slice(0, 7)}`,
        url: head.html_url,
        body: head.commit.message,
        footer: user ? by(user, 'force pushed', push?.created_at ?? head.commit.author.date) : head.commit.author.name,
        color: yellow,
        kind: 'commits'
      })
      state.branches[name] = sha
      save()
      continue
    }

    if (!commits.length && old) {
      commits = [await gh(`/repos/${repo}/commits/${sha}`)]
      count = 1
      url = commits[0].html_url
    }
    if (!commits.length) {
      state.branches[name] = sha
      save()
      continue
    }

    const latest = commits[commits.length - 1]
    const pusher = latest.author?.login ?? latest.commit.author.name
    await post(`push-${name}-${sha}`, 'commits', sha, {
      avatar: latest.author?.avatar_url ?? repoInfo.owner.avatar_url,
      link: latest.html_url,
      header: `*${pusher} pushed*\n## \`${repoName}/${name}\`\n**[${count} new commit${count === 1 ? '' : 's'}](${url})**`,
      blocks: commits.slice(-5).map(c => {
        const [title, ...rest] = c.commit.message.split('\n')
        const who = c.author ? `[${c.author.login}](${c.author.html_url})` : c.commit.author.name
        const when = Math.floor(new Date(c.commit.author.date) / 1000)
        return `[\`${c.sha.slice(0, 7)}\`](${c.html_url}) ${title.slice(0, 100)}${quote(rest.join('\n'))}\n-# *${who} committed <t:${when}:R>*`
      })
    })
    state.branches[name] = sha
    save()
  }
  state.branches = heads

  for (const pr of [...pulls].reverse()) {
    const key = `pr-${pr.number}`
    const prState = pr.merged_at ? 'merged' : pr.state
    const was = state.prs[pr.number]
    const entry = state.messages[key]

    if (was === prState) {
      if (entry && entry.sha !== pr.head.sha) {
        entry.sha = pr.head.sha
        entry.base = prBase(pr)
        await update(key)
      }
      continue
    }

    if (was === undefined) {
      if (new Date(pr.created_at) >= since) await post(key, prKind(), pr.head.sha, prBase(pr), prState)
    } else if (entry) {
      entry.base = prBase(pr)
      entry.prState = prState
      entry.sha = pr.head.sha
      await update(key)
    } else {
      await notify({
        heading: `${repoName}/${pr.base.ref}`,
        title: `Pull request #${pr.number} ${prState === 'open' ? 'reopened' : prState}: ${pr.title}`,
        url: pr.html_url,
        color: prState === 'merged' ? purple : prState === 'closed' ? red : green,
        kind: prKind()
      })
    }
    state.prs[pr.number] = prState
    save()
  }

  for (const issue of [...issues].reverse()) {
    const was = state.issues[issue.number]
    if (was === issue.state) continue
    if (was === undefined && new Date(issue.created_at) >= since) {
      await notify({
        user: issue.user,
        action: 'opened an issue',
        title: `Issue #${issue.number} opened: ${issue.title}`,
        url: issue.html_url,
        body: issue.body,
        footer: by(issue.user, 'opened', issue.created_at),
        color: green
      })
    } else if (was !== undefined) {
      const verb = issue.state === 'closed' ? 'closed' : 'reopened'
      await notify({
        title: `Issue #${issue.number} ${verb}: ${issue.title}`,
        url: issue.html_url,
        color: issue.state === 'open' ? green : issue.state_reason === 'not_planned' ? gray : purple
      })
    }
    state.issues[issue.number] = issue.state
    save()
  }

  for (const comment of comments.filter(c => c.id > state.lastCommentId).reverse()) {
    const number = comment.issue_url.split('/').pop()
    const kind = comment.html_url.includes('/pull/') ? 'pull request' : 'issue'
    await notify({
      user: comment.user,
      action: 'commented',
      title: `New comment on ${kind} #${number}: ${titles[number] ?? ''}`,
      url: comment.html_url,
      body: comment.body,
      footer: by(comment.user, 'commented', comment.created_at),
      kind: 'comments'
    })
    state.lastCommentId = comment.id
    save()
  }

  for (const comment of reviewComments.filter(c => c.id > state.lastReviewCommentId).reverse()) {
    const number = comment.pull_request_url.split('/').pop()
    await notify({
      user: comment.user,
      action: 'commented',
      title: `New review comment on pull request #${number}: ${titles[number] ?? ''}`,
      url: comment.html_url,
      body: comment.body,
      footer: by(comment.user, `commented on \`${comment.path}\``, comment.created_at),
      kind: 'comments'
    })
    state.lastReviewCommentId = comment.id
    save()
  }

  for (const release of releases.filter(r => r.id > state.lastReleaseId && !r.draft).reverse()) {
    await notify({
      user: release.author,
      action: 'published a release',
      title: `${release.prerelease ? 'Pre-release' : 'Release'} published: ${release.name || release.tag_name}`,
      url: release.html_url,
      body: release.body,
      footer: by(release.author, 'published', release.published_at),
      color: green
    })
    state.lastReleaseId = release.id
    save()
  }

  for (const run of [...runs].reverse()) {
    const key = `${run.id}-${run.run_attempt}`
    if (run.status !== 'completed' || tracked.some(({ name }) => name === run.name) || state.runs.includes(key)) continue
    const success = run.conclusion === 'success'
    await notify({
      user: run.actor,
      action: 'triggered a workflow',
      heading: `${repoName}/${run.head_branch}`,
      emoji: success ? '✅' : '❌',
      title: `${run.name} #${run.run_number} ${run.conclusion}`,
      url: run.html_url,
      footer: by(run.actor, `triggered it by ${run.event}`, run.run_started_at),
      color: success ? green : red
    })
    state.runs.push(key)
    save()
  }
  state.runs = state.runs.slice(-200)

  for (const event of [...events].reverse()) {
    if (state.events.includes(event.id)) continue
    const { actor, payload } = event
    let card
    if (new Date(event.created_at) < since) card = null
    else if (event.type === 'PullRequestReviewEvent' && (payload.review.state !== 'commented' || payload.review.body)) {
      const number = payload.pull_request.number
      const verb = { approved: 'approved', changes_requested: 'requested changes' }[payload.review.state] ?? 'reviewed'
      card = {
        action: verb,
        title: `Pull request #${number} ${verb}: ${titles[number] ?? ''}`,
        url: payload.review.html_url,
        body: payload.review.body,
        footer: by(actor, verb, payload.review.submitted_at),
        color: payload.review.state === 'approved' ? green : payload.review.state === 'changes_requested' ? red : null,
        kind: prKind()
      }
    } else if (event.type === 'CommitCommentEvent') {
      card = {
        action: 'commented',
        title: `New comment on commit ${payload.comment.commit_id.slice(0, 7)}`,
        url: payload.comment.html_url,
        body: payload.comment.body,
        footer: by(actor, 'commented', payload.comment.created_at),
        kind: 'comments'
      }
    } else if (event.type === 'WatchEvent') {
      card = { action: 'starred', title: 'New star', url: `${repoUrl}/stargazers`, footer: by(actor, 'starred the repo', event.created_at), color: yellow }
    } else if (event.type === 'ForkEvent') {
      card = { action: 'forked', title: `New fork: ${payload.forkee.full_name}`, url: payload.forkee.html_url, footer: by(actor, 'forked the repo', event.created_at) }
    } else if (event.type === 'MemberEvent') {
      card = { action: `${payload.action} a collaborator`, title: `Collaborator ${payload.action}: ${payload.member.login}`, url: payload.member.html_url, footer: by(actor, payload.action, event.created_at) }
    } else if (event.type === 'GollumEvent') {
      card = { action: 'edited the wiki', title: `Wiki updated: ${payload.pages.map(page => page.title).join(', ')}`, url: payload.pages[0].html_url, footer: by(actor, 'edited the wiki', event.created_at) }
    } else if (event.type === 'PublicEvent') {
      card = { action: 'made the repo public', title: 'Repository made public', url: repoUrl, footer: by(actor, 'made it public', event.created_at) }
    }
    if (card) await notify({ user: actor, ...card })
    state.events.push(event.id)
    save()
  }
  state.events = state.events.slice(-500)

  for (const [key, entry] of Object.entries(state.messages)) {
    const old = Date.now() - entry.createdAt > day
    if ((!entry.finished || firstPoll) && !old) await update(key)
    if (old && entry.prState !== 'open') delete state.messages[key]
  }
  save()
}

async function loop() {
  try {
    await poll()
  } catch (err) {
    console.log(`poll failed: ${err.message}`)
  }
  setTimeout(loop, Math.max(pollMs, rateLimitedUntil - Date.now()))
}

console.log(process.env.GITHUB_TOKEN ? 'github token loaded' : 'no github token, requests are anonymous')
console.log(repos.length ? `watching ${repos.join(', ')}` : 'no repos in config.json, nothing to watch')
if (excludedRepos.length) console.log(`excluding ${excludedRepos.join(', ')}`)

const channelOption = option => option
  .setName('channel')
  .setDescription('Defaults to this channel')
  .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)

const typeOption = option => option
  .setName('type')
  .setDescription('Only this kind of update, defaults to everything not sent elsewhere')
  .addChoices(...Object.entries(kinds).map(([value, name]) => ({ name, value })))

const feedCommand = new SlashCommandBuilder()
  .setName('feed')
  .setDescription('Choose where GitHub updates are posted')
  .addSubcommand(sub => sub.setName('add').setDescription('Post GitHub updates in a channel').addChannelOption(channelOption).addStringOption(typeOption))
  .addSubcommand(sub => sub.setName('remove').setDescription('Stop posting GitHub updates in a channel').addChannelOption(channelOption).addStringOption(typeOption))
  .addSubcommand(sub => sub.setName('list').setDescription('Show the channels that get GitHub updates'))

if (dryRun) {
  loop()
} else {
  client = new Client({ intents: [GatewayIntentBits.Guilds] })

  client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'feed') return
    if (!interaction.inCachedGuild() || !interaction.member.roles.cache.hasAny(...allowedRoles)) {
      return interaction.reply({ content: "You're not allowed to use this command.", flags: MessageFlags.Ephemeral })
    }

    const sub = interaction.options.getSubcommand()
    const channel = interaction.options.getChannel('channel') ?? interaction.channel
    const kind = interaction.options.getString('type')
    const what = kind ? kinds[kind] : 'GitHub updates'
    let content
    if (sub === 'add') {
      const list = kind ? (config.routes[kind] ??= []) : config.channels
      if (!list.includes(channel.id)) list.push(channel.id)
      const canSend = channel.permissionsFor(client.user)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])
      content = `${what} will be posted in ${channel}.` + (canSend ? '' : ' I can\'t see or send messages there yet, check my permissions.')
    } else if (sub === 'remove') {
      if (!kind) config.channels = config.channels.filter(id => id !== channel.id)
      for (const key of kind ? [kind] : Object.keys(config.routes)) {
        config.routes[key] = (config.routes[key] ?? []).filter(id => id !== channel.id)
      }
      content = `Stopped posting ${what} in ${channel}.`
    } else {
      const lines = allChannels().map(id => {
        const types = Object.keys(kinds).filter(key => config.routes[key]?.includes(id)).map(key => kinds[key])
        if (config.channels.includes(id)) types.push('Everything else')
        return `- <#${id}>: ${types.join(', ')}`
      })
      content = lines.length
        ? `GitHub updates are posted in:\n${lines.join('\n')}`
        : 'No channels set, use `/feed add`.'
    }
    saveConfig()
    await interaction.reply({ content, flags: MessageFlags.Ephemeral })
  })

  client.once(Events.ClientReady, async () => {
    await client.application.commands.set([feedCommand])
    console.log(`logged in as ${client.user.tag}, posting in ${allChannels().length} channel(s)`)
    loop()
  })

  await client.login(process.env.DISCORD_TOKEN)
}