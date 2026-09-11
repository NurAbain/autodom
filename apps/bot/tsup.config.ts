import { copyFile, mkdir } from "node:fs/promises";
import { build, defineConfig } from "tsup";

export default defineConfig({
  entry: ["apps/bot/src/cli.ts"],
  outDir: "apps/bot/dist",
  format: ["esm"],
  target: "node24",
  platform: "node",
  removeNodeProtocol: false,
  bundle: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  noExternal: [/^@autodom\//],
  async onSuccess() {
    await mkdir("apps/bot/dist/public", { recursive: true });
    await Promise.all([
      copyFile("apps/bot/web/index.html", "apps/bot/dist/public/index.html"),
      copyFile("apps/bot/web/app.css", "apps/bot/dist/public/app.css"),
    ]);
    await build({
      entry: { app: "apps/bot/web/app.ts" },
      outDir: "apps/bot/dist/public",
      config: false,
      clean: false,
      bundle: true,
      platform: "browser",
      format: ["esm"],
      target: "es2020",
      minify: true,
    });
  },
});
