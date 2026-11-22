/**
 * Curated allow-list of external blog posts we mirror on /blog.
 *
 * We deliberately do NOT pull the full RSS/post list from
 * blog.jamesmurdza.com -- only these two posts are mirrored here, by
 * explicit choice (not everything the source blog publishes is relevant
 * to Possible Planets). To add a post, add an entry here.
 *
 * `originalUrl` is the canonical home of the content: blog.jamesmurdza.com.
 * Every mirrored page and every RSS <link> must point here, not at our own
 * /blog/<slug> URL, so we never compete with the original in search
 * results (see /blog/[slug]/page.tsx's generateMetadata and
 * app/blog/rss.xml/route.ts).
 */
export interface BlogPost {
  slug: string;
  title: string;
  excerpt: string;
  originalUrl: string;
  /** Where we fetch the raw markdown from. */
  markdownUrl: string;
  date: string; // ISO date, used for RSS pubDate and display
}

export const BLOG_POSTS: BlogPost[] = [
  {
    slug: "running-integrated-assessment-models-in-cloud-sandboxes",
    title: "Running integrated assessment models in cloud sandboxes",
    excerpt:
      "How to run large, long-running climate/economic integrated assessment models (like GCAM) inside isolated cloud sandboxes instead of on a local machine.",
    originalUrl: "https://blog.jamesmurdza.com/running-integrated-assessment-models-in-cloud-sandboxes",
    markdownUrl: "https://blog.jamesmurdza.com/running-integrated-assessment-models-in-cloud-sandboxes.md",
    date: "2026-10-01",
  },
  {
    slug: "how-to-forecast-the-climate",
    title: "How to forecast the climate",
    excerpt:
      "An introduction to the models and methods behind long-range climate forecasting, and what it actually takes to produce one.",
    originalUrl: "https://blog.jamesmurdza.com/how-to-forecast-the-climate",
    markdownUrl: "https://blog.jamesmurdza.com/how-to-forecast-the-climate.md",
    date: "2026-09-10",
  },
];

export function getBlogPost(slug: string): BlogPost | undefined {
  return BLOG_POSTS.find((p) => p.slug === slug);
}
