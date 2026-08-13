-- `retries` as a listed column.
--
-- It has always been in the payload (`report.retries`) and never in the list, and the list is the
-- only thing anyone reads from a phone. That gap has a concrete cost: a 38400 read at block 122 was
-- reported from the car as "about as slow as 9600", and the two explanations for that are opposite.
--
--   * the switch was refused and it genuinely ran at 9600 -- `requested_baud` <> `baud` already says
--     so, and the list already shows it as `38400→9600`;
--   * or it really did run at 38400 and spent the entire saving on retries. One retried chunk costs
--     300-1600 ms of deliberate settle, five attempts deep, against a ~94 ms exchange. Sixty of them
--     across 538 chunks is the difference between 51 s and 126 s.
--
-- The first is visible today, the second is not, so "slow at 38400" cannot currently be diagnosed
-- from the list at all. Additive and nullable: rows written before this column existed genuinely do
-- not know, and a backfilled 0 would claim a clean run that was never measured.

ALTER TABLE diagnostics ADD COLUMN retries INTEGER;
