"use client";

import * as React from "react";
import Link from "next/link";
import { MessageCircle, Send, X } from "lucide-react";
import { Button, cn, formatCurrency } from "@/components/ui/primitives";
import { formatMinutes } from "@/lib/time";

export interface AssistantFacts {
  businessName: string;
  supportPhone: string;
  whatsappNumber: string;
  grounds: Array<{ name: string; address: string }>;
  openMin: number;
  closeMin: number;
  minPrice: number;
  maxPrice: number;
  holdMinutes: number;
  bookingWindowDays: number;
  upiId: string;
}

interface Topic {
  id: string;
  question: string;
  keywords: string[];
  answer: (f: AssistantFacts) => React.ReactNode;
}

/**
 * A keyword-matched FAQ, not a language model.
 *
 * Every answer is generated from the same facts the booking engine uses — real
 * grounds, real opening hours, real prices — so it cannot quote a price the turf
 * does not charge. Anything it does not recognise is handed to a human rather
 * than guessed at.
 */
const TOPICS: Topic[] = [
  {
    id: "price",
    question: "What does it cost?",
    keywords: ["price", "cost", "rate", "charge", "fee", "rupee", "money", "how much", "pricing"],
    answer: (f) => (
      <>
        Slots run from <strong>{formatCurrency(f.minPrice)}</strong> to <strong>{formatCurrency(f.maxPrice)}</strong> per
        hour depending on the time of day — mornings are cheapest, evenings peak. A two-hour booking is simply the two
        hours added together. The exact price for any slot shows on the booking page before you pay.
      </>
    ),
  },
  {
    id: "timing",
    question: "What are your timings?",
    keywords: ["time", "timing", "open", "close", "hour", "morning", "night", "late", "early", "when"],
    answer: (f) => (
      <>
        We are open <strong>{formatMinutes(f.openMin)} to {formatMinutes(f.closeMin)}</strong> every day, floodlights on
        after dark. You can book up to <strong>{f.bookingWindowDays} days</strong> ahead.
      </>
    ),
  },
  {
    id: "book",
    question: "How do I book?",
    keywords: ["book", "booking", "reserve", "slot", "how do i", "process"],
    answer: (f) => (
      <>
        Pick a ground, a date and your hours, then pay by UPI and upload the payment screenshot. No account needed. Your
        slot is held for <strong>{f.holdMinutes} minutes</strong> while you pay, so nobody can take it from under you. We
        verify the payment and confirm on WhatsApp.
      </>
    ),
  },
  {
    id: "payment",
    question: "How do I pay?",
    keywords: ["pay", "payment", "upi", "gpay", "phonepe", "paytm", "cash", "card", "online"],
    answer: (f) => (
      <>
        Payment is by <strong>UPI</strong>{f.upiId ? <> to <strong>{f.upiId}</strong></> : null} — scan the QR on the
        booking page with any UPI app, then upload the screenshot. Your booking is confirmed once we have checked the
        payment.
      </>
    ),
  },
  {
    id: "location",
    question: "Where are you?",
    keywords: ["where", "location", "address", "reach", "direction", "map", "near", "ground", "branch"],
    answer: (f) => (
      <>
        We have {f.grounds.length} ground{f.grounds.length === 1 ? "" : "s"}:
        <ul className="mt-2 space-y-1.5">
          {f.grounds.map((g) => (
            <li key={g.name}>
              <strong>{g.name}</strong>
              <br />
              <span className="text-ink-400">{g.address}</span>
            </li>
          ))}
        </ul>
      </>
    ),
  },
  {
    id: "cancel",
    question: "Can I cancel or reschedule?",
    keywords: ["cancel", "reschedule", "refund", "change", "postpone", "move"],
    answer: (f) => (
      <>
        Cancellations and changes are handled by our team directly — message or call us on{" "}
        <strong>+91 {f.supportPhone}</strong> with your booking reference and we will sort it out.
      </>
    ),
  },
  {
    id: "facilities",
    question: "What is at the ground?",
    keywords: ["facility", "facilities", "parking", "washroom", "toilet", "water", "bat", "ball", "equipment", "light", "floodlight", "cafe", "food"],
    answer: () => (
      <>
        Floodlights, changing rooms, clean washrooms, drinking water, free parking and bats, balls and pads on request.
        There is seating for players waiting their turn.
      </>
    ),
  },
  {
    id: "players",
    question: "How many players fit?",
    keywords: ["player", "people", "team", "how many", "size", "capacity", "box cricket"],
    answer: () => (
      <>
        The grounds are set up for box cricket — comfortable for two teams of six to eight, and fine for a smaller
        practice session too.
      </>
    ),
  },
];

interface Message {
  from: "bot" | "user";
  node: React.ReactNode;
}

function findTopic(text: string): Topic | null {
  const q = text.toLowerCase();
  let best: { topic: Topic; score: number } | null = null;
  for (const topic of TOPICS) {
    const score = topic.keywords.reduce((n, k) => (q.includes(k) ? n + k.length : n), 0);
    if (score > 0 && (!best || score > best.score)) best = { topic, score };
  }
  return best?.topic ?? null;
}

