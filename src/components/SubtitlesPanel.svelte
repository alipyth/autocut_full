<script lang="ts">
  import { save } from "@tauri-apps/plugin-dialog";
  import { DEFAULT_AI_BASE_URL } from "../lib/ai";
  import { writeTextFile } from "../lib/api";
  import { ALL_PRESET_MODELS } from "../lib/orchestrator";
  import { editor } from "../lib/store.svelte";
  import {
    formatTimestampShort,
    generateYoutubeChapters,
    generateYoutubeMetadata,
  } from "../lib/subtitles";

  const AUDIO_MODELS = ALL_PRESET_MODELS.filter((m) => m.audio);

  let audioModel = $state("agy/gemini-3.8-flash-low");
  let language = $state("fa");
  let autoSwitch = $state(true);
  let chunkSeconds = $state(45);
  let cooldownSec = $state(3.5);

  let chapters = $state("");
  let metadata = $state("");
  let generating = $state<"chapters" | "metadata" | null>(null);
  let genStatus = $state<string | null>(null);
  let aiError = $state<string | null>(null);
  let copyTag = $state<string | null>(null);

  function getBaseConfig() {
    const baseUrl =
      (typeof localStorage !== "undefined" &&
        localStorage.getItem("ac:ai:baseUrl")) ||
      DEFAULT_AI_BASE_URL;
    const apiKey =
      (typeof localStorage !== "undefined" &&
        localStorage.getItem("ac:ai:apiKey")) ||
      "";
    return { baseUrl, apiKey };
  }

  function suggestedStem(): string {
    if (!editor.video) return "untitled_autocut";
    const p = editor.video.path;
    const slash = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
    const dot = p.lastIndexOf(".");
    return `${p.slice(slash + 1, dot > slash ? dot : undefined)}_autocut`;
  }

  async function runTranscribe() {
    aiError = null;
    const { baseUrl, apiKey } = getBaseConfig();
    await editor.transcribeWithAgy({
      baseUrl,
      apiKey,
      preferredModel: audioModel,
      autoSwitch,
      language,
      chunkSeconds,
      cooldownMs: Math.round(cooldownSec * 1000),
    });
  }

  async function saveSrt() {
    const srt = editor.remappedSrt();
    if (!srt) return;
    const out = await save({
      defaultPath: `${suggestedStem()}.srt`,
      filters: [{ name: "SubRip Subtitle", extensions: ["srt"] }],
    });
    if (!out) return;
    await writeTextFile(out, srt);
    flashCopy("srt-saved");
  }

  async function buildChapters() {
    if (editor.transcript.length === 0 || generating) return;
    generating = "chapters";
    genStatus = "در حال ساخت تایم‌لاین یوتیوب…";
    aiError = null;
    try {
      const { baseUrl, apiKey } = getBaseConfig();
      const res = await generateYoutubeChapters({
        baseUrl,
        apiKey,
        autoSwitch,
        segments: editor.transcript,
        language: editor.transcriptLanguage ?? language,
        onStatus: (m) => (genStatus = m),
      });
      chapters = res.text;
      genStatus = `ساخته شد با ${res.modelUsed}`;
    } catch (err) {
      aiError = err instanceof Error ? err.message : String(err);
      genStatus = null;
    } finally {
      generating = null;
    }
  }

  async function buildMeta() {
    if (editor.transcript.length === 0 || generating) return;
    generating = "metadata";
    genStatus = "در حال ساخت عنوان و دیسکریپشن…";
    aiError = null;
    try {
      const { baseUrl, apiKey } = getBaseConfig();
      const res = await generateYoutubeMetadata({
        baseUrl,
        apiKey,
        autoSwitch,
        segments: editor.transcript,
        language: editor.transcriptLanguage ?? language,
        onStatus: (m) => (genStatus = m),
      });
      metadata = res.text;
      genStatus = `ساخته شد با ${res.modelUsed}`;
    } catch (err) {
      aiError = err instanceof Error ? err.message : String(err);
      genStatus = null;
    } finally {
      generating = null;
    }
  }

  async function copyText(text: string, tag: string) {
    if (!text) return;
    await navigator.clipboard.writeText(text);
    flashCopy(tag);
  }

  function flashCopy(tag: string) {
    copyTag = tag;
    setTimeout(() => {
      if (copyTag === tag) copyTag = null;
    }, 1800);
  }
</script>

