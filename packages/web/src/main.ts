import { mount } from "svelte";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import App from "./App.svelte";
import "./app.css";

const target = document.getElementById("app");
if (!target) throw new Error("#app not found");

mount(App, { target });

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