export function TurfAssistant({ facts }: { facts: AssistantFacts }) {
  const [open, setOpen] = React.useState(false);
  const [input, setInput] = React.useState("");
  const [messages, setMessages] = React.useState<Message[]>([
    {
      from: "bot",
      node: (
        <>
          Hi! Ask me about prices, timings, how booking works or where the grounds are. For anything else I will point
          you to the team.
        </>
      ),
    },
  ]);
  const endRef = React.useRef<HTMLDivElement>(null);
  const [keyboardInset, setKeyboardInset] = React.useState(0);

  React.useEffect(() => {
    if (open) endRef.current?.scrollIntoView({ block: "nearest" });
  }, [messages, open]);

  /**
   * A phone keyboard overlays the viewport instead of shrinking it, so a panel
   * pinned to the bottom ends up behind it the moment someone types. visualViewport
   * reports how much is covered; the panel lifts by that much and shortens to match.
   */
  React.useEffect(() => {
    const viewport = window.visualViewport;
    if (!open || !viewport) return;
    const measure = () =>
      setKeyboardInset(Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop));
    measure();
    viewport.addEventListener("resize", measure);
    viewport.addEventListener("scroll", measure);
    return () => {
      viewport.removeEventListener("resize", measure);
      viewport.removeEventListener("scroll", measure);
    };
  }, [open]);

  function ask(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    const topic = findTopic(trimmed);

    setMessages((m) => [
      ...m,
      { from: "user", node: trimmed },
      {
        from: "bot",
        node: topic ? (
          topic.answer(facts)
        ) : (
          // Never invent an answer about someone's business.
          <>
            I do not have an answer for that one. Message the team on WhatsApp or call{" "}
            <strong>+91 {facts.supportPhone}</strong> — they will know.
          </>
        ),
      },
    ]);
    setInput("");
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="turf-assistant-panel"
        className={cn(
          // Clears the StickyBookBar (72px) on phones and the home indicator everywhere.
          "fixed right-4 z-40 grid h-14 w-14 place-items-center rounded-full shadow-lg transition-transform",
          "bottom-[calc(5rem_+_env(safe-area-inset-bottom))] lg:bottom-[calc(1.5rem_+_env(safe-area-inset-bottom))]",
          "bg-lime-400 text-ink-950 hover:scale-105",
        )}
      >
        {open ? <X className="h-6 w-6" /> : <MessageCircle className="h-6 w-6" />}
        <span className="sr-only">{open ? "Close" : "Open"} the turf assistant</span>
      </button>

      {open ? (
        <div
          id="turf-assistant-panel"
          role="dialog"
          aria-label="Turf assistant"
          style={{ "--keyboard-inset": `${keyboardInset}px` } as React.CSSProperties}
          className={cn(
            "fixed right-4 z-40 flex w-[calc(100vw_-_2rem)] max-w-sm flex-col overflow-hidden rounded-2xl border border-white/10 bg-ink-900 shadow-2xl",
            // Sits above the floating button, and rides up with the keyboard.
            "bottom-[calc(9rem_+_env(safe-area-inset-bottom)_+_var(--keyboard-inset))]",
            "lg:bottom-[calc(5.5rem_+_env(safe-area-inset-bottom))]",
            // Whatever is left of the screen above it, floored so the composer is
            // never clipped away on a very short viewport.
            "max-h-[max(13rem,calc(100dvh_-_10rem_-_env(safe-area-inset-bottom)_-_var(--keyboard-inset)))] lg:max-h-[70dvh]",
          )}
        >
          <div className="shrink-0 border-b border-white/10 px-4 py-3">
            <p className="truncate font-semibold text-white">{facts.businessName}</p>
            <p className="text-xs text-ink-400">Quick answers · not a live person</p>
          </div>

          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3 text-sm">
            {messages.map((m, i) => (
              <div
                key={i}
                className={cn(
                  // break-words: a UPI id or a ground address is one unbreakable word.
                  "max-w-[85%] break-words rounded-xl px-3 py-2",
                  m.from === "bot" ? "bg-white/5 text-ink-200" : "ml-auto bg-lime-400 text-ink-950",
                )}
              >
                {m.node}
              </div>
            ))}
            <div ref={endRef} />
          </div>

          <div className="shrink-0 border-t border-white/10 px-3 py-2">
            <div className="mb-2 flex flex-wrap gap-1.5">
              {TOPICS.slice(0, 4).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => ask(t.question)}
                  className="rounded-full border border-white/10 px-3 py-2 text-sm text-ink-300 hover:bg-white/5 hover:text-white"
                >
                  {t.question}
                </button>
              ))}
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                ask(input);
              }}
              className="flex gap-2"
            >
              <label className="sr-only" htmlFor="assistant-input">
                Ask a question
              </label>
              {/* Keeps .field-input's 16px text: anything smaller makes iOS zoom in on focus. */}
              <input
                id="assistant-input"
                className="field-input h-11 min-w-0 py-0"
                placeholder="Ask about prices, timings…"
                value={input}
                onChange={(e) => setInput(e.target.value)}
              />
              <Button type="submit" size="sm" className="h-11 shrink-0 px-4" disabled={!input.trim()}>
                <Send className="h-4 w-4" aria-hidden="true" />
                <span className="sr-only">Send</span>
              </Button>
            </form>
            <Link href="/book" className="mt-1 block py-2 text-center text-sm text-lime-300 hover:underline">
              Or just check live availability →
            </Link>
          </div>
        </div>
      ) : null}
    </>
  );
}
