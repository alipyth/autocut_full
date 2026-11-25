//! Audio chunk preparation for multimodal AI transcription (agy / Gemini via cli2api).
//!
//! Cuts the kept voice intervals from the source media into compact 16kHz mono
//! MP3 chunks (~45s each) inside the shared cli2api workspace directory so `agy`
//! can read each audio file directly without permission prompts or sending dead
//! silence.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};

use crate::cutlist::CutList;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioChunk {
    pub index: usize,
    pub path: String,
    pub rel_path: String,
    /// Start/end on the post-cut (exported) timeline, in seconds.
    pub timeline_start: f64,
    pub timeline_end: f64,
    /// Anchor start/end on the original source video, in seconds.
    pub source_start: f64,
    pub source_end: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreparedChunks {
    pub dir: String,
    pub chunks: Vec<AudioChunk>,
}

/// Group kept intervals into batches whose total spoken duration stays <= max_chunk_secs.
#[derive(Debug, Clone)]
struct ChunkGroup {
    intervals: Vec<(f64, f64)>,
    timeline_start: f64,
    timeline_end: f64,
    source_start: f64,
    source_end: f64,
}

fn group_keeps(cutlist: &CutList, max_chunk_secs: f64) -> Vec<ChunkGroup> {
    let max_secs = max_chunk_secs.clamp(15.0, 120.0);
    let keeps: Vec<(f64, f64)> = cutlist
        .kept_intervals()
        .map(|c| (c.start, c.end))
        .filter(|(s, e)| *e - *s > 0.05)
        .collect();

    let mut groups: Vec<ChunkGroup> = Vec::new();
    let mut timeline_cursor = 0.0;

    let mut cur_intervals: Vec<(f64, f64)> = Vec::new();
    let mut cur_dur = 0.0;
    let mut cur_tl_start = 0.0;

    let flush = |groups: &mut Vec<ChunkGroup>,
                 intervals: &mut Vec<(f64, f64)>,
                 tl_start: f64,
                 tl_end: f64| {
        if intervals.is_empty() {
            return;
        }
        let src_start = intervals.first().map(|x| x.0).unwrap_or(0.0);
        let src_end = intervals.last().map(|x| x.1).unwrap_or(src_start);
        groups.push(ChunkGroup {
            intervals: std::mem::take(intervals),
            timeline_start: tl_start,
            timeline_end: tl_end,
            source_start: src_start,
            source_end: src_end,
        });
    };

    for (start, end) in keeps {
        let mut s = start;
        while end - s > 0.05 {
            let remaining_room = max_secs - cur_dur;
            if remaining_room < 1.0 && !cur_intervals.is_empty() {
                flush(&mut groups, &mut cur_intervals, cur_tl_start, timeline_cursor);
                cur_dur = 0.0;
                cur_tl_start = timeline_cursor;
            }
            let take = (end - s).min(max_secs - cur_dur);
            if cur_intervals.is_empty() {
                cur_tl_start = timeline_cursor;
            }
            cur_intervals.push((s, s + take));
            cur_dur += take;
            timeline_cursor += take;
            s += take;

            if cur_dur >= max_secs - 0.01 {
                flush(&mut groups, &mut cur_intervals, cur_tl_start, timeline_cursor);
                cur_dur = 0.0;
                cur_tl_start = timeline_cursor;
            }
        }
    }

    flush(&mut groups, &mut cur_intervals, cur_tl_start, timeline_cursor);
    groups
}

fn chunk_output_dir(work_dir: Option<&Path>) -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let id = COUNTER.fetch_add(1, Ordering::Relaxed);
    let base = work_dir
        .map(|p| p.to_path_buf())
        .or_else(|| std::env::var_os("CLI2API_WORKDIR").map(PathBuf::from))
        .unwrap_or_else(|| std::env::temp_dir().join("autocut-audio-chunks"));
    base.join("chunks").join(format!("job-{}-{}", std::process::id(), id))
}

