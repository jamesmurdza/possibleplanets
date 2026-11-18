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
  // Previously had outputFileTracingRoot/outputFileTracingIncludes here,
  // force-including sandboxes/<model>/** so Image.fromDockerfile(model.
  // dockerfile) -- called at request time in lib/runs.ts's submitRun() --
  // could actually find its Dockerfile in Netlify's deployed function
  // (Next.js's build-time tracing can't follow that dynamically
  // constructed path on its own; confirmed by inspecting a real build's
  // own .nft.json). Removed: submitRun() no longer calls
  // Image.fromDockerfile at all -- every model creates from its own
  // pre-built Daytona snapshot instead (see models.ts's daytona_snapshot
  // doc comment), which needs nothing from this app's own deployed
  // filesystem. That tracing config is also what OOM-killed a local
  // build in this project's own dev sandbox (its 3GB memory cap) once
  // gcam's gitignored 5.2GB local database existed alongside it --
  // removing it removes that fragility too, not just dead config.
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
