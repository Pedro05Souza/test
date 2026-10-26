import { Inject, Injectable } from "@nestjs/common";
import { TransactionNotFoundError } from "../../shared/application/errors";
import { UNIT_OF_WORK, type UnitOfWork } from "../../shared/application/ports";
import { toView, type WagerTransactionView } from "./wager-transaction.views";

@Injectable()
export class GetWagerTransaction {
  constructor(@Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork) {}

  byId(transactionId: string): Promise<WagerTransactionView> {
    return this.uow.run(async ({ transactions }) => {
      const tx = await transactions.findById(transactionId);
      if (!tx) throw new TransactionNotFoundError(`transaction ${transactionId} not found`);
      return toView(tx);
    });
  }

  byExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransactionView> {
    return this.uow.run(async ({ transactions }) => {
      const tx = await transactions.findByExternalId(providerId, externalTransactionId);
      if (!tx) throw new TransactionNotFoundError(`transaction ${providerId}/${externalTransactionId} not found`);
      return toView(tx);
    });
  }
}
