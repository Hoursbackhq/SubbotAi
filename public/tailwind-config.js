// Tailwind CDN config — maps utility names onto the "Kiosk Print" tokens in index.html :root
tailwind.config = {
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        "page": "rgb(var(--bg-page) / <alpha-value>)",
        "app": "rgb(var(--bg-app) / <alpha-value>)",
        "panel": "rgb(var(--bg-card) / <alpha-value>)",
        "panel-hover": "rgb(var(--bg-card-hover) / <alpha-value>)",
        "field": "rgb(var(--bg-input) / <alpha-value>)",
        "main": "rgb(var(--text-main) / <alpha-value>)",
        "muted": "rgb(var(--text-muted) / <alpha-value>)",
        "edge": "rgb(var(--border-color) / <alpha-value>)",
        "primary": "rgb(var(--accent) / <alpha-value>)",
        "on-primary": "rgb(var(--on-accent) / <alpha-value>)",
        "secondary": "rgb(var(--text-muted) / <alpha-value>)",
        "tertiary": "rgb(var(--ok) / <alpha-value>)",
        "ok": "rgb(var(--ok) / <alpha-value>)",
        "due": "rgb(var(--due) / <alpha-value>)",
        "error": "rgb(var(--due) / <alpha-value>)",
        "plate": "rgb(var(--plate) / <alpha-value>)"
      },
      fontFamily: {
        "headline": ["Space Grotesk", "sans-serif"],
        "body": ["Space Grotesk", "sans-serif"],
        "label": ["IBM Plex Mono", "monospace"],
        "mono": ["IBM Plex Mono", "monospace"]
      },
      borderRadius: {
        "DEFAULT": "0.375rem",
        "lg": "0.625rem",
        "xl": "0.875rem",
        "2xl": "1rem",
        "3xl": "1.25rem",
        "full": "9999px"
      }
    }
  }
};
