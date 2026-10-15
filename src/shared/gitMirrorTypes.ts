export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

export type MirrorState =
  | 'unconfigured'
  | 'ready'
  | 'waiting-for-git'
  | 'external-change'
  | 'conflict'
  | 'invalid'
  | 'unavailable'

export interface ProfileManifest {
  format: 'cai-tools-profile'
  schemaVersion: 1
  profileId: string
}

export interface PortableRecord {
  schemaVersion: 1
  plugin: string
  adapter: string
  key: string
  deleted: boolean
  payload: Json
}

export interface PluginArtifact {
  name: string
  version: string
  installed: boolean
  packagePath: string | null
  sha256: string | null
  platform: 'win32'
}

export interface MirrorStatus {
  state: MirrorState
  repoPath: string | null
  pending: number
  restartRequired: boolean
  issues: { code: string; relativePath?: string; message: string }[]
}

export const MIRROR_LIMITS = {
  jsonBytes: 1024 * 1024,
  depth: 64,
  blobBytes: 10 * 1024 * 1024,
  packageBytes: 100 * 1024 * 1024,
  snapshotBytes: 512 * 1024 * 1024,
  files: 10000
} as const
