import type { Json } from '../../../../shared/gitMirrorTypes'

export interface Adapter {
  name: string
  pluginVersion: string
  adapterVersion: string
  acceptsKey(key: string): boolean
  exportPayload(key: string, localDocument: Json): Json
  importPayload(key: string, payload: Json, previousDocument: Json | null): Json
}

export interface AdapterLookup {
  get(name: string, exactVersion: string): Adapter | null
}
