/**
 * The name each ground trades under, shown as its title on the home page.
 *
 * Only there: the location name in settings also goes on the booking page,
 * receipts and the admin panel, where the area is what staff and customers go
 * by. Matched on the slug, which is stable; a ground not listed here shows its
 * settings name.
 */
const TITLES: Record<string, string> = {
  medipally: "Spirit Cricket Zone",
  pickleball: "Gen Alpha Pickleball Courts", // Uppal
  vanasthalipuram: "The Cricket Garage",
};

export function groundTitle(location: { slug: string; name: string }): string {
  return TITLES[location.slug] ?? location.name;
}
