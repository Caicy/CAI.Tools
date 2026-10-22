import { describe, expect, it } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import * as asar from '@electron/asar'
import {
  assertHostedWindows,
  validateVersion,
  readInstalledVersion
} from '../../scripts/verify-windows-upgrade.cjs'

it('reads replaced installer archive without reusing the old header' /**
 * 用真实归档替换验证新增文件改变偏移后仍能读取新版本。
 * @returns 验证和临时目录清理结束的 Promise。
 */, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cai-upgrade-archive-'))
  try {
    const source = path.join(root, 'source')
    const installed = path.join(root, 'installed')
    const archive = path.join(installed, 'resources/app.asar')
    await fs.mkdir(source)
    await fs.mkdir(path.dirname(archive), { recursive: true })
    await fs.writeFile(
      path.join(source, 'package.json'),
      JSON.stringify({ version: '3.2.0-local.14' })
    )
    await asar.createPackage(source, archive)
    expect(readInstalledVersion(installed)).toBe('3.2.0-local.14')
    await fs.writeFile(path.join(source, 'a-new-file.txt'), 'new pet companion asset')
    await fs.writeFile(
      path.join(source, 'package.json'),
      JSON.stringify({ version: '3.2.0-local.15' })
    )
    await asar.createPackage(source, archive)
    expect(readInstalledVersion(installed)).toBe('3.2.0-local.15')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

describe('published installer acceptance environment guard', () => {
  const hosted = {
    GITHUB_ACTIONS: 'true',
    RUNNER_ENVIRONMENT: 'github-hosted',
    RUNNER_OS: 'Windows',
    RUNNER_TEMP: os.tmpdir()
  }
  it('accepts only an isolated hosted Windows runner', () => {
    expect(assertHostedWindows(hosted, 'win32')).toBe(path.resolve(os.tmpdir()))
  })
  it.each([
    [{ ...hosted, GITHUB_ACTIONS: undefined }, 'win32'],
    [{ ...hosted, RUNNER_ENVIRONMENT: 'self-hosted' }, 'win32'],
    [{ ...hosted, RUNNER_OS: 'Linux' }, 'win32'],
    [{ ...hosted, RUNNER_TEMP: 'relative-path' }, 'win32'],
    [hosted, 'linux']
  ])('refuses unsafe installer execution environment %j', (env, platform) => {
    expect(() => assertHostedWindows(env, platform)).toThrow()
  })
  it.each(['3.2.0-local.4', '3.2.0-local.5'])('accepts authorized local version %s', (version) => {
    expect(validateVersion(version)).toBe(version)
  })
  it.each(['3.2.0', '../setup.exe', '3.2.0-local.05', '3.2.0-beta.1', '3.2.0-local.5\n'])(
    'refuses non-local version input %s',
    (version) => {
      expect(() => validateVersion(version)).toThrow()
    }
  )
})
