/**
 * The photos for the services and the per-ground gallery.
 *
 * box*, machine*, nets and pickleball are the owner's own photographs of the
 * three grounds. The rest are the stock images this site shipped with; they are
 * kept on behind the real ones so each gallery still fills out, and so a ground
 * the owner adds later is never an empty tab.
 *
 * All of them are JPEG at 2000px on the long edge. The phone originals were
 * 3-5 MB PNGs each, which is a lossless format for photographs: the gallery
 * alone was 22 MB, and on a mobile connection that is a gallery that does not
 * load.
 *
 * Deliberately a plain lookup rather than a database field: there is no image
 * uploader in the admin panel, and building one for photos that arrive by
 * WhatsApp twice a year is work that would be thrown away. Drop a file into
 * `public/images` and add a line here.
 */

/** Matched on the facility slug, which is stable; the name is the owner's to edit. */
const FACILITY_PHOTOS: Record<string, string> = {
  "box-cricket": "/images/boxnight.jpg",
  nets: "/images/nets.jpg",
  "bowling-machine": "/images/machine.jpg",
  pickleball: "/images/pickleball.jpg",
};

const FALLBACK_PHOTO = "/images/floodlight-turf.jpg";

export function facilityPhoto(slug: string): string {
  return FACILITY_PHOTOS[slug] ?? FALLBACK_PHOTO;
}

export interface GalleryPhoto {
  src: string;
  alt: string;
}

/**
 * Each ground's gallery: the owner's own photographs first, then the stock
 * images behind them.
 *
 * The first one is also the cover used on the ground cards and the picker
 * thumbnail, so whatever leads this list is the photo that sells the ground.
 */
const LOCATION_PHOTOS: Record<string, GalleryPhoto[]> = {
  medipally: [
    { src: "/images/boxnight.jpg", alt: "Box cricket under the floodlights" },
    { src: "/images/boxpeople.jpg", alt: "A side after their game on the turf" },
    { src: "/images/box.jpg", alt: "The box cricket turf by day" },
    { src: "/images/nets.jpg", alt: "Batting in the practice nets" },
    { src: "/images/machine.jpg", alt: "The bowling machine set up at the net" },
    { src: "/images/box2.jpg", alt: "The cage from outside" },
    { src: "/images/floodlight-turf.jpg", alt: "Floodlit turf at night" },
    { src: "/images/box-cricket-turf.jpg", alt: "Box cricket turf" },
    { src: "/images/batsman-action.jpg", alt: "Batsman playing a shot in the nets" },
    { src: "/images/ball-closeup.jpg", alt: "Cricket ball on the turf" },
  ],
  vanasthalipuram: [
    { src: "/images/machine.jpg", alt: "The bowling machine set up at the net" },
    { src: "/images/machine2.jpg", alt: "Loading the machine, balls down the lane" },
    { src: "/images/nets.jpg", alt: "The practice net" },
    { src: "/images/bowler-action.jpg", alt: "Bowling machine lane" },
    { src: "/images/hero-turf-action.jpg", alt: "Players mid-session" },
  ],
  pickleball: [
    { src: "/images/pickleball.jpg", alt: "Both courts under the floodlights" },
    { src: "/images/cricket-sunset.jpg", alt: "Court under evening light" },
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

/**
 * The one photo that represents a ground — its card on the home page, its
 * thumbnail in the booking form.
 *
 * Ground photos are set here in code, not in the admin panel. An image saved on
 * a ground before that still wins; otherwise the gallery's first photo stands in,
 * so a new ground shows a real picture rather than a grey box.
 */
export function locationCover(slug: string, ownerImage?: string): string {
  return ownerImage?.trim() || locationPhotos(slug)[0]?.src || FALLBACK_PHOTO;
}

/**
 * The UPI QR customers scan on the payment step. Put the image in public/images
 * and set its path here, e.g. "/images/upi-qr.png". Blank shows the UPI ID only.
 */
export const UPI_QR_IMAGE = "";
