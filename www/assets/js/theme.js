/*
  Two small things CSS alone cannot do: the theme switch and opening the menu
  under the burger on a narrow screen.

  How it works: the button records the choice in the browser's memory and puts a
  data-theme attribute on the root element. The styles in style.css see that
  attribute and substitute a different set of colours.

  Applying the theme itself does not happen here but in a small script in the
  <head> of every page — it has to run BEFORE painting, otherwise a dark page
  flashes white.
*/

document.querySelectorAll(".theme").forEach(function (button) {
  button.addEventListener("click", function () {
    var root = document.documentElement;
    var systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    var current = root.dataset.theme || (systemDark ? "dark" : "light");
    var next = current === "dark" ? "light" : "dark";

    root.dataset.theme = next;

    try {
      localStorage.setItem("theme", next);
    } catch (e) {
      /* private mode — we simply do not remember the choice */
    }
  });
});


/*
  The menu under the burger.

  The styling itself is in style.css: on a narrow screen the panel slides in from
  the side, on a wide one the wrappers get display: contents and it dissolves back
  into the header row. All the script has to do is open it, close it and hold the
  scrolling.

  If the script does not load, the header does not break: the logo and the booking
  button are in place, the burger simply opens nothing.
*/
document.querySelectorAll(".burger").forEach(function (burger) {
  var menu = document.getElementById(burger.getAttribute("aria-controls"));
  if (!menu) return;

  function show(open) {
    menu.classList.toggle("is-open", open);
    burger.setAttribute("aria-expanded", open ? "true" : "false");
    // The page under the opened drawer must not scroll under a finger.
    // The same trick as the full-screen photo view in gallery.js.
    document.documentElement.style.overflow = open ? "hidden" : "";
  }

  burger.addEventListener("click", function (event) {
    event.stopPropagation();
    show(burger.getAttribute("aria-expanded") !== "true");
  });

  // The cross — close smoothly, the person stays on the same page.
  // A link — close instantly, with no slide: the page is about to change anyway,
  // and there is nobody left to play out half a second of animation.
  //
  // This does not affect the theme button: after a theme change the menu stays
  // open, so you can see what you got.
  menu.addEventListener("click", function (event) {
    if (event.target.closest(".drawer-close")) { show(false); return; }
    if (event.target.closest("a")) {
      menu.classList.add("is-instant");
      show(false);
    }
  });

  /* A page transition takes a copy of the outgoing page, and the header has been
     given a view-transition-name (see style.css, "Page transition"). So the drawer,
     which lives inside the header, ends up in that copy too. If it has not slid
     away by that moment, it briefly flashes over the already loaded new page and
     disappears.

     pageswap fires exactly before the copy is taken — we close here with no
     animation and the copy comes out clean. The click handler above does not save
     us on its own: it does not catch Back and Forward through history. */
  window.addEventListener("pageswap", function () {
    menu.classList.add("is-instant");
    show(false);
  });

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") show(false);
  });

  // A click outside the header closes it — familiar, and no need to aim at the burger.
  document.addEventListener("click", function (event) {
    if (!event.target.closest(".head")) show(false);
  });
});
