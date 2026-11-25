<script lang="ts">
  import { open } from "@tauri-apps/plugin-dialog";
  import { editor } from "../lib/store.svelte";
  import { sourceTimeToExportTime } from "../lib/subtitles";
  import type { OverlayMode } from "../lib/types";

  const MODES: { value: OverlayMode; label: string }[] = [
    { value: "custom", label: "آزاد (با ماوس روی ویدیو بکش)" },
    { value: "fullscreen", label: "تمام صفحه (B-Roll)" },
    { value: "pip-tr", label: "بالا راست (PiP)" },
    { value: "pip-tl", label: "بالا چپ (PiP)" },
    { value: "pip-br", label: "پایین راست (PiP)" },
    { value: "pip-bl", label: "پایین چپ (PiP)" },
  ];

  async function pickOverlay() {
    const picked = await open({
      multiple: true,
      directory: false,
      filters: [
        {
          name: "Video or Image",
          extensions: ["mp4", "mov", "mkv", "webm", "avi", "png", "jpg", "jpeg", "webp"],
        },
      ],
    });
    if (!picked) return;
    for (const p of Array.isArray(picked) ? picked : [picked]) {
      const t = Number(
        sourceTimeToExportTime(editor.currentTime, editor.keepIntervals()).toFixed(1),
      );
      editor.addOverlay(p, t, Number((t + 5).toFixed(1)));
    }
  }
</script>

<section class="card panel">
  <header class="card-head">
    <div>
      <h2>video layers</h2>
      <p class="card-sub">
        {#if editor.overlays.length > 0}
          <span class="mono">{editor.overlays.length}</span> active overlay(s)
        {:else}
          b-roll &amp; picture-in-picture
        {/if}
      </p>
    </div>
    <button
      class="btn btn-primary btn-sm"
      onclick={pickOverlay}
      disabled={!editor.video}
    >+ add layer</button>
  </header>

  <div class="body">
    {#if editor.overlays.length === 0}
      <div class="empty muted-2">
        <p class="empty-title">افزودن لایه ویدیو یا عکس (B-Roll / PiP)</p>
        <p class="empty-sub">
          هر ویدیو یا عکسی رو می‌تونی در هر بازه زمانی دلخواه روی ویدیوی اصلی بذاری — چه به صورت تمام صفحه (B-Roll) و چه در گوشه‌های تصویر (Picture-in-Picture). هنگام اکسپورت MP4 خودکار ترکیب می‌شه.
        </p>
      </div>
    {:else}
      {#each editor.overlays as ov (ov.id)}
        <div class="layer-card">
          <div class="layer-head">
            <span class="layer-name mono" title={ov.path}>{ov.name}</span>
            <button
              class="btn btn-ghost btn-sm"
              onclick={() => editor.removeOverlay(ov.id)}
              title="حذف این لایه"
            >×</button>
          </div>

          <div class="time-row">
            <label class="time-field">
              <span class="mono muted-2">از (s)</span>
              <input
                type="number"
                step="0.5"
                min="0"
                class="mono"
                value={ov.start}
                onchange={(e) => {
                  const v = e.currentTarget.valueAsNumber;
                  if (Number.isFinite(v)) {
                    editor.updateOverlay(ov.id, {
                      start: Math.max(0, v),
                      end: Math.max(ov.end, v + 0.5),
                    });
                  }
                }}
              />
            </label>
            <label class="time-field">
              <span class="mono muted-2">تا (s)</span>
              <input
                type="number"
                step="0.5"
                min="0.5"
                class="mono"
                value={ov.end}
                onchange={(e) => {
                  const v = e.currentTarget.valueAsNumber;
                  if (Number.isFinite(v)) {
                    editor.updateOverlay(ov.id, {
                      end: Math.max(ov.start + 0.5, v),
                    });
                  }
                }}
              />
            </label>
            <button
              class="btn btn-sm"
              onclick={() => {
                const t = Number(
                  sourceTimeToExportTime(editor.currentTime, editor.keepIntervals()).toFixed(1),
                );
                const dur = Math.max(1, ov.end - ov.start);
                editor.updateOverlay(ov.id, { start: t, end: Number((t + dur).toFixed(1)) });
              }}
              title="تنظیم شروع لایه روی مکان فعلی پلی‌هد (زمان کات‌خورده)"
            >پلی‌هد</button>
          </div>

          <div class="mode-row">
            <select
              value={ov.mode}
              onchange={(e) =>
                editor.updateOverlay(ov.id, {
                  mode: e.currentTarget.value as OverlayMode,
                })}
            >
              {#each MODES as m (m.value)}
                <option value={m.value}>{m.label}</option>
              {/each}
            </select>
          </div>

          {#if ov.mode !== "fullscreen"}
            <div class="scale-row">
              <span class="mono muted-2">
                سایز: {Math.round(ov.scale * 100)}%
                {#if ov.mode === "custom"}
                  · X:{Math.round(ov.x * 100)}% Y:{Math.round(ov.y * 100)}%
                {/if}
              </span>
              <input
                type="range"
                min="0.10"
                max="1.0"
                step="0.02"
                value={ov.scale}
                oninput={(e) =>
                  editor.updateOverlay(ov.id, {
                    scale: e.currentTarget.valueAsNumber,
                  })}
              />
            </div>
          {/if}
        </div>
      {/each}
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
    gap: 8px;
    min-height: 0;
  }

  .layer-card {
    padding: 8px;
    border-radius: var(--radius);
    background: var(--surface-2);
    border: 1px solid var(--border);
    display: grid;
    gap: 8px;
  }

  .layer-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
  }

  .layer-name {
    font-size: 11px;
    color: var(--foreground);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .time-row {
    display: grid;
    grid-template-columns: 1fr 1fr auto;
    gap: 6px;
    align-items: end;
  }

  .time-field {
    display: grid;
    gap: 2px;
    font-size: 10px;
  }

  .time-field input {
    height: 26px;
    font-size: 11px;
    padding: 2px 6px;
  }

  .scale-row {
    display: grid;
    gap: 2px;
    font-size: 10px;
  }

  .empty {
    margin: auto 0;
    padding: 16px 8px;
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
</style>
