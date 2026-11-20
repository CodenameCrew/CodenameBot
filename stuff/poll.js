import { config, repos, excludedRepos, officialRepos, tracked, pollMs, store, save } from './config.js'
import { ctx } from './ctx.js'
import { gh } from './github.js'
import { images, quote, by } from './format.js'
import { post, update, notify, buildCard } from './messages.js'
import { openThread, postInThread, closeThread, syncTags } from './forums.js'

const day = 24 * 60 * 60 * 1000
const green = 0x238636
const red = 0xda3633
const purple = 0x8957e5
const gray = 0x6e7681
const yellow = 0xe3b341
const prTags = { officialPulls: 'Engine PR', unofficialPulls: 'Library-Fork PR' }

function prKind() {
  if (officialRepos.includes(ctx.repo.toLowerCase())) return 'officialPulls'
  if (ctx.repoInfo.fork) return 'unofficialPulls'
}

function prBase(pr) {
  const status = pr.merged_at ? ' · Merged' : pr.state === 'closed' ? ' · Closed' : ''
  return {
    color: pr.merged_at ? purple : pr.state === 'closed' ? red : green,
    avatar: pr.user.avatar_url,
    link: pr.html_url,
    images: images(pr.body),
    header: `*${pr.user.login} opened a pull request*\n## \`${ctx.repoName}/${pr.base.ref}\`\n**[Pull request #${pr.number}](${pr.html_url})**${status}`,
    blocks: [`**[${pr.title}](${pr.html_url})**${quote(pr.body)}\n-# *${by(pr.user, 'opened', pr.created_at)}*`]
  }
}

function openPrThread(key, pr) {
  return openThread(key, prTags[prKind()], `PR #${pr.number} ${pr.title}`, buildCard({
    user: pr.user,
    action: 'opened a pull request',
    heading: `${ctx.repoName}/${pr.base.ref}`,
    title: `Pull request #${pr.number}: ${pr.title}`,
    url: pr.html_url,
    body: pr.body,
    footer: by(pr.user, 'opened', pr.created_at),
    color: green
  }), pr.labels.map(label => label.name))
}

function prThreadChange(pr, prState) {
  if (prState === 'open') return
  const merged = prState === 'merged'
  const payload = buildCard({
    heading: `${ctx.repoName}/${pr.base.ref}`,
    title: `Pull request #${pr.number} ${prState}`,
    url: pr.html_url,
    color: merged ? purple : red
  })
  return closeThread(`pr-${pr.number}`, payload, merged ? 'Accepted/Merged' : 'Rejected')
}

function issueThreadChange(issue) {
  if (issue.state === 'open') return
  const reason = (issue.state_reason ?? 'completed').replace('_', ' ')
  const payload = buildCard({
    title: `Issue #${issue.number} closed as ${reason}`,
    url: issue.html_url,
    color: issue.state_reason === 'not_planned' ? gray : purple
  })
  return closeThread(`issue-${issue.number}`, payload, 'Closed')
}

export async function watched() {
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
      if (Date.now() < ctx.rateLimitedUntil) throw err
      console.log(`listing repos failed for ${entry}: ${err.message}`)
    }
  }
  const excluded = excludedRepos.map(name => name.toLowerCase())
  return names.filter(name => !excluded.includes(name.toLowerCase()))
}

async function poll() {
  ctx.backfilling = ctx.backfill
  ctx.backfill = false
  for (const name of await watched()) {
    try {
      ctx.repoInfo = await gh(`/repos/${name}`)
      ctx.repo = ctx.repoInfo.full_name
      ctx.repoName = ctx.repoInfo.name
      ctx.repoUrl = ctx.repoInfo.html_url
      ctx.state = store.repos[ctx.repo]
      await pollRepo()
    } catch (err) {
      if (Date.now() < ctx.rateLimitedUntil) throw err
      console.log(`poll failed for ${name}: ${err.message}`)
    }
  }
  ctx.firstPoll = false
  ctx.backfilling = false
  save()
}

