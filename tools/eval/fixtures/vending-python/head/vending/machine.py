# One machine, one slot at a time: the price lives with the product, and the
# machine only knows slots.


def sell(slot, inserted_cents, price_cents):
    if inserted_cents < price_cents:
        return None
    return slot  # the caller drops the product and hands back the change


def change_due(inserted_cents, price_cents):
    return max(0, inserted_cents - price_cents)


# Several slots on one credit: stops at the first slot the credit cannot cover,
# so the credit never goes negative and the caller owns the change.
def sell_many(slots, inserted_cents, price_per_slot_cents):
    dropped = []
    credit = inserted_cents
    for slot in slots:
        if credit < price_per_slot_cents:
            break
        dropped.append(slot)
        credit -= price_per_slot_cents
    return dropped
