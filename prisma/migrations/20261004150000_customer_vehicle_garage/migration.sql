BEGIN;

CREATE TYPE "VehicleCategoryCode" AS ENUM ('BIKE', 'SALOON', 'SUV_PICKUP', 'TRUCK', 'BUS_MINI_TRUCK');

CREATE TABLE "vehicle_categories" (
    "code" "VehicleCategoryCode" NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    CONSTRAINT "vehicle_categories_pkey" PRIMARY KEY ("code")
);

CREATE TABLE "vehicles" (
    "id" UUID NOT NULL,
    "category_code" "VehicleCategoryCode" NOT NULL,
    "registration_number" VARCHAR(80),
    "registration_number_normalized" VARCHAR(240),
    "make" VARCHAR(80),
    "model" VARCHAR(80),
    "year" INTEGER,
    "colour" VARCHAR(80),
    "chassis_number" VARCHAR(80),
    "engine_number" VARCHAR(80),
    "engine_capacity" VARCHAR(40),
    "usage_type" VARCHAR(40),
    "state_of_registration" VARCHAR(80),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "vehicles_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "vehicles_year_bounds" CHECK ("year" IS NULL OR "year" BETWEEN 1000 AND 9999),
    CONSTRAINT "vehicles_registration_pair" CHECK (("registration_number" IS NULL) = ("registration_number_normalized" IS NULL))
);

CREATE TABLE "vehicle_ownerships" (
    "vehicle_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    CONSTRAINT "vehicle_ownerships_pkey" PRIMARY KEY ("vehicle_id")
);

-- Search indexes deliberately do not enforce registration-number uniqueness.
CREATE INDEX "vehicles_registration_number_normalized_idx" ON "vehicles"("registration_number_normalized");
CREATE INDEX "vehicles_created_at_id_idx" ON "vehicles"("created_at", "id");
CREATE INDEX "vehicle_ownerships_user_id_vehicle_id_idx" ON "vehicle_ownerships"("user_id", "vehicle_id");

ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_category_code_fkey" FOREIGN KEY ("category_code") REFERENCES "vehicle_categories"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vehicle_ownerships" ADD CONSTRAINT "vehicle_ownerships_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "vehicle_ownerships" ADD CONSTRAINT "vehicle_ownerships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "vehicle_categories" ("code", "name") VALUES
    ('BIKE', 'Bike'),
    ('SALOON', 'Saloon'),
    ('SUV_PICKUP', 'SUV / Pickup'),
    ('TRUCK', 'Truck'),
    ('BUS_MINI_TRUCK', 'Bus / Mini Truck');

COMMIT;
