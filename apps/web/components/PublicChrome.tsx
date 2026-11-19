"use client";

/**
 * Header/footer shared by every public page (home + model/scenario
 * articles). Styled to match the project's existing Jekyll site
 * (../_config.yml's title/description, ../_includes/header.html's
 * logo+title markup, ../_includes/footer.html's three-column layout,
 * ../_sass/minima's palette/type) -- see globals.css's "Public site"
 * section, built from minima's actual SCSS variables ($text-color: #444,
 * $background-color: #fdfdfd, $brand-color: #2a7ae2, $grey-color-dark,
 * 850px content width, 30px spacing unit), not a new, unrelated look.
 */
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { MODEL_FULL_NAMES, modelAcronym } from "../lib/modelFullNames";

// Static key order of lib/modelFullNames.ts's own MODEL_FULL_NAMES map --
// not fetched from GET /v1/models, since the header renders on every
// public page (including ones with nothing to do with the model list)
// and shouldn't need a network round-trip just to draw its own nav.
const MODELS_NAV_ORDER = Object.keys(MODEL_FULL_NAMES);

function ModelsNavDropdown() {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const pathname = usePathname();

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

  // Close whenever navigation actually happens (clicking a link inside
  // the menu changes pathname), the same belt-and-suspenders reasoning as
  // Dropdown.tsx's value-keyed close effect.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <div
      className={`site-nav-dropdown${open ? " open" : ""}`}
      ref={containerRef}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        className="site-nav-dropdown-toggle page-link"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        Models
        <svg className="site-nav-dropdown-chevron" viewBox="0 0 16 16" aria-hidden="true">
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
      {open && (
        <ul className="site-nav-dropdown-menu" role="menu">
          <li>
            <Link href="/" className={pathname === "/" ? "active" : ""} role="menuitem">
              All models
            </Link>
          </li>
          {MODELS_NAV_ORDER.map((model) => (
            <li key={model}>
              <Link
                href={`/models/${model}`}
                className={pathname === `/models/${model}` ? "active" : ""}
                role="menuitem"
              >
                {modelAcronym(model)}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function PublicHeader() {
  return (
    <header className="site-header">
      <div className="site-header-inner">
        <Link href="/" className="site-title">
          <img src="/globe-small.png" alt="" className="site-logo" />
          Possible Planets
        </Link>
        <nav className="site-nav">
          <ModelsNavDropdown />
          {/* Always points at /dashboard itself, not /account -- proxy.ts
              gates /dashboard/* on the auth cookie and redirects straight
              to /account (preserving ?next=/dashboard) only if it's
              missing, so an already-logged-in visitor goes straight to
              the dashboard in one click instead of landing on the login
              page again. */}
          <Link href="/dashboard" className="page-link">
            Dashboard
          </Link>
        </nav>
      </div>
    </header>
  );
}

export function PublicFooter() {
  return (
    <footer className="site-footer">
      <div className="site-footer-inner">
        <div className="footer-col">
          <h2 className="footer-heading">Possible Planets</h2>
          <a className="footer-link" href="mailto:contact@possibleplanets.com">
            contact@possibleplanets.com
          </a>
        </div>
        <div className="footer-col">
          <a className="footer-link" href="https://github.com/possibleplanets" target="_blank" rel="noopener noreferrer">
            <GithubIcon /> possibleplanets
          </a>
        </div>
        <div className="footer-col footer-col-description">
          <p>
            Possible Planets makes models of Earth&apos;s society and ecology open and accessible through free
            software, clear instruction, and meaningful data visualization.
          </p>
        </div>
      </div>
    </footer>
  );
}

function GithubIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" className="footer-icon">
      <path
        fill="currentColor"
        d="M7.999,0.431c-4.285,0-7.76,3.474-7.76,7.761c0,3.428,2.223,6.337,5.307,7.363c0.388,0.071,0.53-0.168,0.53-0.374c0-0.184-0.007-0.672-0.01-1.32c-2.159,0.469-2.614-1.04-2.614-1.04c-0.353-0.896-0.862-1.135-0.862-1.135c-0.705-0.481,0.053-0.472,0.053-0.472c0.779,0.055,1.189,0.8,1.189,0.8c0.692,1.186,1.816,0.843,2.258,0.645c0.071-0.502,0.271-0.843,0.493-1.037C4.86,11.425,3.049,10.76,3.049,7.786c0-0.847,0.302-1.54,0.799-2.082C3.768,5.507,3.501,4.718,3.924,3.65c0,0,0.652-0.209,2.134,0.796C6.677,4.273,7.34,4.187,8,4.184c0.659,0.003,1.323,0.089,1.943,0.261c1.482-1.004,2.132-0.796,2.132-0.796c0.423,1.068,0.157,1.857,0.077,2.054c0.497,0.542,0.798,1.235,0.798,2.082c0,2.981-1.814,3.637-3.543,3.829c0.279,0.24,0.527,0.713,0.527,1.437c0,1.037-0.01,1.874-0.01,2.129c0,0.208,0.14,0.449,0.534,0.373c3.081-1.028,5.302-3.935,5.302-7.362C15.76,3.906,12.285,0.431,7.999,0.431z"
      />
    </svg>
  );
}
