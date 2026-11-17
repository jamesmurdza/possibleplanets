/** @type {import('next').NextConfig} */
const nextConfig = {
  // @daytona/sdk's Image.fromDockerfile() pulls in `expand-tilde`, which does
  // a dynamic require() the bundler can't statically analyze. Keeping these
  // packages external (plain Node `require` at runtime, not bundled) avoids
  // the build-time crash this otherwise causes.
  serverExternalPackages: ["@daytona/sdk", "@daytona/api-client", "@daytona/toolbox-api-client", "expand-tilde", "pg"],
  // Dev mode blocks cross-origin requests to its own HMR/dev resources by
  // default -- this sandbox serves the dev server through a reverse proxy
  // on a different host than localhost, so the browser's HMR websocket
  // (wss://<proxy host>/_next/hmr) gets rejected unless that host is
  // explicitly allow-listed here.
  allowedDevOrigins: ["*.daytonaproxy01.net"],
  // Once this domain points at this Next.js app instead of the old Jekyll
  // site, this one post needs to keep resolving -- it's been moved to a
  // separate blog, not ported into this app. The path is Jekyll's own
  // default "date" permalink style (../../_config.yml never sets a custom
  // `permalink`, and this post's own front matter has an empty
  // `categories:`), confirmed against ../../_posts/
  // 2022-05-06-how-to-forecast-the-climate.markdown: the live URL was
  // /2022/05/06/how-to-forecast-the-climate.html. Redirecting both that
  // and the extension-less form, in case anything links to it either way.
  async redirects() {
    return [
      {
        source: "/2022/05/06/how-to-forecast-the-climate.html",
        destination: "https://blog.jamesmurdza.com/how-to-forecast-the-climate",
        permanent: true,
      },
      {
        source: "/2022/05/06/how-to-forecast-the-climate",
        destination: "https://blog.jamesmurdza.com/how-to-forecast-the-climate",
        permanent: true,
      },
    ];
  },
};

module.exports = nextConfig;
