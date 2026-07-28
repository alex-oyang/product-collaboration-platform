import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { createPrototypeReviewApp } from './app.mjs'

export async function startServer(options = {}) {
  const port = Number(options.port ?? process.env.PORT ?? 3018)
  const host = options.host ?? process.env.HOST ?? '127.0.0.1'
  const { app, store } = await createPrototypeReviewApp(options)
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(port, host, (error) => {
      if (error) reject(error)
      else resolve(instance)
    })
    instance.once('error', reject)
  })
  const address = server.address()
  const boundHost = address && typeof address === 'object' ? address.address : host
  const boundPort = address && typeof address === 'object' ? address.port : port
  const shownHost = boundHost === '0.0.0.0' ? '0.0.0.0（已开启内网监听）' : boundHost
  process.stdout.write(`Prototype Review API listening on http://${shownHost}:${boundPort}\n`)
  return { server, store }
}

function commandLineOptions(args) {
  const options = {}
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]
    const value = args[index + 1]
    if (value == null) throw new Error(`Missing value for ${flag}`)
    if (flag === '--host') {
      if (!['127.0.0.1', '0.0.0.0'].includes(value)) throw new Error('Host must be 127.0.0.1 or 0.0.0.0')
      options.host = value
    } else if (flag === '--port') {
      const port = Number(value)
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be an integer from 1 to 65535')
      options.port = port
    } else {
      throw new Error(`Unknown option: ${flag}`)
    }
  }
  return options
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (entry && entry.toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  startServer(commandLineOptions(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`)
    process.exitCode = 1
  })
}
