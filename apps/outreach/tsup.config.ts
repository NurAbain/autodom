import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["apps/outreach/src/cli.ts"],
  outDir: "apps/outreach/dist",
  format: ["esm"],
  target: "node24",
  platform: "node",
  removeNodeProtocol: false,
  bundle: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  noExternal: [/^@autodom\//],
  external: [
    "socket.io-client",
    "https-proxy-agent",
    "impit",
    "tough-cookie",
    "undici",
    "puppeteer-core",
  ],
});
