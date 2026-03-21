import fs from 'fs'
import path from 'path'

export function resolveProjectRoot(startDir = __dirname): string {
  let current = path.resolve(startDir)
  while (true) {
    if (
      fs.existsSync(path.join(current, 'package.json')) &&
      fs.existsSync(path.join(current, 'chain-config.json'))
    ) {
      return current
    }
    const parent = path.dirname(current)
    if (parent === current) {
      throw new Error('Unable to resolve tss-signer root')
    }
    current = parent
  }
}

export function resolveRepoConfigPath(fileName: string, fromDir = __dirname): string {
  const projectRoot = resolveProjectRoot(fromDir)
  const filePath = path.join(projectRoot, fileName)
  if (fs.existsSync(filePath)) {
    return filePath
  }
  throw new Error(`[config] Could not find ${fileName} at ${filePath}`)
}
