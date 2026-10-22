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
