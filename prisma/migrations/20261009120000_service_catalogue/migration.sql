BEGIN;

CREATE TABLE "services" (
    "id" UUID NOT NULL,
    "code" VARCHAR(80) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "slug" VARCHAR(120) NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "services_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "services_sort_order_positive" CHECK ("sort_order" > 0)
);

CREATE TABLE "service_variants" (
    "id" UUID NOT NULL,
    "service_id" UUID NOT NULL,
    "code" VARCHAR(60) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "service_variants_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "service_variants_sort_order_positive" CHECK ("sort_order" > 0)
);

CREATE TABLE "service_vehicle_categories" (
    "service_id" UUID NOT NULL,
    "category_code" "VehicleCategoryCode" NOT NULL,
    CONSTRAINT "service_vehicle_categories_pkey" PRIMARY KEY ("service_id", "category_code")
);

CREATE UNIQUE INDEX "services_code_key" ON "services"("code");
CREATE UNIQUE INDEX "services_slug_key" ON "services"("slug");
CREATE INDEX "services_active_sort_order_id_idx" ON "services"("active", "sort_order", "id");
CREATE UNIQUE INDEX "service_variants_service_id_code_key" ON "service_variants"("service_id", "code");
CREATE INDEX "service_variants_service_id_active_sort_order_id_idx" ON "service_variants"("service_id", "active", "sort_order", "id");
CREATE INDEX "service_vehicle_categories_category_code_service_id_idx" ON "service_vehicle_categories"("category_code", "service_id");

ALTER TABLE "service_variants" ADD CONSTRAINT "service_variants_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "service_vehicle_categories" ADD CONSTRAINT "service_vehicle_categories_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "service_vehicle_categories" ADD CONSTRAINT "service_vehicle_categories_category_code_fkey" FOREIGN KEY ("category_code") REFERENCES "vehicle_categories"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
