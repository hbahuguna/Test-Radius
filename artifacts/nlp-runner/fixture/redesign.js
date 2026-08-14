(function () {
  var params = new URLSearchParams(window.location.search);
  var param = params.get("redesign");
  if (param === "1") {
    sessionStorage.setItem("qf-redesign", "1");
  } else if (param === "0") {
    sessionStorage.setItem("qf-redesign", "0");
  }
  var enabled =
    param !== null
      ? param === "1"
      : sessionStorage.getItem("qf-redesign") === "1";
  if (!enabled) return;

  var REDESIGN_TESTIDS = {
    "login-email": "login-email-address",
    "login-password": "login-password-field",
    "login-submit": "btn-sign-in",
    "login-result": "login-message",
    "signup-name": "signup-full-name",
    "signup-email": "signup-email-address",
    "signup-password": "signup-password-field",
    "signup-submit": "btn-create-account",
    "signup-result": "signup-message",
    "waitlist-email": "waitlist-email-address",
    "waitlist-submit": "btn-join-waitlist",
    "waitlist-result": "waitlist-message",
    "plan-card": "pricing-plan",
    "plan-name": "pricing-plan-title",
    "plan-price": "pricing-plan-price",
    "plan-desc": "pricing-plan-desc",
    "dynamic-status": "dynamic-label",
    "dynamic-appears": "dynamic-reveal-btn",
    "dynamic-clicked": "dynamic-message",
  };

  var card = document.querySelector(".card");
  if (card) {
    var banner = document.createElement("p");
    banner.className = "redesign-banner";
    banner.dataset.testid = "redesign-banner";
    banner.textContent = "Redesigned layout";
    card.prepend(banner);
  }

  var nav = document.querySelector("nav.back");
  if (nav && card) {
    card.prepend(nav);
  }

  var elements = document.querySelectorAll("[data-testid]");
  for (var i = 0; i < elements.length; i++) {
    var renamed = REDESIGN_TESTIDS[elements[i].dataset.testid];
    if (renamed) elements[i].dataset.testid = renamed;
  }

  document.body.classList.add("redesign");
})();
