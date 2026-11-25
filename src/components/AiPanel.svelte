<script lang="ts">
  import { onMount } from "svelte";
  import {
    applyAiActions,
    DEFAULT_AI_BASE_URL,
    DEFAULT_AI_MODEL,
    fetchAvailableModels,
    sendAiEditRequest,
    type AiChatMessage,
  } from "../lib/ai";
  import type { Keep } from "../lib/cuts";
  import { ALL_PRESET_MODELS } from "../lib/orchestrator";
  import { editor } from "../lib/store.svelte";
  import type { DetectParams, ExportOptions } from "../lib/types";

  const STORAGE_URL = "ac:ai:baseUrl";
  const STORAGE_KEY = "ac:ai:apiKey";
  const STORAGE_MODEL = "ac:ai:model";

  let baseUrl = $state(
    (typeof localStorage !== "undefined" && localStorage.getItem(STORAGE_URL)) ||
      DEFAULT_AI_BASE_URL,
  );
  let apiKey = $state(
    (typeof localStorage !== "undefined" && localStorage.getItem(STORAGE_KEY)) ||
      "",
  );
  let model = $state(
    (typeof localStorage !== "undefined" && localStorage.getItem(STORAGE_MODEL)) ||
      DEFAULT_AI_MODEL,
  );

  let models = $state<string[]>([]);
  let autoSwitch = $state(true);
  let liveStatus = $state<string | null>(null);
  let connStatus = $state<"checking" | "online" | "offline">("checking");
  let connError = $state<string | null>(null);
  let showSettings = $state(false);

  let prompt = $state("");
  let sending = $state(false);
  let abortCtrl: AbortController | null = null;
  let messages = $state<AiChatMessage[]>([]);
  let chatEl: HTMLDivElement | null = $state(null);

  type UndoSnapshot = {
    keeps: Keep[] | null;
    params: DetectParams;
    exportOptions: ExportOptions;
  };
  let undoStack = $state<UndoSnapshot[]>([]);

  const QUICK_PROMPTS = [
    {
      label: "کات تند یوتیوبی",
      text: "سکوت‌ها رو خیلی تند و یوتیوبی کات کن (threshold=0.62, pad=0.12) و تشخیص سکوت رو اجرا کن",
    },
    {
      label: "حذف ۵ ثانیه اول و آخر",
      text: "۵ ثانیه اول و ۵ ثانیه آخر ویدیو رو حذف کن",
    },
    {
      label: "حذف کلیپ‌های زیر ۱ ثانیه",
      text: "همه کلیپ‌های کوتاه‌تر از ۱ ثانیه رو حذف کن و فاصله‌های زیر ۰.۴ ثانیه رو به هم بچسبون",
    },
    {
      label: "اکسپورت 1080p باکیفیت",
      text: "تنظیمات اکسپورت رو بذار روی 1080p و کیفیت high",
    },
  ];

  function saveConfig() {
    try {
      localStorage.setItem(STORAGE_URL, baseUrl);
      localStorage.setItem(STORAGE_KEY, apiKey);
      localStorage.setItem(STORAGE_MODEL, model);
    } catch {
      /* ignore */
    }
  }

  async function refreshConnection() {
    connStatus = "checking";
    connError = null;
    saveConfig();
    try {
      const list = await fetchAvailableModels(baseUrl, apiKey);
      const presetIds = ALL_PRESET_MODELS.map((m) => m.id);
      models = [...presetIds, ...list.filter((id) => !presetIds.includes(id))];
      saveConfig();
      connStatus = "online";
    } catch (err) {
      connStatus = "offline";
      connError = String(err instanceof Error ? err.message : err);
    }
  }

  onMount(() => {
    void refreshConnection();
  });

  function scrollToBottom() {
    requestAnimationFrame(() => {
      if (chatEl) chatEl.scrollTop = chatEl.scrollHeight;
    });
  }

  function undoLastAiEdit() {
    const snap = undoStack.pop();
    if (!snap) return;
    undoStack = [...undoStack];
    editor.params = { ...snap.params };
    editor.exportOptions = { ...snap.exportOptions };
    if (snap.keeps === null) {
      editor.cutlist = null;
    } else {
      editor.setKeepIntervals(snap.keeps);
    }
    messages = [
      ...messages,
      { role: "assistant", content: "آخرین تغییر هوش مصنوعی برگردانده شد (Undo)." },
    ];
    scrollToBottom();
  }

  function cancelRequest() {
    abortCtrl?.abort();
    abortCtrl = null;
    sending = false;
  }

  async function send(textOverride?: string) {
    const text = (textOverride ?? prompt).trim();
    if (!text || sending || !editor.video) return;
    if (!textOverride) prompt = "";

    const userMsg: AiChatMessage = { role: "user", content: text };
    const historyBefore = [...messages];
    messages = [...messages, userMsg];
    scrollToBottom();

    sending = true;
    abortCtrl = new AbortController();

    try {
      const filename =
        editor.video.path.split(/[/\\]/).pop() ?? editor.video.path;
      const keeps = editor.keepIntervals();

      const res = await sendAiEditRequest({
        baseUrl,
        apiKey,
        model,
        autoSwitch,
        history: historyBefore,
        userMessage: text,
        context: {
          filename,
          duration: editor.video.duration,
          fps: editor.video.fps,
          width: editor.video.width,
          height: editor.video.height,
          currentTime: editor.currentTime,
          params: { ...editor.params },
          keeps,
          exportOptions: { ...editor.exportOptions },
          transcript: editor.transcript,
        },
        signal: abortCtrl.signal,
        onStatus: (m) => (liveStatus = m),
      });

      const applied = applyAiActions(res.actions, {
        duration: editor.video.duration,
        params: { ...editor.params },
        keeps,
        exportOptions: { ...editor.exportOptions },
      });

      const mutated =
        applied.paramsChanged ||
        applied.nextKeeps !== null ||
        applied.exportOptionsChanged ||
        applied.triggerDetect;

      if (mutated) {
        undoStack = [
          ...undoStack.slice(-19),
          {
            keeps: editor.cutlist ? keeps : null,
            params: { ...editor.params },
            exportOptions: { ...editor.exportOptions },
          },
        ];
      }

      if (applied.paramsChanged) {
        editor.params = applied.nextParams;
      }
      if (applied.exportOptionsChanged) {
        editor.exportOptions = applied.nextExportOptions;
      }
      if (applied.triggerDetect) {
        await editor.runDetectNow();
      }
      if (applied.nextKeeps !== null) {
        editor.setKeepIntervals(applied.nextKeeps);
      }
      if (applied.seekTo !== null) {
        editor.requestSeek(applied.seekTo);
      }

      const tags = [...applied.summaries];
      if (res.switchedFrom) {
        tags.unshift(`switched → ${res.modelUsed}`);
        model = res.modelUsed;
        saveConfig();
      }

      messages = [
        ...messages,
        {
          role: "assistant",
          content: res.reply,
          appliedActions: tags,
        },
      ];
      connStatus = "online";
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") {
        messages = [
          ...messages,
          { role: "assistant", content: "درخواست لغو شد.", error: true },
        ];
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        messages = [
          ...messages,
          {
            role: "assistant",
            content: `خطا در ارتباط با cli2api (${baseUrl}): ${msg}`,
            error: true,
          },
        ];
      }
    } finally {
      sending = false;
      liveStatus = null;
      abortCtrl = null;
      scrollToBottom();
    }
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }
</script>

