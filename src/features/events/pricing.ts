import type { SupportedCurrency } from "@/config/site";

interface PricingSeat {
  state: "ACTIVE" | "BLOCKED";
}

export interface PricingSection {
  id: string;
  name: string;
  code: string;
  rows: Array<{ seats: PricingSeat[] }>;
}

export interface PricingTier {
  id: string;
  name: string;
  code: string;
  priceMinor: number;
  currency: SupportedCurrency;
}

export interface SectionAssignment {
  sectionId: string;
  priceTierId: string;
}

export function calculatePricingCoverage(
  sections: PricingSection[],
  tiers: PricingTier[],
  assignments: SectionAssignment[],
) {
  const tierById = new Map(tiers.map((tier) => [tier.id, tier]));
  const sectionById = new Map(sections.map((section) => [section.id, section]));
  const assignmentBySection = new Map<string, SectionAssignment>();
  const issues: string[] = [];

  for (const assignment of assignments) {
    if (assignmentBySection.has(assignment.sectionId)) {
      issues.push("A section can have at most one price tier for a session.");
    }
    assignmentBySection.set(assignment.sectionId, assignment);

    if (!sectionById.has(assignment.sectionId)) {
      issues.push("A pricing assignment references a section from another seat map.");
    }
    if (!tierById.has(assignment.priceTierId)) {
      issues.push("A pricing assignment references a tier from another session.");
    }
  }

  const capacities = sections.map((section) => {
    const sellable = section.rows.reduce(
      (total, row) =>
        total + row.seats.filter((seat) => seat.state === "ACTIVE").length,
      0,
    );
    const blocked = section.rows.reduce(
      (total, row) =>
        total + row.seats.filter((seat) => seat.state === "BLOCKED").length,
      0,
    );
    const assignment = assignmentBySection.get(section.id);

    if (sellable > 0 && !assignment) {
      issues.push(`Section ${section.code} has sellable seats without a price tier.`);
    }

    return {
      sectionId: section.id,
      sectionName: section.name,
      sectionCode: section.code,
      sellable,
      blocked,
      priceTierId: assignment?.priceTierId ?? null,
    };
  });

  const tierCapacities = tiers.map((tier) => ({
    ...tier,
    sellableCapacity: capacities
      .filter((section) => section.priceTierId === tier.id)
      .reduce((total, section) => total + section.sellable, 0),
  }));
  const currencies = new Set(tiers.map((tier) => tier.currency));

  if (tiers.some((tier) => tier.priceMinor < 0)) {
    issues.push("Ticket prices cannot be negative.");
  }
  if (currencies.size > 1) {
    issues.push("All price tiers in a session must use the same currency.");
  }

  const totalSellable = capacities.reduce(
    (total, section) => total + section.sellable,
    0,
  );
  const pricedSellable = capacities
    .filter((section) => section.priceTierId && tierById.has(section.priceTierId))
    .reduce((total, section) => total + section.sellable, 0);

  return {
    sections: capacities,
    tiers: tierCapacities,
    totalSellable,
    pricedSellable,
    unpricedSellable: totalSellable - pricedSellable,
    minimumPriceMinor:
      tiers.length > 0 ? Math.min(...tiers.map((tier) => tier.priceMinor)) : null,
    currency: currencies.size === 1 ? (tiers[0]?.currency ?? null) : null,
    issues: [...new Set(issues)],
  };
}
