import { canonicalJson, sha256Hex } from "../../shared/canonical-json";
import { Money, type MoneyProps } from "../../shared/domain/money";

/** The business fields of a submission. Transport metadata and the idempotency key are excluded. */
export interface WagerPayloadFields {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

/**
 * payloadHash = hex(SHA-256(canonicalJson(fields))), where canonicalJson sorts keys recursively
 * and drops undefined members. Only the fields listed in WagerPayloadFields participate.
 */
export function computePayloadHash(fields: WagerPayloadFields): string {
  const subset: WagerPayloadFields = {
    providerId: fields.providerId,
    externalTransactionId: fields.externalTransactionId,
    playerId: fields.playerId,
    walletId: fields.walletId,
    roundId: fields.roundId,
    gameId: fields.gameId,
    kind: fields.kind,
    // normalized through Money so "25" and "25.00" hash identically
    money: Money.from(fields.money).toJSON(),
    referenceExternalTransactionId: fields.referenceExternalTransactionId,
  };
  return sha256Hex(canonicalJson(subset));
}
