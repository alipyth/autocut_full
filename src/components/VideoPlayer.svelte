<script lang="ts">
  import { convertFileSrc } from "@tauri-apps/api/core";
  import { omittedIntervals, skipTargetFor, type OmittedInterval } from "../lib/cuts";
  import { editor } from "../lib/store.svelte";
  import { sourceTimeToExportTime } from "../lib/subtitles";
  import type { VideoOverlay } from "../lib/types";

  let videoEl: HTMLVideoElement | null = $state(null);
  let stageEl: HTMLDivElement | null = $state(null);
  let draggingId: string | null = $state(null);

  function startDragOverlay(e: PointerEvent, ov: VideoOverlay) {
    if (!stageEl || ov.mode === "fullscreen") return;
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    draggingId = ov.id;

    const rect = stageEl.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const origX = ov.x;
    const origY = ov.y;

    const onMove = (ev: PointerEvent) => {
      if (rect.width <= 0 || rect.height <= 0) return;
      const dx = (ev.clientX - startX) / rect.width;
      const dy = (ev.clientY - startY) / rect.height;
      const nextX = Math.max(0, Math.min(0.95, origX + dx));
      const nextY = Math.max(0, Math.min(0.92, origY + dy));
      editor.updateOverlay(ov.id, {
        mode: "custom",
        x: Number(nextX.toFixed(4)),
        y: Number(nextY.toFixed(4)),
      });
    };

    const onUp = () => {
      draggingId = null;
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", onUp);
    };

    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", onUp);
  }

  function overlayPositionStyle(ov: VideoOverlay): string {
    if (ov.mode === "fullscreen") return "";
    const w = `width: ${Math.round(ov.scale * 100)}%;`;
    if (ov.mode === "custom") {
      return `${w} left: ${(ov.x * 100).toFixed(2)}%; top: ${(ov.y * 100).toFixed(2)}%;`;
    }
    return w;
  }

  const IMAGE_RE = /\.(png|jpe?g|webp|gif|bmp)$/i;

  function isImagePath(p: string): boolean {
    return IMAGE_RE.test(p);
  }

  let exportTime = $derived(
    sourceTimeToExportTime(editor.currentTime, editor.keepIntervals()),
  );

  let activeOverlays = $derived(
    editor.overlays.filter((ov) => exportTime >= ov.start && exportTime <= ov.end),
  );

  let activeSubtitle = $derived(
    editor.transcript.find((s) => exportTime >= s.start && exportTime <= s.end) ?? null,
  );

  /// Action to keep an overlay <video> element synced with the main player's
  /// play/pause state and exported timeline offset.
  function syncOverlayVideo(node: HTMLVideoElement, params: { ov: VideoOverlay }) {
    let currentOv = params.ov;
    const syncNow = () => {
      const target = Math.max(0, exportTime - currentOv.start);
      if (Math.abs(node.currentTime - target) > 0.25) {
        try {
          node.currentTime = target;
        } catch {
          /* metadata not ready yet */
        }
      }
      if (editor.isPlaying) {
        if (node.paused) node.play().catch(() => {});
      } else if (!node.paused) {
        node.pause();
      }
    };

    const stopEffect = $effect.root(() => {
      $effect(() => {
        exportTime;
        editor.isPlaying;
        syncNow();
      });
    });

    node.addEventListener("loadedmetadata", syncNow);
    syncNow();

    return {
      update(next: { ov: VideoOverlay }) {
        currentOv = next.ov;
        syncNow();
      },
      destroy() {
        node.removeEventListener("loadedmetadata", syncNow);
        stopEffect();
      },
    };
  }

  // Recomputed when the cutlist changes, not per frame. Deliberately a plain
  // `let` rather than $state/$derived: the frame loop below reads it from an
  // async callback, and making it reactive would put the whole listener setup
  // effect on a teardown/rebuild cycle every time a cut moves.
  let omitted: OmittedInterval[] = [];
  $effect(() => {
    omitted = editor.cutlist ? omittedIntervals(editor.cutlist) : [];
  });

  let path = $derived(editor.pendingPath ?? editor.video?.path ?? null);
  let src = $derived(path ? convertFileSrc(path) : null);

  $effect(() => {
    editor.seekToken;
    if (videoEl) videoEl.currentTime = editor.seekTarget;
  });

  // UI-driven play/pause: any caller can bump playToggleToken to toggle.
  $effect(() => {
    editor.playToggleToken;
    if (!videoEl) return;
    if (editor.playToggleToken === 0) return; // skip initial run
    if (videoEl.paused || videoEl.ended) {
      videoEl.play().catch(() => {});
    } else {
      videoEl.pause();
    }
  });

  // Mirror underlying paused state into the store so UI glyphs match reality.
  $effect(() => {
    if (!videoEl) return;
    const v = videoEl;
    const onPlay = () => (editor.isPlaying = true);
    const onPause = () => (editor.isPlaying = false);
    v.addEventListener("play", onPlay);
    v.addEventListener("playing", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("ended", onPause);
    return () => {
      v.removeEventListener("play", onPlay);
      v.removeEventListener("playing", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("ended", onPause);
    };
  });

  // Spacebar play/pause anywhere in the app, except while typing in inputs.
  $effect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.code !== "Space" && e.key !== " ") return;
      const ae = document.activeElement as HTMLElement | null;
      const tag = ae?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        ae?.isContentEditable
      ) {
        return;
      }
      if (!videoEl) return;
      e.preventDefault();
      if (videoEl.paused || videoEl.ended) {
        videoEl.play().catch(() => {});
      } else {
        videoEl.pause();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  // Frame-rate-precision skip. `ontimeupdate` only fires ~4×/sec which is
  // long enough to be visible as a stutter when a remove segment is short.
  // requestVideoFrameCallback fires per decoded frame, so the jump lands
  // within one frame of entering the remove region. Fallback to rAF for
  // browsers without rVFC (Firefox at time of writing).
  //
  // Skip strategy:
  //   1. Pre-roll: when the playhead enters the last ~80ms of a keep that
  //      precedes a remove, jump straight to the next keep's start. The
  //      old "wait until we cross into the remove and then jump" approach
  //      always rendered 1-2 frames of the silent gap, which read as a
  //      stutter on short cuts.
  //   2. Post-detect: if we somehow land inside an omitted interval (e.g.
  //      from a manual seek), jump to its end.
  // The lookahead window matches a 60fps frame budget so we never schedule
  // a skip more than ~5 frames in advance.
  const SKIP_LOOKAHEAD = 0.08;

  $effect(() => {
    if (!videoEl) return;
    const v = videoEl;
    let cancelled = false;
    let scheduled = false;
    let scheduleToken = 0;
    let animationFrameId: number | null = null;
    let videoFrameId: number | null = null;
    let lastSkipTarget = -1;
    const frameVideo = v as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
      cancelVideoFrameCallback?: (handle: number) => void;
    };

    function tick() {
      if (cancelled) return;
      const t = v.currentTime;
      editor.currentTime = t;
      const isPlaying = !v.paused && !v.ended;
      if (editor.skipRemoved) {
        // Pre-roll only applies while rolling. A paused playhead parked inside
        // a removed region (from a manual seek) still escapes it, but a paused
        // playhead near one must not jump ahead on its own.
        const target = skipTargetFor(
          omitted,
          t,
          isPlaying ? SKIP_LOOKAHEAD : 0,
        );
        if (target !== null) performSkip(target);
      }
      if (isPlaying) schedule();
    }

    function performSkip(target: number) {
      // Avoid hammering currentTime= when we already requested this exact
      // skip — the browser is mid-seek and re-assigning the value can
      // cause an audible click as the audio context resets.
      if (Math.abs(lastSkipTarget - target) < 0.005) return;
      lastSkipTarget = target;
      v.currentTime = target;
    }

    function clearScheduled() {
      scheduleToken += 1;
      scheduled = false;
      if (animationFrameId !== null) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
      }
      if (videoFrameId !== null) {
        frameVideo.cancelVideoFrameCallback?.(videoFrameId);
        videoFrameId = null;
      }
    }

    function runScheduledTick(token: number) {
      if (token !== scheduleToken) return;
      scheduled = false;
      animationFrameId = null;
      videoFrameId = null;
      tick();
    }

    function schedule() {
      if (cancelled || scheduled || v.paused || v.ended) return;
      scheduled = true;
      const token = ++scheduleToken;
      if (frameVideo.requestVideoFrameCallback) {
        videoFrameId = frameVideo.requestVideoFrameCallback(() => {
          runScheduledTick(token);
        });
      } else {
        animationFrameId = requestAnimationFrame(() => {
          runScheduledTick(token);
        });
      }
    }

    function start() {
      cancelled = false;
      schedule();
    }

    function stop() {
      cancelled = true;
      clearScheduled();
    }

    const onPause = () => {
      editor.currentTime = v.currentTime;
      stop();
    };
    const onSeeked = () => {
      editor.currentTime = v.currentTime;
      lastSkipTarget = -1;
      cancelled = false;
      tick();
    };
    const onTimeUpdate = () => {
      editor.currentTime = v.currentTime;
    };

    v.addEventListener("play", start);
    v.addEventListener("playing", start);
    v.addEventListener("pause", onPause);
    v.addEventListener("ended", onPause);
    v.addEventListener("seeked", onSeeked);
    v.addEventListener("timeupdate", onTimeUpdate);
    start();

    return () => {
      stop();
      v.removeEventListener("play", start);
      v.removeEventListener("playing", start);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("ended", onPause);
      v.removeEventListener("seeked", onSeeked);
      v.removeEventListener("timeupdate", onTimeUpdate);
    };
  });
