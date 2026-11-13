export const CRITERIA = [
  {
    title: "논리와 일관성",
    text: "주장이 논리적이고 타당성 있게 일관적으로 유지되었는가?",
    weight: 20
  },
  {
    title: "쟁점과 논거",
    text: "논제에 대한 주요 쟁점을 이해하고 그에 맞는 논거를 제시하였는가?",
    weight: 20
  },
  {
    title: "반박과 대응",
    text: "상대 주장과 질문에 적절히 대응하였는가?",
    weight: 20
  },
  {
    title: "전달력과 설득력",
    text: "전달력, 설득력 있게 표현하였는가?",
    weight: 20
  },
  {
    title: "시간 활용",
    text: "발언 시간을 적절히 활용하였는가?",
    weight: 10
  },
  {
    title: "토론 예절",
    text: "토론 예절을 준수하며 토론하였는가?",
    weight: 10
  }
];

export const ADMIN_EMAIL = "admin@humanism.local";

export const fmt = ms => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return (
    String(Math.floor(s / 60)).padStart(2, "0") +
    ":" +
    String(s % 60).padStart(2, "0")
  );
};

export function ceda(people) {
  const a1 = people.A[0];
  const a2 = people.A[1] || a1;
  const b1 = people.B[0];
  const b2 = people.B[1] || b1;

  return [
    ["normal", "찬성 입론", 90, "A", a1.id, ""],
    ["cross", "반대 교차조사", 90, "B", b2.id, a1.id],
    ["normal", "반대 입론", 90, "B", b1.id, ""],
    ["cross", "찬성 교차조사", 90, "A", a2.id, b1.id],
    ["free", "자유토론", 600, "N", "", ""],
    ["deliberation", "숙의시간", 60, "N", "", ""],
    ["normal", "반대 최종발언", 120, "B", b2.id, ""],
    ["normal", "찬성 최종발언", 120, "A", a2.id, ""]
  ].map((x, i) => ({
    id: "stage-" + i + "-" + Date.now(),
    type: x[0],
    name: x[1],
    seconds: x[2],
    color: x[3],
    speaker: x[4],
    target: x[5],
    burst: x[0] === "free" ? 120 : 0
  }));
}

export function fresh(c, index, at) {
  const s = c.steps[index];
  return {
    index,
    remaining: s.seconds * 1000,
    a: s.seconds * 1000,
    b: s.seconds * 1000,
    ba: Math.min(s.seconds, s.burst || 0) * 1000,
    bb: Math.min(s.seconds, s.burst || 0) * 1000,
    active: "",
    running: false,
    at,
    revision: 0
  };
}

export function projected(raw, c, at) {
  const s = { ...raw };
  const step = c.steps[s.index];

  if (s.running) {
    const dt = Math.max(0, at - s.at);

    if (step.type !== "free") {
      s.remaining = Math.max(0, s.remaining - dt);
      if (!s.remaining) s.running = false;
    } else if (s.active) {
      const k = s.active === "A" ? "a" : "b";
      const b = k === "a" ? "ba" : "bb";
      const used = Math.min(dt, s[k], s[b]);

      s[k] = Math.max(0, s[k] - used);
      s[b] = Math.max(0, s[b] - used);

      if (!s[k] || !s[b]) s.running = false;
    } else {
      s.running = false;
    }
  }

  s.at = at;
  return s;
}

export function change(raw, c, action, at) {
  let s = projected(raw, c, at);
  const step = c.steps[s.index];

  switch (action.type) {
    case "next":
    case "prev": {
      const i = s.index + (action.type === "next" ? 1 : -1);
      if (i < 0 || i >= c.steps.length) return null;
      s = fresh(c, i, at);
      break;
    }

    case "reset":
      s = fresh(c, s.index, at);
      break;

    case "pause":
      s.running = false;
      break;

    case "toggle":
      if (s.running) {
        s.running = false;
      } else if (step.type !== "free") {
        if (!s.remaining) s.remaining = step.seconds * 1000;
        s.running = true;
      } else if (s.active) {
        const k = s.active === "A" ? "a" : "b";
        s.running = s[k] > 0 && s[k === "a" ? "ba" : "bb"] > 0;
      }
      break;

    case "side": {
      const k = action.side === "A" ? "a" : "b";
      const b = k === "a" ? "ba" : "bb";

      if (!s[k]) return null;

      if (s.active !== action.side) {
        s[b] = Math.min(s[k], step.burst * 1000);
      }

      s.active = action.side;
      s.running = s[b] > 0;
      break;
    }

    case "adjust": {
      const k = action.side === "A" ? "a" : "b";
      const b = k === "a" ? "ba" : "bb";

      s[k] = Math.max(
        0,
        Math.min(step.seconds * 1000, s[k] + action.delta * 1000)
      );
      s[b] = Math.min(s[k], s[b]);

      if (s.active === action.side && (!s[k] || !s[b])) {
        s.running = false;
      }
      break;
    }
  }

  s.revision = raw.revision + 1;
  return s;
}

