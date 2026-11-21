import type {
  QuickJSContext,
  QuickJSDeferredPromise,
  QuickJSHandle,
} from "quickjs-emscripten";
import { getQuickJS } from "quickjs-emscripten";

export type AsyncHostFn = (...args: unknown[]) => Promise<unknown>;

export type HostBindingTree = Record<string, Record<string, AsyncHostFn>>;

export interface RunReadonlyScriptOptions {
  code: string;
  bindings: HostBindingTree;
  timeoutMs?: number;
  maxMemoryBytes?: number;
  maxHostCalls?: number;
  maxOutputBytes?: number;
  maxLogBytes?: number;
}

export interface RunReadonlyScriptResult {
  result: unknown;
  logs: string[];
  hostCalls: number;
  durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_MEMORY_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_STACK_BYTES = 512 * 1024;
const DEFAULT_MAX_HOST_CALLS = 80;
const DEFAULT_MAX_OUTPUT_BYTES = 16_384;
const DEFAULT_MAX_LOG_BYTES = 4096;
const DEFAULT_MAX_MICROTASKS = 5000;
const JOBS_PER_SLICE = 10;

function toQuickJSHandle(vm: QuickJSContext, value: unknown): QuickJSHandle {
  if (value === undefined) {
    return vm.undefined;
  }

  const jsonText = JSON.stringify(value);

  if (jsonText === undefined) {
    return vm.undefined;
  }

  const jsonObj = vm.getProp(vm.global, "JSON");
  const parseFn = vm.getProp(jsonObj, "parse");
  const strHandle = vm.newString(jsonText);
  const parsed = vm.callFunction(parseFn, jsonObj, strHandle);

  strHandle.dispose();
  parseFn.dispose();
  jsonObj.dispose();

  if (parsed.error) {
    const detail = formatQuickJSError(vm, parsed.error);

    parsed.error.dispose();

    throw new Error(`宿主返回值序列化失败：${detail}`);
  }

  return parsed.value;
}

function formatQuickJSError(
  vm: QuickJSContext,
  errHandle: QuickJSHandle,
): string {
  const dumped: unknown = vm.dump(errHandle);

  if (dumped && typeof dumped === "object" && "message" in dumped) {
    const name =
      "name" in dumped && typeof dumped.name === "string"
        ? `${dumped.name}: `
        : "";
    const msg = String(dumped.message);

    return `${name}${msg}`;
  }

  return String(dumped);
}

export async function runReadonlyScript(
  options: RunReadonlyScriptOptions,
): Promise<RunReadonlyScriptResult> {
  const started = performance.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxMemoryBytes = options.maxMemoryBytes ?? DEFAULT_MAX_MEMORY_BYTES;
  const maxHostCalls = options.maxHostCalls ?? DEFAULT_MAX_HOST_CALLS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const maxLogBytes = options.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES;

  const quickJS = await getQuickJS();
  const runtime = quickJS.newRuntime();

  runtime.setMemoryLimit(maxMemoryBytes);
  runtime.setMaxStackSize(DEFAULT_MAX_STACK_BYTES);

  const deadline = Date.now() + timeoutMs;
  let disposed = false;

  runtime.setInterruptHandler(() => disposed || Date.now() > deadline);

  const vm = runtime.newContext();
  const pendingDeferreds = new Set<QuickJSDeferredPromise>();
  const logs: string[] = [];
  let logBytes = 0;
  let hostCalls = 0;
  let executedJobs = 0;

  let settled = false;
  let resolveOuter!: (res: RunReadonlyScriptResult) => void;
  let rejectOuter!: (err: Error) => void;
  const outerPromise = new Promise<RunReadonlyScriptResult>(
    (resolve, reject) => {
      resolveOuter = resolve;
      rejectOuter = reject;
    },
  );

  function fail(err: Error) {
    if (settled) {
      return;
    }

    settled = true;
    rejectOuter(err);
  }

  function succeed(rawJson: string) {
    if (settled) {
      return;
    }

    const bytes = Buffer.byteLength(rawJson, "utf8");

    if (bytes > maxOutputBytes) {
      fail(
        new Error(
          `脚本返回值体积 ${bytes} 字节超过上限（${maxOutputBytes} 字节），请在脚本内先聚合或精简字段后再返回`,
        ),
      );

      return;
    }

    try {
      const parsed: unknown = JSON.parse(rawJson);

      settled = true;
      resolveOuter({
        result: parsed,
        logs,
        hostCalls,
        durationMs: Math.round(performance.now() - started),
      });
    } catch (error) {
      fail(
        new Error(
          `脚本返回值 JSON 解析失败：${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        ),
      );
    }
  }

  function pumpJobs() {
    if (disposed) {
      return;
    }

    while (!settled) {
      if (Date.now() > deadline) {
        fail(new Error(`脚本执行超时（超过 ${timeoutMs}ms）`));

        return;
      }

      if (executedJobs >= DEFAULT_MAX_MICROTASKS) {
        fail(
          new Error(
            `脚本微任务调度超过上限（${DEFAULT_MAX_MICROTASKS} 次，疑似异步死循环）`,
          ),
        );

        return;
      }

      const jobRes = runtime.executePendingJobs(JOBS_PER_SLICE);

      if (jobRes.error) {
        const detail = formatQuickJSError(vm, jobRes.error);

        jobRes.error.dispose();
        fail(
          new Error(
            detail.includes("interrupted")
              ? `脚本执行超时中断（超过 ${timeoutMs}ms）`
              : `脚本执行错误：${detail}`,
          ),
        );

        return;
      }

      if (jobRes.value === 0) {
        return;
      }

      executedJobs += jobRes.value;
    }
  }

  const timer = setTimeout(() => {
    fail(new Error(`脚本执行超时（超过 ${timeoutMs}ms）`));
  }, timeoutMs);

  timer.unref();

  try {
    // 1) Limited console.log / warn / error capture.
    const consoleObj = vm.newObject();
    const makeLogger = (level: string) =>
      vm.newFunction(level, (...argHandles) => {
        if (logBytes >= maxLogBytes) {
          return;
        }

        const line = argHandles
          .map((h) => {
            const val: unknown = vm.dump(h);

            return typeof val === "string" ? val : JSON.stringify(val);
          })
          .join(" ");
        const entry = level === "log" ? line : `[${level}] ${line}`;
        const entryBytes = Buffer.byteLength(entry, "utf8");

        if (logBytes + entryBytes <= maxLogBytes) {
          logs.push(entry);
          logBytes += entryBytes;
        } else {
          const remaining = Math.max(0, maxLogBytes - logBytes);

          if (remaining > 16) {
            logs.push(`${entry.slice(0, remaining)}…`);
          }

          logBytes = maxLogBytes;
        }
      });

    for (const level of ["log", "warn", "error"] as const) {
      const fn = makeLogger(level);

      vm.setProp(consoleObj, level, fn);
      fn.dispose();
    }

    vm.setProp(vm.global, "console", consoleObj);
    consoleObj.dispose();

    // 2) Bridge read-only async host API tree onto global `api`.
    const apiObj = vm.newObject();

    for (const [namespace, methods] of Object.entries(options.bindings)) {
      const nsObj = vm.newObject();

      for (const [methodName, hostFn] of Object.entries(methods)) {
        const fnHandle = vm.newFunction(methodName, (...argHandles) => {
          const deferred = vm.newPromise();

          pendingDeferreds.add(deferred);

          hostCalls++;
          if (hostCalls > maxHostCalls) {
            const errHandle = vm.newError(
              `超过单次脚本宿主调用上限（最多 ${maxHostCalls} 次）`,
            );

            deferred.reject(errHandle);
            errHandle.dispose();
            queueMicrotask(() => {
              if (!disposed) {
                pumpJobs();
              }
            });

            return deferred.handle;
          }

          const dumpedArgs = argHandles.map((h) => vm.dump(h));

          void Promise.resolve()
            .then(() => hostFn(...dumpedArgs))
            .then(
              (value) => {
                if (disposed || settled) {
                  return;
                }

                try {
                  const resHandle = toQuickJSHandle(vm, value);

                  deferred.resolve(resHandle);
                  resHandle.dispose();
                  pumpJobs();
                } catch (marshalErr) {
                  const errHandle = vm.newError(
                    marshalErr instanceof Error
                      ? marshalErr.message
                      : String(marshalErr),
                  );

                  deferred.reject(errHandle);
                  errHandle.dispose();
                  pumpJobs();
                }
              },
              (hostErr: unknown) => {
                if (disposed || settled) {
                  return;
                }

                const errHandle = vm.newError(
                  hostErr instanceof Error ? hostErr.message : String(hostErr),
                );

                deferred.reject(errHandle);
                errHandle.dispose();
                pumpJobs();
              },
            );

          return deferred.handle;
        });

        vm.setProp(nsObj, methodName, fnHandle);
        fnHandle.dispose();
      }

      vm.setProp(apiObj, namespace, nsObj);
      nsObj.dispose();
    }

    vm.setProp(vm.global, "api", apiObj);
    apiObj.dispose();

    // 3) Install one-shot completion hook and run wrapped async script.
    const finishFn = vm.newFunction("__finish", (okHandle, payloadHandle) => {
      const ok = Boolean(vm.dump(okHandle));
      const payload = String(vm.dump(payloadHandle) ?? "");

      if (ok) {
        succeed(payload);
      } else {
        fail(new Error(`脚本运行异常：${payload}`));
      }
    });

    vm.setProp(vm.global, "__finish", finishFn);
    finishFn.dispose();

    const wrapped = `(function(__finish) {
      delete globalThis.__finish;
      (async () => {
        ${options.code}
      })().then(
        (v) => {
          try {
            __finish(true, v === undefined ? "null" : JSON.stringify(v));
          } catch (e) {
            __finish(false, e && typeof e === "object" && "message" in e ? String(e.message) : String(e));
          }
        },
        (e) => {
          __finish(false, e && typeof e === "object" && "message" in e ? String(e.message) : String(e));
        }
      );
    })(globalThis.__finish);`;

    const evalRes = vm.evalCode(wrapped, "readonly-script.js");

    if (evalRes.error) {
      const detail = formatQuickJSError(vm, evalRes.error);

      evalRes.error.dispose();
      fail(
        new Error(
          detail.includes("interrupted")
            ? `脚本执行超时中断（超过 ${timeoutMs}ms）`
            : `脚本执行失败：${detail}`,
        ),
      );
    } else {
      evalRes.value.dispose();
      pumpJobs();
    }

    return await outerPromise;
  } finally {
    clearTimeout(timer);
    disposed = true;
    for (const deferred of pendingDeferreds) {
      deferred.dispose();
    }

    pendingDeferreds.clear();
    vm.dispose();
    runtime.dispose();
  }
}
