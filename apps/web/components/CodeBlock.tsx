"use client";

import Prism from "prismjs";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-python";
import "prismjs/components/prism-julia";

interface CodeBlockProps {
  code: string;
  language?: "bash" | "python" | "julia";
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Previous version highlighted via a ref + useEffect calling
// Prism.highlightElement() client-side only, specifically to avoid
// rendering Prism's <span> markup during SSR. That backfired: React still
// rendered a plain <pre className="run-guide-code"><code> on mount, then
// Prism.highlightElement mutated that live DOM directly (adding a
// "language-bash" class to the <pre>, not just the <code>) -- a mutation
// React's virtual DOM never knew about. The next time React reconciled
// that node (e.g. a parent state update), it compared its own
// (unchanged) idea of the attributes against the Prism-mutated live DOM
// and logged exactly this: "tree hydrated but some attributes ... didn't
// match" -- a real bug, not a SSR/CSR text mismatch at initial hydration.
//
// Fixed by using Prism.highlight() instead of highlightElement() --
// confirmed to be a pure tokenizer with no DOM dependency (it runs fine
// under plain `node -e`, no document/window needed) -- so the exact same
// HTML string is produced on the server and the client, and React
// (not Prism) owns every attribute on both <pre> and <code> going
// forward. No ref, no effect, no DOM mutation outside React at all.
export default function CodeBlock({ code, language }: CodeBlockProps) {
  const grammar = language ? Prism.languages[language] : undefined;
  const html = grammar ? Prism.highlight(code, grammar, language!) : escapeHtml(code);
  const languageClass = language ? `language-${language}` : undefined;

  return (
    // suppressHydrationWarning: Chromium adds an implicit tabindex to a
    // scrollable element (this <pre> has overflow-x: auto -- see
    // globals.css's .run-guide-code) for keyboard accessibility, after
    // layout, as a genuine browser behavior outside React's or this
    // component's control -- not something SSR could ever predict or
    // match, and not a real bug the way the className drift above was.
    <pre className={["run-guide-code", languageClass].filter(Boolean).join(" ")} suppressHydrationWarning>
      <code className={languageClass} dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  );
}