fn build_concat_for_intervals(source: &Path, intervals: &[(f64, f64)]) -> String {
    let escaped = source.to_string_lossy().replace('\'', "'\\''");
    let mut out = String::from("ffconcat version 1.0\n");
    for (start, end) in intervals {
        out.push_str(&format!("file '{escaped}'\n"));
        out.push_str(&format!("inpoint {:.6}\n", start));
        out.push_str(&format!("outpoint {:.6}\n", end));
    }
    out
}

pub fn prepare_audio_chunks(
    ffmpeg: &Path,
    source: &Path,
    cutlist: &CutList,
    max_chunk_secs: f64,
    work_dir: Option<&Path>,
) -> Result<PreparedChunks> {
    let groups = group_keeps(cutlist, max_chunk_secs);
    if groups.is_empty() {
        return Err(anyhow!("no audio intervals to transcribe"));
    }

    let out_dir = chunk_output_dir(work_dir);
    std::fs::create_dir_all(&out_dir)
        .with_context(|| format!("creating audio chunk dir {}", out_dir.display()))?;

    let mut chunks = Vec::with_capacity(groups.len());
    for (idx, g) in groups.iter().enumerate() {
        let list_path = out_dir.join(format!("concat_{idx:03}.txt"));
        let mp3_path = out_dir.join(format!("chunk_{idx:03}.mp3"));

        std::fs::write(&list_path, build_concat_for_intervals(source, &g.intervals))
            .with_context(|| format!("writing chunk concat list {}", list_path.display()))?;

        let out = Command::new(ffmpeg)
            .args(["-y", "-hide_banner", "-loglevel", "error"])
            .args(["-f", "concat", "-safe", "0"])
            .arg("-i")
            .arg(&list_path)
            .args(["-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k"])
            .arg(&mp3_path)
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output()
            .context("spawning ffmpeg for audio chunk extraction")?;

        let _ = std::fs::remove_file(&list_path);

        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            return Err(anyhow!(
                "ffmpeg chunk {idx} failed ({}): {}",
                out.status,
                stderr.trim()
            ));
        }

        let rel_path = mp3_path
            .strip_prefix(work_dir.unwrap_or(&out_dir))
            .unwrap_or(&mp3_path)
            .to_string_lossy()
            .replace('\\', "/");

        chunks.push(AudioChunk {
            index: idx,
            path: mp3_path.to_string_lossy().to_string(),
            rel_path,
            timeline_start: g.timeline_start,
            timeline_end: g.timeline_end,
            source_start: g.source_start,
            source_end: g.source_end,
        });
    }

    Ok(PreparedChunks {
        dir: out_dir.to_string_lossy().to_string(),
        chunks,
    })
}

pub fn cleanup_chunks(dir: &Path) {
    if dir.exists() {
        let _ = std::fs::remove_dir_all(dir);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cutlist::{Cut, CutKind};

    #[test]
    fn groups_short_keeps_into_bounded_chunks() {
        let cl = CutList {
            source_duration: 120.0,
            intervals: vec![
                Cut { start: 0.0, end: 20.0, kind: CutKind::Keep },
                Cut { start: 20.0, end: 25.0, kind: CutKind::Remove },
                Cut { start: 25.0, end: 50.0, kind: CutKind::Keep },
                Cut { start: 50.0, end: 60.0, kind: CutKind::Remove },
                Cut { start: 60.0, end: 115.0, kind: CutKind::Keep },
            ],
        };
        let groups = group_keeps(&cl, 45.0);
        assert_eq!(groups.len(), 3);
        assert!((groups[0].timeline_start - 0.0).abs() < 1e-6);
        assert!((groups[0].timeline_end - 45.0).abs() < 1e-6);
        assert!((groups[1].timeline_start - 45.0).abs() < 1e-6);
        assert!((groups[1].timeline_end - 90.0).abs() < 1e-6);
        assert!((groups[2].timeline_start - 90.0).abs() < 1e-6);
        assert!((groups[2].timeline_end - 100.0).abs() < 1e-6);
    }
}
