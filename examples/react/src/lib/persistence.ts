import type { Persistence } from '../../../../dist'

export const persistence: Persistence = {
  setItem: (...args) => localStorage.setItem(...args),
  getItem: (...args) => localStorage.getItem(...args),
}
