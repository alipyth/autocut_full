//! Cut MP4 export: feed the kept intervals to ffmpeg via the concat demuxer.
//! A temp list file describes each kept range as a `file` + `inpoint` +
//! `outpoint` triple, ffmpeg seeks to each in turn and re-encodes (libx264 +
//! aac). Lossless smart-cut is deferred.
//!
//! Why concat demuxer and not `filter_complex select`: building a single
//! `select=between(t,a,b)+between(t,c,d)+...` expression scales linearly with
//! the number of keeps. Past a few hundred intervals ffmpeg's expression
//! parser fails to allocate the parse tree ("Cannot allocate memory" inside
//! AVFilterGraph init), killing the export. The concat demuxer reads a flat
//! list and has no such limit.
//!
//! Progress is parsed from ffmpeg stderr `out_time_us=` lines (emitted via
//! `-progress pipe:2`). Total target duration is the sum of kept intervals
//! since the output stream's wall-clock is shorter than the source.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use anyhow::{anyhow, Context, Result};
use serde::Deserialize;

use crate::cutlist::CutList;
use crate::sync::lock;

pub struct ExportProgress {
    pub pct: f32,
    pub message: String,
}

/// Quality preset chosen by the user. CRF is libx264's rate-distortion knob:
/// lower = higher quality + bigger file. Audio bitrate scales with it.
#[derive(Debug, Clone, Copy)]
pub enum Quality {
    High,
    Medium,
    Small,
}

impl Quality {
    fn crf(self) -> u8 {
        match self {
            Quality::High => 18,
            Quality::Medium => 22,
            Quality::Small => 26,
        }
    }
    fn audio_bitrate(self) -> &'static str {
        match self {
            Quality::High => "192k",
            Quality::Medium => "128k",
            Quality::Small => "96k",
        }
    }
}

/// Output resolution. `Source` keeps the original dimensions; the numeric
/// variants downscale to that target height (using `-2` for width to keep
/// the aspect ratio while staying divisible by 2 for h264).
#[derive(Debug, Clone, Copy)]
pub enum Resolution {
    Source,
    P1080,
    P720,
    P480,
}

