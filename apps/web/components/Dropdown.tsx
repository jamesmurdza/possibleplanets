"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

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
 *
 * The menu is rendered through a portal into document.body, positioned by
 * reading the toggle button's real on-screen rect (position: fixed, not
 * absolute) -- NOT as a child of .dropdown. Several ancestors of a dropdown
 * (e.g. .panel) use `overflow: hidden` for their own rounded corners; an
 * absolutely-positioned menu nested inside one of those gets clipped by
 * that ancestor regardless of z-index (overflow clipping applies to
 * descendants independent of stacking context). Confirmed by testing: the
 * Compare tab's dropdowns, nested inside .panel, got cut off exactly where
 * .panel's own box ended. A portal sidesteps this entirely -- the menu is
 * no longer a descendant of anything that clips it.
 */
export default function Dropdown({ options, value, onChange, ariaLabel }: DropdownProps) {
  const [open, setOpen] = useState(false);
  const [menuRect, setMenuRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  // Force-closed whenever the selected value changes, regardless of what
  // triggered that change. Belt-and-suspenders alongside the explicit
  // setOpen(false) in the option's own onClick below: confirmed by testing
  // that at least one real case (Compare tab's "Model (fixed)" dropdown,
  // whose onChange kicks off an async schema fetch + several follow-up
  // state updates in the parent) left the menu visibly stuck open even
  // though the selected value itself updated correctly -- i.e. the value
  // change landed but closing the menu didn't, for reasons that trace back
  // to the parent's own re-render cascade, not anything fixable by
  // reordering statements in this component alone. Keying the open state
  // directly off `value` sidesteps that regardless of which async chain
  // the parent runs after a selection.
  useEffect(() => {
    setOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  useEffect(() => {
    if (!open) return;
    function onOutsideClick(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node) &&
        !(e.target as HTMLElement)?.closest?.(".dropdown-menu")
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("click", onOutsideClick);
    return () => document.removeEventListener("click", onOutsideClick);
  }, [open]);

  // Recompute the portal's position whenever the menu opens, and keep it
  // pinned to the toggle button across scroll/resize while open (the menu
  // is no longer in-flow under the toggle now that it's portaled, so this
  // has to be done manually instead of relying on `position: absolute`).
  useLayoutEffect(() => {
    if (!open) return;
    function updateRect() {
      const el = toggleRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setMenuRect({ top: rect.bottom + 4, left: rect.left, width: rect.width });
    }
    updateRect();
    window.addEventListener("scroll", updateRect, true);
    window.addEventListener("resize", updateRect);
    return () => {
      window.removeEventListener("scroll", updateRect, true);
      window.removeEventListener("resize", updateRect);
    };
  }, [open]);

  const selected = options.find((o) => o.value === value);

  return (
    <div className={`dropdown${open ? " open" : ""}`} ref={containerRef}>
      <button
        ref={toggleRef}
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
      {open &&
        menuRect &&
        typeof document !== "undefined" &&
        createPortal(
          <ul
            className="dropdown-menu dropdown-menu-portal"
            role="listbox"
            style={{ top: menuRect.top, left: menuRect.left, minWidth: menuRect.width }}
          >
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
          </ul>,
          document.body,
        )}
    </div>
  );
}
