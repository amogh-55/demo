"use client";

import * as React from "react";
import { cn } from "./primitives";

/**
 * Pick a reason from the common ones, or write your own.
 *
 * The presets are the answer almost every time, so they are the primary control
 * and the chosen one stays visibly selected. The free-text box only appears
 * behind "Other", which keeps the usual path to a single tap and stops the
 * chosen preset being silently duplicated into a textarea nobody edits.
 *
 * Remount it (a changing `key`) to clear the selection — that is what the
 * dialogs do when they open.
 */
export function ReasonPicker({
  id,
  label,
  options,
  value,
  onChange,
  placeholder,
  otherLabel = "Other…",
}: {
  id: string;
  label: string;
  options: string[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  otherLabel?: string;
}) {
  const [writingOwn, setWritingOwn] = React.useState(false);
  const textarea = React.useRef<HTMLTextAreaElement>(null);

  React.useEffect(() => {
    if (writingOwn) textarea.current?.focus();
  }, [writingOwn]);

  return (
    <div>
      <p className="field-label" id={`${id}-label`}>
        {label}
      </p>

      <div className="flex flex-wrap gap-2" role="group" aria-labelledby={`${id}-label`}>
        {options.map((option) => {
          const selected = !writingOwn && value === option;
          return (
            <button
              key={option}
              type="button"
              aria-pressed={selected}
              onClick={() => {
                setWritingOwn(false);
                onChange(option);
              }}
              className={cn(
                "inline-flex min-h-[44px] items-center rounded-lg border px-3 text-sm font-medium transition-colors sm:min-h-[36px]",
                selected
                  ? "border-pitch-600 bg-pitch-600 text-white"
                  : "border-ink-200 bg-white text-ink-700 hover:border-pitch-400 hover:bg-ink-50",
              )}
            >
              {option}
            </button>
          );
        })}

        <button
          type="button"
          aria-pressed={writingOwn}
          onClick={() => {
            setWritingOwn(true);
            onChange("");
          }}
          className={cn(
            "inline-flex min-h-[44px] items-center rounded-lg border px-3 text-sm font-medium transition-colors sm:min-h-[36px]",
            writingOwn
              ? "border-pitch-600 bg-pitch-600 text-white"
              : "border-dashed border-ink-300 bg-white text-ink-600 hover:border-pitch-400 hover:bg-ink-50",
          )}
        >
          {otherLabel}
        </button>
      </div>

      {writingOwn ? (
        <textarea
          ref={textarea}
          id={id}
          className="field-input mt-2 min-h-[70px]"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
        />
      ) : null}
    </div>
  );
}
