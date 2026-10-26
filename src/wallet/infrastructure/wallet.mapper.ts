import type { RequiredEntityData } from "@mikro-orm/core";
import { Money } from "../../shared/domain/money";
import { Wallet } from "../domain/wallet";
import { LedgerDirection, WalletLedgerEntry } from "../domain/wallet-ledger-entry";
import type { WalletLedgerEntryRecord } from "./wallet-ledger-entry.record";
import type { WalletRecord } from "./wallet.record";

export const WalletMapper = {
  toDomain(record: WalletRecord): Wallet {
    return Wallet.rehydrate({
      id: record.id,
      playerId: record.playerId,
      currency: record.currency,
      balance: Money.from({ amount: record.balanceAmount, currency: record.currency }),
      version: record.version,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  },

  toRecord(wallet: Wallet): RequiredEntityData<WalletRecord> {
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balanceAmount: wallet.balance.toJSON().amount,
      version: wallet.version,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    };
  },
};

export const LedgerEntryMapper = {
  toDomain(record: WalletLedgerEntryRecord): WalletLedgerEntry {
    const money = (amount: string) => Money.from({ amount, currency: record.currency });
    return WalletLedgerEntry.rehydrate({
      id: record.id,
      walletId: record.wallet,
      transactionId: record.transaction,
      direction: record.direction as LedgerDirection,
      money: money(record.amount),
      balanceBefore: money(record.balanceBefore),
      balanceAfter: money(record.balanceAfter),
      createdAt: record.createdAt,
    });
  },

  toRecord(entry: WalletLedgerEntry): RequiredEntityData<WalletLedgerEntryRecord> {
    return {
      id: entry.id,
      wallet: entry.walletId,
      transaction: entry.transactionId,
      direction: entry.direction,
      amount: entry.money.toJSON().amount,
      currency: entry.money.currency,
      balanceBefore: entry.balanceBefore.toJSON().amount,
      balanceAfter: entry.balanceAfter.toJSON().amount,
      createdAt: entry.createdAt,
    };
  },
};
