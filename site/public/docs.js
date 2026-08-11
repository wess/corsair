/*
 * Progressive enhancement only. Every page works with this file blocked: the
 * nav is a list of links, the table of contents is anchors, and a code block is
 * selectable text. Nothing here is required to read the documentation.
 */
;(function () {
  "use strict"

  // ------------------------------------------------------------------ menu --
  var toggle = document.querySelector(".menu")
  var nav = document.getElementById("site-nav")
  if (toggle && nav) {
    toggle.addEventListener("click", function () {
      var open = nav.classList.toggle("open")
      toggle.setAttribute("aria-expanded", open ? "true" : "false")
    })
  }

  // ----------------------------------------------------------------- theme --
  // Three states: no stored value means follow the system. Clicking stores the
  // opposite of whatever is currently on screen, so the first click always
  // visibly changes something.
  var theme = document.querySelector(".theme")
  if (theme) {
    theme.addEventListener("click", function () {
      var root = document.documentElement
      var dark =
        root.getAttribute("data-theme") === "dark" ||
        (!root.getAttribute("data-theme") &&
          window.matchMedia("(prefers-color-scheme: dark)").matches)
      var next = dark ? "light" : "dark"
      root.setAttribute("data-theme", next)
      try {
        localStorage.setItem("corsair-theme", next)
      } catch (e) {
        /* private browsing; the choice just does not persist */
      }
    })
  }

  // ------------------------------------------------------------------ copy --
  var blocks = document.querySelectorAll("figure.code")
  Array.prototype.forEach.call(blocks, function (figure) {
    if (!navigator.clipboard) return
    var button = document.createElement("button")
    button.type = "button"
    button.className = "copy"
    button.textContent = "Copy"
    button.addEventListener("click", function () {
      var code = figure.querySelector("code")
      navigator.clipboard.writeText(code ? code.textContent : "").then(function () {
        button.textContent = "Copied"
        setTimeout(function () {
          button.textContent = "Copy"
        }, 1400)
      })
    })
    figure.appendChild(button)
  })

  // ------------------------------------------------------------------- toc --
  var links = document.querySelectorAll(".toc a")
  if (!links.length || !("IntersectionObserver" in window)) return

  var byId = {}
  Array.prototype.forEach.call(links, function (link) {
    byId[link.getAttribute("href").slice(1)] = link
  })

  var targets = Object.keys(byId)
    .map(function (id) {
      return document.getElementById(id)
    })
    .filter(Boolean)

  var active = null
  var observer = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return
        if (active) active.classList.remove("here")
        active = byId[entry.target.id]
        if (active) active.classList.add("here")
      })
    },
    // Only the band just below the sticky masthead counts as "here", so the
    // highlight tracks what is being read rather than everything on screen.
    { rootMargin: "-6rem 0px -75% 0px" },
  )

  targets.forEach(function (target) {
    observer.observe(target)
  })
})()
