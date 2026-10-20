import { describe, expect, it } from 'vitest'
import { clampPetBounds, type PetRect } from '../../src/main/core/desktopPet/windowGeometry'

describe('desktop pet window geometry', () => {
  const primary: PetRect = { x: 0, y: 0, width: 1920, height: 1040 }
  const left: PetRect = { x: -1280, y: 0, width: 1280, height: 1024 }

  it('clamps a window fully inside the selected work area', () => {
    expect(clampPetBounds({ x: 1900, y: 1000, width: 144, height: 192 }, [primary])).toEqual({
      x: 1776,
      y: 848,
      width: 144,
      height: 192
    })
  })

  it('keeps negative-coordinate monitors valid', () => {
    expect(clampPetBounds({ x: -1400, y: 900, width: 144, height: 192 }, [primary, left])).toEqual({
      x: -1280,
      y: 832,
      width: 144,
      height: 192
    })
  })

  it('uses the work area with the largest intersection instead of the primary monitor', () => {
    const bounds = { x: -1100, y: 100, width: 500, height: 500 }
    expect(clampPetBounds(bounds, [primary, left])).toMatchObject({ x: -1100, y: 100 })
  })

  it('falls back to the first work area when the saved rectangle has no intersection', () => {
    expect(clampPetBounds({ x: 5000, y: 5000, width: 144, height: 192 }, [primary, left])).toEqual({
      x: 1776,
      y: 848,
      width: 144,
      height: 192
    })
  })

  it('keeps a window visible when it is larger than the work area', () => {
    expect(clampPetBounds({ x: 20, y: 30, width: 2200, height: 1200 }, [primary])).toEqual({
      x: 0,
      y: 0,
      width: 2200,
      height: 1200
    })
  })

  it('rounds fractional coordinates and leaves empty display input unchanged', () => {
    expect(clampPetBounds({ x: 10.4, y: 20.6, width: 100, height: 100 }, [])).toEqual({
      x: 10.4,
      y: 20.6,
      width: 100,
      height: 100
    })
    expect(clampPetBounds({ x: 10.4, y: 20.6, width: 100, height: 100 }, [primary])).toEqual({
      x: 10,
      y: 21,
      width: 100,
      height: 100
    })
  })
})
