import { onMounted, onUnmounted, ref } from "vue";

export function useEventStream(onEvent: (type: string, data: unknown) => void) {
  const connected = ref(false);
  const paused = ref(false);
  let source: EventSource | null = null;

  function connect() {
    if (source) {
      source.close();
    }

    const es = new EventSource("/api/admin/events");

    es.onopen = () => {
      connected.value = true;
    };

    es.onerror = () => {
      connected.value = false;
    };

    for (const type of [
      "gate_decision",
      "delivery_update",
      "guild_audit",
      "job_update",
      "log",
    ]) {
      es.addEventListener(type, (raw) => {
        if (paused.value) {
          return;
        }

        try {
          onEvent(type, JSON.parse((raw as MessageEvent<string>).data));
        } catch {
          // Ignore malformed event.
        }
      });
    }

    source = es;
  }

  function togglePause() {
    paused.value = !paused.value;
  }

  onMounted(connect);
  onUnmounted(() => {
    source?.close();
    source = null;
  });

  return { connected, paused, togglePause };
}
