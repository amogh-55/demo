import Image from "next/image";
import Link from "next/link";
import {
  CalendarDays,
  Car,
  Clock,
  Droplets,
  Dumbbell,
  Lightbulb,
  MapPin,
  Phone,
  Play,
  QrCode,
  ShieldCheck,
  ShowerHead,
  Sparkles,
  Trophy,
} from "lucide-react";
import { DEFAULT_HOURLY_CONFIG } from "@/lib/booking/service";
import { getPublicCatalog } from "@/lib/catalog";
import { locationCover } from "@/lib/photos";
import { getSettings } from "@/lib/settings";
import { formatMinutes } from "@/lib/time";
import { Button, formatCurrency } from "@/components/ui/primitives";
import { GroundDialog } from "@/components/customer/ground-dialog";
import { GroundsShowcase } from "@/components/customer/grounds-showcase";
import { ScrollToTop, SiteHeader } from "@/components/customer/site-chrome";
import { whatsappUrl } from "@/lib/whatsapp";

/*
 * Built once and served from Vercel's edge cache, not rendered per visit.
 *
 * Nothing on this page depends on who is looking at it, and it was the first
 * thing every customer waited for: a server start and a database read before a
 * single pixel. Any change in the admin panel to a ground, a price or the
 * business details rebuilds it at once (revalidatePath in those routes); the
 * interval is only a backstop for data changed outside the app, by a script.
 */
export const revalidate = 300;

const FACILITIES = [
  { icon: Lightbulb, title: "Floodlights", body: "LED masts with no shadows on the crease. Play as late as you like." },
  { icon: Trophy, title: "Match-grade turf", body: "Artificial grass on a shock-pad base, swept and checked daily." },
  { icon: Car, title: "Free parking", body: "Covered slots for cars and bikes right beside the gate." },
  { icon: ShowerHead, title: "Changing rooms", body: "Lockers, benches and clean washrooms on site." },
  { icon: Droplets, title: "Drinking water", body: "Filtered coolers beside every dugout, refilled through the day." },
  { icon: Dumbbell, title: "Gear on request", body: "Bats, balls, pads and gloves if you turn up empty-handed." },
];

const STEPS = [
  { icon: MapPin, title: "Pick your ground", body: "Choose the turf nearest you." },
  { icon: CalendarDays, title: "Choose date & time", body: "Live availability, by the hour." },
  { icon: QrCode, title: "Pay by UPI", body: "Scan, pay, upload the screenshot." },
  { icon: ShieldCheck, title: "Get confirmed", body: "We verify and confirm on WhatsApp." },
];

