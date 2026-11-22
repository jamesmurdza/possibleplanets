import { PublicHeader, PublicFooter } from "../../components/PublicChrome";

interface BlogPost {
  title: string;
  url: string;
}

const POSTS: BlogPost[] = [
  {
    title: "Running integrated assessment models in cloud sandboxes",
    url: "https://blog.jamesmurdza.com/running-integrated-assessment-models-in-cloud-sandboxes",
  },
  {
    title: "How to forecast the climate",
    url: "https://blog.jamesmurdza.com/how-to-forecast-the-climate",
  },
];

export default function BlogPage() {
  return (
    <div className="public-page">
      <PublicHeader />
      <main className="public-main article">
        <h1 className="article-title">Blog</h1>
        <section className="article-section">
          <ul>
            {POSTS.map((post) => (
              <li key={post.url}>
                <a href={post.url} target="_blank" rel="noopener noreferrer">
                  {post.title}
                </a>
              </li>
            ))}
          </ul>
        </section>
      </main>
      <PublicFooter />
    </div>
  );
}
