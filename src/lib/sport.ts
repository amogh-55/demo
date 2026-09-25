/**
 * A glance-able mark for what is being played. Emoji, so it costs no asset and
 * reads the same on the owner's phone as anywhere else. Kept out of any client
 * file so the server-rendered dashboard can use it too.
 *
 * One mark per service: box cricket, the nets and the bowling machine are all
 * cricket, and one bat for all three made them look like the same booking.
 * Matched on the name, most specific first — "Bowling Machine Nets" is a machine.
 */
export function sportEmoji(facilityName: string): string {
  if (/pickle|tennis|badminton/i.test(facilityName)) return "🏓";
  if (/bowling|machine/i.test(facilityName)) return "⚾";
  if (/\bnets?\b/i.test(facilityName)) return "🥅";
  return "🏏";
}