export default async function HomePage() {
  const [locations, settings] = await Promise.all([getPublicCatalog(), getSettings()]);

  // Every headline number comes from the same configuration the booking engine
  // uses, so the marketing copy can never drift from what customers are charged.
  const facilities = locations.flatMap((l) => l.facilities);
  const hourlyPrices = facilities.map((f) => f.fromPrice).filter((p): p is number => p !== null);
  const ballPrices = facilities.map((f) => f.fromPricePerBlock).filter((p): p is number => p !== null);
  const prices = [...hourlyPrices, ...ballPrices];
  const minPrice = prices.length ? Math.min(...prices) : DEFAULT_HOURLY_CONFIG.priceRules[0]!.price;
  const maxPrice = prices.length ? Math.max(...prices) : DEFAULT_HOURLY_CONFIG.priceRules.at(-1)!.price;
  const openMin = facilities.length ? Math.min(...facilities.map((f) => f.openMin)) : DEFAULT_HOURLY_CONFIG.openMin;
  const closeMin = facilities.length ? Math.max(...facilities.map((f) => f.closeMin)) : DEFAULT_HOURLY_CONFIG.closeMin;
  const holdMinutes = DEFAULT_HOURLY_CONFIG.holdMinutes;
  const bookingWindowDays = facilities.length
    ? Math.max(...facilities.map((f) => f.bookingWindowDays))
    : DEFAULT_HOURLY_CONFIG.bookingWindowDays;

  // Distinct facility names across every ground: "Box Cricket · Nets · Bowling
  // Machine · Pickleball" rather than a number nobody can picture.
  const facilityNames = [...new Set(facilities.map((f) => f.name))];

  const stats = [
    { value: String(locations.length), label: locations.length === 1 ? "Ground" : "Grounds" },
    { value: `${formatMinutes(openMin).replace(":00", "")}–${formatMinutes(closeMin).replace(":00", "")}`, label: "Open daily" },
    { value: `From ${formatCurrency(minPrice)}`, label: "Starting price" },
    { value: `${holdMinutes} min`, label: "Slot held while you pay" },
  ];

  return (
    <div className="min-h-dvh bg-ink-950">
      <SiteHeader businessName={settings.businessName} supportPhone={settings.supportPhone} />

      <main id="main">
        {/* ── Hero ─────────────────────────────────────────────────────── */}
        <section className="relative isolate overflow-hidden">
          <Image
            src="/images/box.jpg"
            alt=""
            fill
            priority
            sizes="(max-width: 640px) 100vw, 1200px"
            quality={50}
            className="object-cover object-[50%_50%] opacity-[0.7]"
          />
          <div className="absolute inset-0 bg-gradient-to-b from-ink-950/75 via-ink-950/60 to-ink-950" />
          <div className="absolute inset-0 bg-pitch-glow" />

          <div className="container relative py-20 sm:py-28 lg:py-36">
            <p className="eyebrow animate-fade-up">
              <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
              {/* Read from the catalogue rather than written into the copy: adding
                  a facility in the admin panel should change what the front page
                  advertises, without a deploy. */}
              {facilityNames.length > 0 ? facilityNames.join(" · ") : `${locations.length} grounds`}
            </p>

            <h1 className="mt-5 max-w-3xl text-4xl font-extrabold uppercase leading-[0.95] tracking-tight text-white animate-fade-up sm:text-6xl lg:text-7xl">
              Everything a match
              <br />
              <span className="text-lime-400">deserves.</span>
            </h1>

            <p className="mt-6 max-w-xl text-base leading-relaxed text-ink-300 animate-fade-up sm:text-lg">
              Box cricket, nets, bowling machines and pickleball courts — booked online in a minute. Live availability,
              UPI payment and a WhatsApp confirmation, with no account, no app and no phone tag.
            </p>

            <div className="mt-8 flex flex-col gap-3 animate-fade-up sm:flex-row">
              {/* Down to the grounds, not straight to the booking form. Three
                  grounds sell different things, and a customer who lands on the
                  form first has to pick one from a dropdown having never seen
                  what is at any of them. */}
              <a href="#grounds">
                <Button size="lg" className="w-full sm:w-auto">
                  <CalendarDays className="h-5 w-5" aria-hidden="true" />
                  Book Now
                </Button>
              </a>
              {/* The photos are the thing that actually sells a ground, and they
                  are already on this page — so this sends people to them rather
                  than out to WhatsApp. */}
              <a href="#gallery">
                <Button size="lg" variant="secondary" className="w-full sm:w-auto">
                  <Play className="h-5 w-5" aria-hidden="true" />
                  Watch the turf
                </Button>
              </a>
            </div>

            {/* Two columns on a phone leaves ~110px per cell, so the padding and the
                figure both step down rather than letting "From ₹1,200" wrap mid-price. */}
            <dl className="mt-14 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-white/10 bg-white/10 lg:grid-cols-4">
              {stats.map((s) => (
                <div key={s.label} className="bg-ink-950/80 px-3 py-4 text-center sm:px-4 sm:py-5">
                  <dt className="sr-only">{s.label}</dt>
                  <dd>
                    <span className="block break-words text-lg font-bold text-lime-400 sm:text-2xl">{s.value}</span>
                    <span className="mt-1 block text-xs text-ink-400">{s.label}</span>
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        {/* ── Grounds ──────────────────────────────────────────────────── */}
        <section id="grounds" className="container scroll-mt-20 py-16 sm:py-24">
          <p className="eyebrow">Our grounds</p>
          <h2 className="mt-4 text-3xl font-extrabold uppercase tracking-tight text-white sm:text-4xl">
            Pick the turf nearest you
          </h2>
          <p className="mt-3 max-w-xl text-ink-400">Every ground is floodlit, match-ready and open late.</p>

          {locations.length === 0 ? (
            <p className="mt-10 rounded-xl border border-dashed border-white/15 px-6 py-12 text-center text-ink-400">
              No grounds are open for booking right now. Please check back shortly.
            </p>
          ) : (
            <ul className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {locations.map((location) => (
                <li
                  key={location.id}
                  className="group overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03] transition-colors hover:border-lime-400/40"
                >
                  <div className="relative h-48 w-full overflow-hidden bg-ink-900">
                    <Image
                      src={locationCover(location.slug, location.image)}
                      alt={location.name}
                      fill
                      sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
                      className="object-cover transition-transform duration-500 group-hover:scale-105"
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-ink-950 via-transparent to-transparent" />
                  </div>
                  <div className="p-5">
                    {/* Ground names and addresses are customer data — assume the longest. */}
                    <h3 className="break-words text-lg font-bold text-white">{location.name}</h3>
                    <p className="mt-2 flex items-start gap-1.5 break-words text-sm text-ink-400">
                      <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-lime-400" aria-hidden="true" />
                      {location.address}
                    </p>
                    {location.description ? (
                      <p className="mt-3 break-words text-sm text-ink-400">{location.description}</p>
                    ) : null}
                    {/* What this particular ground has. They differ — one sells
                        pickleball and no cricket at all — so listing them per
                        card is the only way a customer knows where to go. */}
                    <ul className="mt-3 flex flex-wrap gap-1.5">
                      {location.facilities.map((f) => (
                        <li
                          key={f.id}
                          className="rounded-full border border-lime-400/25 bg-lime-400/10 px-2.5 py-1 text-xs font-medium text-lime-300"
                        >
                          {f.name}
                          {f.kind === "OVERS" && f.fromPricePerBlock !== null
                            ? ` · from ${formatCurrency(f.fromPricePerBlock)} / ${f.oversPerSlot} overs`
                            : f.fromPrice !== null
                              ? ` · from ${formatCurrency(f.fromPrice)}`
                              : ""}
                        </li>
                      ))}
                    </ul>
                    {/* Opens the services and prices first: the question a
                        customer has at this point is "what do they have and what
                        does it cost", and the answer is one tap away rather than
                        a page load away. */}
                    <div className="mt-5">
                      <GroundDialog location={location} />
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ── Facilities ───────────────────────────────────────────────── */}
        <section id="facilities" className="scroll-mt-20 border-y border-white/10 bg-white/[0.02] py-16 sm:py-24">
          <div className="container">
            <p className="eyebrow">Facilities</p>
            <h2 className="mt-4 text-3xl font-extrabold uppercase tracking-tight text-white sm:text-4xl">
              Built like a pro venue
            </h2>
            <p className="mt-3 max-w-xl text-ink-400">
              Maintained daily so your game never has an excuse.
            </p>

            <ul className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {FACILITIES.map((f) => (
                <li key={f.title} className="rounded-2xl border border-white/10 bg-ink-950 p-5">
                  <span className="mb-4 grid h-11 w-11 place-items-center rounded-xl bg-lime-400/10 text-lime-400">
                    <f.icon className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <h3 className="font-bold text-white">{f.title}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-ink-400">{f.body}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* ── Gallery ──────────────────────────────────────────────────── */}
        <section id="gallery" className="container scroll-mt-20 py-16 sm:py-24">
          <p className="eyebrow">Gallery</p>
          <h2 className="mt-4 text-3xl font-extrabold uppercase tracking-tight text-white sm:text-4xl">
            See it before you play
          </h2>
          <p className="mt-3 max-w-xl text-ink-400">
            Tap a ground to see its photos, what it charges and when it is open.
          </p>

          <GroundsShowcase locations={locations} />
        </section>

        {/* ── How booking works ────────────────────────────────────────── */}
        <section className="border-y border-white/10 bg-white/[0.02] py-16 sm:py-24">
          <div className="container">
            <p className="eyebrow">How it works</p>
            <h2 className="mt-4 text-3xl font-extrabold uppercase tracking-tight text-white sm:text-4xl">
              Booked in two minutes
            </h2>

            <ol className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {STEPS.map((step, i) => (
                <li key={step.title} className="relative rounded-2xl border border-white/10 bg-ink-950 p-5">
                  <span className="absolute right-4 top-4 text-3xl font-black text-white/5">{i + 1}</span>
                  <span className="mb-4 grid h-11 w-11 place-items-center rounded-xl bg-lime-400/10 text-lime-400">
                    <step.icon className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <h3 className="font-bold text-white">{step.title}</h3>
                  <p className="mt-1.5 text-sm text-ink-400">{step.body}</p>
                </li>
              ))}
            </ol>

            <p className="mt-8 flex items-center gap-2 text-sm text-ink-400">
              <Clock className="h-4 w-4 text-lime-400" aria-hidden="true" />
              Your slot is held for {holdMinutes} minutes while you pay, so nobody can take it mid-payment.
            </p>
          </div>
        </section>

        {/* ── Location & contact ───────────────────────────────────────── */}
        <section id="location" className="container scroll-mt-20 py-16 sm:py-24">
          <div className="grid gap-10 lg:grid-cols-2">
            <div>
              <p className="eyebrow">Find us</p>
              <h2 className="mt-4 text-3xl font-extrabold uppercase tracking-tight text-white sm:text-4xl">
                Come and play
              </h2>
              <p className="mt-3 text-ink-400">
                Planning a tournament, a corporate match or a regular weekly slot? Call us and we will sort it out.
              </p>

              <ul className="mt-8 space-y-4">
                {locations.map((l) => (
                  <li key={l.id} className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
                    <p className="break-words font-semibold text-white">{l.name}</p>
                    <p className="mt-1 flex items-start gap-1.5 break-words text-sm text-ink-400">
                      <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-lime-400" aria-hidden="true" />
                      {l.address}
                    </p>
                    <a
                      className="mt-2 inline-flex min-h-[44px] items-center gap-1.5 text-sm font-medium text-lime-400 hover:underline"
                      // The owner's own Maps pin when they have given one — a
                      // search on name and address can land on the wrong place.
                      href={l.mapsUrl || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${l.name} ${l.address}`)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Get directions →
                    </a>
                  </li>
                ))}
              </ul>

              {settings.supportPhone ? (
                <a
                  href={`tel:+91${settings.supportPhone}`}
                  className="mt-6 inline-flex min-h-[44px] items-center gap-2 text-lg font-bold text-white hover:text-lime-400"
                >
                  <Phone className="h-5 w-5 text-lime-400" aria-hidden="true" />
                  +91 {settings.supportPhone}
                </a>
              ) : null}
            </div>

            <div className="relative min-h-[320px] overflow-hidden rounded-2xl border border-white/10">
              <Image
                src="/images/boxpeople.jpg"
                alt="A group of players on the turf after their game"
                fill
                sizes="(max-width: 1024px) 100vw, 50vw"
                className="object-cover"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-ink-950 via-ink-950/20 to-transparent" />
              <div className="absolute inset-x-0 bottom-0 p-6">
                <p className="text-sm text-ink-300">Open daily</p>
                <p className="text-2xl font-bold text-white">
                  {formatMinutes(openMin)} – {formatMinutes(closeMin)}
                </p>
                <p className="mt-1 text-sm text-ink-400">
                  {formatCurrency(minPrice)}–{formatCurrency(maxPrice)} per hour · book up to {bookingWindowDays} days ahead
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* ── FAQ / assistant prompt ───────────────────────────────────── */}
        <section id="faq" className="scroll-mt-20 border-t border-white/10 bg-white/[0.02] py-16 sm:py-24">
          <div className="container text-center">
            <p className="eyebrow mx-auto">Questions</p>
            <h2 className="mt-4 text-3xl font-extrabold uppercase tracking-tight text-white sm:text-4xl">
              Anything you want to know
            </h2>
            <p className="mx-auto mt-3 max-w-lg text-ink-400">
              Tap the chat button for instant answers on prices, timings and how booking works — or message the team
              directly.
            </p>
            <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
              <Link href="/book">
                <Button size="lg" className="w-full sm:w-auto">
                  Book a slot
                </Button>
              </Link>
              {settings.whatsappNumber ? (
                <a
                  href={whatsappUrl(settings.whatsappNumber, `Hi ${settings.businessName}, I have a question.`)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Button size="lg" variant="whatsapp" className="w-full sm:w-auto">
                    Message us
                  </Button>
                </a>
              ) : null}
            </div>
          </div>
        </section>
      </main>

      {/* The sticky book bar is fixed over the last ~72px of the page, so the footer
          buys itself room to sit clear of it on phones. */}
      <footer className="border-t border-white/10 pb-[calc(6rem_+_env(safe-area-inset-bottom))] pt-10 lg:pb-10">
        <div className="container flex flex-col gap-4 text-sm text-ink-500 sm:flex-row sm:items-center sm:justify-between">
          <p>
            © {new Date().getFullYear()} {settings.businessName}
          </p>
          <div className="-my-2 flex flex-wrap items-center gap-x-5">
            <a href="#grounds" className="py-2 hover:text-ink-300">
              Grounds
            </a>
            <a href="#facilities" className="py-2 hover:text-ink-300">
              Facilities
            </a>
            <Link href="/admin" className="py-2 hover:text-ink-300">
              Staff login
            </Link>
          </div>
        </div>
      </footer>

      <ScrollToTop />
    </div>
  );
}
