import { describe, expect, it } from 'vitest'
import { getPetFrame } from '../../src/renderer/src/desktopPet/player'

const clip = {
  row: 0,
  frames: 3,
  durationsMs: [100, 200, 300],
  loop: true
}

describe('desktop pet player', () => {
  it('selects frames from cumulative durations', () => {
    expect(getPetFrame(clip, 0)).toEqual({ frame: 0, remainingMs: 100, done: false })
    expect(getPetFrame(clip, 99)).toEqual({ frame: 0, remainingMs: 1, done: false })
    expect(getPetFrame(clip, 100)).toEqual({ frame: 1, remainingMs: 200, done: false })
    expect(getPetFrame(clip, 299)).toEqual({ frame: 1, remainingMs: 1, done: false })
    expect(getPetFrame(clip, 300)).toEqual({ frame: 2, remainingMs: 300, done: false })
  })

  it('loops at the exact total duration and clamps negative elapsed time', () => {
    expect(getPetFrame(clip, 600)).toEqual({ frame: 0, remainingMs: 100, done: false })
    expect(getPetFrame(clip, -10)).toEqual({ frame: 0, remainingMs: 100, done: false })
  })

  it('holds the last frame and marks a non-looping clip complete', () => {
    const oneShot = { ...clip, loop: false }
    expect(getPetFrame(oneShot, 599)).toEqual({ frame: 2, remainingMs: 1, done: false })
    expect(getPetFrame(oneShot, 600)).toEqual({ frame: 2, remainingMs: 0, done: true })
    expect(getPetFrame(oneShot, 900)).toEqual({ frame: 2, remainingMs: 0, done: true })
  })
})
