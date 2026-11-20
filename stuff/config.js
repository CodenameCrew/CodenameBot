import fs from 'fs'

const envPath = new URL('../.env', import.meta.url)
if (fs.existsSync(envPath)) process.loadEnvFile(envPath)

const statePath = new URL('../state.json', import.meta.url)
const configPath = new URL('../config.json', import.meta.url)

export const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
config.channels ??= []
config.routes ??= {}
config.forums ??= {}

export const repos = config.repos ?? []
export const excludedRepos = config.excludedRepos ?? []
export const officialRepos = (config.officialRepos ?? []).map(name => name.toLowerCase())
export const tracked = config.tracked ?? []
export const pollMs = (config.pollSeconds || 30) * 1000
export const dryRun = !!process.env.DRY_RUN
export const allowedRoles = config.allowedRoles ?? []
export const noCommentGuilds = config.noCommentGuilds ?? []

const loaded = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { repos: {} }
export const store = loaded.repos ? loaded : { repos: config.repo ? { [config.repo]: loaded } : {} }

export function save() {
  fs.writeFileSync(statePath, JSON.stringify(store, null, 2))
}

export function saveConfig() {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
}

export function allChannels() {
  return [...new Set([...Object.values(config.routes).flat(), ...config.channels])]
}
