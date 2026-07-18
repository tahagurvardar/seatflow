const localDateTimePattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

interface DateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function parseLocalDateTime(value: string): DateTimeParts {
  const match = localDateTimePattern.exec(value);
  if (!match) throw new Error("Use a valid local date and time.");

  const parts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
  };
  const check = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute),
  );

  if (
    check.getUTCFullYear() !== parts.year ||
    check.getUTCMonth() !== parts.month - 1 ||
    check.getUTCDate() !== parts.day ||
    check.getUTCHours() !== parts.hour ||
    check.getUTCMinutes() !== parts.minute
  ) {
    throw new Error("Use a real calendar date and time.");
  }

  return parts;
}

function partsInTimeZone(date: Date, timeZone: string): DateTimeParts {
  const entries = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(entries.find((entry) => entry.type === type)?.value);

  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
  };
}

function sameParts(first: DateTimeParts, second: DateTimeParts) {
  return (
    first.year === second.year &&
    first.month === second.month &&
    first.day === second.day &&
    first.hour === second.hour &&
    first.minute === second.minute
  );
}

function offsetAt(date: Date, timeZone: string) {
  const local = partsInTimeZone(date, timeZone);
  return (
    Date.UTC(
      local.year,
      local.month - 1,
      local.day,
      local.hour,
      local.minute,
    ) - date.getTime()
  );
}

export function zonedLocalDateTimeToUtc(value: string, timeZone: string) {
  const local = parseLocalDateTime(value);
  const localAsUtc = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
  );
  let candidate = new Date(localAsUtc);

  for (let iteration = 0; iteration < 3; iteration += 1) {
    candidate = new Date(localAsUtc - offsetAt(candidate, timeZone));
  }

  if (!sameParts(partsInTimeZone(candidate, timeZone), local)) {
    throw new Error(
      "That local time does not exist in the venue time zone because of a clock change.",
    );
  }

  return candidate;
}

export function toVenueLocalInputValue(date: Date, timeZone: string) {
  const parts = partsInTimeZone(date, timeZone);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}

export function formatVenueDateTime(
  date: Date | string,
  timeZone: string,
  locale = "en-GB",
) {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(date));
}
