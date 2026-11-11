import { useEffect, useMemo, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { browserPersistenceAvailable, createProject, deleteProject, exportProjectFile, importProjectFile, listProjects, loadProject, saveProject, type StoredProject } from "./projectStorage";
import {
  AudioLines, Clapperboard, FilePlus2, Film, FolderOpen, Image as ImageIcon,
  Music2, Pause, Play, Scissors, Settings2, Sparkles, Trash2, Video,
  Volume2, WandSparkles, Download, MousePointer2, ChevronDown, Plus, X, Search, Clock3, ArrowLeft, Film as FilmIcon, Keyboard, Undo2, Redo2,
  Copy, ClipboardPaste, CopyPlus, Save, CircleHelp, SkipBack, SkipForward, Pencil, Minus, VolumeX
} from "lucide-react";

type MediaKind = "video" | "image" | "audio";
type ProjectAspectRatio = "16:9" | "9:16" | "1:1";
type Clip = {
  id: string; name: string; path: string; src: string; kind: MediaKind;
  track: number; start: number; sourceIn: number; duration: number; volume?: number; opacity?: number; file?: File;
};
const SCALE = 54;
const TRACKS = [
  { id: 0, name: "VIDEO 01", hint: "Main footage", icon: Video },
  { id: 1, name: "OVERLAY", hint: "Images & B-roll", icon: ImageIcon },
  { id: 2, name: "AUDIO", hint: "Music & voice", icon: AudioLines }
];
const fmt = (n: number) => {
  const safe = Math.max(0, n);
  return `${Math.floor(safe / 60).toString().padStart(2, "0")}:${Math.floor(safe % 60).toString().padStart(2, "0")}.${Math.floor((safe % 1) * 10)}`;
};
const kindFrom = (path: string): MediaKind => {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  if (["mp3","wav","m4a","aac","flac","ogg"].includes(ext)) return "audio";
  if (["png","jpg","jpeg","webp","gif","bmp"].includes(ext)) return "image";
  return "video";
};
const basename = (p: string) => p.split(/[\\/]/).pop() || p;

function EditorWorkspace({ projectId, projectName, aspectRatio, onBack, onExportProject }: { projectId: string; projectName: string; aspectRatio: ProjectAspectRatio; onBack: () => void; onExportProject: (project: StoredProject<Clip>) => Promise<void> }) {
  const [clips, setClips] = useState<Clip[]>([]);
  const undoStack = useRef<Clip[][]>([]);
  const redoStack = useRef<Clip[][]>([]);
  const clipClipboard = useRef<Clip[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [mutedTracks, setMutedTracks] = useState<number[]>([]);
  const selectionAnchor = useRef<string | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [denoise, setDenoise] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showMobileInspector, setShowMobileInspector] = useState(false);
  const [notice, setNotice] = useState("Ready when you are. Import media to start editing.");
  const [zoom, setZoom] = useState(1);
  const [dragging, setDragging] = useState<string | null>(null);
  const touchDrag = useRef<{ id: string; pointerId: number; startX: number; startY: number; originalStart: number; originalDuration: number; originalSourceIn: number; track: number; moved: boolean; mode: "move" | "trim-start" | "trim-end"; group: Clip[] } | null>(null);
  const suppressClipClick = useRef(false);
  const scrubbing = useRef(false);
  const [projectReady, setProjectReady] = useState(false);
  const mediaRefs = useRef<Map<string, HTMLMediaElement>>(new Map());
  const lastClockClipId = useRef<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isDesktop = "__TAURI_INTERNALS__" in window;
  const hasLocalBrowserFilesystem = browserPersistenceAvailable();

  useEffect(() => {
    let alive = true;
    loadProject<Clip>(projectId).then(project => {
      if (!alive || !project) return;
      const restored = project.clips.map(c => ({
        ...c,
        src: c.file ? URL.createObjectURL(c.file) : (isDesktop ? convertFileSrc(c.path) : c.src)
      }));
      setClips(restored);
      setNotice(isDesktop ? "Project restored from local files on this PC." : "Project timeline restored. Re-import its source media in this browser session.");
    }).catch(() => {
      if (alive) setNotice("Local project storage is unavailable in this browser.");
    }).finally(() => { if (alive) setProjectReady(true); });
    return () => { alive = false; };
  }, [projectId]);

  useEffect(() => {
    if (!projectReady) return;
    saveProject(projectId, projectName, clips).catch(() => setNotice("Could not autosave this project in local browser storage."));
  }, [clips, projectReady, projectId, projectName]);

  const active = clips.find(c => c.id === selected) || null;
  const selectedClips = useMemo(() => clips.filter(c => selectedIds.includes(c.id)), [clips, selectedIds]);
  const selectClip = (clip: Clip, event?: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean }) => {
    if (event?.shiftKey && selectionAnchor.current) {
      const anchor=clips.find(c=>c.id===selectionAnchor.current);
      if(anchor && anchor.track===clip.track){
        const ordered=clips.filter(c=>c.track===clip.track).sort((a,b)=>a.start-b.start);
        const from=ordered.findIndex(c=>c.id===anchor.id),to=ordered.findIndex(c=>c.id===clip.id);
        setSelectedIds(ordered.slice(Math.min(from,to),Math.max(from,to)+1).map(c=>c.id));setSelected(clip.id);return;
      }
    }
    if(event?.ctrlKey||event?.metaKey){
      const next=selectedIds.includes(clip.id)?selectedIds.filter(id=>id!==clip.id):[...selectedIds,clip.id];
      setSelectedIds(next);setSelected(next[next.length-1]??null);selectionAnchor.current=clip.id;return;
    }
    setSelected(clip.id);setSelectedIds([clip.id]);selectionAnchor.current=clip.id;
  };
  const activeVisualClips = clips.filter(c =>
    c.track < 2 && c.kind !== "audio" && playhead >= c.start && playhead < c.start + c.duration
  ).sort((a, b) => a.track - b.track || a.start - b.start);
  const activeAudioClips = clips.filter(c =>
    c.track === 2 && c.kind === "audio" && playhead >= c.start && playhead < c.start + c.duration
  );
  const clockClip =
    activeVisualClips.find(c => c.track === 0 && c.kind === "video") ||
    activeVisualClips.find(c => c.kind === "video") ||
    activeAudioClips[0] ||
    null;
  const currentPreview = activeVisualClips[activeVisualClips.length - 1] || activeAudioClips[0] || null;
  const activeMediaKey = [...activeVisualClips, ...activeAudioClips]
    .filter(c => c.kind === "video" || c.kind === "audio").map(c => [c.id, c.src, c.start, c.sourceIn, c.duration, c.volume ?? 1].join(":")).join("|") + "|muted:" + mutedTracks.join(",");
  const duration = Math.max(30, ...clips.map(c => c.start + c.duration + 2));
  const scale = SCALE * zoom;
  const selectedSrc = currentPreview?.src || "";

  const updateTimeline = (updater: (previous: Clip[]) => Clip[]) => {
    setClips(previous => {
      undoStack.current.push(previous);
      if (undoStack.current.length > 100) undoStack.current.shift();
      redoStack.current = [];
      return updater(previous);
    });
  };
  const undo = () => setClips(previous => {
    const prior = undoStack.current.pop();
    if (!prior) return previous;
    redoStack.current.push(previous);
    setNotice("Undo.");
    return prior;
  });
  const redo = () => setClips(previous => {
    const next = redoStack.current.pop();
    if (!next) return previous;
    undoStack.current.push(previous);
    setNotice("Redo.");
    return next;
  });

  // Every visible video layer and audio clip shares the same timeline clock.
  // The primary video (or first active audio clip) drives the playhead; secondary
  // media is gently re-synchronized instead of repeatedly seeking the master.
  useEffect(() => {
    if (!playing || clockClip) return;
    const timer = window.setInterval(() => setPlayhead(v => Math.min(duration, v + 0.05)), 50);
    return () => window.clearInterval(timer);
  }, [playing, clockClip?.id, duration]);

  useEffect(() => {
    const activeMedia = [...activeVisualClips, ...activeAudioClips]
      .filter(c => c.kind === "video" || c.kind === "audio");
    const activeIds = new Set(activeMedia.map(clip => clip.id));

    // Keep media elements mounted across edit points to avoid decoder teardown
    // and reinitialization every time the playhead enters the next clip.
    mediaRefs.current.forEach((element, id) => {
      if (!activeIds.has(id) && !element.paused) element.pause();
    });

    activeMedia.forEach(clip => {
      const element = mediaRefs.current.get(clip.id);
      if (!element) return;
      const target = Math.max(0, clip.sourceIn + playhead - clip.start);
      const isClock = clip.id === clockClip?.id;
      const clockChanged = isClock && lastClockClipId.current !== clip.id;
      const threshold = playing && !isClock ? 0.35 : 0.08;
      // When playback crosses an edit point, the new master may have been paused
      // at an old source position. Align it before it takes over the timeline clock.
      if ((!playing || !isClock || clockChanged) && Math.abs(element.currentTime - target) > threshold) {
        try { element.currentTime = Math.min(target, Number.isFinite(element.duration) ? element.duration : target); } catch { /* Metadata may not be ready yet. */ }
      }
      element.volume = mutedTracks.includes(clip.track) ? 0 : Math.max(0, Math.min(1, clip.volume ?? 1));
      if (playing && element.paused) {
        void element.play().catch(() => setNotice("Salah satu media tidak dapat diputar. Periksa format atau codec file tersebut."));
      } else if (!playing && !element.paused) {
        element.pause();
      }
    });
    lastClockClipId.current = clockClip?.id ?? null;
  }, [playhead, playing, activeMediaKey, clockClip?.id]);

  useEffect(() => {
    if (active && playhead < active.start) setPlayhead(active.start);
  }, [active?.id]);

  const addPaths = async (paths: string[]) => {
    const cursors = new Map<number, number>();
    for (const clip of clips) {
      cursors.set(clip.track, Math.max(cursors.get(clip.track) ?? 0, clip.start + clip.duration));
    }
    const newClips: Clip[] = paths.map(path => {
      const kind = kindFrom(path);
      const track = kind === "audio" ? 2 : kind === "image" ? 1 : 0;
      const start = cursors.get(track) ?? 0;
      const duration = kind === "image" ? 5 : 10;
      cursors.set(track, start + duration);
      return {
        id: crypto.randomUUID(), name: basename(path), path,
        src: isDesktop ? convertFileSrc(path) : path,
        kind, track, start, sourceIn: 0, duration, volume: 1
      };
    });
    updateTimeline(old => [...old, ...newClips]);
    if (newClips[0]) { setSelected(newClips[0].id); setSelectedIds([newClips[0].id]); setPlayhead(newClips[0].start); }
    setNotice(`Imported ${newClips.length} media file(s).`);
  };

  const readBrowserMediaDuration = (src: string, kind: MediaKind): Promise<number> => {
    if (kind === "image") return Promise.resolve(5);
    return new Promise(resolve => {
      const media = document.createElement(kind === "audio" ? "audio" : "video");
      media.preload = "metadata";
      const finish = (duration: number) => {
        media.removeAttribute("src");
        media.load();
        resolve(Number.isFinite(duration) && duration > 0 ? duration : 10);
      };
      media.onloadedmetadata = () => finish(media.duration);
      media.onerror = () => finish(10);
      media.src = src;
    });
  };

  const addBrowserFiles = async (files: File[]) => {
    const prepared = await Promise.all(files.map(async file => {
      const kind = kindFrom(file.name);
      const src = URL.createObjectURL(file);
      const duration = await readBrowserMediaDuration(src, kind);
      return { file, kind, src, duration };
    }));
    const relinked = new Map<string, Clip>();
    const additions: Clip[] = [];
    const cursors = new Map<number, number>();
    for (const clip of clips) {
      cursors.set(clip.track, Math.max(cursors.get(clip.track) ?? 0, clip.start + clip.duration));
    }
    for (const { file, kind, src, duration } of prepared) {
      const missing = clips.find(c => !c.src && !relinked.has(c.id) && c.name.toLowerCase() === file.name.toLowerCase());
      if (missing) {
        relinked.set(missing.id, { ...missing, path: file.name, src, file });
        continue;
      }
      const track = kind === "audio" ? 2 : kind === "image" ? 1 : 0;
      const start = cursors.get(track) ?? 0;
      cursors.set(track, start + duration);
      additions.push({
        id: crypto.randomUUID(), name: file.name, path: file.name, src, file,
        kind, track, start, sourceIn: 0, duration, volume: 1
      });
    }
    updateTimeline(old => [...old.map(c => relinked.get(c.id) ?? c), ...additions]);
    const first = [...relinked.values(), ...additions][0];
    if (first) { setSelected(first.id); setSelectedIds([first.id]); setPlayhead(first.start); }
    const relinkCount = relinked.size;
    setNotice(`${relinkCount} media relinked · ${additions.length} new media added.`);
  };

  const importMedia = async () => {
    if (!isDesktop) { fileInputRef.current?.click(); return; }
    try {
      const result = await open({
        multiple: true,
        filters: [{ name: "Media", extensions: ["mp4","mov","mkv","webm","avi","m4v","mp3","wav","m4a","aac","flac","ogg","png","jpg","jpeg","webp","gif"] }]
      });
      if (result) await addPaths(Array.isArray(result) ? result : [result]);
    } catch (e) { setNotice(String(e)); }
  };

  const updateClip = (id: string, patch: Partial<Clip>) =>
    updateTimeline(old => old.map(c => c.id === id ? { ...c, ...patch } : c));

  const splitSelected = () => {
    if (!active) return setNotice("Select a clip first.");
    const cutAt = playhead - active.start;
    if (cutAt <= 0.08 || cutAt >= active.duration - 0.08) return setNotice("Move the playhead inside the selected clip before splitting.");
    const right: Clip = {
      ...active, id: crypto.randomUUID(), name: active.name + " (split)",
      start: playhead, sourceIn: active.sourceIn + cutAt, duration: active.duration - cutAt
    };
    updateTimeline(old => old.flatMap(c => c.id === active.id ? [{ ...c, duration: cutAt }, right] : [c]));
    setSelected(right.id);setSelectedIds([right.id]);
    setNotice("Clip split at playhead.");
  };

  const splitAllTracks = () => {
    const targets = clips.filter(c => playhead > c.start + 0.08 && playhead < c.start + c.duration - 0.08);
    if (!targets.length) return setNotice("Tidak ada klip yang melintasi playhead untuk dipotong.");
    const rightClips = targets.map(c => {
      const leftDuration = playhead - c.start;
      return {
        ...c,
        id: crypto.randomUUID(),
        name: c.name + " (split)",
        start: playhead,
        sourceIn: c.sourceIn + leftDuration,
        duration: c.duration - leftDuration
      };
    });
    const rightById = new Map<string, Clip>(targets.map((c, i) => [c.id, rightClips[i]] as const));
    updateTimeline(old => old.flatMap(c => {
      const right = rightById.get(c.id);
      return right ? [{ ...c, duration: playhead - c.start }, right] : [c];
    }));
    setSelected(rightClips[0].id);setSelectedIds(rightClips.map(c=>c.id));
    setNotice(`Split all tracks: ${rightClips.length} clip(s) cut at playhead.`);
  };

  const copySelected = () => {
    if(!selectedClips.length)return setNotice("Pilih satu atau beberapa klip terlebih dahulu.");
    clipClipboard.current=selectedClips.map(c=>({...c}));setNotice(selectedClips.length+" klip disalin.");
  };
  const cutSelected = () => {
    if(!selectedClips.length)return setNotice("Pilih klip yang ingin dipotong.");
    const ids=new Set(selectedIds);clipClipboard.current=selectedClips.map(c=>({...c}));
    updateTimeline(old=>old.filter(c=>!ids.has(c.id)));setSelected(null);setSelectedIds([]);
    setNotice(ids.size+" klip dipindahkan ke clipboard.");
  };
  const pasteClip = () => {
    const source=clipClipboard.current;if(!source.length)return setNotice("Clipboard Ghous Cut masih kosong.");
    const origin=Math.min(...source.map(c=>c.start));
    const pasted=source.map(c=>({...c,id:crypto.randomUUID(),name:c.name.replace(/ \\(copy\\)$/i,"")+" (copy)",start:playhead+(c.start-origin)}));
    updateTimeline(old=>[...old,...pasted]);setSelected(pasted[pasted.length-1].id);setSelectedIds(pasted.map(c=>c.id));
    setNotice(pasted.length+" klip ditempel dengan susunan relatif yang sama.");
  };
  const duplicateSelected = () => {
    if(!selectedClips.length)return setNotice("Pilih klip yang ingin diduplikasi.");
    const origin=Math.min(...selectedClips.map(c=>c.start)),offset=Math.max(...selectedClips.map(c=>c.start+c.duration))-origin;
    const duplicates=selectedClips.map(c=>({...c,id:crypto.randomUUID(),name:c.name.replace(/ \\(copy\\)$/i,"")+" (copy)",start:c.start+offset}));
    updateTimeline(old=>[...old,...duplicates]);setSelected(duplicates[duplicates.length-1].id);setSelectedIds(duplicates.map(c=>c.id));
    setPlayhead(origin+offset);setNotice(duplicates.length+" klip diduplikasi dengan susunan tetap.");
  };

  const trimLeft = () => {
    if (!active) return setNotice("Select a clip first.");
    const delta = playhead - active.start;
    if (delta <= 0 || delta >= active.duration) return setNotice("Place playhead inside the selected clip.");
    updateClip(active.id, { start: playhead, sourceIn: active.sourceIn + delta, duration: active.duration - delta });
    setNotice("Trimmed the beginning of the selected clip.");
  };
  const trimRight = () => {
    if (!active) return setNotice("Select a clip first.");
    const nextDuration = playhead - active.start;
    if (nextDuration <= 0 || nextDuration >= active.duration) return setNotice("Place playhead inside the selected clip.");
    updateClip(active.id, { duration: nextDuration });
    setNotice("Trimmed the end of the selected clip.");
  };
  const removeSelected = () => {
    const ids=new Set(selectedIds.length?selectedIds:(active?[active.id]:[]));if(!ids.size)return;
    updateTimeline(old=>old.filter(c=>!ids.has(c.id)));setSelected(null);setSelectedIds([]);selectionAnchor.current=null;
    setNotice(ids.size+" klip dihapus dari timeline.");
  };
  // Magnetic timeline snapping: align the moved clip's start/end to nearby
  // clip edges, the playhead, or the beginning of the timeline.
  const snapTime = (id: string, start: number) => {
    const moving = clips.find(c => c.id === id);
    if (!moving) return Math.max(0, start);
    const candidates = [0, playhead];
    clips.forEach(other => {
      if (other.id === id) return;
      candidates.push(other.start, other.start + other.duration);
    });
    let best = Math.max(0, start);
    let distance = 0.18;
    candidates.forEach(point => {
      const alignedStart = Math.max(0, point);
      const alignedEnd = Math.max(0, point - moving.duration);
      [alignedStart, alignedEnd].forEach(candidate => {
        const delta = Math.abs(candidate - start);
        if (delta < distance) {
          distance = delta;
          best = candidate;
        }
      });
    });
    return best;
  };

  const moveClip = (id: string, track: number, start: number) => {
    const moving=clips.find(c=>c.id===id);if(!moving)return;
    const group=selectedIds.includes(id)?clips.filter(c=>selectedIds.includes(c.id)):[moving];
    const snappedStart=snapTime(id,start),trackDelta=track-moving.track;
    const groupIds=new Set(group.map(c=>c.id));
    updateTimeline(old=>old.map(c=>groupIds.has(c.id)?{...c,start:Math.max(0,snappedStart+(c.start-moving.start)),track:Math.max(0,Math.min(2,c.track+trackDelta))}:c));
    setDragging(null);
  };

  const exportVideo = async () => {
    if (!clips.length) return setNotice("Tambahkan media ke timeline sebelum export.");
    if (!isDesktop) return setNotice("MP4 export tersedia di aplikasi Windows Ghous Cut dengan FFmpeg terpasang.");
    try {
      const output = await save({ defaultPath: `ghous-cut-${projectName.replace(/[^a-z0-9-_ ]/gi, "").trim() || "project"}.mp4`, filters: [{ name: "MP4 Video", extensions: ["mp4"] }] });
      if (!output) return;
      setExporting(true);
      setNotice("Rendering seluruh timeline multitrack dengan FFmpeg…");
      const exportClips = clips.map(({ id, name, path, kind, track, start, sourceIn, duration, volume, opacity }) => ({
        id, name, path, kind, track, start, sourceIn, duration, volume: volume ?? 1, opacity: opacity ?? 1
      }));
      const result = await invoke<string>("export_timeline", {
        clips: exportClips,
        output,
        aspectRatio,
        denoise
      });
      setNotice(result);
    } catch (e) {
      setNotice(`Export gagal: ${String(e)}`);
    } finally {
      setExporting(false);
    }
  };

  const togglePlayback = () => {
    if (playing) {
      setPlaying(false);
      mediaRefs.current.forEach(element => element.pause());
      return;
    }
    const activeMedia = [...activeVisualClips, ...activeAudioClips]
      .filter(c => c.kind === "video" || c.kind === "audio");
    const elements = activeMedia.map(c => mediaRefs.current.get(c.id)).filter((el): el is HTMLMediaElement => !!el);
    if (!elements.length) {
      setPlaying(true);
      return;
    }
    Promise.all(elements.map(element => element.play())).then(() => setPlaying(true)).catch(() => {
      elements.forEach(element => element.pause());
      setNotice("Media belum dapat diputar bersama. Periksa format atau codec file media.");
    });
  };

  const previewTime = currentPreview ? Math.max(0, currentPreview.sourceIn + playhead - currentPreview.start) : 0;
  const trackEnd = (track: number) => clips.filter(c => c.track === track).reduce((m,c) => Math.max(m,c.start+c.duration), 0);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editingText = !!target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
      if (editingText || event.altKey || event.metaKey && !event.ctrlKey) return;
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key.toLowerCase() === "z") { event.preventDefault(); event.shiftKey ? redo() : undo(); return; }
      if (mod && event.key.toLowerCase() === "y") { event.preventDefault(); redo(); return; }
      if (mod && event.key === "0") { event.preventDefault(); setZoom(1); return; }
      if (mod && event.shiftKey && event.key.toLowerCase() === "b") { event.preventDefault(); splitAllTracks(); return; }
      if (mod && event.key.toLowerCase() === "b") { event.preventDefault(); splitSelected(); return; }
      if (mod && event.key.toLowerCase() === "c") { event.preventDefault(); copySelected(); return; }
      if (mod && event.key.toLowerCase() === "x") { event.preventDefault(); cutSelected(); return; }
      if (mod && event.key.toLowerCase() === "v") { event.preventDefault(); pasteClip(); return; }
      if (mod && event.key.toLowerCase() === "d") { event.preventDefault(); duplicateSelected(); return; }
      if (mod && event.key.toLowerCase() === "a") { event.preventDefault(); setSelectedIds(clips.map(c=>c.id)); setSelected(clips[0]?.id ?? null); return; }
      if (mod && (event.key === "=" || event.key === "+")) { event.preventDefault(); setZoom(v => Math.min(1.8, Math.round((v + 0.1) * 10) / 10)); return; }
      if (mod && event.key === "-") { event.preventDefault(); setZoom(v => Math.max(0.6, Math.round((v - 0.1) * 10) / 10)); return; }
      if (mod && event.key.toLowerCase() === "i") { event.preventDefault(); void importMedia(); return; }
      if (mod && event.key.toLowerCase() === "s") { event.preventDefault(); void onExportProject({ id: projectId, name: projectName, clips, aspectRatio, createdAt: Date.now(), updatedAt: Date.now() }); setNotice("Project save requested."); return; }
      if (mod && event.key.toLowerCase() === "e") { event.preventDefault(); void exportVideo(); return; }
      if (mod) return;
      switch (event.key) {
        case " ": event.preventDefault(); togglePlayback(); break;
        case "Delete": case "Backspace": event.preventDefault(); removeSelected(); break;
        case "q": case "Q": event.preventDefault(); trimLeft(); break;
        case "w": case "W": event.preventDefault(); trimRight(); break;
        case "ArrowLeft": event.preventDefault(); setPlayhead(v => Math.max(0, v - 1 / 30)); break;
        case "ArrowRight": event.preventDefault(); setPlayhead(v => Math.min(duration, v + 1 / 30)); break;
        case "ArrowUp": {
          event.preventDefault();
          const cuts = clips.flatMap(c => [c.start, c.start + c.duration]).filter(t => t < playhead - 0.001);
          setPlayhead(cuts.length ? Math.max(...cuts) : 0);
          break;
        }
        case "ArrowDown": {
          event.preventDefault();
          const cuts = clips.flatMap(c => [c.start, c.start + c.duration]).filter(t => t > playhead + 0.001);
          setPlayhead(cuts.length ? Math.min(...cuts) : duration);
          break;
        }
        case "Home": event.preventDefault(); setPlayhead(0); break;
        case "End": event.preventDefault(); setPlayhead(duration); break;
        case "?": event.preventDefault(); setShowShortcuts(true); break;
        case "Escape":
          if (showShortcuts) setShowShortcuts(false);
          setPlaying(false);
          mediaRefs.current.forEach(element => element.pause());
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });


  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><button className="back-home" onClick={onBack} title="Kembali ke daftar proyek"><ArrowLeft size={16}/></button><div className="brand-mark"><BrandLogo size={22}/></div><span>ghous<span className="brand-accent">cut</span></span><span className="version">BETA 0.1</span></div>
      <div className="project-name"><span className="live-dot"/> {projectName} <ChevronDown size={14}/></div>
      <div className="top-actions"><button className="btn ghost shortcut-help-btn" onClick={() => setShowShortcuts(true)} title="Keyboard shortcuts" aria-label="Keyboard shortcuts"><CircleHelp size={16}/><span>Shortcuts</span></button><button className="btn ghost import-action" onClick={importMedia} title="Import media" aria-label="Import media"><FolderOpen size={15}/><span>Import</span></button><button className="btn ghost mobile-properties-action" onClick={() => setShowMobileInspector(value => !value)} title="Clip properties" aria-label="Clip properties"><Settings2 size={16}/></button><button className="btn ghost save-action" onClick={() => { void onExportProject({ id: projectId, name: projectName, clips, aspectRatio, createdAt: Date.now(), updatedAt: Date.now() }); setNotice("Project file saved."); }} title="Save project file" aria-label="Save project"><Save size={15}/><span>Save</span></button><button className="btn primary export-action" onClick={exportVideo} disabled={exporting} title="Export video"><Download size={15}/><span>{exporting ? "Rendering…" : "Export"}</span></button></div>
    </header>

    <main className="workspace">
      <aside className="media-panel panel">
        <div className="panel-heading"><div><span className="eyebrow">PROJECT</span><h2>Media Library</h2></div><button className="icon-btn" onClick={importMedia} title="Import media"><Plus size={17}/></button></div>
        <button className="import-drop" onClick={importMedia}><FilePlus2 size={22}/><strong>Import media</strong><span>Video, image or audio</span></button>
        <div className="asset-heading"><span>ASSETS</span><span>{clips.length} items</span></div>
        <div className="asset-list">
          {clips.length === 0 && <div className="empty-assets"><Film size={25}/><p>Your media will appear here</p><span>Import files to begin your project</span></div>}
          {clips.map(c => <button key={c.id} className={`asset-row ${selectedIds.includes(c.id)?"chosen":""}`} onClick={() => {selectClip(c);setPlayhead(c.start);}}>
            <span className={`asset-icon ${c.kind}`}>{c.kind==="video"?<Video size={16}/>:c.kind==="image"?<ImageIcon size={16}/>:<Music2 size={16}/>}</span>
            <span className="asset-meta"><strong>{c.name}</strong><small>{c.kind.toUpperCase()} · {fmt(c.duration)}</small></span>
          </button>)}
        </div>
        <div className="storage-note"><span className="storage-dot"/> {isDesktop ? "Local files · Saved on this PC" : hasLocalBrowserFilesystem ? "Local device files · .ghcut backup" : "Session only · Export .ghcut to keep projects"}</div>
      </aside>

      <section className="center-panel">
        <div className="preview-panel panel">
          <div className="panel-heading preview-heading"><div><span className="eyebrow">CANVAS</span><h2>Preview</h2></div><div className="preview-meta"><span>{aspectRatio}</span><span>FIT</span></div></div>
          <div className="preview-stage">
            {!currentPreview && <div className="preview-empty"><div className="preview-logo"><Clapperboard size={30}/></div><strong>Your story starts here</strong><span>Import a clip and select it in the timeline</span></div>}
            {clips.filter(clip => clip.kind === "video" || clip.kind === "image").map(clip => {
              const isActive = activeVisualClips.some(activeClip => activeClip.id === clip.id);
              if (clip.kind === "image") return (
                <img key={clip.id} src={clip.src} className="preview-media preview-layer image-preview"
                  style={{ zIndex: clip.track + 1, visibility: isActive ? "visible" : "hidden" }} alt={clip.name}/>
              );
              return (
                <video key={clip.id} ref={element => {
                  if (element) mediaRefs.current.set(clip.id, element);
                  else mediaRefs.current.delete(clip.id);
                }} src={clip.src} className="preview-media preview-layer"
                  style={{ zIndex: clip.track + 1, opacity: clip.opacity ?? 1, visibility: isActive ? "visible" : "hidden" }}
                  muted={false} playsInline preload={isActive ? "auto" : "metadata"}
                  onLoadedMetadata={e => {
                    const d = e.currentTarget.duration;
                    if (Number.isFinite(d) && d > 0 && clip.sourceIn === 0 && Math.abs(clip.duration - d) > 0.1) updateClip(clip.id, { duration: d });
                  }}
                  onTimeUpdate={e => {
                    if (playing && clockClip?.id === clip.id) setPlayhead(clip.start + e.currentTarget.currentTime - clip.sourceIn);
                  }}
                  onEnded={() => {
                    if (clockClip?.id === clip.id) {
                      const end = clip.start + clip.duration;
                      setPlayhead(end);
                      if (end >= duration - 0.05) setPlaying(false);
                    }
                  }} />
              );
            })}
            {clips.filter(clip => clip.kind === "audio").map(clip => (
              <audio key={clip.id} ref={element => {
                if (element) mediaRefs.current.set(clip.id, element);
                else mediaRefs.current.delete(clip.id);
              }} src={clip.src} preload={activeAudioClips.some(activeClip => activeClip.id === clip.id) ? "auto" : "metadata"}
                onLoadedMetadata={e => {
                  const d = e.currentTarget.duration;
                  if (Number.isFinite(d) && d > 0 && clip.sourceIn === 0 && Math.abs(clip.duration - d) > 0.1) updateClip(clip.id, { duration: d });
                }}
                onTimeUpdate={e => {
                  if (playing && clockClip?.id === clip.id) setPlayhead(clip.start + e.currentTarget.currentTime - clip.sourceIn);
                }}
                onEnded={() => {
                  if (clockClip?.id === clip.id) {
                    const end = clip.start + clip.duration;
                    setPlayhead(end);
                    if (end >= duration - 0.05) setPlaying(false);
                  }
                }} />
            ))}
            {!activeVisualClips.length && activeAudioClips.length > 0 && <div className="audio-preview"><div className="audio-art"><AudioLines size={52}/></div><strong>{activeAudioClips.length === 1 ? activeAudioClips[0].name : `${activeAudioClips.length} audio tracks`}</strong><span>Audio preview</span></div>}
          </div>
          <div className="transport">
            <span className="timecode">{fmt(playhead)}</span><div className="transport-controls"><button className="transport-btn" onClick={() => setPlayhead(0)} title="Go to start" aria-label="Go to start"><SkipBack size={16}/></button><button className="play-btn" onClick={togglePlayback}>{playing?<Pause size={17}/>:<Play size={17} fill="currentColor"/>}</button><button className="transport-btn" onClick={() => setPlayhead(Math.min(duration,playhead+5))} title="Forward 5 seconds" aria-label="Forward 5 seconds"><SkipForward size={16}/></button></div><span className="timecode muted">{fmt(duration)}</span>
          </div>
        </div>

        <div className="timeline-panel panel">
          <div className="timeline-toolbar">
            <div className="timeline-title"><span className="eyebrow">EDIT</span><h2>Timeline</h2></div>
            <div className="edit-tools">
              <button className="tool-btn" onClick={splitSelected} title="Split clip" aria-label="Split clip"><Scissors size={16}/><span>Split</span></button>
              <button className="tool-btn" onClick={splitAllTracks} title="Split all tracks" aria-label="Split all tracks"><Scissors size={16}/><span>All</span></button>
              <button className="tool-btn" onClick={copySelected} title="Copy clips" aria-label="Copy clips"><Copy size={16}/><span>Copy</span></button>
              <button className="tool-btn" onClick={cutSelected} title="Cut clips" aria-label="Cut clips"><Scissors size={16}/><span>Cut</span></button>
              <button className="tool-btn" onClick={pasteClip} title="Paste clips" aria-label="Paste clips"><ClipboardPaste size={16}/><span>Paste</span></button>
              <button className="tool-btn" onClick={duplicateSelected} title="Duplicate clip" aria-label="Duplicate clip"><CopyPlus size={16}/><span>Duplicate</span></button>
              <button className="tool-btn" onClick={trimLeft} title="Trim start to playhead" aria-label="Trim start"><Scissors size={16}/><span>Trim L</span></button>
              <button className="tool-btn" onClick={trimRight} title="Trim end to playhead" aria-label="Trim end"><Scissors size={16}/><span>Trim R</span></button>
              <button className="tool-btn danger-tool" onClick={removeSelected} title="Delete selected clips" aria-label="Delete selected clips"><Trash2 size={16}/>{selectedIds.length>1&&<span>{selectedIds.length}</span>}</button>
            </div>
            <div className="zoom-control"><button type="button" className="zoom-step" aria-label="Zoom out timeline" onClick={()=>setZoom(v=>Math.max(0.6,Math.round((v-0.1)*10)/10))}><Minus size={13}/></button><input aria-label="Timeline zoom" type="range" min="0.6" max="1.8" step="0.1" value={zoom} onChange={e=>setZoom(Number(e.target.value))}/><button type="button" className="zoom-step" aria-label="Zoom in timeline" onClick={()=>setZoom(v=>Math.min(1.8,Math.round((v+0.1)*10)/10))}><Plus size={13}/></button><button type="button" className="zoom-reset" onClick={()=>setZoom(1)} title="Reset zoom">100%</button></div>
          </div>
          <div className="timeline-scroll" onWheel={e=>{
            if(!e.ctrlKey) return;
            e.preventDefault();
            setZoom(v=>Math.max(0.6,Math.min(1.8,Math.round((v+(e.deltaY<0?0.1:-0.1))*10)/10)));
          }} onPointerMove={e=>{
            const drag=touchDrag.current;
            if(!drag || drag.pointerId!==e.pointerId) return;
            e.preventDefault();
            const dx=e.clientX-drag.startX,dy=e.clientY-drag.startY;
            if(!drag.moved && Math.hypot(dx,dy)<3) return;
            const lane=document.elementFromPoint(e.clientX,e.clientY)?.closest<HTMLElement>(".track-lane");
            const nextTrack=Number(lane?.dataset.track ?? drag.track);
            if(!drag.moved){
              undoStack.current.push(clips);
              if(undoStack.current.length>100) undoStack.current.shift();
              redoStack.current=[];
              drag.moved=true;
            }
            if(drag.mode==="move"){
              const rawStart=Math.max(0,drag.originalStart+dx/scale);
              const nextStart=snapTime(drag.id,rawStart),trackDelta=nextTrack-drag.track;
              const groupIds=new Set(drag.group.map(item=>item.id));
              setClips(old=>old.map(item=>groupIds.has(item.id)?{
                ...item,start:Math.max(0,nextStart+(item.start-drag.originalStart)),
                track:Math.max(0,Math.min(2,item.track+trackDelta))
              }:item));
            } else if(drag.mode==="trim-start"){
              const originalEnd=drag.originalStart+drag.originalDuration;
              const candidate=Math.max(0,Math.min(originalEnd-0.1,drag.originalStart+dx/scale));
              const snapPoints=[0,playhead,...clips.filter(item=>item.id!==drag.id).flatMap(item=>[item.start,item.start+item.duration])];
              let nextStart=candidate,snapDistance=0.18;
              snapPoints.forEach(point=>{const delta=Math.abs(point-candidate);if(delta<snapDistance){snapDistance=delta;nextStart=point;}});
              const safeStart=Math.min(originalEnd-0.1,Math.max(0,nextStart));
              setClips(old=>old.map(item=>item.id===drag.id?{
                ...item,start:safeStart,duration:originalEnd-safeStart,
                sourceIn:Math.max(0,drag.originalSourceIn+(safeStart-drag.originalStart))
              }:item));
            } else {
              const candidate=Math.max(drag.originalStart+0.1,drag.originalStart+drag.originalDuration+dx/scale);
              const snapPoints=[playhead,...clips.filter(item=>item.id!==drag.id).flatMap(item=>[item.start,item.start+item.duration])];
              let nextEnd=candidate,snapDistance=0.18;
              snapPoints.forEach(point=>{const delta=Math.abs(point-candidate);if(delta<snapDistance){snapDistance=delta;nextEnd=point;}});
              setClips(old=>old.map(item=>item.id===drag.id?{...item,duration:Math.max(0.1,nextEnd-drag.originalStart)}:item));
            }
          }} onPointerUp={e=>{
            const drag=touchDrag.current;
            if(!drag || drag.pointerId!==e.pointerId) return;
            if(drag.moved){
              setNotice(drag.mode==="move" ? drag.group.length+" klip dipindahkan bersama." : drag.mode==="trim-start" ? "Awal klip disesuaikan." : "Akhir klip disesuaikan.");
              setSelectedIds(drag.mode==="move"?drag.group.map(item=>item.id):[drag.id]);
              setSelected(drag.id);
              suppressClipClick.current=true;
            }
            touchDrag.current=null;
          }} onPointerCancel={e=>{
            const drag=touchDrag.current;
            if(!drag || drag.pointerId!==e.pointerId) return;
            if(drag.moved){
              setNotice(drag.mode==="move" ? drag.group.length+" klip dipindahkan bersama." : drag.mode==="trim-start" ? "Awal klip disesuaikan." : "Akhir klip disesuaikan.");
              setSelectedIds(drag.mode==="move"?drag.group.map(item=>item.id):[drag.id]);
              setSelected(drag.id);
              suppressClipClick.current=true;
            }
            touchDrag.current=null;
          }}>
            <div className="timeline-ruler-wrap">
              <div className="track-label-spacer"/>
              <div className="ruler" style={{width:Math.max(800,duration*scale)}} onPointerDown={e=>{
                scrubbing.current=true;
                e.currentTarget.setPointerCapture(e.pointerId);
                const r=e.currentTarget.getBoundingClientRect();
                setPlayhead(Math.max(0,Math.min(duration,(e.clientX-r.left)/scale)));
              }} onPointerMove={e=>{
                if(!scrubbing.current) return;
                const r=e.currentTarget.getBoundingClientRect();
                setPlayhead(Math.max(0,Math.min(duration,(e.clientX-r.left)/scale)));
              }} onPointerUp={e=>{
                scrubbing.current=false;
                if(e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
              }} onPointerCancel={()=>{scrubbing.current=false;}}>
                {Array.from({length:Math.ceil(duration/5)+1},(_,i)=><span key={i} className="ruler-tick" style={{left:i*5*scale}}>{fmt(i*5)}</span>)}
              </div>
            </div>
            {TRACKS.map(t => <div className="track-row" key={t.id}>
              <div className="track-label"><t.icon size={15}/><div><strong>{t.name}</strong><small>{t.hint}</small></div><button type="button" className={`track-mute ${mutedTracks.includes(t.id)?"muted":""}`} title={mutedTracks.includes(t.id)?"Unmute track":"Mute track"} aria-label={mutedTracks.includes(t.id)?"Unmute "+t.name:"Mute "+t.name} onClick={e=>{e.stopPropagation();setMutedTracks(old=>old.includes(t.id)?old.filter(id=>id!==t.id):[...old,t.id]);}}>{mutedTracks.includes(t.id)?<VolumeX size={12}/>:<Volume2 size={12}/>}</button></div>
              <div className="track-lane" data-track={t.id} style={{width:Math.max(800,duration*scale),backgroundSize:scale+"px 100%"}} onClick={e=>{
                if(e.target===e.currentTarget){
                  const r=e.currentTarget.getBoundingClientRect();
                  setPlayhead(Math.max(0,Math.min(duration,(e.clientX-r.left)/scale)));
                  setSelected(null);setSelectedIds([]);
                }
              }} onDragOver={e=>e.preventDefault()} onDrop={e=>{
                e.preventDefault();if(dragging)moveClip(dragging,t.id,Math.max(0,(e.clientX-e.currentTarget.getBoundingClientRect().left)/scale));
              }}>
                {clips.filter(c=>c.track===t.id).map(c=><div key={c.id} draggable={false}
                  onDragStart={e=>e.preventDefault()}
                  onPointerDown={e=>{
                    if(e.button!==0) return;
                    e.preventDefault();
                    const scroll=e.currentTarget.closest<HTMLElement>(".timeline-scroll");
                    try { scroll?.setPointerCapture(e.pointerId); } catch { /* pointer may already be cancelled */ }
                    const handle=(e.target as HTMLElement).closest<HTMLElement>(".clip-trim-handle");
                    const mode=(handle?.dataset.trim as "trim-start"|"trim-end"|undefined) ?? "move";
                    const group=mode==="move" && selectedIds.includes(c.id)?clips.filter(item=>selectedIds.includes(item.id)):[c];
                    if(mode!=="move" || !selectedIds.includes(c.id) || e.shiftKey || e.ctrlKey || e.metaKey) selectClip(c,e);
                    setPlayhead(c.start);
                    touchDrag.current={id:c.id,pointerId:e.pointerId,startX:e.clientX,startY:e.clientY,originalStart:c.start,
                      originalDuration:c.duration,originalSourceIn:c.sourceIn,track:c.track,moved:false,mode,group};
                  }}
                  className={`timeline-clip ${c.kind} ${selectedIds.includes(c.id)?"selected":""}` }
                  style={{left:c.start*scale,width:Math.max(66,c.duration*scale)}}>
                  <span className="clip-trim-handle clip-trim-start" data-trim="trim-start" role="slider" aria-label="Trim clip start"/>
                  <span className="clip-thumb">{c.kind==="video"?<Film size={13}/>:c.kind==="image"?<ImageIcon size={13}/>:<AudioLines size={13}/>}</span><span className="clip-name">{c.name}</span><span className="clip-duration">{fmt(c.duration)}</span>
                  <span className="clip-trim-handle clip-trim-end" data-trim="trim-end" role="slider" aria-label="Trim clip end"/>
                </div>)}
              </div>
            </div>)}
            <div className="playhead" style={{left:116+playhead*scale}}><div className="playhead-cap"/><div className="playhead-line"/></div>
          </div>
          <div className="timeline-footer"><span><MousePointer2 size={12}/> Drag to arrange · Click ruler to seek · Space play · Ctrl+B split · Q/W trim · Del remove · Ctrl+Z undo</span><span>{selectedIds.length?selectedIds.length+" selected · ":""}{clips.length} clips · {fmt(duration)} workspace</span></div>
        </div>
      </section>

      <aside className={`inspector-panel panel ${showMobileInspector ? "mobile-open" : ""}`}>
        <div className="panel-heading"><div><span className="eyebrow">PROPERTIES</span><h2>Inspector</h2></div><Settings2 size={17} className="subtle-icon"/></div>
        {active ? <div className="inspector-content">
          <div className="selected-file"><div className={`selected-file-icon ${active.kind}`}>{active.kind==="video"?<Video/>:active.kind==="image"?<ImageIcon/>:<Music2/>}</div><strong>{active.name}</strong><small>{active.kind.toUpperCase()} CLIP</small></div>
          <div className="property-group"><label>POSITION ON TIMELINE</label><div className="property-input"><span>Start</span><strong>{fmt(active.start)}</strong></div><div className="property-input"><span>Duration</span><strong>{fmt(active.duration)}</strong></div><div className="property-input"><span>Track</span><strong>{TRACKS.find(t=>t.id===active.track)?.name}</strong></div></div>
          <div className="property-group"><label>AUDIO LEVEL</label><div className="property-input"><span>Clip volume</span><strong>{Math.round((active.volume ?? 1) * 100)}%</strong></div><input aria-label="Clip volume" type="range" min="0" max="1" step="0.01" value={active.volume ?? 1} onChange={e=>updateClip(active.id,{volume:Number(e.target.value)})} style={{width:"100%"}}/><button className="wide-action" onClick={()=>updateClip(active.id,{volume:0})}>Mute clip</button><button className="wide-action" onClick={()=>updateClip(active.id,{volume:1})}>Reset volume</button></div>
          {active.kind !== "audio" && <div className="property-group"><label>VIDEO OPACITY</label><div className="property-input"><span>Opacity</span><strong>{Math.round((active.opacity ?? 1) * 100)}%</strong></div><input aria-label="Video opacity" type="range" min="0" max="1" step="0.01" value={active.opacity ?? 1} onChange={e=>updateClip(active.id,{opacity:Number(e.target.value)})} style={{width:"100%"}}/><button className="wide-action" onClick={()=>updateClip(active.id,{opacity:1})}>Reset opacity</button></div>}<div className="property-group"><label>TRIM RANGE</label><div className="property-input"><span>Source in</span><strong>{fmt(active.sourceIn)}</strong></div><div className="property-input"><span>Source out</span><strong>{fmt(active.sourceIn+active.duration)}</strong></div><p className="helper-text">Use the trim buttons above the timeline at the playhead position.</p></div>
          <div className="property-group"><label>QUICK ACTIONS</label><button className="wide-action" onClick={()=>{setPlayhead(active.start);setNotice("Playhead moved to clip start.");}}>Go to clip start</button><button className="wide-action" onClick={()=>{setPlayhead(active.start+active.duration);setNotice("Playhead moved to clip end.");}}>Go to clip end</button></div>
        </div> : <div className="inspector-empty"><MousePointer2 size={24}/><strong>Nothing selected</strong><span>Select a clip to inspect its properties</span></div>}
        <div className="ai-card"><div className="ai-card-title"><Sparkles size={15}/><strong>Audio enhancement</strong><span className="beta-pill">BETA</span></div><p>Reduce steady background noise in your exported video using FFmpeg denoising.</p><label className="toggle-row"><span><Volume2 size={15}/> Noise reduction</span><input type="checkbox" checked={denoise} onChange={e=>setDenoise(e.target.checked)}/><i/></label></div>
      </aside>
    </main>
    {showShortcuts && <div className="shortcuts-backdrop" role="presentation" onClick={() => setShowShortcuts(false)}>
      <section className="shortcuts-dialog" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title" onClick={e => e.stopPropagation()}>
        <header><div><span className="eyebrow">GHOUS CUT · EDITOR</span><h2 id="shortcuts-title">Keyboard shortcuts</h2></div><button className="icon-btn" onClick={() => setShowShortcuts(false)} aria-label="Close shortcuts"><X size={16}/></button></header>
        <div className="shortcut-group"><h3>Playback & navigation</h3><div><span>Play / Pause</span><kbd>Space</kbd></div><div><span>Previous / next frame</span><kbd>←</kbd><kbd>→</kbd></div><div><span>Previous / next edit point</span><kbd>↑</kbd><kbd>↓</kbd></div><div><span>Go to beginning / end</span><kbd>Home</kbd><kbd>End</kbd></div><div><span>Stop playback</span><kbd>Esc</kbd></div></div>
        <div className="shortcut-group"><h3>Editing</h3><div><span>Split selected clip</span><kbd>Ctrl</kbd><kbd>B</kbd></div><div><span>Split all tracks</span><kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>B</kbd></div><div><span>Copy / Cut / Paste</span><kbd>Ctrl</kbd><kbd>C</kbd><kbd>Ctrl</kbd><kbd>X</kbd><kbd>Ctrl</kbd><kbd>V</kbd></div><div><span>Duplicate selected clip</span><kbd>Ctrl</kbd><kbd>D</kbd></div><div><span>Timeline zoom in / out / reset</span><kbd>Ctrl</kbd><kbd>+</kbd><kbd>Ctrl</kbd><kbd>−</kbd><kbd>Ctrl</kbd><kbd>0</kbd></div><div><span>Trim left / right to playhead</span><kbd>Q</kbd><kbd>W</kbd></div><div><span>Delete selected clip</span><kbd>Del</kbd></div><div><span>Undo / Redo</span><kbd>Ctrl</kbd><kbd>Z</kbd><kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>Z</kbd><kbd>Ctrl</kbd><kbd>Y</kbd></div></div>
        <div className="shortcut-group"><h3>Project</h3><div><span>Import media</span><kbd>Ctrl</kbd><kbd>I</kbd></div><div><span>Save project file</span><kbd>Ctrl</kbd><kbd>S</kbd></div><div><span>Export video</span><kbd>Ctrl</kbd><kbd>E</kbd></div></div>
        <p><kbd>Ctrl</kbd>+<kbd>A</kbd> memilih semua klip. <kbd>Shift</kbd>+klik memilih rentang pada track yang sama. <kbd>Ctrl</kbd>+klik menambah atau mengurangi pilihan. <kbd>?</kbd> membuka daftar shortcut. <kbd>Esc</kbd> menutup dialog atau menghentikan playback. Shortcut tidak aktif saat kamu sedang mengetik di kolom input.</p>
      </section>
    </div>}
    <footer className="statusbar"><div><span className="status-led"/> {notice}</div><div><WandSparkles size={13}/> GHOUS CUT <span className="status-sep">|</span> LOCAL WORKSPACE</div></footer>
    <input ref={fileInputRef} type="file" multiple accept="video/*,audio/*,image/*" hidden onChange={e=>{
      const files=Array.from(e.target.files||[]);
      void addBrowserFiles(files).then(() => setNotice("Media tersimpan lokal. Browser preview mode; ekspor MP4 tersedia di aplikasi Windows."));
      e.currentTarget.value="";
    }}/>
  </div>;
}

