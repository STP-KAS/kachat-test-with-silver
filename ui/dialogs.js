// In-app confirm / prompt / choose overlays.
//
// The browser's own `window.confirm`, `window.prompt` and `window.alert` announce themselves as
// "localhost:5173 says", which is the BROWSER speaking about the page rather than the app speaking
// to its user. On a page people are trusting with money that is the wrong voice, and it looks like
// something has gone wrong even when nothing has. These are the replacements: same shapes, same
// promise-returning ergonomics, rendered in the app's own chrome.
//
// One module rather than one per screen, so the confirm before deleting a group looks exactly like
// the confirm before wiping an account.

let host = null;
let settle = null;

function ensureHost() {
  if (host) return host;
  host = document.createElement("div");
  host.className = "modal-backdrop app-dialog-backdrop";
  host.hidden = true;
  host.innerHTML = `<div class="contact-modal app-dialog" role="dialog" aria-modal="true" data-app-dialog-body></div>`;
  document.body.appendChild(host);

  // A click on the backdrop itself cancels; a click inside must not.
  host.addEventListener("mousedown", (event) => { if (event.target === host) finish(null); });
  host.addEventListener("click", (event) => {
    if (event.target.closest("[data-app-dialog-cancel]")) { finish(null); return; }
    if (event.target.closest("[data-app-dialog-ok]")) {
      const input = host.querySelector("[data-app-dialog-input]");
      finish(input ? String(input.value) : true);
      return;
    }
    const choice = event.target.closest("[data-app-dialog-choice]");
    if (choice) finish(choice.dataset.appDialogChoice);
  });
  host.addEventListener("keydown", (event) => {
    if (event.key === "Escape") finish(null);
    if (event.key === "Enter" && host.querySelector("[data-app-dialog-input]")) {
      event.preventDefault();
      finish(String(host.querySelector("[data-app-dialog-input]").value));
    }
  });
  return host;
}

function finish(result) {
  if (host) host.hidden = true;
  const resolve = settle;
  settle = null;
  resolve?.(result);
}

function escape(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function headerHtml(kicker, title) {
  return `
    <div class="modal-header">
      <div>${kicker ? `<p class="modal-kicker">${escape(kicker)}</p>` : ""}<h2>${escape(title)}</h2></div>
      <button class="modal-close" type="button" data-app-dialog-cancel aria-label="Close">×</button>
    </div>`;
}

/// Message lines are escaped but newlines survive, so the callers that used "\n\n" in a
/// window.confirm keep their paragraphing.
function bodyHtml(message) {
  if (!message) return "";
  return String(message).split("\n").filter((line) => line.trim())
    .map((line) => `<p class="field-hint">${escape(line)}</p>`).join("");
}

function present(html, focusSelector) {
  const el = ensureHost();
  el.querySelector("[data-app-dialog-body]").innerHTML = html;
  el.hidden = false;
  const focus = focusSelector ? el.querySelector(focusSelector) : el.querySelector("[data-app-dialog-ok]");
  focus?.focus();
  if (focus?.select) focus.select();
}

/// Resolves true when confirmed, false otherwise - never rejects, so callers read as an `if`.
export function confirmDialog({ title, message = "", kicker = null, confirmLabel = "Confirm", destructive = false } = {}) {
  return new Promise((resolve) => {
    settle = (value) => resolve(value !== null);
    present(`
      ${headerHtml(kicker, title)}
      ${bodyHtml(message)}
      <div class="modal-actions">
        <button class="secondary-button" type="button" data-app-dialog-cancel>Cancel</button>
        <button class="primary-button${destructive ? " danger" : ""}" type="button" data-app-dialog-ok>${escape(confirmLabel)}</button>
      </div>`);
  });
}

/// Resolves the typed string, or null when cancelled.
export function promptDialog({ title, label = "", message = "", kicker = null, initial = "", confirmLabel = "Save", maxLength = 120 } = {}) {
  return new Promise((resolve) => {
    settle = resolve;
    present(`
      ${headerHtml(kicker, title)}
      ${bodyHtml(message)}
      <div class="portfolio-editor-body">
        <label class="portfolio-editor-field">
          ${label ? `<span>${escape(label)}</span>` : ""}
          <input type="text" maxlength="${Number(maxLength) || 120}" data-app-dialog-input value="${escape(initial)}" />
        </label>
      </div>
      <div class="modal-actions">
        <button class="secondary-button" type="button" data-app-dialog-cancel>Cancel</button>
        <button class="primary-button" type="button" data-app-dialog-ok>${escape(confirmLabel)}</button>
      </div>`, "[data-app-dialog-input]");
  });
}

/// One of several named options, resolved as the chosen option's `id`, or null when cancelled.
/// Replaces the pattern of listing options in a prompt and asking for a number.
export function chooseDialog({ title, message = "", kicker = null, options = [] } = {}) {
  return new Promise((resolve) => {
    settle = resolve;
    present(`
      ${headerHtml(kicker, title)}
      ${bodyHtml(message)}
      <div class="cold-action-rows">
        ${options.map((option) => `
          <button type="button" class="cold-action-row" data-app-dialog-choice="${escape(option.id)}">
            <span class="cold-action-copy">
              <strong>${escape(option.title)}</strong>
              ${option.subtitle ? `<small>${escape(option.subtitle)}</small>` : ""}
            </span>
          </button>`).join("")}
      </div>`);
  });
}

/// Drop-in replacements for a bare `confirm(text)` / `prompt(text, initial)`.
///
/// The app had twenty-two of these, each with its wording already written as one string. Splitting
/// every one by hand into a title and a body would have been twenty-two chances to change what a
/// warning says while moving it. These keep the text exactly as it was: the first line becomes the
/// heading, the rest the body, which is how those strings were already written - a short question,
/// then the consequences after a blank line.
export function confirmText(text, options = {}) {
  const [first, ...rest] = String(text ?? "").split("\n");
  return confirmDialog({
    title: first.trim() || "Confirm",
    message: rest.join("\n").trim(),
    ...options,
  });
}

export function promptText(text, initial = "", options = {}) {
  const [first, ...rest] = String(text ?? "").split("\n");
  return promptDialog({
    title: first.trim() || "Enter a value",
    message: rest.join("\n").trim(),
    initial,
    ...options,
  });
}
