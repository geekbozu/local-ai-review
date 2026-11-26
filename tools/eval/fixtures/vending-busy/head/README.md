# vending service

A machine sells snacks from numbered slots. `vend` drops one product and returns
the change; payouts settle at close of day, once per operator, at or above the
payout floor.

Restock plans come from the supplier feed: each slot is topped up with what the
supplier offers, capped by the space left in the slot.
