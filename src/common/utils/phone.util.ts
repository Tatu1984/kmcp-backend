/**
 * Puts a mobile number into the one shape an account is stored and found by.
 *
 * Sign-in has always normalised: `LoginSchema` and `OtpRequestSchema` both take
 * `9433361718` and look the account up as `+919433361718`. Nothing that *made*
 * an account did the same — `CreateAttendantSchema` and the user schemas
 * validated the shape of a number and then stored whatever was typed. So an
 * officer registering an attendant as `9433361718` created a real, working
 * account with a real password hash that could never be signed into: the
 * handset sent the same ten digits, sign-in turned them into `+919433361718`,
 * and no row had that number. The account looked correct from every screen and
 * refused every password, which is the hardest kind of wrong to diagnose —
 * "the mobile number and password did not match" is true, and says nothing
 * about which of the two is at fault.
 *
 * Normalising at the point of creation is what makes the two agree. E.164 is
 * the target: a leading `+` and country code, no spaces or punctuation.
 */
export function normalisePhone(raw: string): string {
  const value = raw.trim();

  // Already E.164 — the officer typed the country code, keep their intent.
  if (value.startsWith("+")) return value;

  /**
   * A bare Indian mobile, which is what almost every number typed into this
   * platform is: ten digits opening 6-9. This is the exact case sign-in
   * already assumes, so it has to resolve the same way here.
   */
  if (/^[6-9]\d{9}$/.test(value)) return `+91${value}`;

  /**
   * Anything else that got past the field's own pattern is a plausible
   * international number missing only its plus — `919433361718`, say. Give it
   * one rather than storing a second shape of the same number.
   */
  return `+${value}`;
}
