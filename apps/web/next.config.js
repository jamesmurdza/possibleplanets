/** @type {import('next').NextConfig} */
const nextConfig = {
  // @daytona/sdk's Image.fromDockerfile() pulls in `expand-tilde`, which does
  // a dynamic require() the bundler can't statically analyze. Keeping these
  // packages external (plain Node `require` at runtime, not bundled) avoids
  // the build-time crash this otherwise causes.
  serverExternalPackages: ["@daytona/sdk", "@daytona/api-client", "@daytona/toolbox-api-client", "expand-tilde", "pg"],
};

module.exports = nextConfig;
