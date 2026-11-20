import { SlashCommandBuilder, ChannelType, PermissionFlagsBits, MessageFlags } from 'discord.js'
import { config, allowedRoles, allChannels, saveConfig } from './config.js'
import { ctx } from './ctx.js'
import { gh } from './github.js'
import { watched } from './poll.js'

const kinds = {
  commits: 'Commits',
  officialPulls: 'Official pull requests',
  unofficialPulls: 'Unofficial pull requests',
  comments: 'Comments'
}

const channelOption = option => option.setName('channel').setDescription('Defaults to this channel').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
const typeOption = option => option.setName('type').setDescription('Only this kind of update, defaults to everything not sent elsewhere').addChoices(...Object.entries(kinds).map(([value, name]) => ({ name, value })))
export const feedCommand = new SlashCommandBuilder().setName('feed').setDescription('Choose where GitHub updates are posted').addSubcommand(sub => sub.setName('add').setDescription('Post GitHub updates in a channel').addChannelOption(channelOption).addStringOption(typeOption)).addSubcommand(sub => sub.setName('remove').setDescription('Stop posting GitHub updates in a channel').addChannelOption(channelOption).addStringOption(typeOption)).addSubcommand(sub => sub.setName('list').setDescription('Show the channels that get GitHub updates'))
export const setupCommand = new SlashCommandBuilder().setName('setup').setDescription('Create a forum tag for every GitHub label')

async function setup() {
  const labels = new Map()
  for (const name of await watched()) {
    try {
      for (const label of await gh(`/repos/${name}/labels?per_page=100`)) labels.set(label.name.toLowerCase(), label.name)
    } catch (err) {
      console.log(`labels failed for ${name}: ${err.message}`)
    }
  }

  const lines = []
  for (const [forumName, forumConfig] of Object.entries(config.forums)) {
    try {
      const forum = await ctx.client.channels.fetch(forumConfig.channel)
      forumConfig.tags ??= {}
      const tagName = name => name.slice(0, 20).toLowerCase()
      const wanted = [...Object.keys(forumConfig.tags), ...labels.values()]
      const missing = wanted.filter(name => !forum.availableTags.some(tag => tag.name.toLowerCase() === tagName(name)))
      const room = Math.max(0, 20 - forum.availableTags.length)
      const adding = missing.slice(0, room)

      const updated = adding.length ? await forum.setAvailableTags([...forum.availableTags, ...adding.map(name => ({ name: name.slice(0, 20) }))]) : forum
      const find = name => updated.availableTags.find(tag => tag.name.toLowerCase() === tagName(name))?.id

      for (const name of Object.keys(forumConfig.tags)) forumConfig.tags[name] = find(name) ?? forumConfig.tags[name]
      forumConfig.labels = Object.fromEntries([...labels.values()].map(name => [name, find(name)]).filter(([, id]) => id))
      lines.push(`- **${forumName}**: ${adding.length} created` + (missing.length > room ? `, ${missing.length - room} skipped (forums max out at 20 tags)` : ''))
    } catch (err) {
      lines.push(`- **${forumName}**: failed, ${err.message}`)
    }
  }
  saveConfig()
  return `Found ${labels.size} label(s).\n${lines.join('\n') || 'No forums in config.json.'}`
}

function feed(interaction) {
  const sub = interaction.options.getSubcommand()
  const channel = interaction.options.getChannel('channel') ?? interaction.channel
  const kind = interaction.options.getString('type')
  const what = kind ? kinds[kind] : 'GitHub updates'
  if (sub === 'add') {
    const list = kind ? (config.routes[kind] ??= []) : config.channels
    if (!list.includes(channel.id)) list.push(channel.id)
    const canSend = channel.permissionsFor(interaction.client.user)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])
    return `${what} will be posted in ${channel}.` + (canSend ? '' : ' I can\'t see or send messages there yet, check my permissions.')
  }
  if (sub === 'remove') {
    if (!kind) config.channels = config.channels.filter(id => id !== channel.id)
    for (const key of kind ? [kind] : Object.keys(config.routes)) {
      config.routes[key] = (config.routes[key] ?? []).filter(id => id !== channel.id)
    }
    return `Stopped posting ${what} in ${channel}.`
  }
  const lines = allChannels().map(id => {
    const types = Object.keys(kinds).filter(key => config.routes[key]?.includes(id)).map(key => kinds[key])
    if (config.channels.includes(id)) types.push('Everything else')
    return `- <#${id}>: ${types.join(', ')}`
  })
  return lines.length ? `GitHub updates are posted in:\n${lines.join('\n')}` : 'No channels set, use `/feed add`.'
}

export async function handleCommand(interaction) {
  if (!interaction.isChatInputCommand() || !['feed', 'setup'].includes(interaction.commandName)) return
  if (!interaction.inCachedGuild() || !interaction.member.roles.cache.hasAny(...allowedRoles)) {
    return interaction.reply({ content: "You're not allowed to use this command.", flags: MessageFlags.Ephemeral })
  }

  if (interaction.commandName === 'setup') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral })
    try {
      return await interaction.editReply(await setup())
    } catch (err) {
      return interaction.editReply(`Setup failed: ${err.message}`)
    }
  }

  const content = feed(interaction)
  saveConfig()
  await interaction.reply({ content, flags: MessageFlags.Ephemeral })
}
