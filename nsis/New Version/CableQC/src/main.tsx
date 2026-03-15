import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

function hideInitialSplash() {
  try {
    const el = document.getElementById("initial-splash");
    if (!el) return;
    el.classList.add("hidden");
    window.setTimeout(() => {
      el.parentElement?.removeChild(el);
    }, 400);
  } catch {
  }
}

const rootElement = document.getElementById("root")!;
createRoot(rootElement).render(<App />);

const splashFallback = window.setTimeout(() => {
  hideInitialSplash();
}, 8000);

window.addEventListener(
  "app:hide-splash",
  () => {
    window.clearTimeout(splashFallback);
    hideInitialSplash();
  },
  { once: true },
);