impl Resolution {
    fn target_height(self) -> Option<u32> {
        match self {
            Resolution::Source => None,
            Resolution::P1080 => Some(1080),
            Resolution::P720 => Some(720),
            Resolution::P480 => Some(480),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OverlayMode {
    Fullscreen,
    Custom,
    PipTr,
    PipTl,
    PipBr,
    PipBl,
}

#[derive(Debug, Clone, Deserialize)]
pub struct VideoOverlay {
    pub path: String,
    pub start: f64,
    pub end: f64,
    pub mode: OverlayMode,
    #[serde(default = "default_overlay_scale")]
    pub scale: f64,
    /// Normalized top-left position (0.0..1.0) used when mode == Custom.
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
}

fn default_overlay_scale() -> f64 {
    0.30
}

#[derive(Debug, Clone, Deserialize)]
pub struct SubtitleStyle {
    #[serde(default = "default_sub_font_size")]
    pub font_size: u32,
    #[serde(default = "default_sub_margin_v")]
    pub margin_v: u32,
    /// Hex color like "#FFFFFF" or "#FFE600"
    #[serde(default = "default_sub_color")]
    pub color: String,
    /// Background opacity 0.0..1.0
    #[serde(default = "default_sub_bg_opacity")]
    pub bg_opacity: f64,
}

fn default_sub_font_size() -> u32 { 22 }
fn default_sub_margin_v() -> u32 { 28 }
fn default_sub_color() -> String { "#FFFFFF".to_string() }
fn default_sub_bg_opacity() -> f64 { 0.7 }

impl Default for SubtitleStyle {
    fn default() -> Self {
        Self {
            font_size: default_sub_font_size(),
            margin_v: default_sub_margin_v(),
            color: default_sub_color(),
            bg_opacity: default_sub_bg_opacity(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct ExportOptions {
    pub quality: Quality,
    pub resolution: Resolution,
    pub has_audio: bool,
    /// Optional SRT subtitle text (already remapped to the cut timeline) to
    /// burn directly into the exported MP4 via ffmpeg's `subtitles` filter.
    pub burn_subtitles_srt: Option<String>,
    pub subtitle_style: SubtitleStyle,
    /// When true, applies YouTube-standard -14 LUFS loudness normalization.
    pub normalize_audio: bool,
    /// Optional B-Roll / Picture-in-Picture video or image layers composited
    /// onto the exported timeline at the specified [start, end] ranges.
    pub overlays: Vec<VideoOverlay>,
}

impl Default for ExportOptions {
    fn default() -> Self {
        Self {
            quality: Quality::Medium,
            resolution: Resolution::Source,
            has_audio: true,
            burn_subtitles_srt: None,
            subtitle_style: SubtitleStyle::default(),
            normalize_audio: false,
            overlays: Vec::new(),
        }
    }
}

pub fn export(
    ffmpeg: &Path,
    source: &Path,
    output: &Path,
    cutlist: &CutList,
    options: ExportOptions,
    cancel: Arc<AtomicBool>,
    on_progress: impl FnMut(ExportProgress) + Send + 'static,
) -> Result<()> {
    cutlist.ensure_exportable()?;
    let kept_total: f64 = cutlist.total_kept_duration();

    let list_path = concat_list_path();
    std::fs::write(&list_path, build_concat_list(source, cutlist))
        .with_context(|| format!("writing concat list at {}", list_path.display()))?;
    // Defer file removal so it persists even if we early-return on error —
    // makes failures debuggable. Cleaned up at the bottom of the happy path.

    let srt_path = if let Some(ref srt_text) = options.burn_subtitles_srt {
        if !srt_text.trim().is_empty() {
            let p = subtitle_temp_path();
            std::fs::write(&p, srt_text)
                .with_context(|| format!("writing temp subtitles at {}", p.display()))?;
            Some(p)
        } else {
            None
        }
    } else {
        None
    };

    let crf = options.quality.crf().to_string();

    let mut cmd = Command::new(ffmpeg);
    cmd.args([
        "-y",
        "-hide_banner",
        "-nostats",
        "-progress",
        "pipe:2",
        "-loglevel",
        "error",
    ])
    .args(["-f", "concat", "-safe", "0"])
    .arg("-i")
    .arg(&list_path);

    let active_overlays: Vec<&VideoOverlay> = options
        .overlays
        .iter()
        .filter(|o| !o.path.trim().is_empty() && o.end > o.start)
        .collect();

    for ov in &active_overlays {
        cmd.arg("-i").arg(&ov.path);
    }

    if !active_overlays.is_empty() {
        let fc = build_overlay_filter_complex(
            options.resolution.target_height(),
            &active_overlays,
            srt_path.as_deref(),
            &options.subtitle_style,
        );
        cmd.args(["-filter_complex", &fc, "-map", "[vout]"]);
        if options.has_audio {
            cmd.args(["-map", "0:a?"]);
        }
    } else if let Some(vf) = build_video_filter(
        options.resolution.target_height(),
        srt_path.as_deref(),
        &options.subtitle_style,
    ) {
        cmd.args(["-vf", &vf]);
    }

    cmd.args(["-c:v", "libx264", "-preset", "veryfast", "-crf", &crf]);

    if options.has_audio {
        if options.normalize_audio {
            cmd.args(["-af", "loudnorm=I=-14:TP=-1.5:LRA=11"]);
        }
        cmd.args(["-c:a", "aac", "-b:a", options.quality.audio_bitrate()]);
    } else {
        cmd.arg("-an");
    }
    cmd.arg(output);
    cmd.stdout(Stdio::null()).stderr(Stdio::piped());

    let mut child = cmd.spawn().context("spawning ffmpeg for export")?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| anyhow!("ffmpeg stderr unavailable"))?;

    // Keep a rolling buffer of the last few non-progress stderr lines so we
    // can surface ffmpeg's actual error message when the encode fails.
    // Anything matching `key=value` is a progress field; the real diagnostics
    // are the plain-prose lines.
    let stderr_tail: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let stderr_tail_writer = stderr_tail.clone();
    let cancel_thread = cancel.clone();
    let reader = thread::spawn(move || -> Result<()> {
        // The callback is owned outright by this thread, so it needs no
        // synchronisation — it used to sit behind a Mutex that nothing else
        // could ever contend for.
        let mut on_progress = on_progress;
        let buf = BufReader::new(stderr);
        for line in buf.lines() {
            let line = line.context("reading ffmpeg stderr")?;
            if cancel_thread.load(Ordering::SeqCst) {
                break;
            }
            if let Some(us) = line.strip_prefix("out_time_us=") {
                if let Ok(us) = us.trim().parse::<i64>() {
                    let seconds = us.max(0) as f64 / 1_000_000.0;
                    let pct = ((seconds / kept_total) * 100.0).clamp(0.0, 99.0);
                    let msg = format!("encoded {:.2}s of {:.2}s kept", seconds, kept_total);
                    on_progress(ExportProgress {
                        pct: pct as f32,
                        message: msg,
                    });
                }
                continue;
            }
            // Only keep the last 20 diagnostic lines — enough to identify the
            // failure without dumping every progress key.
            if !is_progress_line(&line) && !line.trim().is_empty() {
                let mut tail = lock(&stderr_tail_writer);
                tail.push(line);
                if tail.len() > 20 {
                    let drop = tail.len() - 20;
                    tail.drain(0..drop);
                }
            }
        }
        Ok(())
    });

    // Cancellation: poll the flag and kill the child if set.
    let outcome: Result<()> = loop {
        if cancel.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = reader.join();
            break Err(anyhow!("export cancelled"));
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                let _ = reader.join();
                if !status.success() {
                    let tail = lock(&stderr_tail);
                    let detail = if tail.is_empty() {
                        String::new()
                    } else {
                        format!("\nffmpeg said:\n{}", tail.join("\n"))
                    };
                    break Err(anyhow!("ffmpeg exited with {status}{detail}"));
                }
                break Ok(());
            }
            Ok(None) => thread::sleep(std::time::Duration::from_millis(100)),
            Err(e) => break Err(anyhow!("waiting on ffmpeg: {e}")),
        }
    };

    // Only clean up the concat list on success; leave it on disk on failure so
    // the user (or a bug report) can inspect what we asked ffmpeg to do.
    if outcome.is_ok() {
        let _ = std::fs::remove_file(&list_path);
        if let Some(ref p) = srt_path {
            let _ = std::fs::remove_file(p);
        }
    } else {
        let _ = std::fs::remove_file(output);
    }
    outcome
}

fn subtitle_temp_path() -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let id = COUNTER.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("autocut-subs-{}-{}.srt", std::process::id(), id))
}

/// Escape a filesystem path for ffmpeg's `subtitles=filename='...'` filter
/// (libass syntax). Forward slashes avoid backslash-escaping pitfalls on
/// Windows, and drive-letter colons (`C:`) must be escaped as `C\:`.
fn escape_ffmpeg_subtitle_path(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "/")
        .replace(':', "\\:")
        .replace('\'', "\\'")
}

/// Convert `#RRGGBB` to ASS `&H00BBGGRR`.
fn hex_to_ass_color(hex: &str) -> String {
    let s = hex.trim().trim_start_matches('#');
    if s.len() == 6 && s.chars().all(|c| c.is_ascii_hexdigit()) {
        let r = &s[0..2];
        let g = &s[2..4];
        let b = &s[4..6];
        return format!("&H00{}{}{}", b.to_uppercase(), g.to_uppercase(), r.to_uppercase());
    }
    "&H00FFFFFF".to_string()
}

fn subtitle_filter_expr(srt: &Path, style: &SubtitleStyle) -> String {
    let escaped = escape_ffmpeg_subtitle_path(srt);
    let font_size = style.font_size.clamp(12, 64);
    let margin_v = style.margin_v.clamp(8, 260);
    let primary = hex_to_ass_color(&style.color);
    let alpha = ((1.0 - style.bg_opacity.clamp(0.0, 1.0)) * 255.0).round() as u8;
    let back = format!("&H{:02X}000000", alpha);
    let border_style = if style.bg_opacity > 0.05 { 3 } else { 1 };
    format!(
        "subtitles='{escaped}':force_style='FontSize={font_size},PrimaryColour={primary},OutlineColour=&H00000000,BackColour={back},BorderStyle={border_style},Outline=2,Shadow=1,MarginV={margin_v}'"
    )
}

fn build_video_filter(
    target_height: Option<u32>,
    srt_path: Option<&Path>,
    style: &SubtitleStyle,
) -> Option<String> {
    let mut filters = Vec::new();
    if let Some(h) = target_height {
        filters.push(format!("scale=-2:{h}"));
    }
    if let Some(srt) = srt_path {
        filters.push(subtitle_filter_expr(srt, style));
    }
    if filters.is_empty() {
        None
    } else {
        Some(filters.join(","))
    }
}

fn build_overlay_filter_complex(
    target_height: Option<u32>,
    overlays: &[&VideoOverlay],
    srt_path: Option<&Path>,
    style: &SubtitleStyle,
) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut current_base = if let Some(h) = target_height {
        parts.push(format!("[0:v]scale=-2:{h}[base0]"));
        "[base0]".to_string()
    } else {
        parts.push("[0:v]null[base0]".to_string());
        "[base0]".to_string()
    };

