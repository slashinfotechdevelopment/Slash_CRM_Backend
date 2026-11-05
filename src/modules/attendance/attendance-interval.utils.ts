export interface TimeInterval {
  start: Date;
  end: Date;
}

/**
 * Validates whether a time interval is non-empty and temporally ordered (start < end).
 */
export function isValidInterval(interval: TimeInterval): boolean {
  return (
    interval &&
    interval.start instanceof Date &&
    interval.end instanceof Date &&
    !isNaN(interval.start.getTime()) &&
    !isNaN(interval.end.getTime()) &&
    interval.start.getTime() < interval.end.getTime()
  );
}

/**
 * Returns the duration in whole seconds between start and end of an interval.
 */
export function intervalDurationSeconds(interval: TimeInterval): number {
  if (!isValidInterval(interval)) return 0;
  return Math.max(
    0,
    Math.floor((interval.end.getTime() - interval.start.getTime()) / 1000),
  );
}

/**
 * Computes the total duration in seconds across an array of disjoint intervals.
 */
export function totalDisjointDurationSeconds(
  intervals: TimeInterval[],
): number {
  return intervals.reduce(
    (sum, interval) => sum + intervalDurationSeconds(interval),
    0,
  );
}

/**
 * Checks whether any two intervals in the array have a non-zero overlap.
 */
export function hasStrictOverlap(intervals: TimeInterval[]): boolean {
  const valid = intervals.filter(isValidInterval);
  if (valid.length < 2) return false;

  const sorted = [...valid].sort(
    (a, b) => a.start.getTime() - b.start.getTime(),
  );

  for (let i = 0; i < sorted.length - 1; i++) {
    const current = sorted[i];
    const next = sorted[i + 1];
    // Strict overlap: next starts before current ends
    if (next.start.getTime() < current.end.getTime()) {
      return true;
    }
  }

  return false;
}

/**
 * Merges overlapping and adjacent time intervals into a minimal list of disjoint canonical intervals.
 */
export function mergeIntervals(intervals: TimeInterval[]): TimeInterval[] {
  const valid = intervals.filter(isValidInterval);
  if (valid.length === 0) return [];

  const sorted = [...valid].sort(
    (a, b) => a.start.getTime() - b.start.getTime(),
  );

  const merged: TimeInterval[] = [];
  let current = {
    start: new Date(sorted[0].start.getTime()),
    end: new Date(sorted[0].end.getTime()),
  };

  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i];
    // Overlapping or contiguous (next.start <= current.end)
    if (next.start.getTime() <= current.end.getTime()) {
      if (next.end.getTime() > current.end.getTime()) {
        current.end = new Date(next.end.getTime());
      }
    } else {
      merged.push(current);
      current = {
        start: new Date(next.start.getTime()),
        end: new Date(next.end.getTime()),
      };
    }
  }

  merged.push(current);
  return merged;
}

/**
 * Computes the geometric intersection between two sets of intervals (A ∩ B).
 * Returns a list of mutually disjoint intervals representing times when both A and B occurred.
 */
export function intersectIntervals(
  setA: TimeInterval[],
  setB: TimeInterval[],
): TimeInterval[] {
  const mergedA = mergeIntervals(setA);
  const mergedB = mergeIntervals(setB);

  if (mergedA.length === 0 || mergedB.length === 0) {
    return [];
  }

  const intersections: TimeInterval[] = [];

  for (const a of mergedA) {
    for (const b of mergedB) {
      const maxStart = Math.max(a.start.getTime(), b.start.getTime());
      const minEnd = Math.min(a.end.getTime(), b.end.getTime());

      if (maxStart < minEnd) {
        intersections.push({
          start: new Date(maxStart),
          end: new Date(minEnd),
        });
      }
    }
  }

  return mergeIntervals(intersections);
}

/**
 * Subtracts subtrahend intervals from source intervals (Source \ Subtrahend).
 * Carves out any segment of source that overlaps with any interval in subtrahend.
 */
export function subtractIntervals(
  source: TimeInterval[],
  subtrahend: TimeInterval[],
): TimeInterval[] {
  const mergedSource = mergeIntervals(source);
  const mergedSubtrahend = mergeIntervals(subtrahend);

  if (mergedSource.length === 0) return [];
  if (mergedSubtrahend.length === 0) return mergedSource;

  const result: TimeInterval[] = [];

  for (const src of mergedSource) {
    let pieces: TimeInterval[] = [src];

    for (const sub of mergedSubtrahend) {
      const nextPieces: TimeInterval[] = [];

      for (const piece of pieces) {
        const pStart = piece.start.getTime();
        const pEnd = piece.end.getTime();
        const sStart = sub.start.getTime();
        const sEnd = sub.end.getTime();

        // No overlap
        if (sEnd <= pStart || sStart >= pEnd) {
          nextPieces.push(piece);
        } else {
          // Left remainder (piece begins before sub)
          if (pStart < sStart) {
            nextPieces.push({
              start: new Date(pStart),
              end: new Date(sStart),
            });
          }
          // Right remainder (piece ends after sub)
          if (pEnd > sEnd) {
            nextPieces.push({
              start: new Date(sEnd),
              end: new Date(pEnd),
            });
          }
        }
      }

      pieces = nextPieces;
    }

    result.push(...pieces);
  }

  return mergeIntervals(result);
}

