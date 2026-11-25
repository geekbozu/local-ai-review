// One machine, one slot at a time: the price lives with the product, and the
// machine only knows slots.

export function dispense(slot: string, insertedCents: number, priceCents: number): string | null {
  if (insertedCents < priceCents) return null;
  return slot; // the caller drops the product and hands back the change
}

export function changeDue(insertedCents: number, priceCents: number): number {
  return Math.max(0, insertedCents - priceCents);
}
