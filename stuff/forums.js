import { config, dryRun, save } from './config.js'
import { ctx } from './ctx.js'

function labelIds(forumName, labels) {
  const known = config.forums[forumName]?.labels ?? {}
  return labels.map(name => known[name]).filter(Boolean)
}

async function getThread(key) {
  const entry = ctx.state.threads[key]
  if (dryRun || !entry || entry.done) return
  try {
    return await ctx.client.channels.fetch(entry.id)
  } catch (err) {
    if (err.code === 10003) delete ctx.state.threads[key]
    console.log(`thread failed in ${entry.id}: ${err.message}`)
  }
}

export async function openThread(key, forumName, name, payload, labels = []) {
  const channel = config.forums[forumName]?.channel
  if (!channel || ctx.state.threads[key]) return
  if (dryRun) {
    console.log(`thread ${key}: ${name}`, JSON.stringify(payload, null, 2))
    return
  }
  try {
    const forum = await ctx.client.channels.fetch(channel)
    const thread = await forum.threads.create({ name: name.slice(0, 100), message: payload, appliedTags: labelIds(forumName, labels).slice(0, 5) })
    ctx.state.threads[key] = { id: thread.id, forum: forumName, done: false, labels: [...labels].sort().join(',') }
    save()
  } catch (err) {
    console.log(`thread failed in ${channel}: ${err.message}`)
  }
}

export async function syncTags(key, labels) {
  const entry = ctx.state.threads[key]
  const joined = [...labels].sort().join(',')
  if (!entry || entry.done || (entry.labels ?? '') === joined) return
  const thread = await getThread(key)
  if (!thread) return
  try {
    if (thread.archived) await thread.edit({ archived: false })
    await thread.setAppliedTags(labelIds(entry.forum, labels).slice(0, 5))
    entry.labels = joined
    save()
  } catch (err) {
    console.log(`thread failed in ${thread.id}: ${err.message}`)
  }
}

export async function postInThread(key, payload) {
  const thread = await getThread(key)
  if (!thread) return
  try {
    if (thread.archived) await thread.edit({ archived: false })
    await thread.send(payload)
  } catch (err) {
    console.log(`thread failed in ${thread.id}: ${err.message}`)
  }
}

export async function closeThread(key, payload, statusTag) {
  const thread = await getThread(key)
  if (!thread) return
  const entry = ctx.state.threads[key]
  const statusIds = Object.values(config.forums[entry.forum].tags)
  entry.done = true
  save()
  try {
    if (thread.archived) await thread.edit({ archived: false })
    await thread.send(payload)
    await thread.edit({
      appliedTags: [...thread.appliedTags.filter(id => !statusIds.includes(id)).slice(0, 4), config.forums[entry.forum].tags[statusTag]],
      archived: true,
      locked: true
    })
  } catch (err) {
    console.log(`thread failed in ${thread.id}: ${err.message}`)
  }
}
