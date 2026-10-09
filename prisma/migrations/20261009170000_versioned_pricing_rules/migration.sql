BEGIN;

CREATE TYPE "PricingStrategy" AS ENUM (
    'FIXED_BY_VEHICLE_CATEGORY',
    'FIXED_BY_VARIANT',
    'FIXED_UNIVERSAL',
    'PERCENTAGE_OF_DECLARED_VALUE',
    'MANUAL_QUOTE',
    'MANUAL_REVIEW'
);

CREATE TYPE "PricingRuleStatus" AS ENUM (
    'ACTIVE',
    'PENDING_CONFIRMATION',
    'RETIRED'
);

CREATE TABLE "pricing_rules" (
    "id" UUID NOT NULL,
    "service_id" UUID NOT NULL,
    "vehicle_category_code" "VehicleCategoryCode",
    "service_variant_id" UUID,
    "strategy" "PricingStrategy" NOT NULL,
    "amount" DECIMAL(18,2),
    "percentage" DECIMAL(7,4),
    "currency" CHAR(3) NOT NULL DEFAULT 'NGN',
    "effective_from" TIMESTAMPTZ(3) NOT NULL,
    "effective_to" TIMESTAMPTZ(3),
    "status" "PricingRuleStatus" NOT NULL DEFAULT 'PENDING_CONFIRMATION',
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "pricing_rules_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "pricing_rules_ngn_only" CHECK ("currency" = 'NGN'),
    CONSTRAINT "pricing_rules_version_positive" CHECK ("version" > 0),
    CONSTRAINT "pricing_rules_effective_window" CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from"),
    CONSTRAINT "pricing_rules_value_shape" CHECK (
        (
            "strategy" IN ('FIXED_BY_VEHICLE_CATEGORY', 'FIXED_BY_VARIANT', 'FIXED_UNIVERSAL')
            AND "amount" IS NOT NULL
            AND "amount" > 0
            AND "percentage" IS NULL
        )
        OR (
            "strategy" = 'PERCENTAGE_OF_DECLARED_VALUE'
            AND "amount" IS NULL
            AND "percentage" IS NOT NULL
            AND "percentage" > 0
            AND "percentage" <= 100
        )
        OR (
            "strategy" IN ('MANUAL_QUOTE', 'MANUAL_REVIEW')
            AND "amount" IS NULL
            AND "percentage" IS NULL
        )
    ),
    CONSTRAINT "pricing_rules_selector_shape" CHECK (
        (
            "strategy" = 'FIXED_BY_VEHICLE_CATEGORY'
            AND "vehicle_category_code" IS NOT NULL
            AND "service_variant_id" IS NULL
        )
        OR (
            "strategy" = 'FIXED_BY_VARIANT'
            AND "vehicle_category_code" IS NULL
            AND "service_variant_id" IS NOT NULL
        )
        OR (
            "strategy" IN ('FIXED_UNIVERSAL', 'PERCENTAGE_OF_DECLARED_VALUE')
            AND "vehicle_category_code" IS NULL
            AND "service_variant_id" IS NULL
        )
        OR "strategy" IN ('MANUAL_QUOTE', 'MANUAL_REVIEW')
    )
);

CREATE INDEX "pricing_rules_service_id_status_effective_from_effective_to_idx" ON "pricing_rules"("service_id", "status", "effective_from", "effective_to");
CREATE INDEX "pricing_rules_vehicle_category_code_service_id_idx" ON "pricing_rules"("vehicle_category_code", "service_id");
CREATE INDEX "pricing_rules_service_variant_id_service_id_idx" ON "pricing_rules"("service_variant_id", "service_id");

ALTER TABLE "pricing_rules" ADD CONSTRAINT "pricing_rules_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pricing_rules" ADD CONSTRAINT "pricing_rules_vehicle_category_code_fkey" FOREIGN KEY ("vehicle_category_code") REFERENCES "vehicle_categories"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pricing_rules" ADD CONSTRAINT "pricing_rules_service_variant_id_fkey" FOREIGN KEY ("service_variant_id") REFERENCES "service_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
