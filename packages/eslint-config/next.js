import nextPlugin from "@next/eslint-plugin-next";
import globals from "globals";
import baseConfig from "./base.js";

/**
 * Shared ESLint flat config for the Next.js web app.
 * Extends the base config with Next.js rules and browser globals.
 */
export default [
  ...baseConfig,
  {
    plugins: {
      "@next/next": nextPlugin,
    },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
    },
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
];
