#!/usr/bin/env python3
"""Render a 75-second Backboard Studio launch-film rough cut with FFmpeg.

The renderer deliberately keeps readable product beats on authentic screenshots.
If Higgsfield hero clips are present in assets/, they replace the matching stills.
"""

from __future__ import annotations

import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
ASSETS = HERE / "assets"
OUT = HERE / "out"
FONT = Path("/System/Library/Fonts/SFNS.ttf")
MONO = Path("/System/Library/Fonts/SFNSMono.ttf")
FPS = 30
W, H = 1920, 1080


@dataclass(frozen=True)
class Segment:
    duration: float
    source: Path | None
    title: str
    subtitle: str = ""
    card: bool = False


def p(relative: str) -> Path:
    return ROOT / relative


def hero(name: str, fallback: str) -> Path:
    generated = ASSETS / f"higgsfield-{name}.mp4"
    return generated if generated.exists() else p(fallback)


SEGMENTS = [
    Segment(3.8, None, "BACKBOARD STUDIO", "THE AGENT-FIRST IDE", True),
    Segment(2.7, p("devin-header-reference-2026-08-06/04-backboard-advanced-menu.png"), "THREE WAYS TO WORK.", "SIMPLE  ·  EDITOR  ·  ADVANCED"),
    Segment(2.7, hero("simple", "advanced-optimus-screenshots-v3/16-browser.jpg"), "SIMPLE", "ASK. WATCH. SHIP."),
    Segment(3.1, p("devin-header-reference-2026-08-06/06-backboard-new-chat-side-panel.png"), "ONE PROMPT.", "Choose a model. Add context. Start."),
    Segment(3.2, p("devin-header-reference-2026-08-06/05-backboard-agent-chat-fixed.png"), "A COMPLETE WORKSPACE.", "Watch the work happen."),
    Segment(2.6, p("advanced-optimus-screenshots-v3/18-feature-picker.jpg"), "EVERY TOOL, ONE PANEL AWAY.", "Review  ·  Files  ·  Terminal  ·  Browser  ·  Side chat"),
    Segment(2.6, p("advanced-optimus-screenshots-v3/14-files.jpg"), "FILES", "THE WORKSPACE, IN CONTEXT."),
    Segment(2.8, p("advanced-optimus-screenshots-v3/13-review.jpg"), "REVIEW", "SEE EXACTLY WHAT CHANGED."),
    Segment(2.8, p("advanced-optimus-screenshots-v3/15-terminal.jpg"), "TERMINAL", "RUN IT HERE."),
    Segment(2.8, p("advanced-optimus-screenshots-v3/16-browser.jpg"), "BROWSER", "VERIFY THE EXPERIENCE."),
    Segment(2.9, p("advanced-optimus-screenshots-v3/17-side-chat.jpg"), "SIDE CHAT", "ASK WITHOUT LOSING YOUR PLACE."),
    Segment(3.8, hero("editor", "artifacts/backboard-launch-video/assets/editor-code.jpg"), "EDITOR", "CODE AT FULL DEPTH."),
    Segment(3.2, ASSETS / "editor-code.jpg", "YOUR CODE.", "Source control, navigation, and context."),
    Segment(3.5, ASSETS / "editor-code.jpg", "YOUR AGENT.", "Side by side with the editor."),
    Segment(3.0, ASSETS / "editor-code.jpg", "ONE IDE.", "Edit. Run. Debug. Test."),
    Segment(3.5, hero("advanced", "advanced-optimus-screenshots-v3/01-board-overview.jpg"), "ADVANCED", "SEE THE WHOLE SYSTEM."),
    Segment(3.5, p("advanced-optimus-screenshots-v3/01-board-overview.jpg"), "EVERY AGENT. EVERY STATUS.", "RUNNING  ·  BLOCKED  ·  READY"),
    Segment(3.5, p("advanced-optimus-screenshots-v3/05-filter-menu.jpg"), "FIND THE WORK THAT MATTERS.", "Status  ·  Time  ·  Agent  ·  Repository"),
    Segment(3.0, p("advanced-optimus-screenshots-v3/02-display-settings.jpg"), "YOUR VIEW. YOUR FLOW.", "Board  ·  List  ·  Sort  ·  Group"),
    Segment(4.0, p("advanced-optimus-screenshots-v3/12-tile-open-launcher.jpg"), "FROM OVERVIEW TO EXECUTION.", "Open any task without losing the system view."),
    Segment(3.5, p("devin-feature-screenshots/15-response-statistics.png"), "MEASURE. REVIEW. DECIDE.", "Stats, changes, and results in one place."),
    Segment(3.0, p("devin-feature-screenshots/18-model-selector.png"), "BRING THE AGENTS YOU TRUST.", "Backboard and connected agent providers."),
    Segment(2.8, p("devin-header-reference-2026-08-06/03-backboard-final.png"), "ONE WORKSPACE.", "SIMPLE  ·  EDITOR  ·  ADVANCED"),
    Segment(2.7, None, "BACKBOARD STUDIO", "THE AGENT-FIRST IDE", True),
]


