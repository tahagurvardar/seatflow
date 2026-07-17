import { describe, expect, it } from "vitest";

import { calculateSeatMapCapacity } from "../src/features/seat-maps/capacity";
import { validateSeatMapForPublication } from "../src/features/seat-maps/publication-validation";
import { generateRowLabels, numberToRowLabel, rowLabelToNumber } from "../src/features/seat-maps/row-labels";

describe("seat-map row labels", () => {
  it("increments labels across alphabet boundaries", () => {
    expect(rowLabelToNumber("Z")).toBe(26);
    expect(numberToRowLabel(27)).toBe("AA");
    expect(generateRowLabels("Y", 4)).toEqual(["Y", "Z", "AA", "AB"]);
  });
});

describe("seat-map capacity", () => {
  it("counts physical, sellable, blocked, and typed capacity", () => {
    const result = calculateSeatMapCapacity({
      sections: [{ rows: [{ seats: [
        { type: "STANDARD", state: "ACTIVE" },
        { type: "ACCESSIBLE", state: "ACTIVE" },
        { type: "COMPANION", state: "BLOCKED" },
        { type: "PREMIUM", state: "BLOCKED" },
      ] }] }],
    });

    expect(result).toMatchObject({ total: 4, sellable: 2, blocked: 2 });
    expect(result.byType.ACCESSIBLE).toEqual({ total: 1, sellable: 1, blocked: 0 });
    expect(result.byType.PREMIUM).toEqual({ total: 1, sellable: 0, blocked: 1 });
  });
});

describe("publication validation", () => {
  it("rejects incomplete, overlapping, and inaccessible companion layouts", () => {
    const issues = validateSeatMapForPublication({
      sections: [{
        name: "Main",
        code: "MAIN",
        displayOrder: 0,
        rows: [{
          label: "A",
          displayOrder: 0,
          seats: [
            { label: "1", displayOrder: 0, x: 0, y: 0, type: "COMPANION", state: "ACTIVE" },
            { label: "2", displayOrder: 1, x: 0, y: 0, type: "STANDARD", state: "ACTIVE" },
          ],
        }],
      }],
    });

    expect(issues).toContain("Section MAIN contains overlapping seat coordinates.");
    expect(issues).toContain("Row MAIN-A needs at least one accessible seat for each companion seat.");
  });

  it("accepts a complete accessible layout", () => {
    expect(validateSeatMapForPublication({
      sections: [{
        name: "Main",
        code: "MAIN",
        displayOrder: 0,
        rows: [{
          label: "A",
          displayOrder: 0,
          seats: [
            { label: "1", displayOrder: 0, x: 0, y: 0, type: "ACCESSIBLE", state: "ACTIVE" },
            { label: "2", displayOrder: 1, x: 40, y: 0, type: "COMPANION", state: "ACTIVE" },
          ],
        }],
      }],
    })).toEqual([]);
  });
});
