import { defineConfig } from "tsup";

export default defineConfig({
  banner: {
    js: "#!/usr/bin/env node",
  },
  clean: true,
  dts: false,
  entry: {
    index: "src/index.ts",
    "pi-tree-extension": "src/pi-extension/tree.ts",
  },
  format: ["esm"],
  minify: false,
  platform: "node",
  sourcemap: true,
  splitting: false,
  target: "node22",
});
