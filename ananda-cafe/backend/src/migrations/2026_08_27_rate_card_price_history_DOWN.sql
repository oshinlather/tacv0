-- Rollback for 2026_08_27_rate_card_price_history.sql.
-- Safe until challans/purchases have started writing real price rows; once they have,
-- export rate_card_prices first — dropping it loses every recorded price change (the
-- current rate_card.price mirror survives, so live costing keeps working, but all history
-- and every past date's as-of price collapse back to that single current value).

DROP TABLE IF EXISTS rate_card_prices;

NOTIFY pgrst, 'reload schema';