    for (i, ov) in overlays.iter().enumerate() {
        let input_idx = i + 1;
        let start = ov.start.max(0.0);
        let end = ov.end.max(start);
        let next_base = format!("[base{}]", i + 1);
        let scale = ov.scale.clamp(0.10, 1.0);

        // Preserve alpha channel (ProRes 4444 / PNG-in-MOV / VP9 WebM / PNG) via format=rgba.
        parts.push(format!(
            "[{input_idx}:v]format=rgba,setpts=PTS-STARTPTS+{start:.3}/TB[ovraw{i}]"
        ));

        match ov.mode {
            OverlayMode::Fullscreen => {
                parts.push(format!(
                    "[ovraw{i}]{current_base}scale2ref=w=iw:h=ih:force_original_aspect_ratio=decrease[ov{i}][ref{i}]"
                ));
                parts.push(format!(
                    "[ref{i}][ov{i}]overlay=(W-w)/2:(H-h)/2:enable='between(t,{start:.3},{end:.3})':eof_action=pass:format=auto{next_base}"
                ));
            }
            OverlayMode::Custom => {
                let nx = ov.x.clamp(0.0, 1.0);
                let ny = ov.y.clamp(0.0, 1.0);
                parts.push(format!(
                    "[ovraw{i}]{current_base}scale2ref=w=iw*{scale:.3}:h=-2[ov{i}][ref{i}]"
                ));
                parts.push(format!(
                    "[ref{i}][ov{i}]overlay=W*{nx:.4}:H*{ny:.4}:enable='between(t,{start:.3},{end:.3})':eof_action=pass:format=auto{next_base}"
                ));
            }
            OverlayMode::PipTr | OverlayMode::PipTl | OverlayMode::PipBr | OverlayMode::PipBl => {
                let (x, y) = match ov.mode {
                    OverlayMode::PipTr => ("W-w-24", "24"),
                    OverlayMode::PipTl => ("24", "24"),
                    OverlayMode::PipBr => ("W-w-24", "H-h-24"),
                    OverlayMode::PipBl => ("24", "H-h-24"),
                    _ => unreachable!(),
                };
                parts.push(format!(
                    "[ovraw{i}]{current_base}scale2ref=w=iw*{scale:.3}:h=-2[ov{i}][ref{i}]"
                ));
                parts.push(format!(
                    "[ref{i}][ov{i}]overlay={x}:{y}:enable='between(t,{start:.3},{end:.3})':eof_action=pass:format=auto{next_base}"
                ));
            }
        }
        current_base = next_base;
    }

