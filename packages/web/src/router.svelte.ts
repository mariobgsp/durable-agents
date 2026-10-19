/// <reference types="svelte" />
type Route =
  | { name: "home" }
  | { name: "session"; id: string }
  | { name: "groups" }
  | { name: "agents" }
  | { name: "providers" }
  | { name: "usage" }
  | { name: "system" }
  | { name: "agent"; id: string };

function parse(): Route {
  const hash = location.hash.replace(/^#\/?/, "");
  const session = hash.match(/^s\/(.+)$/);
  if (session?.[1]) return { name: "session", id: session[1] };
  const agent = hash.match(/^agents\/(.+)$/);
  if (agent?.[1]) return { name: "agent", id: agent[1] };
  if (hash === "groups") return { name: "groups" };
  if (hash === "providers") return { name: "providers" };
  if (hash === "usage") return { name: "usage" };
  if (hash === "system") return { name: "system" };
  if (hash === "agents") return { name: "agents" };
  return { name: "home" };
}

export const route = $state<Route>(parse());

window.addEventListener("hashchange", () => {
  Object.assign(route, parse());
});

export function go(hash: string): void {
  if (location.hash === hash) Object.assign(route, parse());
  else location.hash = hash;
}