SFX = [
    (6.50, p("vscode/src/vs/platform/accessibilitySignal/browser/media/quickFixes.mp3"), 0.18),
    (12.10, p("vscode/src/vs/platform/accessibilitySignal/browser/media/requestSent.mp3"), 0.24),
    (20.90, p("vscode/src/vs/platform/accessibilitySignal/browser/media/diffLineInserted.mp3"), 0.20),
    (21.04, p("vscode/src/vs/platform/accessibilitySignal/browser/media/diffLineDeleted.mp3"), 0.17),
    (25.70, p("vscode/src/vs/platform/accessibilitySignal/browser/media/terminalCommandSucceeded.mp3"), 0.22),
    (39.20, p("vscode/src/vs/platform/accessibilitySignal/browser/media/requestSent.mp3"), 0.22),
    (41.90, p("vscode/src/vs/platform/accessibilitySignal/browser/media/codeActionApplied.mp3"), 0.22),
    (45.10, p("vscode/src/vs/platform/accessibilitySignal/browser/media/terminalCommandSucceeded.mp3"), 0.24),
    (51.90, p("vscode/src/vs/platform/accessibilitySignal/browser/media/taskCompleted.mp3"), 0.23),
    (73.20, p("vscode/src/vs/platform/accessibilitySignal/browser/media/taskCompleted.mp3"), 0.18),
]


def run(args: list[str]) -> None:
    subprocess.run(args, check=True)


def esc(text: str) -> str:
    return (
        text.replace("\\", r"\\")
        .replace(":", r"\:")
        .replace("'", r"\'")
        .replace("%", r"\%")
    )


def lower_third(title: str, subtitle: str) -> str:
    filters = ["drawbox=x=0:y=ih-226:w=iw:h=226:color=0x090b0e@0.78:t=fill"]
    filters.append(
        "drawtext="
        f"fontfile='{FONT}':text='{esc(title)}':"
        "fontcolor=white:fontsize=56:x=88:y=h-178:"
        "shadowcolor=black@0.7:shadowx=0:shadowy=3"
    )
    if subtitle:
        filters.append(
            "drawtext="
            f"fontfile='{FONT}':text='{esc(subtitle)}':"
            "fontcolor=0x9ea7b3:fontsize=28:x=90:y=h-98:"
            "shadowcolor=black@0.7:shadowx=0:shadowy=2"
        )
    return ",".join(filters)


def render_card(seg: Segment, output: Path) -> None:
    vf = ",".join(
        [
            "drawbox=x=w/2-82:y=h/2-172:w=10:h=128:color=0x75a7ff@0.95:t=fill",
            "drawbox=x=w/2-52:y=h/2-172:w=10:h=128:color=0xffffff@0.88:t=fill",
            "drawbox=x=w/2-22:y=h/2-172:w=10:h=128:color=0x75a7ff@0.58:t=fill",
            "drawtext="
            f"fontfile='{FONT}':text='{esc(seg.title)}':"
            "fontcolor=white:fontsize=72:x=(w-text_w)/2:y=h/2+16:"
            "shadowcolor=black@0.8:shadowx=0:shadowy=3",
            "drawtext="
            f"fontfile='{MONO}':text='{esc(seg.subtitle)}':"
            "fontcolor=0x9ea7b3:fontsize=24:x=(w-text_w)/2:y=h/2+118",
            f"fade=t=in:st=0:d=0.45,fade=t=out:st={max(0, seg.duration - 0.45):.3f}:d=0.45",
        ]
    )
    run(
        [
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", f"color=c=0x101216:s={W}x{H}:r={FPS}:d={seg.duration}",
            "-vf", vf, "-an", "-c:v", "libx264", "-preset", "veryfast",
            "-crf", "18", "-pix_fmt", "yuv420p", str(output),
        ]
    )


