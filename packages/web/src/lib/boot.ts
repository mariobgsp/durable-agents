/**
 * The static first-paint screen and the one-way handshake that removes it.
 *
 * The markup is in index.html so it exists before any JavaScript or font is parsed. The app calls finishBoot
 * only after the shell has its first session/agent snapshot; a failure leaves a readable status and a reload
 * action instead of an eternal spinner.
 */
let finished = false;
let slowTimer: number | undefined;
let continueTimer: number | undefined;

function element(): HTMLElement | null {
  return document.getElementById("boot");
}

/** Dev-only hook used by the screenshot gate to photograph the loading state. */
export function bootHeld(): boolean {
  return import.meta.env.DEV && new URLSearchParams(location.search).has("boot");
}

export function finishBoot(): void {
  if (finished || bootHeld()) return;
  finished = true;
  if (slowTimer) window.clearTimeout(slowTimer);
  if (continueTimer) window.clearTimeout(continueTimer);
  const boot = element();
  if (!boot) return;
  boot.classList.add("boot--done");
  window.setTimeout(() => boot.remove(), 180);
}

export function bootStatus(text: string): void {
  const status = document.getElementById("boot-status");
  if (status) status.textContent = text;
}

export function bootFailed(): void {
  if (finished) return;
  bootStatus("Waiting for the server…");
  const retry = document.getElementById("boot-retry");
  if (retry) retry.hidden = false;
  if (slowTimer) window.clearTimeout(slowTimer);
  slowTimer = undefined;
  // Never trap the owner behind a screen if the server is deliberately down: after a while, let the app's
  // own connection/error state be visible.
  if (!continueTimer) {
    continueTimer = window.setTimeout(() => {
      const boot = element();
      if (!boot) return;
      const carryOn = document.getElementById("boot-continue");
      if (carryOn) carryOn.hidden = false;
    }, 15_000);
  }
}

export function startBootWatch(): void {
  if (bootHeld()) {
    bootStatus("Preparing the app…");
    return;
  }
  if (slowTimer) window.clearTimeout(slowTimer);
  slowTimer = window.setTimeout(() => {
    const boot = element();
    if (!boot || finished) return;
    bootStatus("Waiting for the server…");
    const retry = document.getElementById("boot-retry");
    if (retry) retry.hidden = false;
  }, 6000);
}

export function bindBootControls(): void {
  document.getElementById("boot-retry")?.addEventListener("click", () => location.reload());
  document.getElementById("boot-continue")?.addEventListener("click", () => finishBoot());
}
