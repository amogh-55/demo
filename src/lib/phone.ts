/**
 * The bare 10-digit Indian mobile number in what someone typed, or null.
 *
 * Takes it however it arrives — +91, 91, 0 or 00 in front, spaces, dashes,
 * dots, brackets — because that is how people read numbers out. Shared by the
 * server's schema and the admin's phone form, so the form can say "not a valid
 * number" for exactly the numbers the server would refuse.
 */
export function tenDigitMobile(raw: string): string | null {
  const digits = raw.trim().replace(/[\s()\-.]/g, "").replace(/^\+/, "").replace(/^00/, "");
  const bare = /^91\d{10}$/.test(digits) ? digits.slice(2) : /^0\d{10}$/.test(digits) ? digits.slice(1) : digits;
  return /^[6-9]\d{9}$/.test(bare) ? bare : null;
}
