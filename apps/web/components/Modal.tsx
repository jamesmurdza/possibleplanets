"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";

/**
 * Minimal modal dialog, portaled into document.body for the same reason
 * Dropdown.tsx's menu is -- an ancestor's own `overflow: hidden` (e.g.
 * .panel's rounded-corner clipping) would otherwise clip it regardless of
 * z-index if it stayed nested in the card that opened it.
 */
export default function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-box" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3 className="modal-title">{title}</h3>
          <button type="button" className="icon-button secondary modal-close" aria-label="Close" onClick={onClose}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M4 4l8 8M12 4l-8 8"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
