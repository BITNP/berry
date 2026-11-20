<script setup lang="ts" generic="T extends object">
import { ArrowDown } from "@lucide/vue";
import { NButton, NEmpty, NSpin, NVirtualList } from "naive-ui";
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

type VirtualListCompInst = InstanceType<typeof NVirtualList>;
type VirtualItemsProp = VirtualListCompInst["$props"]["items"];

const emit = defineEmits<{
  loadOlder: [];
}>();

const props = withDefaults(
  defineProps<{
    items: T[];
    keyField: string;
    /**
     * Must be <= the minimum possible rendered height of an item (vueuc
     * VirtualList contract).
     */
    itemSize: number;
    emptyText?: string;
    followBottom?: boolean;
    hasOlder?: boolean;
    loadingOlder?: boolean;
    surface?: "plain" | "console";
  }>(),
  {
    emptyText: "暂无记录",
    followBottom: true,
    hasOlder: false,
    loadingOlder: false,
    surface: "plain",
  },
);

const BOTTOM_THRESHOLD_PX = 48;
const TOP_LOAD_THRESHOLD_PX = 56;

const listRef = ref<VirtualListCompInst | null>(null);
const pinnedToBottom = ref(true);
const pendingNewCount = ref(0);
const initialized = ref(false);

let contentObserver: ResizeObserver | null = null;
let observedEl: HTMLElement | null = null;
let programmaticUntil = 0;
let lastScrollTop = 0;
let lastFirstKey: unknown = null;
let lastTailKey: unknown = null;
let lastLength = 0;

function itemKeyOf(item: T | undefined): unknown {
  if (!item) {
    return null;
  }

  return (item as Record<string, unknown>)[props.keyField];
}

function disconnectObserver() {
  if (contentObserver) {
    contentObserver.disconnect();
    contentObserver = null;
  }

  observedEl = null;
}

const getContainer = (): HTMLElement | null =>
  listRef.value?.getScrollContainer?.() ?? null;

const getContent = (): HTMLElement | null =>
  listRef.value?.getScrollContent?.() ?? null;

function applyBottomScroll() {
  const inst = listRef.value;

  if (!inst) {
    return;
  }

  programmaticUntil = performance.now() + 140;
  inst.scrollTo({ position: "bottom" });

  const container = getContainer();

  if (container) {
    container.scrollTop = container.scrollHeight;
    lastScrollTop = container.scrollTop;
  }
}

function attachContentObserver() {
  const itemsEl = getContent();

  if (!itemsEl) {
    disconnectObserver();

    return;
  }

  if (observedEl === itemsEl && contentObserver) {
    return;
  }

  disconnectObserver();
  observedEl = itemsEl;

  if (typeof ResizeObserver === "undefined") {
    return;
  }

  contentObserver = new ResizeObserver(() => {
    if (!pinnedToBottom.value || !props.followBottom) {
      return;
    }

    const container = getContainer();

    if (!container) {
      return;
    }

    const gap =
      container.scrollHeight - container.scrollTop - container.clientHeight;

    if (gap > 2) {
      applyBottomScroll();
    }
  });
  contentObserver.observe(itemsEl);

  if (itemsEl.firstElementChild instanceof HTMLElement) {
    contentObserver.observe(itemsEl.firstElementChild);
  }
}

function snapToBottom() {
  pinnedToBottom.value = true;
  pendingNewCount.value = 0;

  void nextTick(() => {
    attachContentObserver();
    applyBottomScroll();
    requestAnimationFrame(() => {
      if (pinnedToBottom.value) {
        attachContentObserver();
        applyBottomScroll();
      }
    });
  });
}

function handleWheel(event: WheelEvent) {
  if (event.deltaY < 0) {
    pinnedToBottom.value = false;
  }
}

function handleScroll(event: Event) {
  const target = event.target as HTMLElement | null;

  if (!target) {
    return;
  }

  const currentTop = target.scrollTop;
  const distanceToBottom =
    target.scrollHeight - currentTop - target.clientHeight;
  const nearBottom = distanceToBottom <= BOTTOM_THRESHOLD_PX;
  const isProgrammatic = performance.now() < programmaticUntil;

  if (nearBottom) {
    pinnedToBottom.value = true;
    pendingNewCount.value = 0;
  } else if (!isProgrammatic && currentTop < lastScrollTop - 2) {
    pinnedToBottom.value = false;
  } else if (!isProgrammatic && !pinnedToBottom.value) {
    pinnedToBottom.value = false;
  }

  lastScrollTop = currentTop;

  if (
    props.hasOlder &&
    !props.loadingOlder &&
    !pinnedToBottom.value &&
    props.items.length > 0 &&
    currentTop <= TOP_LOAD_THRESHOLD_PX
  ) {
    emit("loadOlder");
  }
}

