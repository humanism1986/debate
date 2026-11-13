import { initializeApp } from "https://www.gstatic.com/firebasejs/13.3.0/firebase-app.js";

import {
  getAuth,
  initializeAuth,
  inMemoryPersistence,
  signInAnonymously,
  signInWithEmailAndPassword,
  signOut
} from "https://www.gstatic.com/firebasejs/13.3.0/firebase-auth.js";

import {
  getDatabase,
  ref,
  get,
  onValue,
  set,
  update,
  push,
  runTransaction,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/13.3.0/firebase-database.js";

import { firebaseConfig } from "./config.js";

import {
  ADMIN_EMAIL,
  aggregate,
  change,
  fresh,
  migrateConfig
} from "./core.js";

export async function createBackend() {
  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const db = getDatabase(app);

  const adminApp = initializeApp(firebaseConfig, "humanism-admin");
  const adminAuth = initializeAuth(adminApp, {
    persistence: inMemoryPersistence
  });
  const adminDb = getDatabase(adminApp);

  await auth.authStateReady();

  const user = auth.currentUser ||
    (await signInAnonymously(auth)).user;

  let offset = 0;
  let connected = false;
  let timeReady = false;

  const connectListeners = new Set();

  const report = () => {
    connectListeners.forEach(fn => fn(connected && timeReady));
  };

  onValue(ref(db, ".info/connected"), snapshot => {
    connected = snapshot.val() === true;
    report();
  });

  onValue(ref(db, ".info/serverTimeOffset"), snapshot => {
    offset = Number(snapshot.val()) || 0;
    timeReady = true;
    report();
  });

  const ready = () => {
    if (!connected || !timeReady) {
      throw Error("인터넷 연결을 확인하고 다시 시도해주세요.");
    }
  };

  const watch = (database, path, fn, fail) => {
    return onValue(
      ref(database, path),
      snapshot => fn(snapshot.val()),
      fail
    );
  };

  const me = () => user.uid;

  const transactRead = async (target, fn) => {
    let stop = () => {};

    try {
      await new Promise((resolve, reject) => {
        stop = onValue(target, () => resolve(), reject);
      });

      return await runTransaction(target, fn, {
        applyLocally: false
      });
    } finally {
      stop();
    }
  };

  const admin = () => {
    ready();

    if (!adminAuth.currentUser) {
      throw Error("관리자 비밀번호를 다시 입력해주세요.");
    }
  };

  return {
    demo: false,

    uid: me,

    now: () => Date.now() + offset,

    onConnection(fn) {
      connectListeners.add(fn);
      fn(connected && timeReady);
      return () => connectListeners.delete(fn);
    },

    async login(password) {
      ready();

      await signInWithEmailAndPassword(
        adminAuth,
        ADMIN_EMAIL,
        password
      );

      const allowed = await get(
        ref(adminDb, "adminAccess/" + adminAuth.currentUser.uid)
      );

      if (allowed.val() !== true) {
        await signOut(adminAuth);
        throw Error(
          "관리자 권한 설정이 필요합니다. 설치 안내를 확인해주세요."
        );
      }
    },

    logout() {
      return signOut(adminAuth);
    },

    watchBoard(fn, fail) {
      return watch(db, "evaluations", fn, fail);
    },

    watchEvaluation(id, fn, fail) {
      return watch(db, "evaluations/" + id, fn, fail);
    },

    async evaluation(id) {
      ready();
      return (await get(ref(db, "evaluations/" + id))).val();
    },

    async management(id) {
      admin();

      const [m, r] = await Promise.all([
        get(ref(adminDb, "evaluations/" + id)),
        get(ref(adminDb, "results/" + id))
      ]);

      return m.exists()
        ? { ...m.val(), ...(r.val() || {}) }
        : null;
    },

    async ownResponse(id) {
      ready();

      return (
        await get(ref(db, "responses/" + id + "/" + me()))
      ).val();
    },

    async createEvaluation(c) {
      admin();

      const id = push(ref(adminDb, "evaluations")).key;

      await set(ref(adminDb, "evaluations/" + id), {
        ...c,
        createdAt: serverTimestamp(),
        open: true,
        mode: "audience",
        judgeWeight: 50
      });

      return id;
    },

    async submit(id, name, scores) {
      ready();

      await set(ref(db, "responses/" + id + "/" + me()), {
        name,
        scores,
        submittedAt: serverTimestamp()
      });
    },

    watchResponses(id, fn, fail) {
      admin();
      return watch(adminDb, "responses/" + id, fn, fail);
    },

    async deleteEvaluation(id) {
      admin();

      await update(ref(adminDb), {
        ["evaluations/" + id]: null,
        ["responses/" + id]: null,
        ["results/" + id]: null
      });
    },

    async deleteResponse(id, uid) {
      admin();

      await update(ref(adminDb), {
        ["responses/" + id + "/" + uid]: null,
        ["results/" + id]: null
      });
    },

    async finalize(id, settings) {
      admin();

      const er = ref(adminDb, "evaluations/" + id);
      let previous;

      const tx = await transactRead(er, c => {
        if (!c) return;
        previous = c;
        return { ...c, open: false };
      });

      if (!tx.committed) {
        throw Error("평가가 삭제되었거나 마감할 수 없습니다.");
      }

      try {
        const rows = (
          await get(ref(adminDb, "responses/" + id))
        ).val() || {};

        const result = {
          ...aggregate(rows, settings),
          finalizedAt: Date.now() + offset
        };

        await set(ref(adminDb, "results/" + id), {
          ...settings,
          result
        });

        return {
          result,
          responses: rows,
          meta: {
            ...tx.snapshot.val(),
            ...settings,
            result
          }
        };
      } catch (e) {
        await update(er, { open: previous.open });
        throw e;
      }
    },

    async createRoom(code, config) {
      ready();

      const tx = await runTransaction(
        ref(db, "rooms/" + code),
        c => {
          if (c) return;

          return {
            ownerUid: me(),
            createdAt: serverTimestamp(),
            config,
            state: fresh(config, 0, Date.now() + offset)
          };
        },
        { applyLocally: false }
      );

      if (!tx.committed) {
        throw Error(
          "이미 사용 중인 방 코드입니다. 다른 코드를 입력해주세요."
        );
      }
    },

    async getRoom(code) {
      ready();

      const raw = (
        await get(ref(db, "rooms/" + code))
      ).val();

      return raw
        ? { ...raw, config: migrateConfig(raw.config) }
        : null;
    },

    watchRoom(code, fn, fail) {
      return watch(
        db,
        "rooms/" + code,
        x => fn(
          x ? { ...x, config: migrateConfig(x.config) } : null
        ),
        fail
      );
    },

    async roomAction(code, action) {
      ready();

      const tx = await transactRead(
        ref(db, "rooms/" + code),
        c => {
          if (!c || c.ownerUid !== me()) return;

          const config = migrateConfig(c.config);
          const state = change(
            c.state,
            config,
            action,
            Date.now() + offset
          );

          return state ? { ...c, config, state } : undefined;
        }
      );

      if (!tx.committed) {
        throw Error(
          "현재 단계에서 실행할 수 없는 조작입니다."
        );
      }
    },

    async updateRoom(code, config) {
      ready();

      const tx = await transactRead(
        ref(db, "rooms/" + code),
        c => {
          if (!c || c.ownerUid !== me()) return;

          return {
            ...c,
            config,
            state: fresh(config, 0, Date.now() + offset)
          };
        }
      );

      if (!tx.committed) {
        throw Error("방 조작 권한이 없습니다.");
      }
    },

    async closeRoom(code) {
      ready();

      const tx = await transactRead(
        ref(db, "rooms/" + code),
        c => c?.ownerUid === me() ? null : undefined
      );

      if (!tx.committed) {
        throw Error("방을 종료할 수 없습니다.");
      }
    }
  };
}