<section class="card panel">
  <header class="card-head">
    <div class="head-left">
      <div class="title-row">
        <span
          class="dot"
          class:dot-online={connStatus === "online"}
          class:dot-neg={connStatus === "offline"}
          title={connStatus === "online"
            ? `Connected to cli2api (${model})`
            : connError ?? "cli2api offline"}
        ></span>
        <h2>ai editor</h2>
        <span class="badge mono">{model}</span>
      </div>
      <p class="card-sub">cli2api · {connStatus}</p>
    </div>

    <div class="card-head-actions">
      {#if undoStack.length > 0}
        <button
          class="btn btn-ghost btn-sm"
          onclick={undoLastAiEdit}
          disabled={sending}
          title="Undo last AI edit"
        >undo</button>
      {/if}
      <button
        class="btn btn-ghost btn-sm"
        onclick={() => (showSettings = !showSettings)}
        title="cli2api connection settings"
      >{showSettings ? "close" : "config"}</button>
    </div>
  </header>

  {#if showSettings}
    <div class="settings">
      <div class="field">
        <label class="field-label" for="ai-url">
          <span>cli2api url</span>
        </label>
        <input
          id="ai-url"
          type="text"
          class="mono"
          bind:value={baseUrl}
          onchange={refreshConnection}
          placeholder="http://localhost:8787/v1"
        />
      </div>

      <div class="field-row">
        <div class="field">
          <label class="field-label" for="ai-model">
            <span>model</span>
          </label>
          {#if models.length > 0}
            <select
              id="ai-model"
              class="mono"
              bind:value={model}
              onchange={saveConfig}
            >
              {#each models as m (m)}
                <option value={m}>{m}</option>
              {/each}
            </select>
          {:else}
            <input
              id="ai-model"
              type="text"
              class="mono"
              bind:value={model}
              onchange={saveConfig}
              placeholder="agy"
            />
          {/if}
        </div>

        <div class="field">
          <label class="field-label" for="ai-key">
            <span>api key (optional)</span>
          </label>
          <input
            id="ai-key"
            type="text"
            class="mono"
            bind:value={apiKey}
            onchange={saveConfig}
            placeholder="none"
          />
        </div>
      </div>

      <label class="toggle" style="font-size:11px">
        <input type="checkbox" bind:checked={autoSwitch} />
        <span>سوئیچ خودکار مدل هنگام لیمیت/کوتا</span>
      </label>

      <button class="btn btn-sm btn-block" onclick={refreshConnection}>
        reconnect & refresh models
      </button>
    </div>
  {/if}

  {#if connStatus === "offline"}
    <div class="offline-banner">
      <span class="dot dot-neg"></span>
      <div class="offline-text">
        <strong>cli2api not reachable</strong>
        <span class="mono">run start-autocut-ai.ps1 or cli2api serve</span>
      </div>
      <button class="btn btn-sm" onclick={refreshConnection}>retry</button>
    </div>
  {/if}

  <div bind:this={chatEl} class="chat">
    {#if messages.length === 0}
      <div class="empty">
        <p class="empty-title">ادیت ویدیو با هوش مصنوعی</p>
        <p class="empty-sub">
          دستورت رو به فارسی یا انگلیسی بنویس تا <span class="mono">{model}</span> مستقیم روی تایم‌لاین اعمال کنه.
        </p>
        <div class="chips">
          {#each QUICK_PROMPTS as q (q.label)}
            <button
              class="chip"
              onclick={() => send(q.text)}
              disabled={sending || !editor.video}
            >{q.label}</button>
          {/each}
        </div>
      </div>
    {:else}
      {#each messages as m, i (i)}
        <div class="msg" class:user={m.role === "user"} class:err={m.error}>
          <div class="msg-text" dir="auto">{m.content}</div>
          {#if m.appliedActions && m.appliedActions.length > 0}
            <div class="action-tags">
              {#each m.appliedActions as tag, j (j)}
                <span class="action-tag mono">✓ {tag}</span>
              {/each}
            </div>
          {/if}
        </div>
      {/each}

      {#if sending}
        <div class="msg thinking">
          <span class="mono" dir="auto">{liveStatus ?? `thinking via ${model}…`}</span>
        </div>
      {/if}
    {/if}
  </div>

  <footer class="composer">
    <textarea
      rows="2"
      dir="auto"
      bind:value={prompt}
      onkeydown={onKeydown}
      disabled={sending || !editor.video}
      placeholder="مثلاً: سکوت‌ها رو تند کات کن و ۵ ثانیه اول رو حذف کن..."
    ></textarea>
    <div class="composer-actions">
      {#if sending}
        <button class="btn btn-danger btn-sm" onclick={cancelRequest}>stop</button>
      {:else}
        <button
          class="btn btn-primary btn-sm"
          onclick={() => send()}
          disabled={!prompt.trim() || !editor.video}
        >run</button>
      {/if}
    </div>
  </footer>
</section>

<style>
  .panel {
    display: grid;
    grid-template-rows: auto auto 1fr auto;
    min-height: 0;
    height: 100%;
  }

  .head-left {
    min-width: 0;
  }

  .title-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .dot-online {
    background: var(--pos);
    box-shadow: 0 0 6px hsl(142 71% 55% / 0.7);
  }

  .badge {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 999px;
    background: hsl(213 94% 68% / 0.12);
    border: 1px solid hsl(213 94% 68% / 0.35);
    color: var(--accent);
  }

  .settings {
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
    background: var(--surface-2);
    display: grid;
    gap: 8px;
  }

  .field-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }

  .offline-banner {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: hsl(0 84% 65% / 0.08);
    border-bottom: 1px solid hsl(0 84% 65% / 0.25);
    font-size: 11px;
  }

  .offline-text {
    display: grid;
    flex: 1;
    min-width: 0;
    color: var(--neg);
  }
  .offline-text span {
    font-size: 10px;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chat {
    overflow-y: auto;
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-height: 0;
  }

  .empty {
    margin: auto 0;
    padding: 8px 6px;
    text-align: center;
  }

  .empty-title {
    margin: 0 0 4px;
    font-size: 13px;
    font-weight: 600;
    color: var(--foreground);
  }

  .empty-sub {
    margin: 0 0 12px;
    font-size: 11px;
    color: var(--muted);
    line-height: 1.6;
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    justify-content: center;
  }

  .chip {
    background: var(--surface-2);
    border: 1px solid var(--border);
    color: var(--foreground);
    border-radius: 999px;
    padding: 4px 10px;
    font: inherit;
    font-size: 11px;
    cursor: pointer;
    transition: border-color 120ms, background 120ms;
  }
  .chip:hover:not(:disabled) {
    border-color: var(--accent);
    background: hsl(213 94% 68% / 0.1);
  }
  .chip:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .msg {
    padding: 8px 10px;
    border-radius: var(--radius);
    background: var(--surface-2);
    border: 1px solid var(--border);
    font-size: 12px;
    line-height: 1.55;
    word-break: break-word;
  }

  .msg.user {
    background: hsl(213 94% 68% / 0.1);
    border-color: hsl(213 94% 68% / 0.3);
  }

  .msg.err {
    background: hsl(0 84% 65% / 0.08);
    border-color: hsl(0 84% 65% / 0.3);
    color: var(--neg);
  }

  .msg.thinking {
    font-size: 11px;
    color: var(--accent);
    border-style: dashed;
  }

  .action-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 6px;
  }

  .action-tag {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: var(--radius-sm);
    background: hsl(142 71% 55% / 0.1);
    border: 1px solid hsl(142 71% 55% / 0.35);
    color: var(--pos);
  }

  .composer {
    display: flex;
    gap: 6px;
    align-items: flex-end;
    padding: 8px;
    border-top: 1px solid var(--border);
    background: var(--surface);
  }

  .composer textarea {
    flex: 1;
    resize: none;
    background: var(--input);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--foreground);
    padding: 6px 8px;
    font: inherit;
    font-size: 12px;
    line-height: 1.4;
    outline: none;
  }
  .composer textarea:focus {
    border-color: var(--accent);
  }

  .composer-actions {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
</style>
