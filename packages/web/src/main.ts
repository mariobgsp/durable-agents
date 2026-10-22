import { mount } from "svelte";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import App from "./App.svelte";
import "./app.css";
import "./app-additions.css";
import { primeAudio } from "./lib/notify.ts";

const target = document.getElementById("app");
if (!target) throw new Error("#app not found");

mount(App, { target });

/**
 * Keep the shell at the visual viewport's height.
 *
 * On a phone, 100dvh does not shrink when the software keyboard opens in every browser. The composer is the
 * last child of the chat column, so without this the keyboard can cover it and the owner has to scroll to find
 * their own input. visualViewport is the size that actually remains visible above the keyboard.
 */
function watchViewport(): void {
  const viewport = window.visualViewport;
  const root = document.documentElement;
  let frame = 0;
  const sync = (): void => {
    frame = 0;
    const height = viewport?.height ?? window.innerHeight;
    if (!Number.isFinite(height) || height < 240) return;
    // The visual viewport is a rectangle inside the layout viewport. Both its height and its top offset move
    // when a phone keyboard opens and the browser pans the focused input into view. Sizing only the height
    // leaves the composer in the layout viewport while the visible rectangle sits lower, so the box appears to
    // jump away. Pin the app to both values instead.
    root.style.setProperty("--app-height", Math.round(height) + "px");
    root.style.setProperty("--app-offset", Math.round(viewport?.offsetTop ?? 0) + "px");
  };
  const schedule = (): void => {
    if (frame !== 0) return;
    frame = window.requestAnimationFrame(sync);
  };
  sync();
  viewport?.addEventListener("resize", schedule);
  viewport?.addEventListener("scroll", schedule);
  window.addEventListener("resize", schedule);
  window.addEventListener("orientationchange", schedule);
}
watchViewport();

/**
 * Browsers allow an AudioContext to start only from a user gesture. Prime it on the first interaction so a
 * completion that happens later can play its chime; if the preference is off, the context is never created.
 */
const prime = (): void => {
  primeAudio();
  window.removeEventListener("pointerdown", prime);
  window.removeEventListener("keydown", prime);
};
window.addEventListener("pointerdown", prime, { passive: true });
window.addEventListener("keydown", prime);

/**
 * No status motion while the tab is hidden.
 *
 * The roadmap's live-indicator rule says so: nobody is watching an off-screen tab, and a sweep would keep the
 * compositor busy for nothing. CSS pauses it, so no component has to know about visibility.
 */
const setHidden = (): void => {
  document.body.classList.toggle("pi-idle", document.hidden);
};
document.addEventListener("visibilitychange", setHidden);
setHidden();

// PWA: production builds only, and only hashed assets (see public/sw.js).
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js");
  });
}