<script setup lang="ts">
import DOMPurify from "dompurify";
import { marked } from "marked";
import { computed } from "vue";

const props = defineProps<{
  source: string;
}>();

const html = computed(() =>
  DOMPurify.sanitize(marked.parse(props.source || "", { async: false })),
);
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -->
  <div class="md-body" v-html="html" />
</template>

<style scoped>
.md-body {
  font-size: 13px;
  line-height: 1.65;
  color: inherit;
  overflow-wrap: anywhere;
}

.md-body :deep(h1),
.md-body :deep(h2),
.md-body :deep(h3) {
  margin: 14px 0 8px;
  font-weight: 600;
}

.md-body :deep(p) {
  margin: 6px 0;
}

.md-body :deep(pre) {
  padding: 10px 12px;
  border-radius: 6px;
  border: 1px solid var(--berry-border);
  background: var(--berry-inset);
  overflow-x: auto;
  font-family: var(--berry-mono);
  font-size: 12px;
}

.md-body :deep(code) {
  font-family: var(--berry-mono);
  font-size: 12px;
}

.md-body :deep(blockquote) {
  margin: 8px 0;
  padding: 4px 12px;
  border-left: 3px solid var(--berry-border);
  color: var(--berry-muted);
}

.md-body :deep(table) {
  border-collapse: collapse;
  width: 100%;
  margin: 8px 0;
}

.md-body :deep(th),
.md-body :deep(td) {
  padding: 6px 10px;
  border: 1px solid var(--berry-border);
  text-align: left;
}
</style>
