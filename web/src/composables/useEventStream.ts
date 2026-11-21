import type { Ref } from "vue";
import { onMounted, onUnmounted, ref, watch } from "vue";

export type AdminEventType =
  | "gate_decision"
  | "delivery_update"
  | "guild_audit"
  | "llm_call"
  | "job_update"
  | "log"
  | "message_update"
  | "memory_update"
  | "schedule_update"
  | "conversation_update";

const EVENT_TYPES: readonly AdminEventType[] = [
  "gate_decision",
  "delivery_update",
  "guild_audit",
  "llm_call",
  "job_update",
  "log",
  "message_update",
  "memory_update",
  "schedule_update",
  "conversation_update",
];

type EventHandler = (type: AdminEventType, data: unknown) => void;
type ReconnectHandler = () => void;

const sharedConnected = ref(false);
const listeners = new Set<EventHandler>();
const reconnectListeners = new Set<ReconnectHandler>();

let sharedSource: EventSource | null = null;
let everOpened = false;

function ensureSharedSource() {
  if (sharedSource || typeof EventSource === "undefined") {
    return;
  }

  const es = new EventSource("/api/admin/events");

  es.onopen = () => {
    const isReconnect = everOpened && !sharedConnected.value;

    everOpened = true;
    sharedConnected.value = true;

    if (isReconnect) {
      for (const listener of reconnectListeners) {
        try {
          listener();
        } catch {
          // Ignore individual subscriber errors.
        }
      }
    }
  };

  es.onerror = () => {
    sharedConnected.value = false;
  };

  for (const type of EVENT_TYPES) {
    es.addEventListener(type, (raw) => {
      let parsed: unknown;

      try {
        parsed = JSON.parse((raw as MessageEvent<string>).data);
      } catch {
        return;
      }

      for (const listener of listeners) {
        try {
          listener(type, parsed);
        } catch {
          // Ignore individual subscriber errors.
        }
      }
    });
  }

  sharedSource = es;
}

function maybeCloseSharedSource() {
  if (listeners.size === 0 && reconnectListeners.size === 0 && sharedSource) {
    sharedSource.close();
    sharedSource = null;
    sharedConnected.value = false;
    everOpened = false;
  }
}

export function useEventStream(
  onEvent: EventHandler,
  options: { onReconnect?: ReconnectHandler } = {},
) {
  const paused = ref(false);

  const wrapped: EventHandler = (type, data) => {
    if (!paused.value) {
      onEvent(type, data);
    }
  };

  const wrappedReconnect: ReconnectHandler | null = options.onReconnect
    ? () => {
        if (!paused.value) {
          options.onReconnect?.();
        }
      }
    : null;

  onMounted(() => {
    listeners.add(wrapped);

    if (wrappedReconnect) {
      reconnectListeners.add(wrappedReconnect);
    }

    ensureSharedSource();
  });

  onUnmounted(() => {
    listeners.delete(wrapped);

    if (wrappedReconnect) {
      reconnectListeners.delete(wrappedReconnect);
    }

    maybeCloseSharedSource();
  });

  function togglePause() {
    paused.value = !paused.value;
  }

  return { connected: sharedConnected, paused, togglePause };
}

export function useLiveRefresh(options: {
  events: readonly AdminEventType[];
  refresh: () => void | Promise<void>;
  debounceMs?: number;
  match?: (type: AdminEventType, data: unknown) => boolean;
  enabled?: () => boolean;
  paused?: Ref<boolean>;
  onReconnect?: boolean;
}) {
  const eventSet = new Set<AdminEventType>(options.events);
  const debounceMs = options.debounceMs ?? 250;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let pendingAfterRun = false;
  let unmounted = false;

  const isActive = () =>
    !unmounted &&
    !(options.paused?.value ?? false) &&
    (options.enabled ? options.enabled() : true);

  async function execute() {
    if (!isActive()) {
      return;
    }

    if (running) {
      pendingAfterRun = true;

      return;
    }

    running = true;

    try {
      await options.refresh();
    } finally {
      running = false;

      if (pendingAfterRun && isActive()) {
        pendingAfterRun = false;
        schedule();
      } else {
        pendingAfterRun = false;
      }
    }
  }

  function schedule() {
    if (!isActive()) {
      return;
    }

    if (running) {
      pendingAfterRun = true;

      return;
    }

    if (timer) {
      clearTimeout(timer);
    }

    timer = setTimeout(() => {
      timer = null;
      void execute();
    }, debounceMs);
  }

  useEventStream(
    (type, data) => {
      if (!eventSet.has(type) || !isActive()) {
        return;
      }

      if (options.match && !options.match(type, data)) {
        return;
      }

      schedule();
    },
    {
      onReconnect:
        options.onReconnect === false
          ? undefined
          : () => {
              if (isActive()) {
                schedule();
              }
            },
    },
  );

  onUnmounted(() => {
    unmounted = true;

    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  });

  return { trigger: schedule };
}

export function useLiveClock(active: () => boolean, intervalMs = 1000) {
  const now = ref(Date.now());
  let timer: ReturnType<typeof setInterval> | null = null;

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function start() {
    if (timer) {
      return;
    }

    now.value = Date.now();
    timer = setInterval(() => {
      now.value = Date.now();
    }, intervalMs);
  }

  watch(
    active,
    (isOn) => {
      if (isOn) {
        start();
      } else {
        stop();
      }
    },
    { immediate: true },
  );

  onUnmounted(stop);

  return now;
}