    if let Some(srt) = srt_path {
        parts.push(format!("{current_base}{}[vout]", subtitle_filter_expr(srt, style)));
    } else {
        parts.push(format!("{current_base}null[vout]"));
    }

    parts.join(";")
}

/// Transcode a non-browser-friendly overlay video (e.g. QuickTime .mov ProRes/HEVC)
/// into a lightweight H.264/yuv420p MP4 proxy so WebView2 can render a live preview.
/// Export still uses the original full-quality file.
pub fn prepare_overlay_preview(ffmpeg: &Path, source: &Path) -> Result<PathBuf> {
    let dir = std::env::temp_dir().join("autocut-overlay-previews");
    std::fs::create_dir_all(&dir)
        .with_context(|| format!("creating preview dir {}", dir.display()))?;

    let meta = std::fs::metadata(source)
        .with_context(|| format!("reading metadata for {}", source.display()))?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let stem = source
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("overlay")
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect::<String>();
    let out_path = dir.join(format!("alpha_{stem}_{}_{}.webm", meta.len(), mtime));
    if out_path.exists() {
        return Ok(out_path);
    }

    // VP9 with yuva420p preserves alpha transparency natively in Chromium/WebView2.
    let out = Command::new(ffmpeg)
        .args(["-y", "-hide_banner", "-loglevel", "error"])
        .arg("-i")
        .arg(source)
        .args([
            "-an",
            "-vf",
            "scale='min(1280,iw)':-2,format=yuva420p",
            "-c:v",
            "libvpx-vp9",
            "-pix_fmt",
            "yuva420p",
            "-auto-alt-ref",
            "0",
            "-deadline",
            "realtime",
            "-cpu-used",
            "8",
            "-crf",
            "32",
            "-b:v",
            "0",
        ])
        .arg(&out_path)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .context("spawning ffmpeg for transparent overlay preview proxy")?;

    if !out.status.success() {
        let _ = std::fs::remove_file(&out_path);
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(anyhow!(
            "overlay preview proxy failed ({}): {}",
            out.status,
            stderr.trim()
        ));
    }
    Ok(out_path)
}

