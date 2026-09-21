import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-full text-sm font-semibold transition-colors " +
    "disabled:pointer-events-none disabled:opacity-60",
  {
    variants: {
      variant: {
        // Dark site by default; `.theme-light` (the admin shell) restyles them.
        primary:
          "bg-lime-400 text-ink-950 hover:bg-lime-300 theme-light:bg-pitch-600 theme-light:text-white theme-light:hover:bg-pitch-700",
        secondary:
          "border border-white/15 bg-white/5 text-white hover:bg-white/10 theme-light:border-ink-200 theme-light:bg-white theme-light:text-ink-800 theme-light:hover:bg-ink-50",
        danger: "bg-red-500 text-white hover:bg-red-600 theme-light:bg-red-600 theme-light:hover:bg-red-700",
        ghost: "text-ink-300 hover:bg-white/10 theme-light:text-ink-700 theme-light:hover:bg-ink-100",
        whatsapp: "bg-[#25D366] text-ink-950 hover:bg-[#1eb455] hover:text-white",
      },
      size: {
        sm: "h-9 px-3",
        md: "h-11 px-4",
        lg: "h-12 px-6 text-base",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, type = "button", ...props },
  ref,
) {
  return <button ref={ref} type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
});

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent", className)}
    />
  );
}

/**
 * Status pill. Colour is reinforced by the label and an icon glyph so the meaning
 * survives colour blindness and greyscale printing.
 */
const badgeStyles: Record<string, string> = {
  AVAILABLE: "bg-green-50 text-green-800 ring-green-600/30",
  HELD: "bg-amber-50 text-amber-900 ring-amber-600/30",
  PENDING: "bg-amber-50 text-amber-900 ring-amber-600/30",
  PARTIAL: "bg-orange-50 text-orange-900 ring-orange-600/30",
  BOOKED: "bg-red-50 text-red-800 ring-red-600/30",
  CONFIRMED: "bg-green-50 text-green-800 ring-green-600/30",
  BLOCKED: "bg-ink-800 text-white ring-ink-900/30",
  PAST: "bg-ink-100 text-ink-500 ring-ink-300",
  REJECTED: "bg-ink-100 text-ink-600 ring-ink-300",
  CANCELLED: "bg-ink-100 text-ink-600 ring-ink-300",
  EXPIRED: "bg-ink-100 text-ink-600 ring-ink-300",
  VERIFIED: "bg-green-50 text-green-800 ring-green-600/30",
};

const badgeGlyph: Record<string, string> = {
  AVAILABLE: "●",
  HELD: "◐",
  PENDING: "◐",
  PARTIAL: "◑",
  BOOKED: "■",
  CONFIRMED: "✓",
  BLOCKED: "✕",
  PAST: "–",
  REJECTED: "–",
  CANCELLED: "–",
  EXPIRED: "–",
  VERIFIED: "✓",
};

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset",
        badgeStyles[status] ?? "bg-ink-100 text-ink-700 ring-ink-300",
        className,
      )}
    >
      <span aria-hidden="true">{badgeGlyph[status] ?? "•"}</span>
      {status.charAt(0) + status.slice(1).toLowerCase()}
    </span>
  );
}

export function Alert({
  tone = "error",
  children,
  className,
}: {
  tone?: "error" | "info" | "success" | "warning";
  children: React.ReactNode;
  className?: string;
}) {
  const tones = {
    error:
      "border-red-500/30 bg-red-500/10 text-red-200 theme-light:border-red-200 theme-light:bg-red-50 theme-light:text-red-900",
    warning:
      "border-amber-400/30 bg-amber-400/10 text-amber-100 theme-light:border-amber-200 theme-light:bg-amber-50 theme-light:text-amber-900",
    info: "border-white/10 bg-white/5 text-ink-200 theme-light:border-ink-200 theme-light:bg-ink-50 theme-light:text-ink-800",
    success:
      "border-lime-400/30 bg-lime-400/10 text-lime-100 theme-light:border-green-200 theme-light:bg-green-50 theme-light:text-green-900",
  };
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn("rounded-lg border px-3.5 py-3 text-sm", tones[tone], className)}
    >
      {children}
    </div>
  );
}

/**
 * One field-level complaint, shown under the field it is about.
 *
 * Paired with `aria-invalid` on the input: that attribute draws the red outline
 * (see `.field-input[aria-invalid="true"]`) and announces the state, this says
 * what is actually wrong. A disabled button with neither is what people read as
 * a broken page.
 */
export function FieldError({ id, children }: { id?: string; children: React.ReactNode }) {
  return (
    <p id={id} className="field-error" role="alert">
      <span aria-hidden="true">!</span>
      <span>{children}</span>
    </p>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-dashed border-white/15 px-6 py-10 text-center theme-light:border-ink-200">
      <p className="font-medium text-ink-200 theme-light:text-ink-700">{title}</p>
      {hint ? <p className="mt-1 text-sm text-ink-400 theme-light:text-ink-500">{hint}</p> : null}
    </div>
  );
}

/**
 * Money, or a dash.
 *
 * The guard is not decoration: a price read from a document written before a
 * field was renamed arrives here as undefined, and an unguarded `.toLocaleString`
 * takes down the whole booking page over one missing number. A dash tells the
 * customer this price is not available and leaves everything else usable.
 */
export function formatCurrency(amount: number | null | undefined): string {
  if (typeof amount !== "number" || !Number.isFinite(amount)) return "—";
  return `₹${amount.toLocaleString("en-IN")}`;
}
