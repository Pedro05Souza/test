import { Money } from "../../src/shared/domain/money";
import { computePayloadHash } from "../../src/wagering/application/payload-hash";
import { ReferenceRetryPolicy } from "../../src/wagering/domain/reference-retry-policy";
import {
  WagerTransaction,
  type SubmittableKind,
} from "../../src/wagering/domain/wager-transaction";
import { Wallet } from "../../src/wallet/domain/wallet";

export const NOW = new Date("2026-07-29T15:00:00.000Z");
export const PLAYER = "player-1";
export const WALLET = "wallet-1";

let seq = 0;
export const nextId = (prefix = "id") => `${prefix}-${++seq}`;

export const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
export const usd = (amount: string) => Money.from({ amount, currency: "USD" });

export function openWallet(initial = "100.00", currency = "BRL"): Wallet {
  return Wallet.open({
    id: WALLET,
    playerId: PLAYER,
    initialBalance: Money.from({ amount: initial, currency }),
    opening: { transactionId: nextId("opening"), ledgerEntryId: nextId("entry") },
    at: NOW,
  }).wallet;
}

export function tx(
  kind: SubmittableKind,
  amount: string,
  overrides: Partial<{
    externalTransactionId: string;
    reference: string;
    roundId: string;
    playerId: string;
    providerId: string;
    currency: string;
  }> = {},
): WagerTransaction {
  const externalTransactionId = overrides.externalTransactionId ?? nextId("ext");
  const providerId = overrides.providerId ?? "provider-a";
  const money = { amount, currency: overrides.currency ?? "BRL" };
  const fields = {
    providerId,
    externalTransactionId,
    playerId: overrides.playerId ?? PLAYER,
    walletId: WALLET,
    roundId: overrides.roundId ?? "round-1",
    gameId: "fortune-chimp",
    kind,
    money,
    referenceExternalTransactionId: overrides.reference,
  };
  return WagerTransaction.create({
    ...fields,
    id: nextId("tx"),
    idempotencyKey: `${providerId}:${externalTransactionId}`,
    payloadHash: computePayloadHash(fields),
    money: Money.from(money),
    createdAt: NOW,
  });
}

export const policy = new ReferenceRetryPolicy(3, 1_000, 10_000);
