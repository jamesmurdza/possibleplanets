"use client";

import { useEffect, useRef, useState } from "react";

export interface DropdownOption {
  value: string;
  label: string;
}

interface DropdownProps {
  options: DropdownOption[];
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
}

/**
 * React port of the vanilla-JS custom dropdown in apps/dashboard/app.js.
 * That version wrapped a real (visually hidden) <select> for accessibility
 * and kept a styled button+listbox in sync via a MutationObserver; here the
 * same visual contract is kept (same CSS classes from globals.css) but state
 * is just React state instead of DOM observation.
 */
export default function Dropdown({ options, value, onChange, ariaLabel }: DropdownProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onOutsideClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("click", onOutsideClick);
    return () => document.removeEventListener("click", onOutsideClick);
  }, [open]);

  const selected = options.find((o) => o.value === value);

  return (
    <div className={`dropdown${open ? " open" : ""}`} ref={containerRef}>
      <button
        type="button"
        className="dropdown-toggle"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="dropdown-value">{selected ? selected.label : "Loading..."}</span>
        <svg className="dropdown-chevron" viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M4 6l4 4 4-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      <ul className="dropdown-menu" role="listbox" hidden={!open}>
        {options.map((opt) => (
          <li
            key={opt.value}
            className={`dropdown-option${opt.value === value ? " selected" : ""}`}
            role="option"
            aria-selected={opt.value === value}
            onClick={() => {
              onChange(opt.value);
              setOpen(false);
            }}
          >
            {opt.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
