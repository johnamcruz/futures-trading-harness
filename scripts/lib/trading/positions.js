'use strict';

/**
 * Reading a broker's positions without ever mistaking bad data for a flat
 * account. A position's size must be a whole number of contracts, 0 or more;
 * anything else (missing, null, a fraction, negative, a string that isn't a
 * number) is unknown:
 *
 *   positionSize(p)  the size, or throws (the order gate fails closed on it)
 *   signedSize(p)    long +, short -, or throws (unknown type or size)
 *   isOpen(p)        true for a position of size > 0, or of unknown size:
 *                    the runner manages, protects and flattens it rather
 *                    than reading it as flat
 */

const SIGN = { 1: 1, 2: -1 };

function positionSize(p) {
  const raw = p ? p.size : undefined;
  // A number, or a string of digits: never a coerced blank, boolean, list, or hex.
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`position ${p && p.contractId ? p.contractId : '?'} has no valid size (${JSON.stringify(raw)}): the account can't be read`);
  }
  return n;
}

function signedSize(p) {
  const sign = SIGN[p && p.type];
  if (sign === undefined) throw new Error(`position with unknown type ${JSON.stringify(p && p.type)}`);
  return sign * positionSize(p);
}

function isOpen(p) {
  try {
    return positionSize(p) > 0;
  } catch (_err) {
    return true;
  }
}

module.exports = { positionSize, signedSize, isOpen };
