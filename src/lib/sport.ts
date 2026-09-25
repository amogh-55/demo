/**
 * A glance-able mark for what is being played. Emoji, so it costs no asset and
 * reads the same on the owner's phone as anywhere else. Kept out of any client
 * file so the server-rendered dashboard can use it too.
 */
export function sportEmoji(facilityName: string): string {
  return /pickle|tennis|badminton/i.test(facilityName) ? "🏓" : "🏏";
}