export function validateScores(scores) {
  if (
    !Array.isArray(scores) ||
    scores.length !== 6 ||
    scores.some(x => !Number.isInteger(x) || x < 0 || x > 100)
  ) {
    throw Error("각 항목을 0~100점으로 평가해주세요.");
  }
}

export function weighted(scores) {
  validateScores(scores);
  return scores.reduce(
    (sum, x, i) => sum + x * CRITERIA[i].weight,
    0
  ) / 100;
}

export function aggregate(responses, settings) {
  const rows = Object.entries(responses || {});
  const judgeIds = settings.mode === "audience"
    ? {}
    : settings.judgeIds || {};

  if (!["judges", "mixed", "audience"].includes(settings.mode)) {
    throw Error("평가 방식을 선택해주세요.");
  }

  const percent = settings.mode === "judges"
    ? 100
    : settings.mode === "audience"
      ? 0
      : Number(settings.judgeWeight);

  if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
    throw Error("반영 비중을 확인해주세요.");
  }

  const judges = rows.filter(([id]) => judgeIds[id]);
  const audience = rows.filter(([id]) => !judgeIds[id]);

  if (settings.mode !== "audience" && judges.length > 3) {
    throw Error("심사위원은 최대 3명입니다.");
  }
  if (percent > 0 && !judges.length) {
    throw Error("심사위원으로 지정된 응답이 없습니다.");
  }
  if (percent < 100 && !audience.length) {
    throw Error("청중 응답이 없습니다.");
  }

  const sum = list => list.reduce((v, [, r]) => {
    validateScores(r.scores);
    return v + r.scores.reduce(
      (a, x, i) => a + x * CRITERIA[i].weight,
      0
    );
  }, 0);

  const jSum = sum(judges);
  const aSum = sum(audience);
  const j = judges.length;
  const a = audience.length;

  let numerator;
  let denominator;

  if (percent === 100) {
    numerator = jSum;
    denominator = 100 * j;
  } else if (percent === 0) {
    numerator = aSum;
    denominator = 100 * a;
  } else {
    numerator =
      percent * jSum * a +
      (100 - percent) * aSum * j;
    denominator = 10000 * j * a;
  }

  const pro = numerator / denominator;

  return {
    pro,
    con: 100 - pro,
    winner: numerator === 50 * denominator
      ? "draw"
      : numerator > 50 * denominator ? "A" : "B",
    mode: settings.mode,
    judgeWeight: percent,
    judgeCount: j,
    audienceCount: a,
    responseCount: rows.length,
    judgeMean: j ? jSum / 100 / j : null,
    audienceMean: a ? aSum / 100 / a : null
  };
}

export function migrateConfig(c) {
  if (c.people) return c;

  const people = {
    A: (c.sideANames || ["찬성1", "찬성2"]).map((name, i) => ({
      id: "A" + i,
      name
    })),
    B: (c.sideBNames || ["반대1", "반대2"]).map((name, i) => ({
      id: "B" + i,
      name
    }))
  };

  const all = [...people.A, ...people.B];

  return {
    mode: c.mode,
    topic: c.topic,
    people,
    steps: c.steps.map((s, i) => ({
      id: "legacy-" + i,
      type: s.type === "free"
        ? "free"
        : s.target
          ? "cross"
          : s.name === "숙의시간" ? "deliberation" : "normal",
      name: s.name,
      seconds: s.seconds,
      burst: s.burst_limit || 0,
      color: s.color_role || "N",
      speaker: all.find(p => p.name === s.speaker)?.id || "",
      target: all.find(p => p.name === s.target)?.id || ""
    }))
  };
}
