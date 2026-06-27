// Tailwind CDN config — semantic CSS variable mapping for flawless Light/Dark contrast
tailwind.config = {
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        "page": "var(--bg-page)",
        "app": "var(--bg-app)",
        "panel": "var(--bg-card)",
        "panel-hover": "var(--bg-card-hover)",
        "field": "var(--bg-input)",
        "main": "var(--text-main)",
        "muted": "var(--text-muted)",
        "edge": "var(--border-color)",
        "primary": "var(--accent)",
        "secondary": "#38bdf8",
        "tertiary": "#34d399",
        "error": "#f87171"
      },
      fontFamily: {
        "headline": ["Inter", "sans-serif"],
        "body": ["Inter", "sans-serif"],
        "label": ["Inter", "sans-serif"],
        "mono": ["JetBrains Mono", "monospace"]
      },
      borderRadius: {
        "DEFAULT": "0.125rem",
        "lg": "0.375rem",
        "xl": "0.625rem",
        "2xl": "0.875rem",
        "3xl": "1.25rem",
        "full": "9999px"
      }
    }
  }
};
