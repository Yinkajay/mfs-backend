import { Injectable } from '@nestjs/common';
import {
  PricingRuleStatus,
  PricingStrategy,
  Prisma,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  PRICE_REVIEW_MESSAGES,
  type ManualPriceResolution,
  type PriceResolution,
  type PriceReviewReason,
  type ResolvePriceInput,
} from './pricing.types';

const RULE_SELECT = {
  id: true,
  vehicleCategoryCode: true,
  serviceVariantId: true,
  strategy: true,
  amount: true,
  percentage: true,
  currency: true,
  version: true,
} satisfies Prisma.PricingRuleSelect;

type SelectedRule = Prisma.PricingRuleGetPayload<{
  select: typeof RULE_SELECT;
}>;

function manual(
  reason: PriceReviewReason,
  rule?: SelectedRule,
): ManualPriceResolution {
  return {
    resolution: 'MANUAL_REVIEW',
    reason,
    message: PRICE_REVIEW_MESSAGES[reason],
    ...(rule ? { pricingRuleId: rule.id, pricingVersion: rule.version } : {}),
  };
}

function selectorSpecificity(rule: SelectedRule): number {
  return (
    Number(rule.vehicleCategoryCode !== null) +
    Number(rule.serviceVariantId !== null)
  );
}

function matchesSelection(
  rule: SelectedRule,
  input: ResolvePriceInput,
): boolean {
  switch (rule.strategy) {
    case PricingStrategy.FIXED_BY_VEHICLE_CATEGORY:
      return (
        input.vehicleCategory !== undefined &&
        input.vehicleCategory !== null &&
        rule.vehicleCategoryCode === input.vehicleCategory
      );
    case PricingStrategy.FIXED_BY_VARIANT:
      return (
        input.serviceVariantId !== undefined &&
        input.serviceVariantId !== null &&
        rule.serviceVariantId === input.serviceVariantId
      );
    case PricingStrategy.FIXED_UNIVERSAL:
    case PricingStrategy.PERCENTAGE_OF_DECLARED_VALUE:
      return true;
    case PricingStrategy.MANUAL_QUOTE:
    case PricingStrategy.MANUAL_REVIEW:
      return (
        (rule.vehicleCategoryCode === null ||
          rule.vehicleCategoryCode === input.vehicleCategory) &&
        (rule.serviceVariantId === null ||
          rule.serviceVariantId === input.serviceVariantId)
      );
  }
}

@Injectable()
export class PricingService {
  constructor(private readonly prisma: PrismaService) {}

  async resolvePrice(input: ResolvePriceInput): Promise<PriceResolution> {
    if (
      !(input.requestedAt instanceof Date) ||
      Number.isNaN(input.requestedAt.getTime())
    )
      return manual('INVALID_REQUEST_DATE');

    const service = await this.prisma.service.findFirst({
      where: { id: input.serviceId, active: true },
      select: {
        variants: {
          where: { active: true },
          select: { id: true },
        },
        applicableCategories: { select: { categoryCode: true } },
      },
    });
    if (!service) return manual('SERVICE_NOT_FOUND');

    if (
      input.vehicleCategory !== undefined &&
      input.vehicleCategory !== null &&
      !service.applicableCategories.some(
        ({ categoryCode }) => categoryCode === input.vehicleCategory,
      )
    )
      return manual('SERVICE_NOT_AVAILABLE_FOR_CATEGORY');

    const variantIds = new Set(service.variants.map(({ id }) => id));
    if (variantIds.size > 0 && !input.serviceVariantId)
      return manual('VARIANT_REQUIRED');
    if (input.serviceVariantId && !variantIds.has(input.serviceVariantId))
      return manual('VARIANT_NOT_FOUND');

    const rules = await this.prisma.pricingRule.findMany({
      where: {
        serviceId: input.serviceId,
        status: PricingRuleStatus.ACTIVE,
        effectiveFrom: { lte: input.requestedAt },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: input.requestedAt } }],
      },
      select: RULE_SELECT,
    });

    const candidates = rules.filter((rule) => matchesSelection(rule, input));
    if (candidates.length === 0) {
      if (
        !input.vehicleCategory &&
        rules.some((rule) => rule.vehicleCategoryCode !== null)
      )
        return manual('VEHICLE_CATEGORY_REQUIRED');
      return manual('NO_ACTIVE_RULE');
    }

    const specificity = Math.max(...candidates.map(selectorSpecificity));
    const applicable = candidates.filter(
      (rule) => selectorSpecificity(rule) === specificity,
    );
    if (applicable.length !== 1) return manual('AMBIGUOUS_ACTIVE_RULES');

    const rule = applicable[0];
    if (rule.currency !== 'NGN')
      return manual('RULE_CONFIGURATION_ERROR', rule);

    if (rule.strategy === PricingStrategy.MANUAL_QUOTE)
      return manual('MANUAL_QUOTE_REQUIRED', rule);
    if (rule.strategy === PricingStrategy.MANUAL_REVIEW)
      return manual('MANUAL_REVIEW_REQUIRED', rule);

    if (rule.strategy === PricingStrategy.PERCENTAGE_OF_DECLARED_VALUE) {
      if (
        input.declaredVehicleValue === undefined ||
        input.declaredVehicleValue === null
      )
        return manual('DECLARED_VALUE_REQUIRED', rule);
      let declaredValue: Prisma.Decimal;
      try {
        declaredValue = new Prisma.Decimal(input.declaredVehicleValue);
      } catch {
        return manual('INVALID_DECLARED_VALUE', rule);
      }
      if (!declaredValue.isFinite() || declaredValue.lte(0))
        return manual('INVALID_DECLARED_VALUE', rule);
      if (!rule.percentage || rule.percentage.lte(0) || rule.percentage.gt(100))
        return manual('RULE_CONFIGURATION_ERROR', rule);
      const calculated = declaredValue.mul(rule.percentage).div(100);
      if (calculated.decimalPlaces() > 2)
        return manual('PERCENTAGE_ROUNDING_UNCONFIRMED', rule);
      return {
        resolution: 'AUTO',
        currency: 'NGN',
        amount: calculated.toFixed(2),
        pricingRuleId: rule.id,
        pricingVersion: rule.version,
      };
    }

    if (!rule.amount || rule.amount.lte(0))
      return manual('RULE_CONFIGURATION_ERROR', rule);
    return {
      resolution: 'AUTO',
      currency: 'NGN',
      amount: rule.amount.toFixed(2),
      pricingRuleId: rule.id,
      pricingVersion: rule.version,
    };
  }
}
