const path = require("path");

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Monorepo root (two levels up from apps/web) -- needed so
  // outputFileTracingIncludes below can reach ../../sandboxes at all.
  // Without this, Turbopack's tracer rejects any include glob that
  // starts with "../" ("it has a prefix that navigates out of the
  // project root") -- confirmed by testing: the include below fails to
  // build until this is set. See output.md's own monorepo example.
  outputFileTracingRoot: path.join(__dirname, "..", ".."),
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
  // POST /v1/models/[model]/runs -- specifically submitRun() in lib/runs.ts
  // -- calls Image.fromDockerfile(model.dockerfile), reading
  // ../../sandboxes/<model>/Dockerfile (and whatever it COPYs: run.py,
  // requirements.txt, etc.) straight off disk at request time, for every
  // model except gcam (which uses a Daytona snapshot instead -- see
  // models.ts's daytona_snapshot comment). That path is only ever built at
  // runtime (path.join(SANDBOXES_DIR, modelName, "Dockerfile")), which
  // Next.js's own build-time file tracing can't follow -- confirmed by
  // inspecting .next/server/app/v1/models/[model]/runs/route.js.nft.json
  // after a real `next build`: zero files under sandboxes/ were traced.
  // Without this, Netlify's deployed function never has sandboxes/ at all,
  // so creating a sandbox for ANY non-cached run of ANY model but gcam
  // fails immediately in production (confirmed directly: POST
  // .../twolayer/runs with refresh:true returned a bare 502 in ~0.2s on
  // the live site, consistent with a missing-file crash, not a slow
  // build) even though it works perfectly in `next dev`, which reads
  // straight from the full source tree with no tracing/bundling step at
  // all -- the exact reason this went unnoticed through all of this
  // session's earlier local testing.
  outputFileTracingIncludes: {
    // Relative to outputFileTracingRoot (the monorepo root) above, not to
    // this file's own directory. Every model EXCEPT gcam, individually --
    // not a single "sandboxes/**/*" -- for two reasons: (1) gcam uses
    // Image.base/a Daytona snapshot now (see models.ts's daytona_snapshot
    // comment), never reading its own Dockerfile at request time, so it
    // doesn't need tracing at all; (2) gcam's own sandboxes/gcam/runtime/
    // directory contains a 5.2GB gitignored local-only XML database
    // (confirmed by testing: including "sandboxes/**/*" here OOM-killed
    // this exact build locally trying to trace/copy it) -- harmless in a
    // real deploy, where that directory is simply absent, but there's no
    // reason to even attempt matching it.
    "/v1/models/\\[model\\]/runs": [
      "sandboxes/hector/**/*",
      "sandboxes/fair/**/*",
      "sandboxes/oscar/**/*",
      "sandboxes/dice/**/*",
      "sandboxes/magicc/**/*",
      "sandboxes/twolayer/**/*",
    ],
  },
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
