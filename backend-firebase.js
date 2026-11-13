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
  serverTimestamp,
  onDisconnect,
  goOffline,
  goOnline
} from "https://www.gstatic.com/firebasejs/13.3.0/firebase-database.js";

import { firebaseConfig } from "./config.js";

import {
  ADMIN_EMAIL,
  aggregate,
  change,
  fresh,
  migrateConfig,
  roomIsLive,
  controlsRoom
} from "./core.js";

export async function createBackend() {
  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const db = getDatabase(app);

  const adminApp = initializeApp(
    firebaseConfig,
    "humanism-admin"
  );

  const adminAuth = initializeAuth(adminApp, {
    persistence: inMemoryPersistence
  });

  const adminDb = getDatabase(adminApp);

  await auth.authStateReady();

  const user =
    auth.currentUser ||
    (await signInAnonymously(auth)).user;

  let offset = 0;
  let connected = false;
  let timeReady = false;

  const connectListeners = new Set();
  const hostLeases = new Map();

  const report = () => {
    connectListeners.forEach(fn =>
      fn(connected && timeReady)
    );
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
      throw Error(
        "인터넷 연결을 확인하고 다시 시도해주세요."
      );
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
        stop = onValue(
          target,
          () => resolve(),
          reject
        );
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
      throw Error(
        "관리자 비밀번호를 다시 입력해주세요."
      );
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
        ref(
          adminDb,
          "adminAccess/" + adminAuth.currentUser.uid
        )
      );

      if (allowed.val() !== true) {
        await signOut(adminAuth);

        throw Error(
          "관리자 권한 설정이 필요합니다."
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
      return watch(
        db,
        "evaluations/" + id,
        fn,
        fail
      );
    },

    async evaluation(id) {
      ready();

      return (
        await get(ref(db, "evaluations/" + id))
      ).val();
    },

    async management(id) {
      admin();

      const [meta, result] = await Promise.all([
        get(ref(adminDb, "evaluations/" + id)),
        get(ref(adminDb, "results/" + id))
      ]);

      return meta.exists()
        ? {
            ...meta.val(),
            ...(result.val() || {})
          }
        : null;
    },

    async ownResponse(id) {
      ready();

      return (
        await get(
          ref(
            db,
            "responses/" + id + "/" + me()
          )
        )
      ).val();
    },

    async createEvaluation(config) {
      admin();

      const id = push(
        ref(adminDb, "evaluations")
      ).key;

      await set(
        ref(adminDb, "evaluations/" + id),
        {
          ...config,
          createdAt: serverTimestamp(),
          open: true,
          mode: "audience",
          judgeWeight: 50
        }
      );

      return id;
    },

    async submit(id, name, scores) {
      ready();

      const tx = await transactRead(
        ref(
          db,
          "responses/" + id + "/" + me()
        ),
        previous => ({
          name,
          scores,
          submittedAt:
            previous?.submittedAt ||
            serverTimestamp(),
          updatedAt: serverTimestamp()
        })
      );

      if (!tx.committed) {
        throw Error(
          "응답을 저장할 수 없습니다."
        );
      }
    },

    watchResponses(id, fn, fail) {
      admin();

      return watch(
        adminDb,
        "responses/" + id,
        fn,
        fail
      );
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

    async setEvaluationOpen(id, open) {
      admin();

      const tx = await transactRead(
        ref(adminDb, "evaluations/" + id),
        current =>
          current
            ? { ...current, open: !!open }
            : undefined
      );

      if (!tx.committed) {
        throw Error("삭제된 평가입니다.");
      }

      await set(
        ref(adminDb, "results/" + id + "/result"),
        null
      );

      return tx.snapshot.val();
    },

    async finalize(id, settings) {
      admin();

      const [meta, answers] = await Promise.all([
        get(ref(adminDb, "evaluations/" + id)),
        get(ref(adminDb, "responses/" + id))
      ]);

      if (!meta.exists()) {
        throw Error("삭제된 평가입니다.");
      }

      const rows = answers.val() || {};

      const result = {
        ...aggregate(rows, settings),
        finalizedAt: Date.now() + offset
      };

      await set(
        ref(adminDb, "results/" + id),
        {
          ...settings,
          result
        }
      );

      return {
        result,
        responses: rows,
        meta: {
          ...meta.val(),
          ...settings,
          result
        }
      };
    },

    ownsRoom(code, value) {
      return controlsRoom(
        value,
        me(),
        hostLeases.get(code)
      );
    },

    disconnect() {
      goOffline(db);
    },

    reconnect() {
      goOnline(db);
    },

    async createRoom(code, config) {
      ready();

      const lease = crypto.randomUUID();
      const target = ref(db, "rooms/" + code);

      const tx = await runTransaction(
        target,
        current => {
          if (
            roomIsLive(current) &&
            current.ownerUid !== me()
          ) {
            return;
          }

          return {
            ownerUid: me(),
            lease,
            createdAt: serverTimestamp(),
            config,
            state: fresh(
              config,
              0,
              Date.now() + offset
            )
          };
        },
        { applyLocally: false }
      );

      if (!tx.committed) {
        throw Error(
          "이미 사용 중인 방 코드입니다. 다른 코드를 입력해주세요."
        );
      }

      const presenceRef = ref(
        db,
        "rooms/" + code + "/presence/" + lease
      );

      try {
        await onDisconnect(presenceRef).remove();

        const active = await transactRead(
          target,
          current => {
            if (
              !controlsRoom(
                current,
                me(),
                lease
              )
            ) {
              return;
            }

            return {
              ...current,
              presence: {
                [lease]: true
              }
            };
          }
        );

        if (!active.committed) {
          throw Error(
            "방 생성이 취소되었습니다. 다시 시도해주세요."
          );
        }

        await onDisconnect(presenceRef).remove();

        hostLeases.set(code, lease);
      } catch (error) {
        await transactRead(
          target,
          current =>
            controlsRoom(current, me(), lease)
              ? null
              : undefined
        ).catch(() => {});

        throw error;
      }
    },

    async getRoom(code) {
      ready();

      const raw = (
        await get(ref(db, "rooms/" + code))
      ).val();

      return roomIsLive(raw)
        ? {
            ...raw,
            config: migrateConfig(raw.config)
          }
        : null;
    },

    watchRoom(code, fn, fail, asHost = false) {
      return watch(
        db,
        "rooms/" + code,
        current => {
          const valid =
            roomIsLive(current) &&
            (
              !asHost ||
              controlsRoom(
                current,
                me(),
                hostLeases.get(code)
              )
            );

          fn(
            valid
              ? {
                  ...current,
                  config: migrateConfig(
                    current.config
                  )
                }
              : null
          );
        },
        fail
      );
    },

    async roomAction(code, action) {
      ready();

      const tx = await transactRead(
        ref(db, "rooms/" + code),
        current => {
          if (
            !controlsRoom(
              current,
              me(),
              hostLeases.get(code)
            ) ||
            !roomIsLive(current)
          ) {
            return;
          }

          const config = migrateConfig(
            current.config
          );

          const state = change(
            current.state,
            config,
            action,
            Date.now() + offset
          );

          return state
            ? {
                ...current,
                config,
                state
              }
            : undefined;
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
        current => {
          if (
            !controlsRoom(
              current,
              me(),
              hostLeases.get(code)
            ) ||
            !roomIsLive(current)
          ) {
            return;
          }

          return {
            ...current,
            config,
            state: fresh(
              config,
              0,
              Date.now() + offset
            )
          };
        }
      );

      if (!tx.committed) {
        throw Error(
          "방 조작 권한이 없습니다."
        );
      }
    },

    async closeRoom(code) {
      ready();

      const lease = hostLeases.get(code);

      const tx = await transactRead(
        ref(db, "rooms/" + code),
        current =>
          controlsRoom(current, me(), lease)
            ? null
            : undefined
      );

      if (lease) {
        await onDisconnect(
          ref(
            db,
            "rooms/" + code + "/presence/" + lease
          )
        ).cancel().catch(() => {});

        hostLeases.delete(code);
      }

      return tx.committed;
    }
  };
}
