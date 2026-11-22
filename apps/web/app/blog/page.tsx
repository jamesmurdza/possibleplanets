import type { Metadata } from "next";
import Link from "next/link";
import { PublicHeader, PublicFooter } from "../../components/PublicChrome";
import { BLOG_POSTS } from "../../lib/blogPosts";

export const metadata: Metadata = {
  title: "Blog | Possible Planets",
  description: "Writing on climate modeling, forecasting, and running integrated assessment models.",
};

export default function BlogPage() {
  return (
    <div className="public-page">
      <PublicHeader />
      <main className="public-main article">
        <h1 className="article-title">Blog</h1>
        <p className="blog-intro">
          Posts on climate modeling and forecasting, written by the team and mirrored here from{" "}
          <a href="https://writing.jamesmurdza.com" target="_blank" rel="noopener noreferrer">
            writing.jamesmurdza.com
          </a>
          .
        </p>

        <div className="blog-post-list">
          {BLOG_POSTS.map((post) => (
            <article key={post.slug} className="blog-post-card">
              <h2 className="blog-post-card-title">
                <Link href={`/blog/${post.slug}`}>{post.title}</Link>
              </h2>
              <p className="blog-post-card-meta">
                {new Date(post.date).toLocaleDateString(undefined, {
                  year: "numeric",
                  month: "long",
                  day: "numeric",
                })}
              </p>
              <p className="blog-post-card-excerpt">{post.excerpt}</p>
              <Link href={`/blog/${post.slug}`} className="blog-post-card-readmore">
                Read post &rarr;
              </Link>
            </article>
          ))}
        </div>
      </main>
      <PublicFooter />
    </div>
  );
}
