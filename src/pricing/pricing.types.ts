import type { Prisma, VehicleCategoryCode } from '../generated/prisma/client';

export type ResolvePriceInput = {
  serviceId: string;
  vehicleCategory?: VehicleCategoryCode | null;
  serviceVariantId?: string | null;
  declaredVehicleValue?: string | Prisma.Decimal | null;
  requestedAt: Date;
};

export type AutomaticPriceResolution = {
  resolution: 'AUTO';
  currency: 'NGN';
  amount: string;
  pricingRuleId: string;
  pricingVersion: number;
};

export const PRICE_REVIEW_MESSAGES = {
  INVALID_REQUEST_DATE: 'The requested pricing date is invalid.',
  SERVICE_NOT_FOUND: 'The selected service is unavailable.',
  SERVICE_NOT_AVAILABLE_FOR_CATEGORY:
    'The selected service is not configured for this vehicle category.',
  VEHICLE_CATEGORY_REQUIRED:
    'A vehicle category is required to determine this price.',
  VARIANT_REQUIRED: 'A service variant is required to determine this price.',
  VARIANT_NOT_FOUND: 'The selected service variant is unavailable.',
  NO_ACTIVE_RULE: 'No active price is configured for this selection.',
  AMBIGUOUS_ACTIVE_RULES:
    'More than one active price applies to this selection.',
  MANUAL_QUOTE_REQUIRED: 'MFS must prepare a manual quote for this selection.',
  MANUAL_REVIEW_REQUIRED: 'MFS must review this selection before pricing it.',
  DECLARED_VALUE_REQUIRED:
    'A declared vehicle value is required to determine this price.',
  INVALID_DECLARED_VALUE:
    'The declared vehicle value must be a positive decimal amount.',
  PERCENTAGE_ROUNDING_UNCONFIRMED:
    'MFS must review this result because percentage rounding is not configured.',
  RULE_CONFIGURATION_ERROR:
    'The applicable pricing rule needs configuration review.',
} as const;

export type PriceReviewReason = keyof typeof PRICE_REVIEW_MESSAGES;

export type ManualPriceResolution = {
  resolution: 'MANUAL_REVIEW';
  reason: PriceReviewReason;
  message: (typeof PRICE_REVIEW_MESSAGES)[PriceReviewReason];
  pricingRuleId?: string;
  pricingVersion?: number;
};

export type PriceResolution = AutomaticPriceResolution | ManualPriceResolution;