def render_visual(seg: Segment, output: Path) -> None:
    assert seg.source is not None
    if not seg.source.exists():
        raise FileNotFoundError(seg.source)
    is_video = seg.source.suffix.lower() in {".mp4", ".mov", ".m4v", ".webm"}
    base = (
        f"scale={W}:{H}:force_original_aspect_ratio=increase:flags=lanczos,"
        f"crop={W}:{H},"
    )
    if is_video:
        source_args = ["-stream_loop", "-1", "-i", str(seg.source), "-t", str(seg.duration)]
        motion = "fps=30,"
    else:
        source_args = ["-loop", "1", "-framerate", str(FPS), "-i", str(seg.source), "-t", str(seg.duration)]
        frames = max(1, round(seg.duration * FPS))
        motion = (
            "zoompan="
            "z='min(zoom+0.00010,1.022)':"
            "x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':"
            f"d={frames}:s={W}x{H}:fps={FPS},"
        )
    vf = base + motion + lower_third(seg.title, seg.subtitle)
    run(
        [
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
            *source_args, "-vf", vf, "-an", "-c:v", "libx264",
            "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
            "-r", str(FPS), str(output),
        ]
    )


def render_music(output: Path) -> None:
    duration = sum(seg.duration for seg in SEGMENTS)
    args = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", f"sine=frequency=55:sample_rate=48000:duration={duration}",
        "-f", "lavfi", "-i", f"sine=frequency=164.81:sample_rate=48000:duration={duration}",
        "-f", "lavfi", "-i", f"anoisesrc=color=white:sample_rate=48000:duration={duration}",
    ]
    for _, file, _ in SFX:
        args += ["-i", str(file)]

    chains = [
        "[0:a]volume=0.042,lowpass=f=180,afade=t=in:st=0:d=2.5,afade=t=out:st=72:d=3[sub]",
        "[1:a]volume=0.012,tremolo=f=3.733:d=0.88,lowpass=f=1800,afade=t=in:st=3:d=5,afade=t=out:st=69:d=4[pulse]",
        "[2:a]highpass=f=6500,lowpass=f=11000,tremolo=f=3.733:d=0.96,volume=0.0022,afade=t=in:st=18:d=8,afade=t=out:st=67:d=4[hat]",
    ]
    labels = ["[sub]", "[pulse]", "[hat]"]
    for index, (time_s, _, volume) in enumerate(SFX, start=3):
        delay = round(time_s * 1000)
        label = f"sfx{index}"
        chains.append(f"[{index}:a]adelay={delay}|{delay},volume={volume}[{label}]")
        labels.append(f"[{label}]")
    chains.append(
        "".join(labels)
        + f"amix=inputs={len(labels)}:duration=longest:normalize=0,"
        "highpass=f=28,alimiter=limit=0.89,loudnorm=I=-16:LRA=8:TP=-1.0,"
        "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[mix]"
    )
    args += ["-filter_complex", ";".join(chains), "-map", "[mix]", "-c:a", "aac", "-b:a", "256k", str(output)]
    run(args)


def main() -> None:
    if shutil.which("ffmpeg") is None:
        raise SystemExit("ffmpeg is required")
    if not FONT.exists() or not MONO.exists():
        raise SystemExit("Expected macOS system fonts were not found")

    OUT.mkdir(parents=True, exist_ok=True)
    ASSETS.mkdir(parents=True, exist_ok=True)
    final = OUT / "backboard-studio-launch-roughcut.mp4"

    with tempfile.TemporaryDirectory(prefix="backboard-launch-") as temp_name:
        temp = Path(temp_name)
        clips: list[Path] = []
        for index, seg in enumerate(SEGMENTS):
            clip = temp / f"{index:02d}.mp4"
            print(f"[{index + 1:02d}/{len(SEGMENTS)}] {seg.title}")
            if seg.card:
                render_card(seg, clip)
            else:
                render_visual(seg, clip)
            clips.append(clip)

        concat = temp / "concat.txt"
        concat.write_text("".join(f"file '{clip}'\n" for clip in clips), encoding="utf-8")
        silent = temp / "silent.mp4"
        run(
            [
                "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                "-f", "concat", "-safe", "0", "-i", str(concat),
                "-c", "copy", str(silent),
            ]
        )
        music = temp / "music.m4a"
        print("[audio] Building original temp score and UI cues")
        render_music(music)
        run(
            [
                "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                "-i", str(silent), "-i", str(music), "-map", "0:v:0", "-map", "1:a:0",
                "-c:v", "copy", "-c:a", "aac", "-b:a", "256k", "-shortest",
                "-movflags", "+faststart", str(final),
            ]
        )

    print(final)


if __name__ == "__main__":
    main()
