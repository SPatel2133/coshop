export const $ = (id) => document.getElementById(id);
export const make = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
export const faces = {
  sage: ":)",
  clay: ":›",
  butter: ":D",
  lilac: ":3",
  sky: ":o",
  rose: ";)",
};
export function showScreen(id) {
  for (const screen of document.querySelectorAll("[data-screen]"))
    screen.hidden = screen.id !== id;
  document.querySelector("#" + id + " h1")?.focus({ preventScroll: true });
}
export function showStatus(code, message, retry) {
  const titles = {
    ROOM_FULL: "All six seats are taken.",
    ROOM_EXPIRED: "This room had its moment.",
    INVALID_LINK: "This link goes nowhere.",
    INVALID_SESSION: "Let’s get you back in.",
    RATE_LIMITED: "A little breather.",
    NETWORK: "Can’t reach your room yet.",
  };
  $("status-kicker").textContent =
    code === "ROOM_FULL" ? "Good company, full house" : "A moment, together";
  $("status-title").textContent = titles[code] || "Finding your room…";
  $("status-description").textContent = message || "";
  $("status-retry").hidden = !retry;
  $("status-retry").onclick = retry || null;
  showScreen("status-page");
}
export function showEntry(join, title) {
  $("room-name-field").hidden = join;
  $("entry-kicker").textContent = join
    ? "They saved you a seat"
    : "Save them a seat";
  $("entry-title").textContent = join
    ? "Your people are here."
    : "Make yourself at home.";
  $("entry-description").textContent = join
    ? title || "A little shopping, together."
    : "A room for your people and whatever catches your eye.";
  $("enter-room").textContent = join ? "Join your people ↗" : "Make room ↗";
  $("entry-error").textContent = "";
  showScreen("entry");
}
export function renderRoom(room, me) {
  $("room-title").textContent = room.name;
  $("seat-count").textContent = room.participants.length + " / 6 seats";
  $("members").replaceChildren(
    ...room.participants.map((person) => {
      const li = make(
        "li",
        undefined,
        "seat" + (person.connected ? "" : " reserved"),
      );
      const face = make(
        "span",
        faces[person.avatar] || ":)",
        "face " + person.avatar,
      );
      face.setAttribute("aria-hidden", "true");
      const label = make("div");
      label.append(
        make("strong", person.name + (person.id === me ? " (you)" : "")),
        make(
          "span",
          person.connected ? "Here" : "Seat saved · up to 10 min",
          "seat-state",
        ),
      );
      li.append(face, label);
      return li;
    }),
  );
  $("company-note").textContent = room.participants.some((p) => !p.connected)
    ? "A lost connection doesn’t lose a friend. Disconnected seats stay reserved for 10 minutes."
    : "Everyone has the same seat. No host controls, no accounts.";
  $("first-friend").hidden = room.participants.length > 1;
  if ($("room").hidden) showScreen("room");
}
