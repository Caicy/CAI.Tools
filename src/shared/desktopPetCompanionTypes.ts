/** 可由用户主动触发的轻互动。 */
export type PetInteraction = 'pat' | 'feed'

/** 台词与呈现解耦；未来的语音消费者可订阅同一生命周期。 */
export interface PetUtterance {
  id: string
  text: string
  source: 'local' | 'ai'
  emotion: 'warm' | 'happy' | 'encouraging'
  action: 'waving' | 'coffee' | 'idle'
}

export interface PetDialogueEntry extends PetUtterance {
  role: 'user' | 'assistant'
}

export interface PetCompanionSnapshot {
  messages: PetDialogueEntry[]
  busy: boolean
  notice: string
  modelRef: string
  reviewsEnabled: boolean
  models: Array<{ value: string; label: string }>
}

export interface DesktopPetCompanionBridge {
  ready(): Promise<PetCompanionSnapshot>
  send(text: string): Promise<void>
  interact(kind: PetInteraction): Promise<void>
  configure(modelRef: string, reviewsEnabled: boolean): Promise<void>
  cancel(): Promise<void>
  clear(): Promise<void>
  close(): void
  onState(callback: (state: PetCompanionSnapshot) => void): () => void
}