</script>

{#if src}
  <div bind:this={stageEl} class="stage-wrap">
    <video
      bind:this={videoEl}
      {src}
      controls
      preload="metadata"
    >
      <track kind="captions" />
    </video>

    {#each activeOverlays as ov (ov.id)}
      {@const ovSrc = convertFileSrc(ov.previewPath ?? ov.path)}
      <div
        class="overlay-item mode-{ov.mode}"
        class:draggable={ov.mode !== "fullscreen"}
        class:dragging={draggingId === ov.id}
        style={overlayPositionStyle(ov)}
        onpointerdown={(e) => startDragOverlay(e, ov)}
        title={ov.mode !== "fullscreen" ? "بکش و هرجا خواستی بذار" : undefined}
        role="presentation"
      >
        {#if ov.previewLoading}
          <div class="ov-loading mono">آماده‌سازی پیش‌نمایش شفاف {ov.name}…</div>
        {:else if isImagePath(ov.path)}
          <img src={ovSrc} alt={ov.name} draggable="false" />
        {:else}
          <video
            src={ovSrc}
            muted
            playsinline
            preload="auto"
            onerror={() => editor.ensureOverlayPreview(ov.id)}
            use:syncOverlayVideo={{ ov }}
          ></video>
        {/if}
      </div>
    {/each}

    {#if activeSubtitle}
      <div
        class="sub-preview"
        dir="auto"
        style={`bottom: calc(44px + ${editor.subtitleStyle.bottomPct}%);`}
      >
        <span
          style={`font-size: ${Math.max(12, Math.round(editor.subtitleStyle.fontSize * 0.78))}px; color: ${editor.subtitleStyle.color}; background: rgba(0, 0, 0, ${editor.subtitleStyle.bgOpacity});`}
        >{activeSubtitle.text}</span>
      </div>
    {/if}
  </div>
{:else}
  <div class="empty mono muted-2">no video loaded</div>
{/if}

<style>
  .stage-wrap {
    position: relative;
    width: 100%;
    height: 100%;
    background: #000;
    border-radius: var(--radius-lg);
    overflow: hidden;
  }
  .stage-wrap > video {
    width: 100%;
    height: 100%;
    object-fit: contain;
    background: #000;
    display: block;
  }

  .overlay-item {
    position: absolute;
    pointer-events: none;
    z-index: 3;
    overflow: hidden;
    background: transparent;
    user-select: none;
  }
  .overlay-item.draggable {
    pointer-events: auto;
    cursor: grab;
    border-radius: 6px;
    outline: 1px dashed transparent;
    transition: outline-color 120ms;
  }
  .overlay-item.draggable:hover {
    outline-color: hsl(213 94% 68% / 0.75);
  }
  .overlay-item.dragging {
    cursor: grabbing;
    outline: 2px solid var(--accent);
  }
  .overlay-item img,
  .overlay-item video {
    width: 100%;
    height: 100%;
    display: block;
    border: 0 !important;
    background: transparent !important;
    pointer-events: none;
  }

  .overlay-item.mode-fullscreen {
    inset: 0 0 44px 0;
    background: transparent;
  }
  .overlay-item.mode-fullscreen img,
  .overlay-item.mode-fullscreen video {
    object-fit: contain;
  }

  .overlay-item.mode-pip-tr { top: 16px; right: 16px; }
  .overlay-item.mode-pip-tl { top: 16px; left: 16px; }
  .overlay-item.mode-pip-br { bottom: 56px; right: 16px; }
  .overlay-item.mode-pip-bl { bottom: 56px; left: 16px; }

  .ov-loading {
    padding: 12px 14px;
    font-size: 11px;
    color: var(--accent);
    background: hsl(0 0% 0% / 0.8);
    text-align: center;
  }

  .sub-preview {
    position: absolute;
    left: 50%;
    bottom: 54px;
    transform: translateX(-50%);
    max-width: 86%;
    z-index: 5;
    pointer-events: none;
    text-align: center;
  }
  .sub-preview span {
    display: inline-block;
    padding: 4px 12px;
    border-radius: 6px;
    background: hsl(0 0% 0% / 0.72);
    color: #fff;
    font-size: 16px;
    font-weight: 600;
    line-height: 1.5;
    text-shadow: 0 1px 3px #000, 0 0 6px #000;
  }

  .empty {
    display: grid;
    place-items: center;
    height: 100%;
    font-size: 12px;
  }
</style>
