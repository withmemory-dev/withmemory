import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  target: "es2022",
  // Source maps omitted from the published tarball to halve its size.
  // Developers who need them can `pnpm build` from a source checkout.
  sourcemap: false,
});
