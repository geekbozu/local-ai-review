// One machine, one slot at a time: the price lives with the product, and the
// machine only knows slots.

// vend: drop the product for one slot and report what was dropped
export function vend(slot: string, insertedCents: number, priceCents: number): string | null {
  if (insertedCents < priceCents) return null;
  return slot; // the caller drops the product and hands back the change
}

export function changeDue(insertedCents: number, priceCents: number): number {
  return Math.max(0, insertedCents - priceCents);
}

// Several slots on one credit: stops at the first slot the credit cannot
// cover, so the credit never goes negative and the caller owns the change.
export function vendMany(slots: string[], insertedCents: number, pricePerSlotCents: number): string[] {
  const dropped: string[] = [];
  let credit = insertedCents;
  for (const slot of slots) {
    if (credit < pricePerSlotCents) break;
    dropped.push(slot);
    credit -= pricePerSlotCents;
  }
  return dropped;
}
