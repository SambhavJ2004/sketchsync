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
  // ...but keep the Prisma client external (native query engine + dynamic requires).
  external: [/^@prisma\//, ".prisma/client"],
});
