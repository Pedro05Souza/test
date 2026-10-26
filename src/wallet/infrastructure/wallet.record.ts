import { defineEntity, p, type InferEntity } from "@mikro-orm/core";

/**
 * Persistence records (MikroORM). Kept separate from the domain classes, which have private
 * constructors and no ORM knowledge; mappers translate between the two.
 *
 * Money columns are NUMERIC(20,2) hydrated as strings (`p.decimal("string")`) — never JS numbers —
 * and turned into `Money` by the mappers. Relations use `mapToPk()` so properties stay plain ids
 * while the Unit of Work still knows the FK graph and orders INSERTs accordingly.
 */
export const WalletRecord = defineEntity({
  name: "WalletRecord",
  tableName: "wallets",
  properties: {
    id: p.uuid().primary(),
    playerId: p.string().length(128),
    currency: p.string().columnType("char(3)"),
    balanceAmount: p.decimal("string").precision(20).scale(2),
    version: p.integer(),
    createdAt: p.datetime().columnType("timestamptz"),
    updatedAt: p.datetime().columnType("timestamptz"),
  },
});
export type WalletRecord = InferEntity<typeof WalletRecord>;