<section class="card panel">
  <header class="card-head">
    <div>
      <h2>subtitles &amp; chapters</h2>
      <p class="card-sub">
        {#if editor.transcript.length > 0}
          <span class="mono">{editor.transcript.length}</span> lines · agy gemini
        {:else}
          agy audio · anti-quota orchestrator
        {/if}
      </p>
    </div>
    {#if editor.transcript.length > 0}
      <button class="btn btn-sm" onclick={saveSrt}>
        {copyTag === "srt-saved" ? "saved ✓" : "save .srt"}
      </button>
    {/if}
  </header>

  <div class="body">
    <div class="controls">
      <div class="field">
        <label class="field-label" for="audio-model">
          <span>مدل صوتی Gemini (Audio-Capable)</span>
        </label>
        <select id="audio-model" bind:value={audioModel} disabled={editor.transcribing}>
          {#each AUDIO_MODELS as m (m.id)}
            <option value={m.id}>{m.label}</option>
          {/each}
        </select>
      </div>

      <div class="select-row">
        <select bind:value={language} disabled={editor.transcribing} title="زبان صحبت">
          <option value="fa">فارسی (fa)</option>
          <option value="en">English (en)</option>
          <option value="auto">Auto</option>
        </select>
        <select bind:value={chunkSeconds} disabled={editor.transcribing} title="طول هر تکه صوتی">
          <option value={30}>تکه‌های ۳۰ ثانیه</option>
          <option value={45}>تکه‌های ۴۵ ثانیه (پیشنهادی)</option>
          <option value={60}>تکه‌های ۶۰ ثانیه (کم‌درخواست)</option>
        </select>
      </div>

      <label class="toggle small-toggle" title="اگر مدل فعلی به لیمیت یا کوتا بخوره، خودکار به مدل جمنای بعدی سوئیچ می‌کنه">
        <input type="checkbox" bind:checked={autoSwitch} disabled={editor.transcribing} />
        <span>سوئیچ خودکار بین مدل‌های جمنای + محافظت کوتا ({cooldownSec}s)</span>
      </label>

      {#if editor.transcribing}
        <button class="btn btn-danger btn-block" onclick={() => editor.cancelTranscribe()}>
          توقف ترنسکرایب
        </button>
      {:else}
        <button
          class="btn btn-primary btn-block"
          onclick={runTranscribe}
          disabled={!editor.video}
        >
          {editor.transcript.length > 0
            ? "ترنسکرایب مجدد با agy (Gemini)"
            : "برش صوت و ساخت زیرنویس با agy"}
        </button>
      {/if}

      {#if editor.transcribeStatus}
        <div class="status mono" dir="auto">{editor.transcribeStatus}</div>
      {/if}

      {#if editor.transcript.length > 0}
        <label class="toggle hardsub-toggle">
          <input
            type="checkbox"
            checked={editor.exportOptions.burnSubtitles === true}
            onchange={(e) =>
              (editor.exportOptions.burnSubtitles = e.currentTarget.checked)}
          />
          <span>حک کردن زیرنویس روی MP4 (Hardsub)</span>
        </label>

        <div class="style-box">
          <div class="style-title mono">استایل کل زیرنویس (پیش‌نمایش + خروجی)</div>
          <div class="style-grid">
            <label class="style-field">
              <span class="mono muted-2">سایز: {editor.subtitleStyle.fontSize}px</span>
              <input
                type="range"
                min="14"
                max="44"
                step="1"
                bind:value={editor.subtitleStyle.fontSize}
              />
            </label>
            <label class="style-field">
              <span class="mono muted-2">ارتفاع از پایین: {editor.subtitleStyle.bottomPct}%</span>
              <input
                type="range"
                min="4"
                max="80"
                step="2"
                bind:value={editor.subtitleStyle.bottomPct}
              />
            </label>
          </div>
          <div class="style-row">
            <div class="swatches">
              {#each ["#FFFFFF", "#FFE600", "#4ADE80", "#38BDF8"] as c (c)}
                <button
                  type="button"
                  class="swatch"
                  class:active={editor.subtitleStyle.color === c}
                  style={`background:${c}`}
                  onclick={() => (editor.subtitleStyle.color = c)}
                  title={`رنگ ${c}`}
                  aria-label={`Subtitle color ${c}`}
                ></button>
              {/each}
            </div>
            <label class="style-field bg-slider">
              <span class="mono muted-2">پس‌زمینه: {Math.round(editor.subtitleStyle.bgOpacity * 100)}%</span>
              <input
                type="range"
                min="0"
                max="1"
                step="0.1"
                bind:value={editor.subtitleStyle.bgOpacity}
              />
            </label>
          </div>
        </div>
      {/if}

      {#if editor.transcribeError}
        <div class="error mono" dir="auto">{editor.transcribeError}</div>
      {/if}
    </div>

    {#if editor.transcript.length > 0}
      <div class="yt-box">
        <div class="yt-actions">
          <button
            class="btn btn-sm"
            onclick={buildChapters}
            disabled={generating !== null}
          >
            {generating === "chapters" ? "در حال ساخت…" : "ساخت تایم‌لاین یوتیوب"}
          </button>
          <button
            class="btn btn-sm"
            onclick={buildMeta}
            disabled={generating !== null}
          >
            {generating === "metadata" ? "در حال ساخت…" : "عنوان و دیسکریپشن"}
          </button>
        </div>

        {#if genStatus}
          <div class="status mono" dir="auto">{genStatus}</div>
        {/if}

        {#if aiError}
          <div class="error mono" dir="auto">{aiError}</div>
        {/if}

        {#if chapters}
          <div class="result-block">
            <div class="result-head">
              <span class="mono">youtube chapters</span>
              <button
                class="btn btn-ghost btn-sm"
                onclick={() => copyText(chapters, "ch")}
              >{copyTag === "ch" ? "copied ✓" : "copy"}</button>
            </div>
            <textarea class="result-text mono" rows="5" dir="auto" bind:value={chapters}></textarea>
          </div>
        {/if}

        {#if metadata}
          <div class="result-block">
            <div class="result-head">
              <span class="mono">title · description · tags</span>
              <button
                class="btn btn-ghost btn-sm"
                onclick={() => copyText(metadata, "meta")}
              >{copyTag === "meta" ? "copied ✓" : "copy"}</button>
            </div>
            <textarea class="result-text" rows="6" dir="auto" bind:value={metadata}></textarea>
          </div>
        {/if}
      </div>

      <div class="sub-list">
        {#each editor.transcript as seg, i (i)}
          <div class="sub-row">
            <button
              class="ts mono"
              onclick={() => editor.requestSeek(seg.sourceStart ?? seg.start)}
              title="رفتن به این لحظه در ویدیو"
            >{formatTimestampShort(seg.start)}</button>
            <input
              type="text"
              dir="auto"
              value={seg.text}
              onchange={(e) => editor.updateTranscriptSegment(i, e.currentTarget.value)}
            />
          </div>
        {/each}
      </div>
    {:else}
      <div class="empty muted-2">
        <p class="empty-title">زیرنویس بدون ویسپر (با agy / Gemini)</p>
        <p class="empty-sub">
          اول سکوت‌ها رو حذف کن، بعد دکمه بالا رو بزن: صدای کات‌خورده به تکه‌های کم‌حجم تبدیل می‌شه، با مکث امن (ضد بن و ضد لیمیت) به مدل‌های صوتی <strong>Gemini</strong> فرستاده می‌شه و اگر مدلی به کوتا بخوره، خودکار سوئیچ می‌کنه به مدل بعدی!
        </p>
      </div>
    {/if}
  </div>
</section>

<style>
  .panel {
    display: grid;
    grid-template-rows: auto 1fr;
    min-height: 0;
    height: 100%;
  }

  .body {
    overflow-y: auto;
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-height: 0;
  }

  .controls {
    display: grid;
    gap: 8px;
  }

  .select-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
  }

  .small-toggle {
    font-size: 11px;
    color: var(--muted);
  }

  .hardsub-toggle {
    font-size: 12px;
    color: var(--foreground);
  }

  .style-box {
    display: grid;
    gap: 8px;
    padding: 8px;
    border-radius: var(--radius);
    background: var(--surface-2);
    border: 1px solid var(--border);
  }
  .style-title {
    font-size: 10px;
    color: var(--muted);
  }
  .style-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .style-field {
    display: grid;
    gap: 2px;
    font-size: 10px;
  }
  .style-row {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .swatches {
    display: flex;
    gap: 5px;
  }
  .swatch {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    border: 2px solid transparent;
    cursor: pointer;
    padding: 0;
  }
  .swatch.active {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px #000;
  }
  .bg-slider {
    flex: 1;
  }

  .status {
    padding: 6px 8px;
    border-radius: var(--radius-sm);
    background: hsl(213 94% 68% / 0.08);
    border: 1px solid hsl(213 94% 68% / 0.25);
    color: var(--accent);
    font-size: 10px;
    line-height: 1.5;
  }

  .yt-box {
    display: grid;
    gap: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--border);
  }

  .yt-actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
  }

  .result-block {
    display: grid;
    gap: 4px;
    padding: 6px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }

  .result-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
  }

  .result-text {
    width: 100%;
    resize: vertical;
    background: var(--input);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--foreground);
    padding: 6px;
    font-size: 11px;
    line-height: 1.5;
    outline: none;
  }

  .sub-list {
    display: grid;
    gap: 4px;
    padding-top: 8px;
    border-top: 1px solid var(--border);
  }

  .sub-row {
    display: grid;
    grid-template-columns: 44px 1fr;
    gap: 6px;
    align-items: center;
  }

  .ts {
    height: 26px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--accent);
    font-size: 10px;
    cursor: pointer;
    padding: 0;
  }
  .ts:hover {
    border-color: var(--accent);
  }

  .sub-row input {
    height: 26px;
    font-size: 11px;
    padding: 2px 6px;
  }

  .empty {
    margin: auto 0;
    padding: 14px 8px;
    text-align: center;
  }
  .empty-title {
    margin: 0 0 6px;
    font-size: 12px;
    font-weight: 600;
    color: var(--muted);
  }
  .empty-sub {
    margin: 0;
    font-size: 11px;
    line-height: 1.6;
  }

  .error {
    padding: 6px 8px;
    border-radius: var(--radius-sm);
    background: hsl(0 84% 65% / 0.08);
    border: 1px solid hsl(0 84% 65% / 0.3);
    color: var(--neg);
    font-size: 11px;
    word-break: break-word;
  }
</style>
