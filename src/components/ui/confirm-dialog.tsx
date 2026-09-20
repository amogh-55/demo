"use client";

import * as Dialog from "@radix-ui/react-dialog";
import * as React from "react";
import { Alert, Button, Spinner } from "./primitives";
import { ReasonPicker } from "./reason-picker";

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  /** Renders a required free-text reason field when set. */
  reasonLabel?: string;
  reasonOptions?: string[];
  confirmLabel: string;
  confirmTone?: "primary" | "danger";
  busy?: boolean;
  error?: string | null;
  onConfirm: (reason: string) => void;
}

/**
 * Radix dialog: focus trapping, escape-to-close and aria wiring come for free,
 * which is what makes the destructive-action confirmations usable by keyboard.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  reasonLabel,
  reasonOptions,
  confirmLabel,
  confirmTone = "primary",
  busy = false,
  error,
  onConfirm,
}: ConfirmDialogProps) {
  const [reason, setReason] = React.useState("");

  React.useEffect(() => {
    if (open) setReason("");
  }, [open]);

  const needsReason = Boolean(reasonLabel);
  const canConfirm = !busy && (!needsReason || reason.trim().length >= 3);

  return (
    <Dialog.Root open={open} onOpenChange={(next) => (busy ? null : onOpenChange(next))}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink-950/50 backdrop-blur-sm" />
        {/* Capped and scrollable: with the reason field plus its presets this dialog is
            taller than a short phone, and the confirm button must stay reachable. */}
        <Dialog.Content className="theme-light fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl bg-white p-5 shadow-xl focus:outline-none">
          <Dialog.Title className="text-lg font-semibold text-ink-900">{title}</Dialog.Title>
          {description ? (
            <Dialog.Description asChild>
              <div className="mt-2 text-sm text-ink-600">{description}</div>
            </Dialog.Description>
          ) : null}

          {needsReason ? (
            <div className="mt-4">
              {reasonOptions?.length ? (
                <ReasonPicker
                  key={`reason-${String(open)}`}
                  id="confirm-reason"
                  label={reasonLabel!}
                  options={reasonOptions}
                  value={reason}
                  onChange={setReason}
                  placeholder="Add a short reason the customer will understand"
                />
              ) : (
                <>
                  <label className="field-label" htmlFor="confirm-reason">
                    {reasonLabel}
                  </label>
                  <textarea
                    id="confirm-reason"
                    className="field-input min-h-[80px]"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Add a short reason the customer will understand"
                    required
                  />
                </>
              )}
            </div>
          ) : null}

          {error ? (
            <Alert tone="error" className="mt-3">
              {error}
            </Alert>
          ) : null}

          <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Dialog.Close asChild>
              <Button variant="secondary" disabled={busy}>
                Cancel
              </Button>
            </Dialog.Close>
            <Button variant={confirmTone} disabled={!canConfirm} onClick={() => onConfirm(reason.trim())}>
              {busy ? <Spinner /> : null}
              {busy ? "Working…" : confirmLabel}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
