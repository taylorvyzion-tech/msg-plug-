/**
 * MSGPlug embeddable chat widget.
 *
 * A shop drops this one line on their site:
 *
 *   <script src="https://YOUR-HOST/widget.js"
 *           data-slug="fresh-fade-studio"
 *           data-accent="#C9A227"
 *           data-label="Chat with us"></script>
 *
 * It renders a floating bubble that opens the shop's chat page in an iframe.
 */
(function () {
  var script =
    document.currentScript ||
    (function () {
      var all = document.getElementsByTagName("script");
      return all[all.length - 1];
    })();

  var slug = script.getAttribute("data-slug");
  if (!slug) {
    console.error("[MSGPlug] widget.js needs a data-slug attribute.");
    return;
  }

  var origin = script.getAttribute("data-host") || new URL(script.src, location.href).origin;
  var accent = script.getAttribute("data-accent") || "#C9A227";
  var label = script.getAttribute("data-label") || "Chat with us";
  var emoji = script.getAttribute("data-emoji") || "💬";
  var side = script.getAttribute("data-position") === "left" ? "left" : "right";

  var open = false;

  var style = document.createElement("style");
  style.textContent = [
    ".msgplug-btn{position:fixed;bottom:20px;" + side + ":20px;z-index:2147483000;",
    "display:flex;align-items:center;gap:8px;padding:13px 18px;border:0;border-radius:999px;",
    "background:" + accent + ";color:#000;font:600 15px/1 Inter,system-ui,-apple-system,'Segoe UI',sans-serif;",
    "cursor:pointer;box-shadow:0 6px 24px rgba(0,0,0,.3);transition:transform .18s ease}",
    ".msgplug-btn:hover{transform:translateY(-2px)}",
    ".msgplug-frame{position:fixed;bottom:88px;" + side + ":20px;z-index:2147483000;",
    "width:380px;height:min(620px,calc(100vh - 120px));border:0;border-radius:16px;",
    "box-shadow:0 12px 48px rgba(0,0,0,.45);background:#0B0B0B;display:none;overflow:hidden}",
    ".msgplug-frame.open{display:block}",
    "@media(max-width:460px){.msgplug-frame{width:calc(100vw - 24px);" + side + ":12px;",
    "height:calc(100vh - 110px);bottom:80px}}",
  ].join("");
  document.head.appendChild(style);

  var frame = document.createElement("iframe");
  frame.className = "msgplug-frame";
  frame.title = "Chat";
  frame.setAttribute("loading", "lazy");

  var btn = document.createElement("button");
  btn.className = "msgplug-btn";
  btn.type = "button";
  btn.setAttribute("aria-label", label);
  btn.innerHTML = "<span>" + emoji + "</span><span>" + label + "</span>";

  btn.addEventListener("click", function () {
    open = !open;
    if (open && !frame.src) {
      frame.src = origin + "/c/" + encodeURIComponent(slug);
    }
    frame.classList.toggle("open", open);
    btn.innerHTML = open
      ? "<span>✕</span><span>Close</span>"
      : "<span>" + emoji + "</span><span>" + label + "</span>";
  });

  function mount() {
    document.body.appendChild(frame);
    document.body.appendChild(btn);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
})();
