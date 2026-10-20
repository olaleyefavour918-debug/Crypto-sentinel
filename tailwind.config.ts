import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: { DEFAULT: "#0a0f1e", 2: "#0e1427" },
        panel: { DEFAULT: "#111933", 2: "#151e3b" },
        line: { DEFAULT: "#1f2a4a", 2: "#2a3760" },
        fg: { DEFAULT: "#e7ebf7", dim: "#aab3cf", mute: "#7482a6" },
        up: "#2ebd85",
        down: "#f6465d",
        warn: "#f0b429",
        accent: { DEFAULT: "#7aa2ff", dim: "#4c6bd1" },
        btc: "#f7931a",
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "Helvetica Neue", "Arial", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "Liberation Mono", "monospace"],
      },
      boxShadow: { card: "0 1px 0 0 rgba(255,255,255,0.03) inset, 0 8px 24px -12px rgba(0,0,0,0.6)" },
    },
  },
  plugins: [],
};

export default config;
