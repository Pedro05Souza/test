import { SQL } from "bun";
import { DEFAULT_DATABASE_URL } from "../../src/shared/infrastructure/database/mikro-orm.config";

export interface HttpResult<T = any> {
  status: number;
  body: T;
}

export class Api {
  constructor(readonly baseUrl: string) {}

  async request<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<HttpResult<T>> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  }

  openWallet(amount = "100.00", currency = "BRL", playerId = `player-${Bun.randomUUIDv7()}`) {
    return this.request("POST", "/wallets", { playerId, initialBalance: { amount, currency } });
  }

  async wallet(amount = "100.00", currency = "BRL"): Promise<{ id: string; playerId: string }> {
    const res = await this.openWallet(amount, currency);
    if (res.status !== 201) throw new Error(`could not open wallet: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  }

  submit(payload: WagerPayload, idempotencyKey = `${payload.providerId}:${payload.externalTransactionId}`) {
    return this.request("POST", "/wagering/transactions", payload, { "idempotency-key": idempotencyKey });
  }
}

export interface WagerPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

export function wager(
  wallet: { id: string; playerId: string },
  kind: string,
  amount: string,
  overrides: Partial<WagerPayload> = {},
): WagerPayload {
  return {
    providerId: "provider-a",
    externalTransactionId: `tx-${Bun.randomUUIDv7()}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: "round-1",
    gameId: "fortune-chimp",
    kind,
    money: { amount, currency: "BRL" },
    ...overrides,
  };
}

export const db = () => new SQL(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL, { max: 5 });

/**
 * The invariant every test ends with: wallet.balance == balance rebuilt from the ledger,
 * and the ledger is a gapless chain.
 */
export async function ledgerInvariant(sql: SQL, walletId: string) {
  const [row] = await sql`
    SELECT w.balance_amount::text AS stored,
           COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0)::numeric(20,2)::text AS rebuilt,
           COUNT(l.id)::int AS entries,
           COUNT(*) FILTER (WHERE l.direction = 'DEBIT')::int AS debits
      FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
     WHERE w.id = ${walletId}
     GROUP BY w.balance_amount`;
  return row as { stored: string; rebuilt: string; entries: number; debits: number };
}
