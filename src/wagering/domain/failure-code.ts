/**
 * Stable, machine-readable reasons a transaction ended REJECTED or FAILED.
 * The `providerAction` tells the provider what to do; it is exposed in API responses and events.
 */
export enum FailureCode {
  InsufficientFunds = "INSUFFICIENT_FUNDS",
  ReversalInsufficientFunds = "REVERSAL_INSUFFICIENT_FUNDS",
  CurrencyMismatch = "CURRENCY_MISMATCH",
  WalletPlayerMismatch = "WALLET_PLAYER_MISMATCH",
  ReferenceNotFound = "REFERENCE_NOT_FOUND",
  ReferenceMismatch = "REFERENCE_MISMATCH",
  InvalidReferenceKind = "INVALID_REFERENCE_KIND",
  ReferenceNotProcessed = "REFERENCE_NOT_PROCESSED",
  AlreadyReversed = "ALREADY_REVERSED",
  AmountMismatch = "AMOUNT_MISMATCH",
  InfrastructureFailure = "INFRASTRUCTURE_FAILURE",
}

/**
 * - `DO_NOT_RETRY`: the outcome is final for this externalTransactionId; resending returns the same result.
 * - `FIX_AND_RESEND`: the request was wrong; send a corrected operation under a NEW externalTransactionId.
 * - `INVESTIGATE`: requires manual/ops attention (data inconsistency between provider and wallet).
 */
export type ProviderAction = "DO_NOT_RETRY" | "FIX_AND_RESEND" | "INVESTIGATE";

export const FAILURE_CODE_ACTION: Readonly<Record<FailureCode, ProviderAction>> = {
  [FailureCode.InsufficientFunds]: "DO_NOT_RETRY",
  [FailureCode.ReversalInsufficientFunds]: "INVESTIGATE",
  [FailureCode.CurrencyMismatch]: "FIX_AND_RESEND",
  [FailureCode.WalletPlayerMismatch]: "FIX_AND_RESEND",
  [FailureCode.ReferenceNotFound]: "INVESTIGATE",
  [FailureCode.ReferenceMismatch]: "FIX_AND_RESEND",
  [FailureCode.InvalidReferenceKind]: "FIX_AND_RESEND",
  [FailureCode.ReferenceNotProcessed]: "DO_NOT_RETRY",
  [FailureCode.AlreadyReversed]: "DO_NOT_RETRY",
  [FailureCode.AmountMismatch]: "FIX_AND_RESEND",
  [FailureCode.InfrastructureFailure]: "INVESTIGATE",
};
