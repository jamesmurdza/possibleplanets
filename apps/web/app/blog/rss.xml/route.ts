import { BLOG_POSTS } from "../../../lib/blogPosts";

/**
 * RSS feed for the blog section. Deliberately scoped to ONLY the curated
 * posts in lib/blogPosts.ts, not a mirror of the source blog's own RSS
 * feed -- we're syndicating a hand-picked subset, not everything James
 * publishes.
 *
 * Each <link>/<guid> points at the post's real canonical URL
 * (blog.jamesmurdza.com), not our /blog/<slug> mirror, so this feed
 * never asserts our pages as the authoritative source -- consistent with
 * the <link rel="canonical"> set in app/blog/[slug]/page.tsx.
 */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export async function GET() {
  const siteUrl = "https://possibleplanets.com";
  const items = BLOG_POSTS.map(
    (post) => `
    <item>
      <title>${escapeXml(post.title)}</title>
      <link>${escapeXml(post.originalUrl)}</link>
      <guid isPermaLink="true">${escapeXml(post.originalUrl)}</guid>
      <description>${escapeXml(post.excerpt)}</description>
      <pubDate>${new Date(post.date).toUTCString()}</pubDate>
    </item>`,
  ).join("");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Possible Planets Blog</title>
    <link>${siteUrl}/blog</link>
    <description>Curated posts on climate modeling and forecasting.</description>
    ${items}
  </channel>
</rss>`;

  return new Response(xml, {
    headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
  });
}
