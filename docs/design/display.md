# Agent display customization

The display system lets an agent change the app's look without editing source, rebuilding or restarting. It is a
deliberate middle ground: expressive enough to make dura-agents feel different, narrow enough that a model cannot
execute code in the shell.

## Model

display.json stores a closed theme:

- displayName, tagline and logo
- accent, background, panel, text and muted colours (hex only)
- font (geist, system, serif or mono), density (compact, comfortable or spacious) and radius (0–28)
- a bounded customCss layer

The server validates every field. customCss is limited to 20,000 characters and rejects @import, url(), remote
URLs, @font-face, javascript:, expression(), behavior and -moz-binding. There is no HTML or JavaScript channel.

## Apply path

The client fetches /api/display during boot, sets the existing CSS variables, the density data attribute,
document.title and one style element, and keeps the saved display in the shared store. The presence socket sends
a whole display snapshot on connect and after each update, so open tabs apply a change live. A tab that missed
the frame sees the same result after a refresh; the file is the source of truth.

## Ownership and recovery

The display is global. Any agent can call customize_ui; the System page reports the last change and offers Reset
display. If a stylesheet hides the app, ?display=default bypasses the saved display for that page load, and the
owner can reset the API or delete data/display.json. The visible brush is powerful enough to be useful, but the
escape hatch does not depend on the hidden UI being reachable.

## Boundaries

This is not source editing. Svelte components, the server and package code remain outside the model. A request for
full self-modification needs a separate design with build/restart, rollback and a much stronger trust boundary.
