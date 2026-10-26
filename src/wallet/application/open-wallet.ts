import { Inject, Injectable } from "@nestjs/common";
import { OutboxMessage } from "../../messaging/domain/outbox-message";
import { UniqueViolationError, WalletAlreadyExistsError } from "../../shared/application/errors";
import {
  CLOCK,
  ID_GENERATOR,
  LOGGER,
  UNIT_OF_WORK,
  type Clock,
  type IdGenerator,
  type Logger,
  type UnitOfWork,
} from "../../shared/application/ports";
import { Money, type MoneyProps } from "../../shared/domain/money";
import { WalletBalanceChanged } from "../../wagering/domain/events";
import { WagerTransaction } from "../../wagering/domain/wager-transaction";
import { Wallet } from "../domain/wallet";
import { toWalletView, type WalletView } from "./wallet.views";

export interface OpenWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
}

/**
 * Creates a wallet. A positive initial balance is funded by an internal OPENING transaction with
 * its CREDIT ledger line — wallet, transaction, ledger and event in the same SQL transaction.
 */
@Injectable()
export class OpenWallet {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async execute(command: OpenWalletCommand, trace: { correlationId: string }): Promise<WalletView> {
    const initialBalance = Money.from(command.initialBalance);
    try {
      const view = await this.uow.run(async (repos) => {
        const now = this.clock.now();
        const walletId = this.ids.next();
        const openingTxId = this.ids.next();
        const { wallet, openingEntry } = Wallet.open({
          id: walletId,
          playerId: command.playerId,
          initialBalance,
          opening: { transactionId: openingTxId, ledgerEntryId: this.ids.next() },
          at: now,
        });
        repos.wallets.add(wallet);
        if (openingEntry) {
          repos.transactions.add(
            WagerTransaction.createOpening({ id: openingTxId, walletId, playerId: wallet.playerId, money: initialBalance, at: now }),
          );
          repos.ledger.add(openingEntry);
          repos.outbox.add(
            OutboxMessage.enqueue(
              WalletBalanceChanged.from(wallet, openingEntry, { eventId: this.ids.next(), correlationId: trace.correlationId, occurredAt: now }),
            ),
          );
        }
        return toWalletView(wallet);
      });
      this.logger.info("wallet opened", { correlationId: trace.correlationId, walletId: view.id });
      return view;
    } catch (error) {
      if (error instanceof UniqueViolationError && error.constraint === "wallets_player_currency_uq") {
        throw new WalletAlreadyExistsError(
          `player already has a ${initialBalance.currency} wallet`,
          { cause: error },
        );
      }
      throw error;
    }
  }
}
