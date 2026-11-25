# One machine, one slot at a time: the price lives with the product, and the
# machine only knows slots.


def vend(slot, inserted_cents, price_cents):
    if inserted_cents < price_cents:
        return None
    return slot  # the caller drops the product and hands back the change


def change_due(inserted_cents, price_cents):
    return max(0, inserted_cents - price_cents)
