// tailwind.config.js
const { heroui } = require("@heroui/react")


/** @type {import('tailwindcss').Config} */

module.exports = {
  content: [
    "./renderer/**/*.{js,ts,jsx,tsx}",
    "./node_modules/@heroui/theme/dist/**/*.{js,ts,jsx,tsx}"
  ],
  theme: {
    extend: {},
  },
  darkMode: "class",
  plugins: [heroui({
    themes: {
      "xbox-dark": {
        extend: "dark",
        colors: {
          background: "#090A0F",
          foreground: "#F8FAFC",
          focus: "#DF6069",
          divider: "#1E2235",
          content1: "#131620",
          content2: "#181C28",
          content3: "#1E2235",
          content4: "#2A2E42",
          default: {
            50: "#0F121A",
            100: "#131620",
            200: "#1E2235",
            300: "#2A2E42",
            400: "#64748B",
            500: "#94A3B8",
            600: "#CBD5E1",
            700: "#E2E8F0",
            800: "#F8FAFC",
            900: "#FFFFFF",
            foreground: "#F8FAFC",
          },
          primary: {
            50: "#FFF1F2",
            100: "#FFE3E6",
            200: "#FFC9CE",
            300: "#F9A4AB",
            400: "#EE7780",
            500: "#DF6069",
            600: "#C8434D",
            700: "#A7333D",
            800: "#8A2C35",
            900: "#732830",
            DEFAULT: "#DF6069",
            foreground: "#ffffff",
          },
        }
      },
      "xbox-light": {
        extend: "light",
        colors: {
          primary: {
            50: "#FFF1F2",
            100: "#FFE3E6",
            200: "#FFC9CE",
            300: "#F9A4AB",
            400: "#EE7780",
            500: "#DF6069",
            600: "#C8434D",
            700: "#A7333D",
            800: "#8A2C35",
            900: "#732830",
            DEFAULT: "#DF6069",
          },
        }
      }
    }
  })]
}
