import { describe, expect, it } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { assertHostedWindows, validateVersion } from '../../scripts/verify-windows-upgrade.cjs'

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
