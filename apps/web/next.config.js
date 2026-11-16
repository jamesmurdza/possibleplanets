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
};

module.exports = nextConfig;