/// Is this stderr line one of ffmpeg's `-progress` fields rather than a
/// diagnostic worth showing the user?
///
/// The progress stream is strictly `snake_case_key=value`. Testing for a bare
/// '=' anywhere in the line also swallowed real errors — ffmpeg says things
/// like "maybe incorrect parameters such as bit_rate, rate, width or height"
/// and quotes filter expressions containing '=' — which left failed exports
/// reporting nothing but the exit status.
fn is_progress_line(line: &str) -> bool {
    let Some((key, _)) = line.split_once('=') else {
        return false;
    };
    !key.is_empty()
        && key
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

/// Build a concat demuxer list (UTF-8, LF line endings) repeating the source
/// path for every kept interval with `inpoint`/`outpoint` directives.
///
/// The path is wrapped in single quotes; embedded single quotes are escaped as
/// `'\''` (close-quote, escaped-quote, reopen-quote — the standard POSIX
/// shell idiom that ffmpeg's concat parser also accepts). Backslashes in
/// Windows paths are literal inside single quotes; no escaping needed.
fn build_concat_list(source: &Path, cutlist: &CutList) -> String {
    let escaped = source.to_string_lossy().replace('\'', "'\\''");
    let mut out = String::new();
    out.push_str("ffconcat version 1.0\n");
    for c in cutlist.kept_intervals() {
        out.push_str(&format!("file '{escaped}'\n"));
        out.push_str(&format!("inpoint {:.6}\n", c.start));
        out.push_str(&format!("outpoint {:.6}\n", c.end));
    }
    out
}

/// Unique path inside the OS temp dir. PID + a process-local atomic counter
/// guarantees no collision between concurrent exports (the cli never runs them
/// in parallel today, but cheap insurance).
fn concat_list_path() -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let id = COUNTER.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("autocut-concat-{}-{}.txt", std::process::id(), id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cutlist::{Cut, CutKind};

    #[test]
    fn concat_list_emits_one_entry_per_kept_interval() {
        let cl = CutList {
            source_duration: 10.0,
            intervals: vec![
                Cut {
                    start: 0.0,
                    end: 1.0,
                    kind: CutKind::Keep,
                },
                Cut {
                    start: 1.0,
                    end: 2.0,
                    kind: CutKind::Remove,
                },
                Cut {
                    start: 2.0,
                    end: 3.5,
                    kind: CutKind::Keep,
                },
            ],
        };
        let list = build_concat_list(Path::new("/tmp/clip.mp4"), &cl);
        assert!(list.starts_with("ffconcat version 1.0\n"), "{list}");
        assert_eq!(list.matches("file '/tmp/clip.mp4'").count(), 2);
        assert!(list.contains("inpoint 0.000000"));
        assert!(list.contains("outpoint 1.000000"));
        assert!(list.contains("inpoint 2.000000"));
        assert!(list.contains("outpoint 3.500000"));
        // The removed range must not appear as a keep entry.
        assert!(!list.contains("inpoint 1.000000\noutpoint 2.000000"));
    }

    #[test]
    fn concat_list_is_just_a_header_when_no_keeps() {
        let cl = CutList {
            source_duration: 5.0,
            intervals: vec![],
        };
        let list = build_concat_list(Path::new("/tmp/clip.mp4"), &cl);
        assert_eq!(list, "ffconcat version 1.0\n");
    }

    #[test]
    fn concat_list_escapes_single_quotes_in_paths() {
        let cl = CutList {
            source_duration: 5.0,
            intervals: vec![Cut {
                start: 0.0,
                end: 1.0,
                kind: CutKind::Keep,
            }],
        };
        let list = build_concat_list(Path::new("/tmp/it's mine.mp4"), &cl);
        assert!(list.contains(r"file '/tmp/it'\''s mine.mp4'"), "{list}");
    }

    #[test]
    fn concat_list_preserves_windows_backslash_paths() {
        let cl = CutList {
            source_duration: 5.0,
            intervals: vec![Cut {
                start: 0.0,
                end: 1.0,
                kind: CutKind::Keep,
            }],
        };
        let list = build_concat_list(Path::new(r"C:\Users\me\my video.mp4"), &cl);
        // Backslashes are literal inside single quotes; nothing should escape them.
        assert!(list.contains(r"file 'C:\Users\me\my video.mp4'"), "{list}");
    }

    #[test]
    fn concat_list_path_is_unique_per_call() {
        let a = concat_list_path();
        let b = concat_list_path();
        assert_ne!(a, b);
    }

    #[test]
    fn progress_fields_are_recognised() {
        for line in [
            "out_time_us=1234567",
            "frame=42",
            "bitrate=N/A",
            "speed=1.02x",
            "progress=continue",
        ] {
            assert!(is_progress_line(line), "{line} should be a progress field");
        }
    }

    #[test]
    fn diagnostics_containing_an_equals_sign_are_not_mistaken_for_progress() {
        // The tail buffer exists to surface ffmpeg's actual complaint when an
        // encode fails. Treating every line with an '=' in it as a progress
        // field threw away exactly the lines worth keeping, leaving the user
        // with a bare "ffmpeg exited with exit status: 1".
        for line in [
            "[libx264 @ 0x7f8] width not divisible by 2 (1921x1080)",
            "Error while opening encoder for output stream #0:0 - maybe incorrect parameters such as bit_rate, rate, width or height",
            "[Parsed_scale_0 @ 0x600] Error when evaluating the expression 'a=b'",
            "Conversion failed!",
            "",
        ] {
            assert!(
                !is_progress_line(line),
                "{line} should be kept as a diagnostic"
            );
        }
    }
}
