interface SessionRange {
  startAt: Date;
  endAt: Date;
}

export function sessionRangesOverlap(
  first: SessionRange,
  second: SessionRange,
) {
  return first.startAt < second.endAt && first.endAt > second.startAt;
}
