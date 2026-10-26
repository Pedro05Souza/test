import { describe, expect, test } from "bun:test";
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidArgumentError,
  LedgerImbalanceError,
} from "../../src/shared/domain/errors";
import { Money } from "../../src/shared/domain/money";
import { Wallet } from "../../src/wallet/domain/wallet";
import { LedgerDirection, WalletLedgerEntry } from "../../src/wallet/domain/wallet-ledger-entry";
import { brl, NOW, openWallet, usd } from "./fixtures";

const ctx = (n: number) => ({ transactionId: `tx-${n}`, ledgerEntryId: `entry-${n}`, at: NOW });

describe("Wallet", () => {
  test("opens with version 1 and an OPENING credit entry for a positive balance", () => {
    const { wallet, openingEntry } = Wallet.open({
      id: "w",
      playerId: "p",
      initialBalance: brl("1000.00"),
      opening: { transactionId: "open-tx", ledgerEntryId: "open-entry" },
      at: NOW,
    });
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toJSON()).toEqual({ amount: "1000.00", currency: "BRL" });
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.balanceBefore.isZero()).toBe(true);
    expect(openingEntry?.balanceAfter.equals(wallet.balance)).toBe(true);
  });

  test("opens without ledger entry for a zero balance", () => {
    const { wallet, openingEntry } = Wallet.open({ id: "w", playerId: "p", initialBalance: brl("0"), at: NOW });
    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeUndefined();
  });

  test("refuses a positive opening balance without an OPENING transaction", () => {
    expect(() => Wallet.open({ id: "w", playerId: "p", initialBalance: brl("1.00"), at: NOW })).toThrow(
      InvalidArgumentError,
    );
  });

  test("debit and credit move the balance, bump the version and return a balanced entry", () => {
    const wallet = openWallet("100.00");
    const debit = wallet.debit(brl("30.00"), ctx(1));
    expect(wallet.balance.toJSON().amount).toBe("70.00");
    expect(wallet.version).toBe(2);
    expect(debit.balanceBefore.toJSON().amount).toBe("100.00");
    expect(debit.balanceAfter.toJSON().amount).toBe("70.00");
    expect(debit.isBalanced()).toBe(true);

    const credit = wallet.credit(brl("5.50"), ctx(2));
    expect(wallet.balance.toJSON().amount).toBe("75.50");
    expect(wallet.version).toBe(3);
    expect(credit.direction).toBe(LedgerDirection.Credit);
  });

  test("never goes negative: debit beyond balance throws and leaves the wallet untouched", () => {
    const wallet = openWallet("100.00");
    expect(wallet.canDebit(brl("100.01"))).toBe(false);
    expect(() => wallet.debit(brl("100.01"), ctx(1))).toThrow(InsufficientFundsError);
    expect(wallet.balance.toJSON().amount).toBe("100.00");
    expect(wallet.version).toBe(1);
  });

  test("allows debiting the exact balance down to zero", () => {
    const wallet = openWallet("100.00");
    wallet.debit(brl("100.00"), ctx(1));
    expect(wallet.balance.isZero()).toBe(true);
  });

  test("rejects zero or other-currency movements", () => {
    const wallet = openWallet("100.00");
    expect(() => wallet.credit(brl("0"), ctx(1))).toThrow(InvalidArgumentError);
    expect(() => wallet.credit(usd("1.00"), ctx(1))).toThrow(CurrencyMismatchError);
    expect(() => wallet.debit(usd("1.00"), ctx(1))).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
  });

  test("balance always equals the sum of its ledger entries", () => {
    const { wallet, openingEntry } = Wallet.open({
      id: "w",
      playerId: "p",
      initialBalance: brl("50.00"),
      opening: { transactionId: "o", ledgerEntryId: "oe" },
      at: NOW,
    });
    const entries = [openingEntry!];
    entries.push(wallet.debit(brl("20.00"), ctx(1)));
    entries.push(wallet.credit(brl("35.25"), ctx(2)));
    entries.push(wallet.debit(brl("0.25"), ctx(3)));

    const rebuilt = entries.reduce((sum, e) => sum.add(e.signedAmount()), Money.zero("BRL"));
    expect(rebuilt.equals(wallet.balance)).toBe(true);
    expect(wallet.version).toBe(4);
  });
});

describe("WalletLedgerEntry", () => {
  const base = {
    id: "e",
    walletId: "w",
    transactionId: "t",
    direction: LedgerDirection.Debit,
    money: brl("10.00"),
    balanceBefore: brl("50.00"),
    balanceAfter: brl("40.00"),
    createdAt: NOW,
  };

  test("validates the arithmetic in the factory", () => {
    expect(WalletLedgerEntry.create(base).isBalanced()).toBe(true);
    expect(() => WalletLedgerEntry.create({ ...base, balanceAfter: brl("41.00") })).toThrow(LedgerImbalanceError);
    expect(() => WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Credit })).toThrow(
      LedgerImbalanceError,
    );
  });

  test("rejects non-positive amounts and negative resulting balances", () => {
    expect(() => WalletLedgerEntry.create({ ...base, money: brl("0") , balanceAfter: brl("50.00")})).toThrow(
      InvalidArgumentError,
    );
    expect(() =>
      WalletLedgerEntry.create({ ...base, balanceBefore: brl("5.00"), balanceAfter: brl("5.00").subtract(brl("10.00")) }),
    ).toThrow(LedgerImbalanceError);
  });

  test("exposes only read-only queries (no transition methods)", () => {
    const entry = WalletLedgerEntry.create(base);
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(entry)).sort()).toEqual([
      "constructor",
      "isBalanced",
      "signedAmount",
    ]);
  });
});
