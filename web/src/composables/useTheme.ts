import { ref, watchEffect } from "vue";

const STORAGE_KEY = "berry-theme";

function initialTheme(): "light" | "dark" {
  const saved = localStorage.getItem(STORAGE_KEY);

  if (saved === "light" || saved === "dark") {
    return saved;
  }

  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

const theme = ref<"light" | "dark">(initialTheme());

watchEffect(() => {
  document.documentElement.dataset.theme = theme.value;
  localStorage.setItem(STORAGE_KEY, theme.value);
});

export function useTheme() {
  function toggle() {
    theme.value = theme.value === "dark" ? "light" : "dark";
  }

  return { theme, toggle };
}
