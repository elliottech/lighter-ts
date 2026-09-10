import { useLighterStore } from '../store/useLighterStore'
import { selectL1Address } from '../store/user/selectors'

export const useUserAddress = () => useLighterStore(selectL1Address)
