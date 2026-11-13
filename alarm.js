export function createAlarm(
  url,
  {
    makeContext = () =>
      new (window.AudioContext || window.webkitAudioContext)(),
    fetchAudio = fetch
  } = {}
) {
  let context;
  let buffer;
  let loading;
  let source;

  function stop() {
    if (!source) return;

    source.onended = null;

    try {
      source.stop();
    } catch (_) {}

    source.disconnect();
    source = null;
  }

  async function unlock() {
    context ??= makeContext();

    const resumed =
      context.state === "running"
        ? Promise.resolve()
        : context.resume();

    if (!buffer && !loading) {
      loading = (async () => {
        const response = await fetchAudio(url);

        if (!response.ok) {
          throw Error(
            "효과음 파일을 불러올 수 없습니다. assets/time-up.mp3를 확인해주세요."
          );
        }

        buffer = await context.decodeAudioData(
          await response.arrayBuffer()
        );
      })().finally(() => {
        loading = null;
      });
    }

    await Promise.all([resumed, loading]);
  }

  function play() {
    if (!buffer || context?.state !== "running") {
      return false;
    }

    stop();

    const next = context.createBufferSource();

    next.buffer = buffer;
    next.loop = false;
    next.connect(context.destination);

    next.onended = () => {
      next.disconnect();

      if (source === next) {
        source = null;
      }
    };

    source = next;
    next.start();

    return true;
  }

  return { unlock, play, stop };
}
