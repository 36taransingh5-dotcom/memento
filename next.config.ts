import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `pg` and the AWS SDK use dynamic requires that break when bundled; keep them
  // external so they resolve from node_modules at runtime on the server.
  serverExternalPackages: ["pg", "@aws-sdk/client-bedrock-runtime"],

  // This project usually lives inside a directory containing other checkouts.
  // Pinning the tracing root stops Next from inferring a parent workspace and
  // tracing files that have nothing to do with Memento.
  outputFileTracingRoot: dirname(fileURLToPath(import.meta.url)),

  // Standalone output keeps the deployed image small — see docs/deployment.md.
  output: "standalone",
};

export default nextConfig;
