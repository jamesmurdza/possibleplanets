"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";

/**
 * Slide-in panel from the right edge of the viewport -- used by RunsPanel
 * to show a run's chart/detail without leaving the Runs table (replacing
 * the old below-the-table detail panel). Portaled into document.body for
 * the same reason Modal.tsx is: an ancestor's own `overflow: hidden`
 * would otherwise clip it regardless of z-index.
 */
export default function Drawer({
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
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer-panel" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="drawer-header">
          <h3 className="drawer-title">{title}</h3>
          <button type="button" className="icon-button secondary" aria-label="Close" onClick={onClose}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="drawer-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
