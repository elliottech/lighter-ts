export interface Persistence {
  setItem: (key: string, value: string) => void
  getItem: (key: string) => string | null
}

export const persistence: Persistence = {
  setItem: () => {},
  getItem: () => null,
}
