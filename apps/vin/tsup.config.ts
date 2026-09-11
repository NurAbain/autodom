import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["apps/vin/src/cli.ts"],
  outDir: "apps/vin/dist",
  format: ["esm"],
  target: "node24",
  platform: "node",
  removeNodeProtocol: false,
  bundle: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  noExternal: [/^@autodom\//],
});
