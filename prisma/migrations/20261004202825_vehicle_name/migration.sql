-- Optional customer label; existing vehicles remain unnamed and unchanged.
BEGIN;

ALTER TABLE "vehicles" ADD COLUMN "name" VARCHAR(80);

COMMIT;
