import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import yaml from 'yaml'
import { verifyWindowsUpdate } from '../../scripts/verify-windows-update.mjs'

let root: string
const version = '3.2.0-local.10'
const filename = `CAI.Tools-${version}-win-x64-setup.exe`

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cai-update-artifacts-'))
  const resources = path.join(root, 'win-unpacked', 'resources')
  await fs.mkdir(resources, { recursive: true })
  const bytes = Buffer.from('test fixture, not a Windows executable')
  const sha512 = createHash('sha512').update(bytes).digest('base64')
  await fs.writeFile(path.join(root, filename), bytes)
  await fs.writeFile(path.join(root, filename + '.blockmap'), 'fixture blockmap')
  await fs.writeFile(
    path.join(root, 'local.yml'),
    yaml.stringify({
      version,
      path: filename,
      sha512,
      files: [{ url: filename, sha512, size: bytes.length }]
    })
  )
  await fs.writeFile(
    path.join(resources, 'app-update.yml'),
    yaml.stringify({ provider: 'github', owner: 'Caicy', repo: 'CAI.Tools', channel: 'local' })
  )
  await fs.writeFile(
    path.join(resources, 'ztools-install-info.json'),
    JSON.stringify({ schemaVersion: 1, appId: 'tools.cai.local', updater: 'electron-updater-nsis' })
  )
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('Windows release update contract', () => {
  it('accepts a complete local release fixture', async () => {
    await expect(verifyWindowsUpdate(root, version)).resolves.toBeUndefined()
  })
  it('rejects corrupted installers', async () => {
    await fs.appendFile(path.join(root, filename), 'corrupt')
    await expect(verifyWindowsUpdate(root, version)).rejects.toThrow('integrity')
  })
  it('rejects an incorrect manifest version', async () => {
    await expect(verifyWindowsUpdate(root, '3.2.0-local.11')).rejects.toThrow('version mismatch')
  })
  it('rejects missing channel metadata or blockmaps', async () => {
    await fs.rm(path.join(root, filename + '.blockmap'))
    await expect(verifyWindowsUpdate(root, version)).rejects.toThrow()
  })
  it.each([
    { provider: 'github', owner: 'ZToolsCenter', repo: 'ZTools', channel: 'local' },
    { provider: 'github', owner: 'Caicy', repo: 'CAI.Tools', channel: 'local', token: 'fixture' },
    { provider: 'generic', url: 'https://example.com/feed' }
  ])('rejects a foreign or credential-bearing packaged source %j', async (feed) => {
    await fs.writeFile(
      path.join(root, 'win-unpacked/resources/app-update.yml'),
      yaml.stringify(feed)
    )
    await expect(verifyWindowsUpdate(root, version)).rejects.toThrow('update source')
  })
  it('rejects upstream installation identity', async () => {
    await fs.writeFile(
      path.join(root, 'win-unpacked/resources/ztools-install-info.json'),
      JSON.stringify({ schemaVersion: 1, appId: 'top.z-tools', updater: 'electron-updater-nsis' })
    )
    await expect(verifyWindowsUpdate(root, version)).rejects.toThrow('identity')
  })
})
