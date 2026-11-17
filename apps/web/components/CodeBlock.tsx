"use client";

import { useEffect, useRef } from "react";
import Prism from "prismjs";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-python";
import "prismjs/components/prism-julia";

interface CodeBlockProps {
  code: string;
  language?: "bash" | "python" | "julia";
}

// Highlights `code` client-side with Prism when `language` is a grammar we
// loaded above; falls back to a plain, un-highlighted <pre> otherwise (e.g.
// a language id this file hasn't imported, or no language at all). Done via
// a ref + useEffect (Prism.highlightElement) rather than Prism.highlight()
// at render time so this stays a plain, server-renderable string until the
// client takes over -- avoids a hydration mismatch from injecting Prism's
// <span> markup during SSR.
export default function CodeBlock({ code, language }: CodeBlockProps) {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    if (ref.current && language && Prism.languages[language]) {
      Prism.highlightElement(ref.current);
    }
  }, [code, language]);

  return (
    <pre className="run-guide-code">
      <code ref={ref} className={language ? `language-${language}` : undefined}>
        {code}
      </code>
    </pre>
  );
}
