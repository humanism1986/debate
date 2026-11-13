const safeId = value => /^[A-Za-z0-9_-]{1,128}$/.test(value || "");

export function routePath(screen) {
  const id = encodeURIComponent(screen.id || "");
  const code = encodeURIComponent(screen.code || "");

  switch (screen.name) {
    case "timer-menu":
      return "/timer";
    case "setup":
      return "/timer/setup";
    case "join":
      return "/timer/join";
    case "timer":
      return "/timer/room/" + code + (screen.host ? "/host" : "");
    case "board":
      return "/evaluations";
    case "create":
      return "/evaluations/new";
    case "ballot":
      return "/evaluations/" + id;
    case "submitted":
      return "/evaluations/" + id + "/submitted";
    case "manage":
      return "/evaluations/" + id + "/manage";
    case "detail":
      return "/evaluations/" + id + "/responses/" +
        encodeURIComponent(screen.responseId || "");
    case "countdown":
      return "/evaluations/" + id + "/countdown";
    case "result":
      return "/evaluations/" + id + "/result";
    default:
      return "";
  }
}

export function parseRoute(hash) {
  let parts;

  try {
    parts = String(hash || "")
      .replace(/^#/, "")
      .split("/")
      .filter(Boolean)
      .map(decodeURIComponent);
  } catch (_) {
    return { name: "cover" };
  }

  if (!parts.length) return { name: "cover" };

  if (parts[0] === "timer") {
    if (parts.length === 1) {
      return { name: "timer-menu" };
    }

    if (parts.length === 2 && parts[1] === "setup") {
      return { name: "setup" };
    }

    if (parts.length === 2 && parts[1] === "join") {
      return { name: "join" };
    }

    if (
      parts[1] === "room" &&
      /^[A-Z0-9]{4,6}$/.test(parts[2] || "")
    ) {
      if (
        parts.length === 3 ||
        (parts.length === 4 && parts[3] === "host")
      ) {
        return {
          name: "timer",
          code: parts[2],
          host: parts[3] === "host"
        };
      }
    }
  }

  if (parts[0] === "evaluations") {
    if (parts.length === 1) {
      return { name: "board" };
    }

    if (parts.length === 2 && parts[1] === "new") {
      return { name: "create" };
    }

    const id = parts[1];

    if (!safeId(id)) return { name: "cover" };

    if (parts.length === 2) {
      return { name: "ballot", id };
    }

    if (
      parts.length === 3 &&
      ["submitted", "manage", "countdown", "result"].includes(parts[2])
    ) {
      return { name: parts[2], id };
    }

    if (
      parts.length === 4 &&
      parts[2] === "responses" &&
      safeId(parts[3])
    ) {
      return {
        name: "detail",
        id,
        responseId: parts[3]
      };
    }
  }

  return { name: "cover" };
}

export function screenUrl(screen) {
  const url = new URL(location.href);
  url.searchParams.delete("room");
  url.hash = routePath(screen) ? "#" + routePath(screen) : "";
  return url.href;
}

export function createRouter({ capture, restore, depart, onError }) {
  const snapshots = new Map();
  const stamp = () => crypto.randomUUID();
  const previous = history.state;

  let current = {
    humanism: true,
    key: stamp(),
    index: previous?.humanism === true ? previous.index || 0 : 0
  };

  let epoch = 0;
  let used = false;
  let lastHref = location.href;

  history.replaceState(current, "", location.href);

  function remember() {
    snapshots.set(current.key, capture());
  }

  function go(screen, replace = false) {
    epoch++;
    used = true;
    remember();

    current = {
      humanism: true,
      key: stamp(),
      index: replace ? current.index : current.index + 1
    };

    history[replace ? "replaceState" : "pushState"](
      current,
      "",
      screenUrl(screen)
    );

    lastHref = location.href;
  }

  async function arrive(state, initial = false) {
    const turn = ++epoch;
    const alive = () => turn === epoch;

    if (!initial) remember();

    current = state?.humanism === true
      ? state
      : {
          humanism: true,
          key: stamp(),
          index: current.index + 1
        };

    history.replaceState(current, "", location.href);
    lastHref = location.href;

    const target = parseRoute(location.hash);

    try {
      if (!initial && depart) await depart();
      if (!alive()) return;

      const actual = await restore(
        target,
        snapshots.get(current.key),
        alive
      );

      if (!alive() || !actual) return;

      history.replaceState(current, "", screenUrl(actual));
      lastHref = location.href;
    } catch (error) {
      if (alive()) onError(error);
    }
  }

  window.addEventListener("popstate", event => {
    void arrive(event.state);
  });

  window.addEventListener("hashchange", () => {
    if (location.href !== lastHref) {
      void arrive(history.state);
    }
  });

  return {
    go,

    back() {
      if (current.index <= 0) return false;
      history.back();
      return true;
    },

    async start() {
      if (!used) await arrive(current, true);
    }
  };
}
