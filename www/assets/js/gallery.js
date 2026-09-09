/*
  The gallery on a car page.

  It does two things: switches the photo when a thumbnail is clicked, and opens it
  full screen over the page.

  Why a script at all. Both the large photo and the thumbnails used to be links
  straight to the file in storage. Clicking one took a person off the site to a
  bare Supabase address — somebody else's domain in the address bar and not a
  single way back. Now they are buttons: the page stays where it is, and the
  storage address is not shown to the visitor.

  An honest caveat: an address cannot be hidden completely on a static site — the
  browser downloads the file from it anyway, and it is visible in the developer
  panel or through "Open image in new tab". The script takes the address out of
  the ordinary user path; it does not hide it altogether.

  If the script does not load, the page does not break: the large photo and the
  row of thumbnails stay where they are, they simply stop switching.
*/

document.querySelectorAll(".gallery").forEach(function (gallery) {
  var main = gallery.querySelector(".gallery__main");
  if (!main) return;

  var mainImg = main.querySelector("img");
  var thumbs = Array.prototype.slice.call(gallery.querySelectorAll(".gallery__thumb"));
  /* A photo has two addresses: the plain one and the set of copies for different
     screens (srcset). We deliberately keep them as a pair. Swapping src alone is
     NOT ENOUGH: srcset outranks it, and while it still points at the previous
     photo nothing changes on screen. That is exactly what broke the gallery when
     photos started being served as copies sized for the screen.

     data-full on a thumbnail is the set of copies of THIS photo for the large
     frame, not for the thumbnail: the thumbnail's set is a hundred points wide and
     would be mush in the large frame. */
  var sources = thumbs.length
    ? thumbs.map(function (b) {
        return { src: b.querySelector("img").getAttribute("src"),
                 set: b.getAttribute("data-full") || "" };
      })
    : [{ src: mainImg.getAttribute("src"), set: mainImg.getAttribute("srcset") || "" }];
  var bigSizes = gallery.dataset.sizes || "";
  var current = 0;

  /** Put a photo into an image tag — always together with its set of copies. */
  function put(img, photo, sizes) {
    if (photo.set) {
      img.setAttribute("sizes", sizes);
      img.setAttribute("srcset", photo.set);
    } else {
      img.removeAttribute("srcset");
      img.removeAttribute("sizes");
    }
    img.setAttribute("src", photo.src);
  }

  function show(index) {
    current = (index + sources.length) % sources.length;
    put(mainImg, sources[current], bigSizes);
    thumbs.forEach(function (b, n) { b.classList.toggle("is-active", n === current); });
    if (box) put(boxImg, sources[current], "100vw");
  }

  thumbs.forEach(function (thumb, n) {
    thumb.addEventListener("click", function () { show(n); });
  });

  /* ── Arrows over the large photo ────────────────────────────────────
     The wrapper and the buttons are built here rather than in the markup: if the
     script does not load, no arrows that lead nowhere are left on the page. */
  if (sources.length > 1) {
    var stage = document.createElement("div");
    stage.className = "gallery__stage";
    main.parentNode.insertBefore(stage, main);
    stage.appendChild(main);
    stage.appendChild(arrow("prev", -1));
    stage.appendChild(arrow("next", 1));
  }

  function arrow(dir, step) {
    return button("gallery__arrow gallery__arrow--" + dir, label(dir),
      function () { show(current + step); });
  }

  /* ── Full-screen view ───────────────────────────────────────────────
     The layer is built once, on first opening: until a person clicks a photo,
     there are no extra nodes in the document. */
  var box = null, boxImg = null, opener = null;

  function label(name) { return gallery.dataset[name] || ""; }

  function build() {
    box = document.createElement("div");
    box.className = "lightbox";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");

    boxImg = document.createElement("img");
    boxImg.className = "lightbox__img";
    boxImg.setAttribute("alt", mainImg.getAttribute("alt") || "");

    var closeBtn = button("lightbox__close", label("close"), close);
    box.appendChild(boxImg);
    box.appendChild(closeBtn);

    if (sources.length > 1) {
      box.appendChild(button("lightbox__nav lightbox__nav--prev", label("prev"),
        function () { show(current - 1); }));
      box.appendChild(button("lightbox__nav lightbox__nav--next", label("next"),
        function () { show(current + 1); }));
    }

    // A click outside the photo closes it: familiar, and no need to aim at the cross
    box.addEventListener("click", function (event) {
      if (event.target === box) close();
    });

    document.body.appendChild(box);
  }

  function button(className, text, onClick) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = className;
    b.setAttribute("aria-label", text);
    b.addEventListener("click", onClick);
    return b;
  }

  function onKey(event) {
    if (event.key === "Escape") close();
    else if (event.key === "ArrowLeft") show(current - 1);
    else if (event.key === "ArrowRight") show(current + 1);
  }

  function open() {
    if (!box) build();
    opener = document.activeElement;
    put(boxImg, sources[current], "100vw");
    box.classList.add("is-open");
    // The background under the layer must not scroll under a finger
    document.documentElement.style.overflow = "hidden";
    document.addEventListener("keydown", onKey);
    box.querySelector(".lightbox__close").focus();
  }

  function close() {
    box.classList.remove("is-open");
    document.documentElement.style.overflow = "";
    document.removeEventListener("keydown", onKey);
    if (opener && opener.focus) opener.focus();
  }

  main.addEventListener("click", open);
});