function jumpToBottom() {
  snapToBottom();
}

watch(
  () => props.items,
  (next) => {
    const nextLen = next.length;
    const nextFirst = itemKeyOf(next[0]);
    const nextTail = itemKeyOf(next.at(-1));

    if (nextLen === 0) {
      initialized.value = false;
      pinnedToBottom.value = true;
      pendingNewCount.value = 0;
      lastFirstKey = null;
      lastTailKey = null;
      lastLength = 0;
      disconnectObserver();

      return;
    }

    const prepended =
      initialized.value &&
      lastLength > 0 &&
      nextLen > lastLength &&
      nextTail === lastTailKey &&
      nextFirst !== lastFirstKey;

    const appended =
      initialized.value &&
      lastLength > 0 &&
      nextTail !== lastTailKey &&
      (nextFirst === lastFirstKey ||
        (nextLen === lastLength && itemKeyOf(next.at(-2)) === lastTailKey));

    const delta = nextLen - lastLength;
    const appendedCount = delta > 0 ? delta : 1;

    lastFirstKey = nextFirst;
    lastTailKey = nextTail;
    lastLength = nextLen;

    if (!initialized.value) {
      initialized.value = true;
      snapToBottom();

      return;
    }

    if (prepended && delta > 0) {
      pinnedToBottom.value = false;
      void nextTick(() => {
        programmaticUntil = performance.now() + 140;
        listRef.value?.scrollTo({ index: delta });
      });

      return;
    }

    if (appended) {
      if (props.followBottom && pinnedToBottom.value) {
        snapToBottom();
      } else {
        pendingNewCount.value += appendedCount;
      }

      return;
    }

    // List was replaced/reloaded (e.g. switched chat or reset search): re-anchor at newest.
    snapToBottom();
  },
  { flush: "post" },
);

watch(
  () => props.followBottom,
  (enabled) => {
    if (enabled && pinnedToBottom.value && props.items.length > 0) {
      snapToBottom();
    }
  },
);

onMounted(() => {
  if (props.items.length > 0) {
    lastFirstKey = itemKeyOf(props.items[0]);
    lastTailKey = itemKeyOf(props.items.at(-1));
    lastLength = props.items.length;
    initialized.value = true;
    snapToBottom();
  }
});

onBeforeUnmount(() => {
  disconnectObserver();
});

defineExpose({
  scrollToBottom: jumpToBottom,
});
</script>

<template>
  <div class="chrono-shell" :class="`surface-${surface}`">
    <div v-if="loadingOlder" class="chrono-top-bar">
      <NSpin :size="12" />
      <span>正在加载更早记录…</span>
    </div>
    <div v-else-if="hasOlder && items.length > 0" class="chrono-top-bar">
      <NButton quaternary size="tiny" @click="emit('loadOlder')">
        加载更早记录
      </NButton>
    </div>

    <NEmpty
      v-if="items.length === 0"
      class="py-empty"
      :description="emptyText"
    />

    <NVirtualList
      v-else
      ref="listRef"
      class="chrono-vlist"
      item-resizable
      :item-size
      :items="items as unknown as VirtualItemsProp"
      :key-field
      :on-scroll="handleScroll"
      :on-wheel="handleWheel"
      :padding-bottom="8"
    >
      <template #default="{ item, index }">
        <slot :index :item="item as unknown as T" />
      </template>
    </NVirtualList>

    <div v-if="items.length > 0 && !pinnedToBottom" class="chrono-jump-wrap">
      <NButton
        round
        size="tiny"
        :type="pendingNewCount > 0 ? 'primary' : 'default'"
        @click="jumpToBottom"
      >
        <template #icon>
          <ArrowDown :size="13" />
        </template>
        {{ pendingNewCount > 0 ? `${pendingNewCount} 条新内容` : "回到底部" }}
      </NButton>
    </div>
  </div>
</template>

<style scoped>
.chrono-shell {
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.chrono-shell.surface-console {
  font-family: var(--berry-mono);
  font-size: 12px;
  line-height: 1.6;
  background: #0d1017;
  color: #e2e8f0;
  border: 1px solid #1f2430;
  border-radius: 6px;
  padding: 6px 8px;
}

.chrono-top-bar {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 2px 0 6px;
  font-size: 12px;
  color: var(--berry-muted);
  flex-shrink: 0;
}

.chrono-vlist {
  flex: 1;
  min-height: 0;
  height: 100%;
}

.chrono-jump-wrap {
  position: absolute;
  right: 16px;
  bottom: 12px;
  z-index: 4;
  box-shadow: 0 4px 12px rgb(0 0 0 / 0.25);
  border-radius: 999px;
}
</style>
