import os from 'os'
import fs from 'fs'
import { ctx } from './ctx.js'

const gb = bytes => (bytes / 1024 ** 3).toFixed(1)

function duration(seconds) {
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor(seconds % 86400 / 3600)
  const minutes = Math.floor(seconds % 3600 / 60)
  return [days && `${days}d`, hours && `${hours}h`, `${minutes}m`].filter(Boolean).join(' ')
}

async function cpuUsage() {
  const sample = () => os.cpus().reduce(([total, idle], cpu) => [total + Object.values(cpu.times).reduce((a, b) => a + b, 0), idle + cpu.times.idle], [0, 0])
  const [total1, idle1] = sample()
  await new Promise(resolve => setTimeout(resolve, 500))
  const [total2, idle2] = sample()
  return (1 - (idle2 - idle1) / (total2 - total1)) * 100
}

async function location() {
  try {
    const data = await (await fetch('https://ipwho.is/')).json()
    if (!data.success) return 'unknown'
    return `${data.country} (${data.connection?.isp ?? 'unknown isp'})`
  } catch {
    return 'unknown'
  }
}

export async function systemInfo() {
  const [cpu, place] = await Promise.all([cpuUsage(), location()])
  const totalMem = os.totalmem()
  const usedMem = totalMem - os.freemem()
  const disk = fs.statfsSync(process.cwd())
  const totalDisk = disk.blocks * disk.bsize
  const usedDisk = totalDisk - disk.bavail * disk.bsize

  return [
    '**Host**',
    `- ${os.hostname()}, ${os.type()} ${os.release()} (${os.arch()})`,
    `- ${os.cpus()[0].model.trim()}, ${os.cpus().length} threads`,
    `- Node ${process.version}`,
    `- Host up for ${duration(os.uptime())}, bot up for ${duration(process.uptime())}`,
    '**Location**',
    `- ${place}`,
    '**Usage**',
    `- CPU: ${cpu.toFixed(1)}%`,
    `- Memory: ${gb(usedMem)} / ${gb(totalMem)} GB, bot using ${(process.memoryUsage().rss / 1024 ** 2).toFixed(0)} MB`,
    `- Disk: ${gb(usedDisk)} / ${gb(totalDisk)} GB`,
    `- Discord ping: ${ctx.client.ws.ping} ms`
  ].join('\n')
}
