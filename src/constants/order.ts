export const TX_TIMEOUT = 15000
// Once TX_TIMEOUT passes without a ws update the tx is looked up by hash, up to
// TX_LOOKUP_ATTEMPTS times. Each attempt is bounded by TX_LOOKUP_TIMEOUT and
// they are TX_LOOKUP_RETRY_DELAY apart.
export const TX_LOOKUP_TIMEOUT = 5000
export const TX_LOOKUP_ATTEMPTS = 3
export const TX_LOOKUP_RETRY_DELAY = 2000
export const DRAFT_RFQ_ID = -1
