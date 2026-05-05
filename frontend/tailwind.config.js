/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      colors: {
        accent: {
          DEFAULT: '#7c3aed',
          soft: '#ede9fe',
          muted: '#a78bfa',
        },
      },
      boxShadow: {
        card: '0 1px 3px 0 rgb(0 0 0 / 0.06), 0 1px 2px -1px rgb(0 0 0 / 0.06)',
        cardHover: '0 10px 40px -10px rgb(0 0 0 / 0.12), 0 4px 6px -2px rgb(0 0 0 / 0.05)',
      },
    },
  },
  plugins: [],
};
