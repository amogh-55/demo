/**
 * Stock photos for the services and the per-ground gallery.
 *
 * PLACEHOLDERS. These are the sample images that ship in `public/images`, picked
 * so a customer sees something recognisable next to "Bowling Machine" instead of
 * a grey box. Replace the files with the owner's own photos of each ground and
 * nothing here needs to change — the names are what the pages reference.
 *
 * Deliberately a plain lookup rather than a database field: the owner has not
 * sent real photos yet, and an admin uploader for images nobody has is work that
 * would be thrown away. Add it when the photos arrive.
 */

/** Matched on the facility slug, which is stable; the name is the owner's to edit. */
const FACILITY_PHOTOS: Record<string, string> = {
  "box-cricket": "/images/box-cricket-turf.jpg",
  nets: "/images/batsman-action.jpg",
  "bowling-machine": "/images/bowler-action.jpg",
  pickleball: "/images/cricket-sunset.jpg",
};

const FALLBACK_PHOTO = "/images/floodlight-turf.jpg";

export function facilityPhoto(slug: string): string {
  return FACILITY_PHOTOS[slug] ?? FALLBACK_PHOTO;
}

export interface GalleryPhoto {
  src: string;
  alt: string;
}

/** Four photos per ground, so each tab of the gallery looks like its own place. */
const LOCATION_PHOTOS: Record<string, GalleryPhoto[]> = {
  medipally: [
    { src: "/images/floodlight-turf.jpg", alt: "Floodlit turf at night" },
    { src: "/images/box-cricket-turf.jpg", alt: "Box cricket turf" },
    { src: "/images/batsman-action.jpg", alt: "Batsman playing a shot in the nets" },
    { src: "/images/ball-closeup.jpg", alt: "Cricket ball on the turf" },
  ],
  vanasthalipuram: [
    { src: "/images/bowler-action.jpg", alt: "Bowling machine lane" },
    { src: "/images/cricket-action-3.jpg", alt: "Batting practice" },
    { src: "/images/hero-turf-action.jpg", alt: "Players mid-session" },
    { src: "/images/fitness-training.jpg", alt: "Warm-up area" },
  ],
  pickleball: [
    { src: "/images/cricket-sunset.jpg", alt: "Court under evening light" },
    { src: "/images/cricket-stadium.jpg", alt: "Courts from the stands" },
    { src: "/images/cafe-lounge.jpg", alt: "Seating and lounge" },
    { src: "/images/floodlight-turf.jpg", alt: "Floodlights over the courts" },
  ],
};

/** A ground the owner adds later still gets a gallery rather than an empty tab. */
const GENERIC_PHOTOS: GalleryPhoto[] = [
  { src: "/images/hero-turf-action.jpg", alt: "Match in play" },
  { src: "/images/floodlight-turf.jpg", alt: "Floodlit turf at night" },
  { src: "/images/cricket-action-3.jpg", alt: "Players mid-match" },
  { src: "/images/cafe-lounge.jpg", alt: "Seating and lounge" },
];

export function locationPhotos(slug: string): GalleryPhoto[] {
  return LOCATION_PHOTOS[slug] ?? GENERIC_PHOTOS;
}
