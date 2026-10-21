/**
 * Completion sound and desktop notifications.
 *
 * Preferences are local and tiny. The sound is synthesized with one shared AudioContext, so there is no audio
 * asset to download and no second decoder. Desktop notifications are requested only from a user click; the
 * browser's own permission prompt on page load would be both blocked and rude.
 */
export type NotifyPrefs = {
  sound: boolean;
  desktop: boolean;
  toast: boolean;
};

const KEY = "durable-agents.notify";
const DEFAULT: NotifyPrefs = { sound: true, desktop: false, toast: true };

export function loadNotifyPrefs(): NotifyPrefs {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<NotifyPrefs>;
    return {
      sound: parsed.sound !== false,
      desktop: parsed.desktop === true,
      toast: parsed.toast !== false,
    };
  } catch {
    return { ...DEFAULT };
  }
}

export function saveNotifyPrefs(prefs: NotifyPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* A private-mode storage failure must not break a completion alert. */
  }
}

export type PermissionState = "granted" | "denied" | "default" | "unsupported";

export function notificationPermission(): PermissionState {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}

export async function requestNotificationPermission(): Promise<PermissionState> {
  if (typeof Notification === "undefined") return "unsupported";
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

let audio: AudioContext | undefined;

/** Create and resume the shared context during a real user gesture, so a later completion is allowed to play. */
export function primeAudio(): void {
  if (!loadNotifyPrefs().sound) return;
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    audio ??= new Ctor();
    if (audio.state === "suspended") void audio.resume().catch(() => undefined);
  } catch {
    /* No audio device or no permission; the chime is simply unavailable. */
  }
}

/** A soft two-note chime. Silent on a browser that has not let audio start yet. */
export function playChime(): void {
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    audio ??= new Ctor();
    if (audio.state === "suspended") void audio.resume().catch(() => undefined);
    const now = audio.currentTime;
    const gain = audio.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.045, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);
    gain.connect(audio.destination);
    for (const [frequency, offset] of [
      [660, 0],
      [880, 0.11],
    ] as const) {
      const oscillator = audio.createOscillator();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(frequency, now + offset);
      oscillator.connect(gain);
      oscillator.start(now + offset);
      oscillator.stop(now + offset + 0.24);
    }
  } catch {
    /* No audio permission, no device, or a suspended context: the notification still stands. */
  }
}

const live = new Set<Notification>();

export type CompletionNotice = {
  /** The thread to open on click. */
  sessionId: string;
  title: string;
  body: string;
};

/**
 * Show one desktop notification. It is the caller's job to decide whether the tab is hidden or the thread is
 * not the open one; this function only checks the permission and the preference.
 */
export function showDesktopNotification(notice: CompletionNotice, silent: boolean): void {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    const item = new Notification(notice.title, {
      body: notice.body,
      tag: "dura-agent-" + notice.sessionId,
      icon: "/icon-192.png",
      silent,
    });
    live.add(item);
    item.onclose = () => live.delete(item);
    item.onclick = () => {
      window.focus();
      location.hash = "#/s/" + notice.sessionId;
      item.close();
    };
    window.setTimeout(() => {
      live.delete(item);
      item.close();
    }, 12_000);
  } catch {
    /* Some browsers reject construction on insecure origins; the in-app toast remains. */
  }
}