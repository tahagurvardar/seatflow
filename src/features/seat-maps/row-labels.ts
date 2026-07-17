const ALPHABET_SIZE = 26;

export function rowLabelToNumber(label: string) {
  const normalized = label.trim().toUpperCase();

  if (!/^[A-Z]{1,3}$/.test(normalized)) {
    throw new Error("Row labels must contain one to three letters.");
  }

  return [...normalized].reduce(
    (value, character) => value * ALPHABET_SIZE + character.charCodeAt(0) - 64,
    0,
  );
}

export function numberToRowLabel(value: number) {
  if (!Number.isInteger(value) || value < 1 || value > 18_278) {
    throw new Error("Row label number is outside the supported A-ZZZ range.");
  }

  let remainder = value;
  let label = "";

  while (remainder > 0) {
    remainder -= 1;
    label = String.fromCharCode(65 + (remainder % ALPHABET_SIZE)) + label;
    remainder = Math.floor(remainder / ALPHABET_SIZE);
  }

  return label;
}

export function generateRowLabels(startLabel: string, count: number) {
  const start = rowLabelToNumber(startLabel);
  return Array.from({ length: count }, (_, index) => numberToRowLabel(start + index));
}

export function generateSeatLabels(startNumber: number, count: number) {
  if (!Number.isInteger(startNumber) || startNumber < 1 || startNumber > 9_999) {
    throw new Error("The first seat number must be between 1 and 9999.");
  }

  if (!Number.isInteger(count) || count < 1 || startNumber + count - 1 > 9_999) {
    throw new Error("Generated seat labels must stay inside the 1-9999 range.");
  }

  return Array.from({ length: count }, (_, index) => String(startNumber + index));
}
