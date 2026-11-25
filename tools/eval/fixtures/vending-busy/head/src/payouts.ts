// Close-of-day payouts: takings leave the machine account and land in the
// operator account, one receipt per transfer, one batch id per close.

export type Payout = {
  id: string;
  operatorId: string;
  amountCents: number;
};

export type SettledBatch = {
  batchId: string;
  count: number;
  totalCents: number;
  receipts: { receiptId: string }[];
};

// The floor keeps micro-charges in the machine: takings only leave once they
// reach it, so an operator is not paid in single-vend receipts.
export const PAYOUT_FLOOR_CENTS = 500;

export function pickPayouts(rows: Payout[], floorCents: number = PAYOUT_FLOOR_CENTS): Payout[] {
  return rows.filter((row) => row.amountCents >= floorCents);
}

export function summarize(payouts: Payout[]): { count: number; totalCents: number } {
  return {
    count: payouts.length,
    totalCents: payouts.reduce((sum, payout) => sum + payout.amountCents, 0),
  };
}

export function groupByOperator(payouts: Payout[]): Map<string, Payout[]> {
  const byOperator = new Map<string, Payout[]>();
  for (const payout of payouts) {
    const mine = byOperator.get(payout.operatorId);
    if (mine) mine.push(payout);
    else byOperator.set(payout.operatorId, [payout]);
  }
  return byOperator;
}

// Per-operator close: the operator portal shows one settled batch per
// operator, not one per machine.
export function settlePlan(payouts: Payout[]): { operatorId: string; totalCents: number; ids: string[] }[] {
  return [...groupByOperator(payouts)].map(([operatorId, mine]) => ({
    operatorId,
    totalCents: summarize(mine).totalCents,
    ids: mine.map((payout) => payout.id),
  }));
}

// Transfers run one at a time, in arrival order: the ledger is append-only and
// receipt order is part of the audit trail.
export async function settleBatch(
  ledger: { transfer(operatorId: string, amountCents: number): Promise<{ receiptId: string }> },
  payouts: Payout[],
): Promise<SettledBatch> {
  const payable = payouts.filter((payout) => payout.amountCents > 0);
  const first = payable[0];
  const receipts: { receiptId: string }[] = [];
  for (const payout of payable) {
    receipts.push(await ledger.transfer(payout.operatorId, payout.amountCents));
  }
  return { batchId: first.id, ...summarize(payable), receipts };
}
