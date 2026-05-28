/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{js,jsx,ts,tsx}", "./src/**/*.{js,jsx,ts,tsx}"],
  theme: {
    extend: {
      colors: {
        darkBg: "#0D1B2A",
        midBg: "#132338",
        headerBg: "#1A3A5C",
        accent: "#00C8A0",
        gold: "#F5A623",
        subtle: "#C8D6E5",
        red: "#E05252",
        border: "#2A4A6B",
      },
    },
  },
  plugins: [],
};
