import { Client, GatewayIntentBits, Events } from 'discord.js'
import { repos, excludedRepos, allChannels, dryRun } from './stuff/config.js'
import { ctx } from './stuff/ctx.js'
import { loop } from './stuff/poll.js'
import { feedCommand, setupCommand, systemInfoCommand, handleCommand } from './stuff/commands.js'

console.log(process.env.GITHUB_TOKEN ? 'github token loaded' : 'no github token, requests are anonymous')
console.log(repos.length ? `watching ${repos.join(', ')}` : 'no repos in config.json, nothing to watch')
if (excludedRepos.length) console.log(`excluding ${excludedRepos.join(', ')}`)

if (dryRun) {
  loop()
} else {
  const client = ctx.client = new Client({ intents: [GatewayIntentBits.Guilds] })

  client.on(Events.InteractionCreate, handleCommand)

  client.once(Events.ClientReady, async () => {
    await client.application.commands.set([feedCommand, setupCommand, systemInfoCommand])
    console.log(`logged in as ${client.user.tag}, posting in ${allChannels().length} channel(s)`)
    loop()
  })

  await client.login(process.env.DISCORD_TOKEN)
}
