import type { Config } from "tailwindcss";
import plugin from "tailwindcss/plugin";

const config: Config = {
  darkMode: ["class"],
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    container: { center: true, padding: "1rem", screens: { "2xl": "1200px" } },
    extend: {
      colors: {
        pitch: {
          50: "#f2f8f4",
          100: "#dcecdf",
          200: "#bcd9c3",
          300: "#8fbe9c",
          400: "#5c9d70",
          500: "#3a8052",
          600: "#2a6741",
          700: "#235236",
          800: "#1e422d",
          900: "#193727",
          950: "#0c1f15",
        },
        ink: {
          50: "#f6f7f8",
          100: "#e9ecef",
          200: "#d0d6dd",
          300: "#a8b2bd",
          400: "#7d8a98",
          500: "#5d6a79",
          600: "#47525f",
          700: "#39424e",
          800: "#272e38",
          900: "#171c24",
          950: "#0b0e13",
        },
      },
      fontFamily: { sans: ["var(--font-sans)", "system-ui", "sans-serif"] },
      backgroundImage: {
        "pitch-glow": "radial-gradient(60rem 30rem at 50% -10%, rgba(163,230,53,0.14), transparent 70%)",
      },
      keyframes: {
        "fade-up": { from: { opacity: "0", transform: "translateY(10px)" }, to: { opacity: "1", transform: "none" } },
        marquee: { from: { transform: "translateX(0)" }, to: { transform: "translateX(-50%)" } },
      },
      animation: {
        "fade-up": "fade-up .4s ease-out both",
        marquee: "marquee 28s linear infinite",
      },
    },
  },
  plugins: [
    require("tailwindcss-animate"),
    // The customer site is dark by default; the admin shell opts back into light
    // by wrapping itself in `.theme-light`, and shared components restyle with
    // `theme-light:` utilities rather than each keeping two copies.
    plugin(({ addVariant }) => {
      addVariant("theme-light", ".theme-light &");
    }),
  ],
};
export default config;