type ProjectCard = StoredProject<Clip>;
function BrandLogo({ size = 28 }: { size?: number }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <Clapperboard size={size} aria-label="Ghous Cut"/>;
  return <img
    className="brand-logo-image"
    src={`${import.meta.env.BASE_URL}logo%20ghooust%20web.svg`}
    width={size}
    height={size}
    alt="Ghous Cut"
    onError={() => setFailed(true)}
  />;
}

export default function App() {
  const [screen, setScreen] = useState<"splash" | "library" | "editor">("splash");
  const [projects, setProjects] = useState<ProjectCard[]>([]);
  const [activeProject, setActiveProject] = useState<ProjectCard | null>(null);
  const [search, setSearch] = useState("");
  const [sortMode, setSortMode] = useState<"recent" | "name">("recent");
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftAspectRatio, setDraftAspectRatio] = useState<ProjectAspectRatio>("16:9");
  const [storageError, setStorageError] = useState("");
  const projectFileInputRef = useRef<HTMLInputElement>(null);

  // The project library uses normal document scrolling. The editor keeps its own
  // fixed-height landscape workspace, so scope viewport rules to the active screen.
  useEffect(() => {
    const isLibrary = screen === "library";
    document.documentElement.classList.toggle("library-page", isLibrary);
    document.body.classList.toggle("library-page", isLibrary);
    return () => {
      document.documentElement.classList.remove("library-page");
      document.body.classList.remove("library-page");
    };
  }, [screen]);

  const exportProject = async (project: StoredProject<Clip>) => {
    try {
      const saved = await exportProjectFile(project);
      if (saved) setStorageError("");
    } catch (error) {
      setStorageError(`Gagal menyimpan file proyek: ${String(error)}`);
    }
  };

  const importProject = async (file: File) => {
    try {
      const project = await importProjectFile(file) as ProjectCard;
      await refreshProjects();
      setActiveProject(project);
      setScreen("editor");
      setStorageError("");
    } catch (error) {
      setStorageError(`File proyek tidak dapat dibuka: ${String(error)}`);
    }
  };

  const refreshProjects = async () => {
    try {
      const items = await listProjects();
      setProjects(items);
      setStorageError("");
    } catch {
      setStorageError("Penyimpanan proyek tidak dapat dibuka di browser ini.");
    }
  };

  useEffect(() => {
    let alive = true;
    const timer = window.setTimeout(async () => {
      try {
        const items = await listProjects();
        if (alive) setProjects(items);
      } catch {
        if (alive) setStorageError("Penyimpanan proyek tidak dapat dibuka di browser ini.");
      }
      if (alive) setScreen("library");
    }, 1250);
    return () => { alive = false; window.clearTimeout(timer); };
  }, []);

  const startProject = async () => {
    const name = draftName.trim() || "Proyek Tanpa Judul";
    const now = Date.now();
    const project: ProjectCard = { id: crypto.randomUUID(), name, clips: [], aspectRatio: draftAspectRatio, createdAt: now, updatedAt: now };
    try {
      await createProject(project);
      setProjects(old => [project, ...old]);
      setActiveProject(project);
      setCreating(false);
      setDraftName("");
      setDraftAspectRatio("16:9");
      setScreen("editor");
    } catch {
      setStorageError("Proyek gagal dibuat. Periksa izin penyimpanan browser.");
    }
  };

  const openProject = async (project: ProjectCard) => {
    const full = await loadProject<Clip>(project.id);
    setActiveProject(full || project);
    setScreen("editor");
  };

  const renameProject = async (project: ProjectCard) => {
    const nextName = window.prompt("Ubah nama proyek", project.name);
    if (!nextName?.trim() || nextName.trim() === project.name) return;
    const updated = { ...project, name: nextName.trim(), updatedAt: Date.now() };
    try {
      await saveProject(updated.id, updated.name, updated.clips);
      setProjects(old => old.map(item => item.id === updated.id ? updated : item));
      setActiveProject(current => current?.id === updated.id ? updated : current);
      setStorageError("");
    } catch (error) {
      setStorageError(`Nama proyek gagal diperbarui: ${String(error)}`);
    }
  };

  const duplicateProject = async (project: ProjectCard) => {
    const now = Date.now();
    try {
      const fullProject = await loadProject<Clip>(project.id) || project;
      const duplicate: ProjectCard = {
        ...fullProject,
        id: crypto.randomUUID(),
        name: `${project.name} (Salinan)`,
        clips: fullProject.clips.map(clip => ({ ...clip, id: crypto.randomUUID() })),
        createdAt: now,
        updatedAt: now
      };
      await createProject(duplicate);
      setProjects(old => [duplicate, ...old]);
      setStorageError("");
    } catch (error) {
      setStorageError(`Proyek gagal diduplikasi: ${String(error)}`);
    }
  };

  const removeProject = async (project: ProjectCard) => {
    if (!window.confirm(`Hapus proyek "${project.name}"? Tindakan ini tidak dapat dibatalkan.`)) return;
    await deleteProject(project.id);
    await refreshProjects();
  };

  const visibleProjects = projects
    .filter(project => project.name.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => sortMode === "recent" ? b.updatedAt - a.updatedAt : a.name.localeCompare(b.name));

  const formatDate = (value: number) => new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));

  if (screen === "splash") return <main className="splash-screen">
    <div className="splash-glow"/>
    <div className="splash-brand-mark"><BrandLogo size={88}/></div>
    <div className="splash-title">GHOUS <span>CUT</span></div>
    <div className="splash-subtitle">VIDEO EDITOR</div>
    <div className="splash-loading"><i/></div>
    <div className="splash-caption">Preparing your creative workspace</div>
  </main>;

  if (screen === "editor" && activeProject) return <EditorWorkspace
    key={activeProject.id}
    projectId={activeProject.id}
    projectName={activeProject.name}
    aspectRatio={activeProject.aspectRatio || "16:9"}
    onBack={async () => { await refreshProjects(); setScreen("library"); }}
    onExportProject={exportProject}
  />;

  return <main className="project-library">
    <header className="library-topbar">
      <div className="library-brand"><span className="library-mark"><BrandLogo size={32}/></span><span>GHOUS <b>CUT</b></span><small>VIDEO EDITOR</small></div>
      <div className="library-account"><span className="library-online"/><span>Local workspace</span></div>
    </header>
    <section className="library-content">
      <div className="library-welcome">
        <div><span className="library-kicker">YOUR CREATIVE SPACE</span><h1>Proyek Saya</h1><p>Lanjutkan karya terakhir atau mulai video baru. File .ghcut menyimpan susunan proyek; media sumber tetap di perangkatmu.</p></div>
        <div className="library-welcome-actions"><button className="btn ghost" onClick={() => projectFileInputRef.current?.click()}><FolderOpen size={16}/> Buka .ghcut</button><button className="new-project-button" onClick={() => setCreating(true)}><Plus size={18}/> Proyek Baru</button></div>
      </div>
      <div className="library-toolbar">
        <label className="project-search"><Search size={16}/><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Cari proyek..." /></label>
        <select className="project-sort" value={sortMode} onChange={e => setSortMode(e.target.value as "recent" | "name")} aria-label="Urutkan proyek">
          <option value="recent">Terakhir dibuka</option><option value="name">Nama proyek</option>
        </select>
      </div>
      {storageError && <div className="storage-warning">{storageError}</div>}
      <div className="project-section-heading"><h2>Semua proyek</h2><span>{visibleProjects.length} proyek</span></div>
      {visibleProjects.length === 0 ? <div className="library-empty">
        <div className="empty-ghost"><BrandLogo size={56}/></div>
        <h3>{search ? "Proyek tidak ditemukan" : "Belum ada proyek"}</h3>
        <p>{search ? "Coba kata pencarian lain." : "Proyek video yang kamu buat akan tersimpan di sini."}</p>
        {!search && <button className="new-project-button secondary" onClick={() => setCreating(true)}><Plus size={16}/> Buat proyek pertama</button>}
      </div> : <div className="project-grid">
        {visibleProjects.map(project => <article className="project-card" key={project.id}>
          <button className="project-open" onClick={() => void openProject(project)} aria-label={`Buka ${project.name}`}>
            <div className="project-thumbnail"><div className="thumbnail-glow"/>{project.clips.find(clip => clip.kind === "image" && clip.src)?.src ? <img src={project.clips.find(clip => clip.kind === "image" && clip.src)?.src} alt="" loading="lazy"/> : project.clips.find(clip => clip.kind === "video" && clip.src)?.src ? <video src={project.clips.find(clip => clip.kind === "video" && clip.src)?.src} muted playsInline preload="metadata"/> : <BrandLogo size={64}/>}<span className="thumbnail-play"><FilmIcon size={17}/></span></div>
            <div className="project-card-info"><strong>{project.name}</strong><span><Clock3 size={12}/> {formatDate(project.updatedAt)}</span></div>
          </button>
          <div className="project-card-actions"><span>{project.clips.length} media</span><button onClick={() => void renameProject(project)} title="Ubah nama proyek" aria-label={`Ubah nama ${project.name}`}><Pencil size={15}/></button><button onClick={() => void duplicateProject(project)} title="Duplikat proyek" aria-label={`Duplikat ${project.name}`}><CopyPlus size={15}/></button><button onClick={() => void removeProject(project)} title="Hapus proyek" aria-label={`Hapus ${project.name}`}><Trash2 size={15}/></button></div>
        </article>)}
      </div>}
    </section>
    <input ref={projectFileInputRef} type="file" accept=".ghcut,application/json" hidden onChange={e => { const file = e.target.files?.[0]; if (file) void importProject(file); e.currentTarget.value = ""; }} />\n    {creating && <div className="project-modal-backdrop" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget) setCreating(false); }}>
      <form className="project-modal" onSubmit={e => { e.preventDefault(); void startProject(); }}>
        <div className="modal-heading"><div><span className="library-kicker">NEW CREATION</span><h2>Buat proyek baru</h2></div><button type="button" onClick={() => setCreating(false)} aria-label="Tutup"><X size={18}/></button></div>
        <label className="project-name-field">Nama proyek<input autoFocus value={draftName} onChange={e => setDraftName(e.target.value)} placeholder="Contoh: Video Liburan" maxLength={70}/></label>
        <label className="project-name-field">Rasio kanvas<select value={draftAspectRatio} onChange={e => setDraftAspectRatio(e.target.value as ProjectAspectRatio)}><option value="16:9">16:9 · Landscape</option><option value="9:16">9:16 · Portrait</option><option value="1:1">1:1 · Square</option></select></label>
        <div className="modal-actions"><button type="button" className="cancel-project" onClick={() => setCreating(false)}>Batal</button><button type="submit" className="new-project-button"><Plus size={16}/> Buat & Edit</button></div>
      </form>
    </div>}
  </main>;
}
