(function () {
  "use strict";

  var header = document.getElementById("siteHeader");
  var nav = document.getElementById("primaryNav");
  var toggle = document.getElementById("menuToggle");

  // Mobile menu
  toggle.addEventListener("click", function () {
    var open = nav.classList.toggle("open");
    toggle.setAttribute("aria-expanded", String(open));
  });

  // Dropdowns: click to open on touch/mobile, hover handled in CSS
  Array.prototype.forEach.call(document.querySelectorAll(".sub-toggle"), function (btn) {
    btn.addEventListener("click", function (e) {
      e.preventDefault();
      var open = btn.getAttribute("aria-expanded") === "true";
      document.querySelectorAll('.sub-toggle[aria-expanded="true"]').forEach(function (other) {
        if (other !== btn) other.setAttribute("aria-expanded", "false");
      });
      btn.setAttribute("aria-expanded", String(!open));
    });
  });

  document.addEventListener("click", function (e) {
    if (!e.target.closest(".has-sub")) {
      document.querySelectorAll('.sub-toggle[aria-expanded="true"]').forEach(function (b) {
        b.setAttribute("aria-expanded", "false");
      });
    }
  });

  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    nav.classList.remove("open");
    toggle.setAttribute("aria-expanded", "false");
    document.querySelectorAll('.sub-toggle[aria-expanded="true"]').forEach(function (b) {
      b.setAttribute("aria-expanded", "false");
    });
  });

  // Close mobile menu after choosing a link
  nav.addEventListener("click", function (e) {
    if (e.target.tagName === "A" && window.innerWidth <= 900) {
      nav.classList.remove("open");
      toggle.setAttribute("aria-expanded", "false");
    }
  });

  // Header shadow on scroll
  var onScroll = function () {
    header.classList.toggle("scrolled", window.scrollY > 8);
  };
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });

  // Accordion: one panel open at a time
  var accordion = document.getElementById("accordion");
  if (accordion) {
    accordion.addEventListener("toggle", function (e) {
      var item = e.target;
      if (item.tagName !== "DETAILS" || !item.open) return;
      accordion.querySelectorAll("details[open]").forEach(function (other) {
        if (other !== item) other.open = false;
      });
    }, true);
  }

  // Scroll reveal
  var targets = document.querySelectorAll(".section > .wrap > *, .card, .person, .price, .steps li");
  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("in");
        io.unobserve(entry.target);
      });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.06 });

    targets.forEach(function (el) {
      el.classList.add("reveal");
      io.observe(el);
    });
  }

  // Request form (front-end only)
  var form = document.getElementById("requestForm");
  var status = document.getElementById("formStatus");
  if (form) {
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (!form.checkValidity()) {
        status.textContent = "Please add an athlete name and a valid email.";
        form.reportValidity();
        return;
      }
      var name = form.elements.name.value.trim();
      status.textContent = "Thanks " + name + " — your request has been noted. Lotus will follow up by email.";
      form.reset();
    });
  }

  document.getElementById("year").textContent = new Date().getFullYear();
})();
