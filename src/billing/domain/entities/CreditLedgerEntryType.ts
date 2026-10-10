/** Discriminante del ledger de crédito (ver billing/infrastructure/db/schema.ts: creditLedgerEntries) — text plano en vez de pgEnum: agregar un tipo nuevo es un cambio de código, nunca una migración ALTER TYPE. */
export const CreditLedgerEntryType = {
  PlanGrant: 'plan_grant',
  Topup: 'topup',
  Usage: 'usage',
  Expire: 'expire',
} as const
export type CreditLedgerEntryType = (typeof CreditLedgerEntryType)[keyof typeof CreditLedgerEntryType]
