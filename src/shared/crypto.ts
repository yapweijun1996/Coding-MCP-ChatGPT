import { timingSafeEqual } from "node:crypto";

// Length-independent constant-time string compare. Returns false (without a
// timing-distinguishable early exit beyond length) when either side is missing
// or lengths differ. Use for any secret/token comparison so a `===` does not
// leak a byte-by-byte match position via timing.
export function constantTimeEqual(left: string | undefined, right: string | undefined): boolean {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}
