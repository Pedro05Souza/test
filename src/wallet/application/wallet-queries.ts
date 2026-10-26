import { Inject, Injectable } from "@nestjs/common";
import { ValidationError, WalletNotFoundError } from "../../shared/application/errors";
import { LOGGER, METRICS, UNIT_OF_WORK, type Logger, type Metrics, type UnitOfWork } from "../../shared/application/ports";
import type { MoneyProps } from "../../shared/domain/money";
import { toLedgerEntryView, toWalletView, type LedgerEntryView, type WalletView } from "./wallet.views";

export const LEDGER_PAGE_DEFAULT = 50;
export const LEDGER_PAGE_MAX = 200;

export interface LedgerPage {
  items: LedgerEntryView[];
  /** Opaque; pass back as `cursor` to get the next page. Absent on the last page. */
  nextCursor?: string;
}

export interface ReconciliationReport {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

/**
 * Cursor = base64url(JSON {v:1, s:<ledger seq>}). The ledger is append-only and `seq` is
 * monotonic, so pages are stable: new entries only ever appear after the last page.
 */
export const LedgerCursor = {
  encode(seq: string): string {
    return Buffer.from(JSON.stringify({ v: 1, s: seq })).toString("base64url");
  },
  decode(cursor: string): string {
    try {
      const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { v?: unknown; s?: unknown };
      if (parsed.v === 1 && typeof parsed.s === "string" && /^\d{1,19}$/.test(parsed.s)) return parsed.s;
    } catch {
      // fall through
    }
    throw new ValidationError("invalid cursor", [{ path: "cursor", message: "malformed or foreign cursor" }]);
  },
};

@Injectable()
export class WalletQueries {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(METRICS) private readonly metrics: Metrics,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  getWallet(walletId: string): Promise<WalletView> {
    return this.uow.run(async ({ wallets }) => {
      const wallet = await wallets.findById(walletId);
      if (!wallet) throw new WalletNotFoundError(`wallet ${walletId} not found`);
      return toWalletView(wallet);
    });
  }

  getLedgerPage(walletId: string, cursor: string | undefined, limit = LEDGER_PAGE_DEFAULT): Promise<LedgerPage> {
    if (!Number.isInteger(limit) || limit < 1 || limit > LEDGER_PAGE_MAX) {
      throw new ValidationError(`limit must be an integer between 1 and ${LEDGER_PAGE_MAX}`, [
        { path: "limit", message: "out of range" },
      ]);
    }
    const afterSeq = cursor ? LedgerCursor.decode(cursor) : undefined;
    return this.uow.run(async ({ wallets, ledger }) => {
      if (!(await wallets.findById(walletId))) throw new WalletNotFoundError(`wallet ${walletId} not found`);
      const rows = await ledger.page(walletId, afterSeq, limit + 1);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map((row) => toLedgerEntryView(row.entry)),
        ...(rows.length > limit && last ? { nextCursor: LedgerCursor.encode(last.seq) } : {}),
      };
    });
  }

  /** Compares the materialized balance to the ledger. Divergences are reported, never auto-corrected. */
  async reconcile(walletId: string, trace: { correlationId: string }): Promise<ReconciliationReport> {
    const snapshot = await this.uow.run(async ({ wallets, ledger }) => {
      if (!(await wallets.findById(walletId))) throw new WalletNotFoundError(`wallet ${walletId} not found`);
      return ledger.reconciliationSnapshot(walletId);
    });
    if (!snapshot) throw new WalletNotFoundError(`wallet ${walletId} not found`);

    const difference = snapshot.storedBalance.subtract(snapshot.calculatedBalance);
    const consistent = difference.isZero();
    this.metrics.reconciliation(consistent);
    if (!consistent) {
      this.logger.error("wallet balance diverges from ledger", {
        correlationId: trace.correlationId,
        walletId,
        checkedEntries: snapshot.checkedEntries,
      });
    }
    return {
      walletId,
      storedBalance: snapshot.storedBalance.toJSON(),
      calculatedBalance: snapshot.calculatedBalance.toJSON(),
      difference: difference.toJSON(),
      consistent,
      checkedEntries: snapshot.checkedEntries,
    };
  }
}
