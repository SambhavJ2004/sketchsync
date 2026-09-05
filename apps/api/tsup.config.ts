import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  clean: true,
  sourcemap: true,
  // Bundle internal workspace packages (they ship TS source, not built JS)...
  noExternal: [/^@sketchsync\//],
  // ...but keep the Prisma client external — it has a native query engine and
  // dynamic requires that must not be bundled.
  external: [/^@prisma\//, ".prisma/client"],
});