async function pollRepo() {
  const { repo, repoName, repoUrl, repoInfo } = ctx
  let state = ctx.state

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
    state = ctx.state = store.repos[repo] = {
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
      messages: {},
      threads: {}
    }
    save()
    console.log(`initialised ${repo}, watching ${Object.keys(heads).length} branch(es)`)
    return
  }

  state.threads ??= {}
  const closing = []

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
      if (Date.now() < ctx.rateLimitedUntil) throw err
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

    if (ctx.backfilling && prState === 'open' && !state.threads[key]) await openPrThread(key, pr)
    await syncTags(key, pr.labels.map(label => label.name))

    if (was === prState) {
      if (entry && entry.sha !== pr.head.sha) {
        entry.sha = pr.head.sha
        entry.base = prBase(pr)
        await update(key)
      }
      continue
    }

    if (was === undefined) {
      if (new Date(pr.created_at) >= since) {
        await post(key, prKind(), pr.head.sha, prBase(pr), prState)
        await openPrThread(key, pr)
      }
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
    closing.push(() => prThreadChange(pr, prState))
    state.prs[pr.number] = prState
    save()
  }

  for (const issue of [...issues].reverse()) {
    const was = state.issues[issue.number]
    await syncTags(`issue-${issue.number}`, issue.labels.map(label => label.name))
    if (was === issue.state) continue
    if (was === undefined && new Date(issue.created_at) >= since) {
      const opened = {
        user: issue.user,
        action: 'opened an issue',
        title: `Issue #${issue.number} opened: ${issue.title}`,
        url: issue.html_url,
        body: issue.body,
        footer: by(issue.user, 'opened', issue.created_at),
        color: green
      }
      await notify(opened)
      await openThread(`issue-${issue.number}`, 'Issues', `Issue #${issue.number} ${issue.title}`, buildCard(opened), issue.labels.map(label => label.name))
    } else if (was !== undefined) {
      const verb = issue.state === 'closed' ? 'closed' : 'reopened'
      await notify({
        title: `Issue #${issue.number} ${verb}: ${issue.title}`,
        url: issue.html_url,
        color: issue.state === 'open' ? green : issue.state_reason === 'not_planned' ? gray : purple
      })
    }
    closing.push(() => issueThreadChange(issue))
    state.issues[issue.number] = issue.state
    save()
  }

  for (const comment of comments.filter(c => c.id > state.lastCommentId).reverse()) {
    const number = comment.issue_url.split('/').pop()
    const kind = comment.html_url.includes('/pull/') ? 'pull request' : 'issue'
    const info = {
      user: comment.user,
      action: 'commented',
      title: `New comment on ${kind} #${number}: ${titles[number] ?? ''}`,
      url: comment.html_url,
      body: comment.body,
      footer: by(comment.user, 'commented', comment.created_at)
    }
    await notify({ ...info, kind: 'comments' })
    await postInThread(`${kind === 'issue' ? 'issue' : 'pr'}-${number}`, buildCard(info))
    state.lastCommentId = comment.id
    save()
  }

  for (const comment of reviewComments.filter(c => c.id > state.lastReviewCommentId).reverse()) {
    const number = comment.pull_request_url.split('/').pop()
    const info = {
      user: comment.user,
      action: 'commented',
      title: `New review comment on pull request #${number}: ${titles[number] ?? ''}`,
      url: comment.html_url,
      body: comment.body,
      footer: by(comment.user, `commented on \`${comment.path}\``, comment.created_at)
    }
    await notify({ ...info, kind: 'comments' })
    await postInThread(`pr-${number}`, buildCard(info))
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
    let threadKey
    if (new Date(event.created_at) < since) card = null
    else if (event.type === 'PullRequestReviewEvent' && (payload.review.state !== 'commented' || payload.review.body)) {
      const number = payload.pull_request.number
      threadKey = `pr-${number}`
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
    if (card) {
      await notify({ user: actor, ...card })
      if (threadKey) await postInThread(threadKey, buildCard({ user: actor, ...card }))
    }
    state.events.push(event.id)
    save()
  }
  state.events = state.events.slice(-500)

  for (const close of closing) await close()

  for (const [key, entry] of Object.entries(state.messages)) {
    const old = Date.now() - entry.createdAt > day
    if ((!entry.finished || ctx.firstPoll) && !old) await update(key)
    if (old && entry.prState !== 'open') delete state.messages[key]
  }
  save()
}

export async function loop() {
  try {
    await poll()
  } catch (err) {
    console.log(`poll failed: ${err.message}`)
    if (ctx.backfilling) ctx.backfill = true
  }
  setTimeout(loop, Math.max(pollMs, ctx.rateLimitedUntil - Date.now()))
}
