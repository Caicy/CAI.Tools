import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PetClickArbiter } from '../../src/renderer/src/desktopPet/interaction'

describe('desktop pet click arbitration', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('delays a single click until the double-click window closes', () => {
    const single = vi.fn()
    const double = vi.fn()
    const arbiter = new PetClickArbiter()

    arbiter.click(single, double)
    expect(single).not.toHaveBeenCalled()
    vi.advanceTimersByTime(299)
    expect(single).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(single).toHaveBeenCalledOnce()
    expect(double).not.toHaveBeenCalled()
  })

  it('cancels the pending single click and emits only one double click', () => {
    const single = vi.fn()
    const double = vi.fn()
    const arbiter = new PetClickArbiter()

    arbiter.click(single, double)
    arbiter.click(single, double)
    vi.runAllTimers()

    expect(single).not.toHaveBeenCalled()
    expect(double).toHaveBeenCalledOnce()
  })

  it('cancels a click after a drag, blur, or destroyed surface', () => {
    const single = vi.fn()
    const double = vi.fn()
    const arbiter = new PetClickArbiter()

    arbiter.click(single, double)
    arbiter.cancel()
    vi.advanceTimersByTime(300)

    expect(single).not.toHaveBeenCalled()
    expect(double).not.toHaveBeenCalled()
  })
})
