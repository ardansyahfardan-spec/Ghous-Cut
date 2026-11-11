import { useEffect, useMemo, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { loadLocalProject, saveLocalProject } from "./projectStorage";
import {
  AudioLines, Clapperboard, FilePlus2, Film, FolderOpen, Image as ImageIcon,
  Music2, Pause, Play, Scissors, Settings2, Sparkles, Trash2, Video,
  Volume2, WandSparkles, Download, MousePointer2, ChevronDown, Plus, X, Smartphone, RotateCw
} from "lucide-react";

type MediaKind = "video" | "image" | "audio";
type Clip = {
  id: string; name: string; path: string; src: string; kind: MediaKind;
  track: number; start: number; sourceIn: number; duration: number; volume?: number; file?: File;
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

export default function App() {
  const [clips, setClips] = useState<Clip[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [denoise, setDenoise] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState("Ready when you are. Import media to start editing.");
  const [zoom, setZoom] = useState(1);
  const [dragging, setDragging] = useState<string | null>(null);
  const [projectReady, setProjectReady] = useState(false);
  const [isMobilePortrait, setIsMobilePortrait] = useState(false);
  const previewRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isDesktop = "__TAURI_INTERNALS__" in window;

  useEffect(() => {
    const media = window.matchMedia("(max-width: 900px) and (orientation: portrait)");
    const update = () => setIsMobilePortrait(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);

  const requestLandscape = async () => {
    const root = document.documentElement as HTMLElement & { requestFullscreen?: () => Promise<void> };
    try {
      if (!document.fullscreenElement && root.requestFullscreen) await root.requestFullscreen();
    } catch {
      // Fullscreen is optional; continue to attempt orientation lock.
    }
    const orientation = screen.orientation as (ScreenOrientation & { lock?: (value: "landscape") => Promise<void> }) | undefined;
    if (!orientation?.lock) {
      setNotice("Browser ini belum mendukung penguncian otomatis. Putar HP ke posisi landscape untuk melanjutkan.");
      return;
    }
    try {
      await orientation.lock("landscape");
      setNotice("Mode landscape diaktifkan.");
    } catch {
      setNotice("Browser menolak penguncian otomatis. Silakan putar HP ke posisi landscape.");
    }
  };

  useEffect(() => {
    let alive = true;
    loadLocalProject<Clip>().then(project => {
      if (!alive || !project) return;
      const restored = project.clips.map(c => ({
        ...c,
        src: c.file ? URL.createObjectURL(c.file) : (isDesktop ? convertFileSrc(c.path) : c.src)
      }));
      setClips(restored);
      setNotice("Local project restored from this device.");
    }).catch(() => {
      if (alive) setNotice("Local project storage is unavailable in this browser.");
    }).finally(() => { if (alive) setProjectReady(true); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!projectReady) return;
    saveLocalProject(clips).catch(() => setNotice("Could not autosave this project in local browser storage."));
  }, [clips, projectReady]);

  const active = clips.find(c => c.id === selected) || null;
  const activeAtPlayhead = clips.find(c => c.track === 0 && playhead >= c.start && playhead <= c.start + c.duration);
  const duration = Math.max(30, ...clips.map(c => c.start + c.duration + 2));
  const scale = SCALE * zoom;
  const selectedSrc = active?.src || activeAtPlayhead?.src || "";

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => setPlayhead(v => v + 0.1), 100);
    return () => window.clearInterval(timer);
  }, [playing]);

  useEffect(() => {
    if (previewRef.current) previewRef.current.volume = Math.max(0, Math.min(1, active?.volume ?? 1));
    if (audioRef.current) audioRef.current.volume = Math.max(0, Math.min(1, active?.volume ?? 1));
  }, [active?.id, active?.volume]);

  useEffect(() => {
    const el = previewRef.current;
    if (!el || !active || active.kind !== "video") return;
    const target = Math.max(0, active.sourceIn + playhead - active.start);
    if (Math.abs(el.currentTime - target) > 0.45) el.currentTime = Math.min(target, Number.isFinite(el.duration) ? el.duration : target);
  }, [playhead, active?.id]);

  useEffect(() => {
    if (active && playhead < active.start) setPlayhead(active.start);
  }, [active?.id]);

  const addPaths = async (paths: string[]) => {
    const newClips: Clip[] = paths.map((path, i) => {
      const kind = kindFrom(path);
      const track = kind === "audio" ? 2 : kind === "image" ? 1 : 0;
      const last = clips.filter(c => c.track === track).reduce((m, c) => Math.max(m, c.start + c.duration), 0);
      return {
        id: crypto.randomUUID(), name: basename(path), path,
        src: isDesktop ? convertFileSrc(path) : path,
        kind, track, start: last + (i ? 0.25 * i : 0), sourceIn: 0, duration: kind === "image" ? 5 : 10, volume: 1
      };
    });
    setClips(old => [...old, ...newClips]);
    if (newClips[0]) { setSelected(newClips[0].id); setPlayhead(newClips[0].start); }
    setNotice(`Imported ${newClips.length} media file(s).`);
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
    setClips(old => old.map(c => c.id === id ? { ...c, ...patch } : c));

  const splitSelected = () => {
    if (!active) return setNotice("Select a clip first.");
    const cutAt = playhead - active.start;
    if (cutAt <= 0.08 || cutAt >= active.duration - 0.08) return setNotice("Move the playhead inside the selected clip before splitting.");
    const right: Clip = {
      ...active, id: crypto.randomUUID(), name: active.name + " (split)",
      start: playhead, sourceIn: active.sourceIn + cutAt, duration: active.duration - cutAt
    };
    updateClip(active.id, { duration: cutAt });
    setClips(old => [...old, right]);
    setSelected(right.id);
    setNotice("Clip split at playhead.");
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
    if (!active) return;
    setClips(old => old.filter(c => c.id !== active.id));
    setSelected(null);
    setNotice("Clip removed from timeline.");
  };
  const moveClip = (id: string, track: number, start: number) => {
    setClips(old => old.map(c => c.id === id ? { ...c, track, start: Math.max(0, start) } : c));
    setDragging(null);
  };

  const exportVideo = async () => {
    if (!active) return setNotice("Select a video clip to export.");
    if (active.kind !== "video") return setNotice("The first export milestone exports a selected video clip. Select a video track clip.");
    if (!isDesktop) return setNotice("MP4 export is available in the Windows desktop build with FFmpeg installed.");
    try {
      const output = await save({ defaultPath: "ghous-cut-export.mp4", filters: [{ name: "MP4 Video", extensions: ["mp4"] }] });
      if (!output) return;
      setExporting(true);
      setNotice("Rendering selected clip with FFmpeg…");
      const result = await invoke<string>("export_clip", {
        input: active.path, output, start: active.sourceIn, duration: active.duration, denoise, volume: active.volume ?? 1
      });
      setNotice(result);
    } catch (e) {
      setNotice(`Export failed: ${String(e)}`);
    } finally { setExporting(false); }
  };

  const togglePlayback = () => {
    if (playing) {
      setPlaying(false);
      previewRef.current?.pause();
      audioRef.current?.pause();
    } else {
      setPlaying(true);
      if (active?.kind === "video") void previewRef.current?.play().catch(() => {});
      if (active?.kind === "audio") void audioRef.current?.play().catch(() => {});
    }
  };

  const currentPreview = active || activeAtPlayhead;
  const previewTime = currentPreview ? Math.max(0, currentPreview.sourceIn + playhead - currentPreview.start) : 0;
  const trackEnd = (track: number) => clips.filter(c => c.track === track).reduce((m,c) => Math.max(m,c.start+c.duration), 0);

  return <div className="app-shell">
    {isMobilePortrait && <div className="orientation-gate" role="dialog" aria-modal="true" aria-labelledby="orientation-title">
      <div className="orientation-card">
        <div className="orientation-icon"><Smartphone size={38}/><RotateCw size={22}/></div>
        <span className="eyebrow">GHOUS CUT · MOBILE EDITOR</span>
        <h1 id="orientation-title">Putar perangkat Anda</h1>
        <p>Ghous Cut menggunakan workspace landscape agar timeline, preview, dan panel editing lebih nyaman digunakan.</p>
        <button className="btn primary orientation-action" onClick={requestLandscape}><RotateCw size={16}/> Aktifkan landscape</button>
        <small>Jika layar tidak berputar otomatis, matikan kunci rotasi HP lalu putar perangkat ke samping.</small>
      </div>
    </div>}
    <header className="topbar">
      <div className="brand"><div className="brand-mark"><Clapperboard size={19}/></div><span>ghous<span className="brand-accent">cut</span></span><span className="version">BETA 0.1</span></div>
      <div className="project-name"><span className="live-dot"/> Untitled Project <ChevronDown size={14}/></div>
      <div className="top-actions"><button className="btn ghost" onClick={importMedia}><FolderOpen size={15}/> Import</button><button className="btn primary" onClick={exportVideo} disabled={exporting}><Download size={15}/>{exporting ? "Rendering…" : "Export"}</button></div>
    </header>

    <main className="workspace">
      <aside className="media-panel panel">
        <div className="panel-heading"><div><span className="eyebrow">PROJECT</span><h2>Media Library</h2></div><button className="icon-btn" onClick={importMedia} title="Import media"><Plus size={17}/></button></div>
        <button className="import-drop" onClick={importMedia}><FilePlus2 size={22}/><strong>Import media</strong><span>Video, image or audio</span></button>
        <div className="asset-heading"><span>ASSETS</span><span>{clips.length} items</span></div>
        <div className="asset-list">
          {clips.length === 0 && <div className="empty-assets"><Film size={25}/><p>Your media will appear here</p><span>Import files to begin your project</span></div>}
          {clips.map(c => <button key={c.id} className={`asset-row ${selected===c.id?"chosen":""}`} onClick={() => {setSelected(c.id);setPlayhead(c.start);}}>
            <span className={`asset-icon ${c.kind}`}>{c.kind==="video"?<Video size={16}/>:c.kind==="image"?<ImageIcon size={16}/>:<Music2 size={16}/>}</span>
            <span className="asset-meta"><strong>{c.name}</strong><small>{c.kind.toUpperCase()} · {fmt(c.duration)}</small></span>
          </button>)}
        </div>
        <div className="storage-note"><span className="storage-dot"/> {isDesktop ? "Local project · Files stay on your PC" : "Auto-save · This browser & device"}</div>
      </aside>

      <section className="center-panel">
        <div className="preview-panel panel">
          <div className="panel-heading preview-heading"><div><span className="eyebrow">CANVAS</span><h2>Preview</h2></div><div className="preview-meta"><span>16:9</span><span>FIT</span></div></div>
          <div className="preview-stage">
            {!currentPreview && <div className="preview-empty"><div className="preview-logo"><Clapperboard size={30}/></div><strong>Your story starts here</strong><span>Import a clip and select it in the timeline</span></div>}
            {currentPreview?.kind === "video" && <video ref={previewRef} src={currentPreview.src} className="preview-media" controls={false} onLoadedMetadata={e => {
              const d = e.currentTarget.duration;
              if (Number.isFinite(d) && d > 0 && currentPreview.sourceIn === 0) updateClip(currentPreview.id,{duration:d});
            }} onTimeUpdate={e => {
              if (playing && currentPreview) setPlayhead(currentPreview.start + e.currentTarget.currentTime - currentPreview.sourceIn);
            }} onEnded={() => setPlaying(false)} />}
            {currentPreview?.kind === "image" && <img src={currentPreview.src} className="preview-media image-preview" />}
            {currentPreview?.kind === "audio" && <div className="audio-preview"><div className="audio-art"><AudioLines size={52}/></div><strong>{currentPreview.name}</strong><span>Audio preview</span><audio ref={audioRef} src={currentPreview.src} controls /></div>}
          </div>
          <div className="transport">
            <span className="timecode">{fmt(playhead)}</span><div className="transport-controls"><button className="transport-btn" onClick={() => setPlayhead(0)} title="Go to start">|◀</button><button className="play-btn" onClick={togglePlayback}>{playing?<Pause size={17}/>:<Play size={17} fill="currentColor"/>}</button><button className="transport-btn" onClick={() => setPlayhead(Math.min(duration,playhead+5))} title="Forward 5 seconds">▶|</button></div><span className="timecode muted">{fmt(duration)}</span>
          </div>
        </div>

        <div className="timeline-panel panel">
          <div className="timeline-toolbar">
            <div className="timeline-title"><span className="eyebrow">EDIT</span><h2>Timeline</h2></div>
            <div className="edit-tools">
              <button className="tool-btn" onClick={splitSelected} title="Split at playhead"><Scissors size={15}/><span>Split</span></button>
              <button className="tool-btn" onClick={trimLeft} title="Trim beginning to playhead">◧<span>Trim left</span></button>
              <button className="tool-btn" onClick={trimRight} title="Trim end to playhead">◨<span>Trim right</span></button>
              <button className="tool-btn danger-tool" onClick={removeSelected} title="Remove selected clip"><Trash2 size={15}/></button>
            </div>
            <div className="zoom-control"><span>−</span><input aria-label="Timeline zoom" type="range" min="0.6" max="1.8" step="0.1" value={zoom} onChange={e=>setZoom(Number(e.target.value))}/><span>+</span></div>
          </div>
          <div className="timeline-scroll">
            <div className="timeline-ruler-wrap">
              <div className="track-label-spacer"/>
              <div className="ruler" style={{width:Math.max(800,duration*scale)}} onClick={e=>{
                const r=e.currentTarget.getBoundingClientRect();setPlayhead(Math.max(0,(e.clientX-r.left)/scale));
              }}>
                {Array.from({length:Math.ceil(duration/5)+1},(_,i)=><span key={i} className="ruler-tick" style={{left:i*5*scale}}>{fmt(i*5)}</span>)}
              </div>
            </div>
            {TRACKS.map(t => <div className="track-row" key={t.id}>
              <div className="track-label"><t.icon size={15}/><div><strong>{t.name}</strong><small>{t.hint}</small></div></div>
              <div className="track-lane" style={{width:Math.max(800,duration*scale)}} onDragOver={e=>e.preventDefault()} onDrop={e=>{
                e.preventDefault();if(dragging)moveClip(dragging,t.id,Math.max(0,(e.clientX-e.currentTarget.getBoundingClientRect().left)/scale));
              }}>
                {clips.filter(c=>c.track===t.id).map(c=><div key={c.id} draggable onDragStart={()=>setDragging(c.id)} onDragEnd={()=>setDragging(null)}
                  className={`timeline-clip ${c.kind} ${selected===c.id?"selected":""}`}
                  style={{left:c.start*scale,width:Math.max(66,c.duration*scale)}}
                  onClick={()=>{setSelected(c.id);setPlayhead(c.start);}}>
                  <span className="clip-thumb">{c.kind==="video"?<Film size={13}/>:c.kind==="image"?<ImageIcon size={13}/>:<AudioLines size={13}/>}</span><span className="clip-name">{c.name}</span><span className="clip-duration">{fmt(c.duration)}</span>
                </div>)}
              </div>
            </div>)}
            <div className="playhead" style={{left:116+playhead*scale}}><div className="playhead-cap"/><div className="playhead-line"/></div>
          </div>
          <div className="timeline-footer"><span><MousePointer2 size={12}/> Drag clips to arrange · Click ruler to move playhead</span><span>{clips.length} clips · {fmt(duration)} workspace</span></div>
        </div>
      </section>

      <aside className="inspector-panel panel">
        <div className="panel-heading"><div><span className="eyebrow">PROPERTIES</span><h2>Inspector</h2></div><Settings2 size={17} className="subtle-icon"/></div>
        {active ? <div className="inspector-content">
          <div className="selected-file"><div className={`selected-file-icon ${active.kind}`}>{active.kind==="video"?<Video/>:active.kind==="image"?<ImageIcon/>:<Music2/>}</div><strong>{active.name}</strong><small>{active.kind.toUpperCase()} CLIP</small></div>
          <div className="property-group"><label>POSITION ON TIMELINE</label><div className="property-input"><span>Start</span><strong>{fmt(active.start)}</strong></div><div className="property-input"><span>Duration</span><strong>{fmt(active.duration)}</strong></div><div className="property-input"><span>Track</span><strong>{TRACKS.find(t=>t.id===active.track)?.name}</strong></div></div>
          <div className="property-group"><label>AUDIO LEVEL</label><div className="property-input"><span>Clip volume</span><strong>{Math.round((active.volume ?? 1) * 100)}%</strong></div><input aria-label="Clip volume" type="range" min="0" max="1" step="0.01" value={active.volume ?? 1} onChange={e=>updateClip(active.id,{volume:Number(e.target.value)})} style={{width:"100%"}}/><button className="wide-action" onClick={()=>updateClip(active.id,{volume:0})}>Mute clip</button><button className="wide-action" onClick={()=>updateClip(active.id,{volume:1})}>Reset volume</button></div><div className="property-group"><label>TRIM RANGE</label><div className="property-input"><span>Source in</span><strong>{fmt(active.sourceIn)}</strong></div><div className="property-input"><span>Source out</span><strong>{fmt(active.sourceIn+active.duration)}</strong></div><p className="helper-text">Use the trim buttons above the timeline at the playhead position.</p></div>
          <div className="property-group"><label>QUICK ACTIONS</label><button className="wide-action" onClick={()=>{setPlayhead(active.start);setNotice("Playhead moved to clip start.");}}>Go to clip start</button><button className="wide-action" onClick={()=>{setPlayhead(active.start+active.duration);setNotice("Playhead moved to clip end.");}}>Go to clip end</button></div>
        </div> : <div className="inspector-empty"><MousePointer2 size={24}/><strong>Nothing selected</strong><span>Select a clip to inspect its properties</span></div>}
        <div className="ai-card"><div className="ai-card-title"><Sparkles size={15}/><strong>Audio enhancement</strong><span className="beta-pill">BETA</span></div><p>Reduce steady background noise in your exported video using FFmpeg denoising.</p><label className="toggle-row"><span><Volume2 size={15}/> Noise reduction</span><input type="checkbox" checked={denoise} onChange={e=>setDenoise(e.target.checked)}/><i/></label></div>
      </aside>
    </main>
    <footer className="statusbar"><div><span className="status-led"/> {notice}</div><div><WandSparkles size={13}/> GHOUS CUT <span className="status-sep">|</span> LOCAL WORKSPACE</div></footer>
    <input ref={fileInputRef} type="file" multiple accept="video/*,audio/*,image/*" hidden onChange={e=>{
      const files=Array.from(e.target.files||[]);
      const urls=files.map(f=>URL.createObjectURL(f));
      const newClips=files.map((f,i)=>({id:crypto.randomUUID(),name:f.name,path:f.name,src:urls[i],file:f,kind:kindFrom(f.name),track:kindFrom(f.name)==="audio"?2:kindFrom(f.name)==="image"?1:0,start:0,sourceIn:0,duration:10,volume:1} as Clip));
      setClips(old=>[...old,...newClips]);if(newClips[0])setSelected(newClips[0].id);setNotice("Browser preview mode. Run the Windows app for FFmpeg export.");
      e.currentTarget.value="";
    }}/>
  </div>;
}