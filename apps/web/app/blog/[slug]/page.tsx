import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { marked } from "marked";
import { PublicHeader, PublicFooter } from "../../../components/PublicChrome";
import { BLOG_POSTS, getBlogPost } from "../../../lib/blogPosts";

// Only the two curated posts in lib/blogPosts.ts are ever mirrored --
// nothing else from the source blog/RSS gets a route here.
export function generateStaticParams() {
  return BLOG_POSTS.map((post) => ({ slug: post.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const post = getBlogPost(slug);
  if (!post) return {};
  return {
    title: `${post.title} | Possible Planets`,
    description: post.excerpt,
    // SEO-critical: this page mirrors someone else's content, so it must
    // never be treated as the canonical copy. Pointing this at
    // post.originalUrl (the source's own declared canonical, currently
    // writing.jamesmurdza.com -- see lib/blogPosts.ts) tells search
    // engines all ranking signal belongs to the original, so this mirror
    // can't dilute or compete with it. Do not remove this when editing
    // this page.
    alternates: {
      canonical: post.originalUrl,
    },
  };
}

async function fetchMarkdown(url: string): Promise<string | null> {
  try {
    // Revalidate periodically rather than on every request, both to be a
    // polite neighbor to the source blog and so a transient outage there
    // doesn't take this page down -- the stale cached copy keeps serving.
    const res = await fetch(url, { next: { revalidate: 3600 } });
    if (!res.ok) return null;
    const text = await res.text();
    return stripLeadingTitle(text);
  } catch {
    return null;
  }
}

// The source markdown starts with its own "# Title" (and often a leading
// blank line/front matter before it) -- we already render that title
// ourselves as the page's <h1 className="article-title">, so drop the
// first H1 here to avoid rendering the same title twice.
function stripLeadingTitle(markdown: string): string {
  return markdown.replace(/^\s*(?:#\s+.*\n+)/, "");
}

export default async function BlogPostPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const post = getBlogPost(slug);
  if (!post) notFound();

  const markdown = await fetchMarkdown(post.markdownUrl);
  const html = markdown ? await marked.parse(markdown) : null;

  return (
    <div className="public-page">
      <PublicHeader />
      <main className="public-main article">
        <h1 className="article-title">{post.title}</h1>
        <p className="blog-post-card-meta">
          {new Date(post.date).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}.
          Published on{" "}
          <a href={post.originalUrl} target="_blank" rel="noopener noreferrer">
            jamesmurdza.com
          </a>
        </p>

        {html ? (
          <div className="blog-post-body" dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <section className="article-section">
            <p>
              This post couldn&apos;t be loaded right now. Read it directly at{" "}
              <a href={post.originalUrl} target="_blank" rel="noopener noreferrer">
                {post.originalUrl}
              </a>
              .
            </p>
          </section>
        )}

        <p className="blog-post-source-footer">
          Read the original on{" "}
          <a href={post.originalUrl} target="_blank" rel="noopener noreferrer">
            writing.jamesmurdza.com &rarr;
          </a>
        </p>
      </main>
      <PublicFooter />
    </div>
  );
}
