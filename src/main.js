import { Midi } from "@tonejs/midi";
import { WorkletSynthesizer } from "spessasynth_lib";
import "./styles.css";

const MIN_NOTE = 54; // F#3
const MAX_NOTE = 78; // F#5
const MIN_DELAY = 0.05;
const MAX_DELAY = 10;
const NOTE_SUSTAIN = 0.85;
const PIANO_ROLL_LEAD_TIME = 3;
const MAX_MIDI_SIZE = 25 * 1024 * 1024;
const MULTIPLAYER_CHUNK_SIZE = 12000;
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

const elements = {
  midiFile: document.querySelector("#midiFile"),
  dropZone: document.querySelector("#dropZone"),
  fileCard: document.querySelector("#fileCard"),
  fileName: document.querySelector("#fileName"),
  fileMeta: document.querySelector("#fileMeta"),
  removeFile: document.querySelector("#removeFile"),
  startOffset: document.querySelector("#startOffset"),
  startOffsetOutput: document.querySelector("#startOffsetOutput"),
  tempoScale: document.querySelector("#tempoScale"),
  tempoScaleOutput: document.querySelector("#tempoScaleOutput"),
  previewVolume: document.querySelector("#previewVolume"),
  previewVolumeOutput: document.querySelector("#previewVolumeOutput"),
  reuseNotes: document.querySelector("#reuseNotes"),
  blockSaveSummary: document.querySelector("#blockSaveSummary"),
  mergeNotes: document.querySelector("#mergeNotes"),
  autoFollow: document.querySelector("#autoFollow"),
  builderPart: document.querySelector("#builderPart"),
  builderPartHint: document.querySelector("#builderPartHint"),
  multiplayerStatus: document.querySelector("#multiplayerStatus"),
  multiplayerCode: document.querySelector("#multiplayerCode"),
  multiplayerHelp: document.querySelector("#multiplayerHelp"),
  hostRoom: document.querySelector("#hostRoom"),
  joinRoom: document.querySelector("#joinRoom"),
  connectAnswer: document.querySelector("#connectAnswer"),
  syncMultiplayer: document.querySelector("#syncMultiplayer"),
  myBuildStatus: document.querySelector("#myBuildStatus"),
  friendBuildStatus: document.querySelector("#friendBuildStatus"),
  markBuildDone: document.querySelector("#markBuildDone"),
  resetBuildDone: document.querySelector("#resetBuildDone"),
  emptyState: document.querySelector("#emptyState"),
  resultsContent: document.querySelector("#resultsContent"),
  loadingOverlay: document.querySelector("#loadingOverlay"),
  loadingTitle: document.querySelector("#loadingTitle"),
  loadingText: document.querySelector("#loadingText"),
  statNotes: document.querySelector("#statNotes"),
  statBlocks: document.querySelector("#statBlocks"),
  statDelays: document.querySelector("#statDelays"),
  statDuration: document.querySelector("#statDuration"),
  planNotice: document.querySelector("#planNotice"),
  timeline: document.querySelector("#timeline"),
  pianoRoll: document.querySelector("#pianoRoll"),
  rollLanes: document.querySelector("#rollLanes"),
  rollNotes: document.querySelector("#rollNotes"),
  rollIdle: document.querySelector("#rollIdle"),
  rollKeys: document.querySelector("#rollKeys"),
  instructionList: document.querySelector("#instructionList"),
  noteTableBody: document.querySelector("#noteTableBody"),
  previewButton: document.querySelector("#previewButton"),
  stopButton: document.querySelector("#stopButton"),
  copyInstructions: document.querySelector("#copyInstructions"),
  copyNotes: document.querySelector("#copyNotes"),
  keyboard: document.querySelector("#keyboard"),
  toast: document.querySelector("#toast"),
};

const state = {
  file: null,
  rawNotes: [],
  convertedNotes: 0,
  sourceType: null,
  analysisMeta: null,
  plan: null,
  synth: null,
  synthPromise: null,
  audioContext: null,
  outputGain: null,
  previewStartedAt: null,
  stopTimer: null,
  audioTimers: [],
  highlightTimers: [],
  toastTimer: null,
  peerConnection: null,
  dataChannel: null,
  incomingChunks: new Map(),
  localBuildDone: false,
  remoteBuildDone: false,
  remoteBuildPart: null,
};

function midiToName(midi) {
  return `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
}

function cleanLabel(value, fallback = "Unknown") {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim() || fallback;
}

function foldIntoPlayableRange(midi) {
  let foldedMidi = midi;

  while (foldedMidi < MIN_NOTE) foldedMidi += 12;
  while (foldedMidi > MAX_NOTE) foldedMidi -= 12;

  return foldedMidi;
}

function isPercussionTrack(track) {
  const family = cleanLabel(track.instrument?.family, "");
  const searchable = `${track.name ?? ""} ${track.instrument?.name ?? ""} ${family}`.toLowerCase();
  return (
    track.channel === 9 ||
    track.notes?.some((note) => note.channel === 9) ||
    track.instrument?.percussion === true ||
    family.toLowerCase().includes("drum") ||
    /\b(drum|drums|percussion|kit|snare|clap|hi-hat|hihat|kick|cymbal)\b/.test(searchable)
  );
}

function compactNoteLabel(note) {
  return note.name;
}

function noteBlockLabel(note) {
  return `Music Note ${note.id} (${compactNoteLabel(note)})`;
}

function createMidiNote(note) {
  const originalMidi = Math.round(Number(note.midi));
  const foldedMidi = foldIntoPlayableRange(originalMidi);
  return {
    midi: foldedMidi,
    originalMidi,
    originalName: midiToName(originalMidi),
    wasConverted: foldedMidi !== originalMidi,
    sourceTime: Number(note.time ?? note.sourceTime ?? 0),
    sourceDuration: Number(note.duration ?? note.sourceDuration ?? NOTE_SUSTAIN),
    velocity: Math.min(1, Math.max(0.05, Number(note.velocity ?? 0.8))),
  };
}

function roundDelay(value) {
  return Math.round(value * 100) / 100;
}

function formatSeconds(value, precision = 2) {
  return `${value.toFixed(precision)}s`;
}

function formatClock(value) {
  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60)
    .toString()
    .padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function sleep(ms = 0) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function showToast(message) {
  window.clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  state.toastTimer = window.setTimeout(() => elements.toast.classList.remove("show"), 3200);
}

function showLoading(title, text) {
  elements.loadingTitle.textContent = title;
  elements.loadingText.textContent = text;
  elements.loadingOverlay.classList.remove("hidden");
}

function hideLoading() {
  elements.loadingOverlay.classList.add("hidden");
}

function updatePreviewVolume() {
  const volume = Number(elements.previewVolume.value);
  elements.previewVolumeOutput.value = `${volume}%`;

  if (state.outputGain && state.audioContext) {
    state.outputGain.gain.setTargetAtTime(
      volume / 100,
      state.audioContext.currentTime,
      0.015,
    );
  }
}

function splitDelay(seconds) {
  const legalDuration = Math.max(MIN_DELAY, roundDelay(seconds));
  if (legalDuration <= MAX_DELAY) return [legalDuration];

  const segments = [];
  let remaining = legalDuration;

  while (remaining > MAX_DELAY) {
    if (remaining - MAX_DELAY < MIN_DELAY) {
      segments.push(roundDelay(remaining - MIN_DELAY));
      remaining = MIN_DELAY;
      break;
    }
    segments.push(MAX_DELAY);
    remaining = roundDelay(remaining - MAX_DELAY);
  }

  if (remaining >= MIN_DELAY) segments.push(roundDelay(remaining));
  return segments;
}

function createPlan() {
  if (!state.rawNotes.length) return null;

  const speed = Number(elements.tempoScale.value) / 100;
  const mergeWindow = elements.mergeNotes.checked ? 0.025 : 0.001;
  const startOffset = Number(elements.startOffset.value);
  const saveBlocks = elements.reuseNotes?.checked ?? true;
  const scaledNotes = state.rawNotes
    .map((note) => ({ ...note, time: note.sourceTime / speed }))
    .sort((a, b) => a.time - b.time || a.midi - b.midi);

  const grouped = [];
  for (const note of scaledNotes) {
    const last = grouped.at(-1);
    if (!last || note.time - last.sourceTime > mergeWindow) {
      grouped.push({ sourceTime: note.time, notes: [note] });
      continue;
    }

    if (!last.notes.some((existing) => existing.midi === note.midi)) {
      last.notes.push(note);
    }
  }

  let previousSourceTime = 0;
  let plannedTime = 0;
  let nextDelayId = 1;
  let nextMusicBlockId = 1;
  const reusedNoteIds = new Map();
  let adjustedGaps = 0;
  const getMusicBlockId = (midi) => {
    if (!saveBlocks) return nextMusicBlockId++;
    if (!reusedNoteIds.has(midi)) {
      reusedNoteIds.set(midi, nextMusicBlockId);
      nextMusicBlockId += 1;
    }
    return reusedNoteIds.get(midi);
  };

  const events = grouped.map((group, eventIndex) => {
    const requestedDelay =
      eventIndex === 0
        ? startOffset + group.sourceTime
        : group.sourceTime - previousSourceTime;
    const delaySegments = splitDelay(requestedDelay);
    const effectiveDelay = delaySegments.reduce((total, segment) => total + segment, 0);
    if (requestedDelay < MIN_DELAY) adjustedGaps += 1;

    plannedTime = roundDelay(plannedTime + effectiveDelay);
    previousSourceTime = group.sourceTime;

    const delays = delaySegments.map((duration) => ({
      id: nextDelayId++,
      duration,
    }));
    const notes = group.notes
      .sort((a, b) => a.midi - b.midi)
      .map((note) => ({
        ...note,
        id: getMusicBlockId(note.midi),
        name: midiToName(note.midi),
        propertyClicks: note.midi - MIN_NOTE,
      }));

    return {
      id: eventIndex + 1,
      sourceTime: group.sourceTime,
      requestedDelay,
      effectiveDelay,
      plannedTime,
      delays,
      notes,
    };
  });

  const noteCount = events.reduce((total, event) => total + event.notes.length, 0);
  const noteBlockCount = saveBlocks ? reusedNoteIds.size : noteCount;

  return {
    events,
    speed,
    saveBlocks,
    adjustedGaps,
    noteCount,
    noteBlockCount,
    savedNoteBlocks: Math.max(0, noteCount - noteBlockCount),
    delayCount: nextDelayId - 1,
    duration: plannedTime + NOTE_SUSTAIN,
  };
}

function getBuilderSlice() {
  const events = state.plan?.events ?? [];
  const selected = elements.builderPart?.value ?? "all";
  if (!events.length || selected === "all") {
    return {
      events,
      label: "Full build",
      startIndex: 0,
      endIndex: events.length,
    };
  }

  const midpoint = Math.max(1, Math.ceil(events.length / 2));
  if (selected === "first") {
    return {
      events: events.slice(0, midpoint),
      label: "Builder A: first half",
      startIndex: 0,
      endIndex: midpoint,
    };
  }

  return {
    events: events.slice(midpoint),
    label: "Builder B: second half",
    startIndex: midpoint,
    endIndex: events.length,
  };
}

function updateBuilderPartHint() {
  if (!elements.builderPartHint) return;
  if (!state.plan?.events.length) {
    elements.builderPartHint.textContent = "Load a song to split the build into two parts.";
    return;
  }

  const slice = getBuilderSlice();
  if (!slice.events.length) {
    elements.builderPartHint.textContent = `${slice.label} has no steps for this short song.`;
    return;
  }

  const firstEvent = slice.events[0];
  const lastEvent = slice.events.at(-1);
  const extra =
    slice.startIndex > 0
      ? ` Start from the transfer ${`Delay ${state.plan.events[slice.startIndex - 1].delays.at(-1).id} -> Delay ${firstEvent.delays[0].id}`}.`
      : " Start from the Button or Seat trigger.";

  elements.builderPartHint.textContent =
    `${slice.label}: activations ${firstEvent.id}-${lastEvent.id} of ${state.plan.events.length}.${extra}`;
}

function updateBlockSaveSummary() {
  if (!elements.blockSaveSummary) return;
  if (!state.plan?.events.length) {
    elements.blockSaveSummary.textContent = elements.reuseNotes.checked
      ? "Load a MIDI to see how many Music Note blocks you can save."
      : "Shared note blocks are off. Every note activation will get its own Music Note block.";
    return;
  }

  const { plan } = state;
  if (!plan.saveBlocks) {
    elements.blockSaveSummary.textContent =
      `Reuse is off: ${plan.noteCount.toLocaleString()} Music Note blocks will be placed.`;
    return;
  }

  elements.blockSaveSummary.textContent =
    `${plan.noteBlockCount.toLocaleString()} Music Note block${plan.noteBlockCount === 1 ? "" : "s"} can play ${plan.noteCount.toLocaleString()} activation${plan.noteCount === 1 ? "" : "s"}. Saved ${plan.savedNoteBlocks.toLocaleString()} duplicate block${plan.savedNoteBlocks === 1 ? "" : "s"}.`;
}

function renderPlan() {
  state.plan = createPlan();
  if (!state.plan) return;

  const { plan } = state;
  elements.statNotes.textContent = plan.noteCount.toLocaleString();
  elements.statBlocks.textContent = plan.noteBlockCount.toLocaleString();
  elements.statDelays.textContent = plan.delayCount.toLocaleString();
  elements.statDuration.textContent = formatClock(plan.duration);

  const notices = [];
  if (state.analysisMeta?.skippedPercussionNotes) {
    notices.push(
      `${state.analysisMeta.skippedPercussionNotes.toLocaleString()} drum MIDI note${state.analysisMeta.skippedPercussionNotes === 1 ? "" : "s"} were skipped because BABFT Music Notes only play pitched notes.`,
    );
  }
  if (state.convertedNotes) {
    notices.push(
      `${state.convertedNotes.toLocaleString()} note${state.convertedNotes === 1 ? " was" : "s were"} outside F#3-F#5 and shifted by octaves into the playable range.`,
    );
  }
  if (plan.adjustedGaps) {
    notices.push(
      `${plan.adjustedGaps.toLocaleString()} gap${plan.adjustedGaps === 1 ? " was" : "s were"} shorter than 0.05s and adjusted to BABFT's minimum Delay.`,
    );
  }
  if (plan.saveBlocks && plan.savedNoteBlocks) {
    notices.push(
      `Save blocks is on, so repeated pitches reuse existing Music Note blocks. Delay blocks stay in order because each Delay holds its signal before passing it on.`,
    );
  }

  elements.planNotice.textContent = notices.join(" ");
  elements.planNotice.classList.toggle("hidden", notices.length === 0);
  updateBlockSaveSummary();
  renderTimeline();
  renderPianoRoll();
  renderInstructions();
  renderNoteTable();
  updateBuilderPartHint();
  elements.emptyState.classList.add("hidden");
  elements.resultsContent.classList.remove("hidden");
  elements.previewButton.disabled = false;
  elements.stopButton.disabled = true;
}

function renderTimeline() {
  const displayEvents = state.plan.events;
  const fragment = document.createDocumentFragment();

  for (const event of displayEvents) {
    const row = document.createElement("div");
    row.className = "timeline-event";
    row.dataset.eventId = event.id;

    const time = document.createElement("div");
    time.className = "timeline-time";
    time.textContent = formatSeconds(event.plannedTime);

    const body = document.createElement("div");
    body.className = "timeline-body";

    event.delays.forEach((delay, index) => {
      const chip = document.createElement("span");
      chip.className = "timeline-delay";
      chip.innerHTML = `<i></i> Delay ${delay.id} · ${formatSeconds(delay.duration)}`;
      body.append(chip);

      if (index < event.delays.length - 1 || event.notes.length) {
        const arrow = document.createElement("span");
        arrow.className = "timeline-arrow";
        arrow.textContent = "→";
        body.append(arrow);
      }
    });

    event.notes.forEach((note, index) => {
      const chip = document.createElement("span");
      chip.className = "timeline-note";
      chip.innerHTML = `<i></i> ${noteBlockLabel(note)}`;
      body.append(chip);
      if (index < event.notes.length - 1) {
        const plus = document.createElement("span");
        plus.className = "timeline-arrow";
        plus.textContent = "+";
        body.append(plus);
      }
    });

    row.append(time, body);
    fragment.append(row);
  }

  elements.timeline.replaceChildren(fragment);
}

function renderPianoRoll() {
  const laneFragment = document.createDocumentFragment();
  const keyFragment = document.createDocumentFragment();

  for (let midi = MIN_NOTE; midi <= MAX_NOTE; midi += 1) {
    const name = midiToName(midi);
    const sharp = name.includes("#");

    const lane = document.createElement("span");
    lane.className = sharp ? "sharp" : "";
    laneFragment.append(lane);

    const key = document.createElement("button");
    key.type = "button";
    key.className = `roll-key${sharp ? " sharp" : ""}`;
    key.dataset.midi = midi;
    key.textContent = name;
    key.title = `Play ${name}`;
    key.addEventListener("click", () => playKeyboardNote(midi, key));
    keyFragment.append(key);
  }

  elements.rollLanes.replaceChildren(laneFragment);
  elements.rollKeys.replaceChildren(keyFragment);
  resetPianoRoll();
}

function resetPianoRoll() {
  elements.rollNotes.replaceChildren();
  elements.pianoRoll.classList.remove("playing");
  elements.rollIdle.classList.remove("hidden");
  elements.rollKeys.querySelectorAll(".active").forEach((key) => key.classList.remove("active"));
}

function startPianoRoll(elapsed = 0) {
  const fragment = document.createDocumentFragment();

  for (const event of getBuilderSlice().events) {
    for (const note of event.notes) {
      const tile = document.createElement("span");
      tile.className = `roll-note${note.name.includes("#") ? " sharp" : ""}`;
      tile.style.setProperty("--lane", note.midi - MIN_NOTE);
      tile.style.animationDelay = `${event.plannedTime - PIANO_ROLL_LEAD_TIME - elapsed}s`;
      tile.style.animationDuration = `${PIANO_ROLL_LEAD_TIME}s`;
      tile.textContent = note.name;
      fragment.append(tile);
    }
  }

  elements.rollNotes.replaceChildren(fragment);
  elements.rollIdle.classList.add("hidden");
  elements.pianoRoll.classList.add("playing");
}

function setRollKeyActive(midi, active) {
  const key = elements.rollKeys.querySelector(`[data-midi="${midi}"]`);
  key?.classList.toggle("active", active);
}

function followTimelineRow(row) {
  if (!elements.autoFollow.checked || !document.querySelector("#timelineView").classList.contains("active")) {
    return;
  }

  const timelineRect = elements.timeline.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  const target =
    elements.timeline.scrollTop +
    rowRect.top -
    timelineRect.top -
    elements.timeline.clientHeight / 2 +
    rowRect.height / 2;

  elements.timeline.scrollTo({ top: target, behavior: "smooth" });
}

function delaySettingsLabel(delays) {
  return delays.map((delay) => `${delay.id}: ${formatSeconds(delay.duration)}`).join(", ");
}

function delayTitleLabel(delays) {
  return delays
    .map((delay) => `Delay ${delay.id} (${formatSeconds(delay.duration)})`)
    .join(" → ");
}

function createConnectionChip(from, to, type = "delay") {
  const chip = document.createElement("span");
  chip.className = `connection-chip ${type}`;
  chip.innerHTML = `<i></i>${from}<b>→</b>${to}`;
  return chip;
}

function collectMusicBlocks(events) {
  const blocks = new Map();

  for (const event of events) {
    for (const note of event.notes) {
      const existing = blocks.get(note.id) ?? {
        id: note.id,
        midi: note.midi,
        name: note.name,
        propertyClicks: note.propertyClicks,
        starts: [],
        uses: 0,
      };
      existing.starts.push(event.plannedTime);
      existing.uses += 1;
      blocks.set(note.id, existing);
    }
  }

  return [...blocks.values()].sort((a, b) => a.id - b.id);
}

function renderInstructions() {
  const fragment = document.createDocumentFragment();
  const slice = getBuilderSlice();

  const trigger = document.createElement("li");
  trigger.className = "trigger-step";
  trigger.innerHTML =
    '<div class="instruction-icon" aria-hidden="true">START</div><div class="instruction-content"><div class="instruction-title"><span>Trigger</span><strong>Button or seat → Delay 1</strong></div><p>Place a Button, Pilot Seat, or Car Seat and bind it to Delay 1. Buttons activate when pressed. Any seat input can activate the chain, so choose seat keys carefully.</p><div class="connection-list"><span class="connection-chip trigger"><i></i>Button / Seat<b>→</b>Delay 1</span></div></div>';
  fragment.append(trigger);
  if (slice.startIndex > 0 && slice.events.length) {
    const previousDelay = state.plan.events[slice.startIndex - 1].delays.at(-1).id;
    const firstDelay = slice.events[0].delays[0].id;
    trigger.innerHTML = `
      <div class="instruction-icon" aria-hidden="true">LINK</div>
      <div class="instruction-content">
        <div class="instruction-title">
          <span>Incoming signal</span>
          <strong>Delay ${previousDelay} -> Delay ${firstDelay}</strong>
        </div>
        <p>This is Builder B's half of the same chain. Builder A finishes by binding Delay ${previousDelay} into your first Delay.</p>
        <div class="connection-list"><span class="connection-chip trigger"><i></i>Delay ${previousDelay}<b>-></b>Delay ${firstDelay}</span></div>
      </div>
    `;
  }

  for (const event of slice.events) {
    const item = document.createElement("li");
    item.className = "delay-step";
    const source =
      event.id === 1
        ? "Button / Seat"
        : `Delay ${state.plan.events[event.id - 2].delays.at(-1).id}`;
    const noteLabels = event.notes.map(noteBlockLabel).join(", ");
    const next = state.plan.events[event.id]?.delays[0]?.id;
    const finalDelay = event.delays.at(-1);
    const content = document.createElement("div");
    content.className = "instruction-content";
    content.innerHTML = `
      <div class="instruction-title">
        <span>Delay chain</span>
        <strong>${delayTitleLabel(event.delays)} → ${event.notes.map(compactNoteLabel).join(" + ")}</strong>
      </div>
      <div class="delay-time-list">
        ${event.delays.map((delay) => `<span><i></i>Delay ${delay.id}<b>${formatSeconds(delay.duration)}</b></span>`).join("")}
      </div>
      <p>Set the Delay times above with the Property Tool. Bind each block using the connections below. The final Delay activates ${state.plan.saveBlocks ? "existing " : ""}${noteLabels}${next ? ` and transfers the signal to Delay ${next}` : ""}.</p>
    `;

    const icon = document.createElement("div");
    icon.className = "instruction-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "DELAY";

    const connections = document.createElement("div");
    connections.className = "connection-list";
    connections.append(createConnectionChip(source, `Delay ${event.delays[0].id}`, "trigger"));
    event.delays.slice(0, -1).forEach((delay, index) => {
      connections.append(
        createConnectionChip(`Delay ${delay.id}`, `Delay ${event.delays[index + 1].id}`),
      );
    });
    event.notes.forEach((note) => {
      connections.append(
        createConnectionChip(`Delay ${finalDelay.id}`, noteBlockLabel(note), "note"),
      );
    });
    if (next) {
      connections.append(
        createConnectionChip(`Delay ${finalDelay.id}`, `Delay ${next}`, "continue"),
      );
    }
    content.append(connections);
    item.append(icon, content);
    fragment.append(item);
  }

  elements.instructionList.replaceChildren(fragment);
}

function renderNoteTable() {
  const fragment = document.createDocumentFragment();

  for (const block of collectMusicBlocks(getBuilderSlice().events)) {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${block.id}</td>
      <td>${block.name}</td>
      <td>${block.propertyClicks === 0 ? "Default F#3" : `+${block.propertyClicks} from F#3`}</td>
      <td>${block.uses.toLocaleString()}x</td>
      <td>${formatSeconds(block.starts[0])}</td>
    `;
    fragment.append(row);
  }

  elements.noteTableBody.replaceChildren(fragment);
}

function buildInstructionsText() {
  const slice = getBuilderSlice();
  const lines = [
    "BABFT MUSIC BUILD PLAN",
    `Playable activations: ${state.plan.noteCount} | Music Note blocks: ${state.plan.noteBlockCount} | Delay blocks: ${state.plan.delayCount} | Length: ${formatClock(state.plan.duration)}`,
    `Section: ${slice.label}`,
    state.plan.saveBlocks
      ? "Save blocks: ON. Reuse the same Music Note block whenever the note name matches."
      : "Save blocks: OFF. Place a separate Music Note block for every activation.",
    "",
  ];

  if (slice.startIndex === 0) {
    lines.push("1. Place a Button, Pilot Seat, or Car Seat and bind it to Delay 1.");
  } else if (slice.events.length) {
    const previousDelay = state.plan.events[slice.startIndex - 1].delays.at(-1).id;
    const firstDelay = slice.events[0].delays[0].id;
    lines.push(`1. Incoming transfer: Builder A binds Delay ${previousDelay} -> Delay ${firstDelay}.`);
  }

  slice.events.forEach((event, index) => {
    const source =
      event.id === 1 ? "Button / Seat" : `Delay ${state.plan.events[event.id - 2].delays.at(-1).id}`;
    const notes = event.notes.map(noteBlockLabel).join(", ");
    const nextDelay = state.plan.events[event.id]?.delays[0]?.id;
    const finalDelay = event.delays.at(-1);
    const connections = [
      `${source} -> Delay ${event.delays[0].id}`,
      ...event.delays.slice(0, -1).map((delay, delayIndex) =>
        `Delay ${delay.id} -> Delay ${event.delays[delayIndex + 1].id}`),
      ...event.notes.map((note) => `Delay ${finalDelay.id} -> ${noteBlockLabel(note)}`),
      ...(nextDelay ? [`Delay ${finalDelay.id} -> Delay ${nextDelay}`] : []),
    ];
    lines.push(
      `${index + 2}. ${delayTitleLabel(event.delays)} -> ${event.notes.map(compactNoteLabel).join(" + ")}\n   Set: ${delaySettingsLabel(event.delays)}\n   Bind: ${connections.join(" | ")}\n   Output: ${notes}${nextDelay ? `, then continue to Delay ${nextDelay}` : " (end of chain)"}`,
    );
  });

  return lines.join("\n");
}

function buildNotesText() {
  const slice = getBuilderSlice();
  const lines = [
    "BABFT MUSIC NOTE BLOCKS",
    `Section: ${slice.label}`,
    state.plan.saveBlocks
      ? "Place each block once. Reuse it by binding every matching Delay output to it."
      : "Reuse is off. This list follows the separate note blocks in the build steps.",
    "",
  ];
  for (const block of collectMusicBlocks(slice.events)) {
    lines.push(
      `Music Note ${block.id}: ${block.name} (${block.propertyClicks === 0 ? "default F#3" : `increment ${block.propertyClicks}× from F#3`}) | Used ${block.uses}x | First play ${formatSeconds(block.starts[0])}`,
    );
  }
  return lines.join("\n");
}

async function copyText(text, successMessage) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(successMessage);
  } catch {
    showToast("Clipboard access was blocked by the browser.");
  }
}

function setMultiplayerStatus(text, connected = false) {
  elements.multiplayerStatus.innerHTML = `<i></i> ${text}`;
  elements.multiplayerStatus.classList.toggle("connected", connected);
}

function encodeSignal(payload) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function decodeSignal(code) {
  const binary = atob(code.trim());
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function cleanupMultiplayer() {
  state.dataChannel?.close();
  state.peerConnection?.close();
  state.dataChannel = null;
  state.peerConnection = null;
  state.incomingChunks.clear();
  state.remoteBuildDone = false;
  state.remoteBuildPart = null;
  updateBuildProgress();
  setMultiplayerStatus("Offline");
}

function waitForIceGathering(peerConnection) {
  if (peerConnection.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = window.setTimeout(resolve, 2500);
    peerConnection.addEventListener("icegatheringstatechange", () => {
      if (peerConnection.iceGatheringState === "complete") {
        window.clearTimeout(timeout);
        resolve();
      }
    });
  });
}

function createLocalPeerConnection() {
  if (!("RTCPeerConnection" in window)) {
    throw new Error("This browser does not support WebRTC multiplayer.");
  }

  const peerConnection = new RTCPeerConnection({ iceServers: [] });
  peerConnection.ondatachannel = (event) => setupDataChannel(event.channel);
  peerConnection.onconnectionstatechange = () => {
    const stateName = peerConnection.connectionState;
    if (stateName === "connected") setMultiplayerStatus("Connected", true);
    if (["failed", "closed", "disconnected"].includes(stateName)) setMultiplayerStatus(stateName);
  };
  state.peerConnection = peerConnection;
  return peerConnection;
}

function setupDataChannel(channel) {
  state.dataChannel = channel;
  channel.onopen = () => {
    setMultiplayerStatus("Connected", true);
    elements.multiplayerHelp.textContent = "Connected. Use Sync MIDI for MIDI plans, or mark your build section done.";
    sendCurrentPlanToPeer();
    sendBuildStatusToPeer();
  };
  channel.onclose = () => setMultiplayerStatus("Closed");
  channel.onerror = () => setMultiplayerStatus("Error");
  channel.onmessage = (event) => handleMultiplayerMessage(event.data);
}

function sendMultiplayerMessage(payload) {
  const channel = state.dataChannel;
  if (!channel || channel.readyState !== "open") return false;

  const text = JSON.stringify(payload);
  if (text.length <= MULTIPLAYER_CHUNK_SIZE) {
    channel.send(text);
    return true;
  }

  const id = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const total = Math.ceil(text.length / MULTIPLAYER_CHUNK_SIZE);
  for (let index = 0; index < total; index += 1) {
    channel.send(JSON.stringify({
      type: "chunk",
      id,
      index,
      total,
      data: text.slice(index * MULTIPLAYER_CHUNK_SIZE, (index + 1) * MULTIPLAYER_CHUNK_SIZE),
    }));
  }
  return true;
}

function handleMultiplayerMessage(rawMessage) {
  let message;
  try {
    message = JSON.parse(rawMessage);
  } catch {
    return;
  }

  if (message.type === "chunk") {
    const chunks = state.incomingChunks.get(message.id) ?? [];
    chunks[message.index] = message.data;
    state.incomingChunks.set(message.id, chunks);
    if (chunks.filter(Boolean).length === message.total) {
      state.incomingChunks.delete(message.id);
      handleMultiplayerMessage(chunks.join(""));
    }
    return;
  }

  if (message.type === "plan") applyMultiplayerPlan(message);
  if (message.type === "play") previewPlan({ broadcast: false, delayMs: message.delayMs ?? 0 });
  if (message.type === "stop") stopPreview();
  if (message.type === "build-status") applyBuildStatus(message);
}

function currentPlanPayload() {
  if (!state.rawNotes.length) return null;
  return {
    type: "plan",
    sourceType: state.sourceType,
    convertedNotes: state.convertedNotes,
    analysisMeta: state.analysisMeta,
    settings: {
      startOffset: elements.startOffset.value,
      tempoScale: elements.tempoScale.value,
      mergeNotes: elements.mergeNotes.checked,
      reuseNotes: elements.reuseNotes.checked,
      builderPart: elements.builderPart.value,
    },
    notes: state.rawNotes.map((note) => ({
      m: note.midi,
      o: note.originalMidi,
      t: Number(note.sourceTime.toFixed(4)),
      d: Number((note.sourceDuration ?? 0).toFixed(4)),
      v: Number((note.velocity ?? 0.8).toFixed(3)),
      c: Boolean(note.wasConverted),
    })),
  };
}

function sendCurrentPlanToPeer() {
  const payload = currentPlanPayload();
  if (!payload) return false;
  return sendMultiplayerMessage(payload);
}

function applyMultiplayerPlan(message) {
  stopPreview();
  state.file = null;
  state.sourceType = message.sourceType ?? "multiplayer";
  state.analysisMeta = message.analysisMeta ?? null;
  state.convertedNotes = message.convertedNotes ?? 0;
  state.rawNotes = message.notes.map((note) => ({
    midi: note.m,
    originalMidi: note.o ?? note.m,
    originalName: midiToName(note.o ?? note.m),
    wasConverted: Boolean(note.c),
    sourceTime: note.t,
    sourceDuration: note.d,
    velocity: note.v,
  }));

  elements.startOffset.value = message.settings?.startOffset ?? elements.startOffset.value;
  elements.tempoScale.value = message.settings?.tempoScale ?? elements.tempoScale.value;
  elements.mergeNotes.checked = message.settings?.mergeNotes ?? elements.mergeNotes.checked;
  elements.reuseNotes.checked = message.settings?.reuseNotes ?? elements.reuseNotes.checked;
  elements.builderPart.value = message.settings?.builderPart ?? elements.builderPart.value;
  elements.startOffsetOutput.value = formatSeconds(Number(elements.startOffset.value));
  elements.tempoScaleOutput.value = `${elements.tempoScale.value}%`;
  elements.fileName.textContent = "Shared multiplayer song";
  elements.fileMeta.textContent = `${state.rawNotes.length.toLocaleString()} notes synced over LAN · no file uploaded`;
  elements.fileCard.classList.remove("hidden");
  elements.dropZone.classList.add("hidden");
  renderPlan();
  showToast("Multiplayer song synced.");
}

async function hostMultiplayerRoom() {
  try {
    cleanupMultiplayer();
    const peerConnection = createLocalPeerConnection();
    setupDataChannel(peerConnection.createDataChannel("babft-sync", { ordered: true }));
    await peerConnection.setLocalDescription(await peerConnection.createOffer());
    await waitForIceGathering(peerConnection);
    elements.multiplayerCode.value = encodeSignal({
      kind: "babft-lan-offer",
      description: peerConnection.localDescription,
    });
    elements.multiplayerHelp.textContent = "Send this invite to your friend. When they send an answer back, paste it and click Use answer.";
    setMultiplayerStatus("Invite ready");
  } catch (error) {
    console.error(error);
    showToast(error.message || "Could not create multiplayer invite.");
  }
}

async function joinMultiplayerRoom() {
  try {
    cleanupMultiplayer();
    const signal = decodeSignal(elements.multiplayerCode.value);
    if (signal.kind !== "babft-lan-offer") throw new Error("Paste a host invite code first.");
    const peerConnection = createLocalPeerConnection();
    await peerConnection.setRemoteDescription(signal.description);
    await peerConnection.setLocalDescription(await peerConnection.createAnswer());
    await waitForIceGathering(peerConnection);
    elements.multiplayerCode.value = encodeSignal({
      kind: "babft-lan-answer",
      description: peerConnection.localDescription,
    });
    elements.multiplayerHelp.textContent = "Send this answer back to the host. Keep this page open.";
    setMultiplayerStatus("Answer ready");
  } catch (error) {
    console.error(error);
    showToast(error.message || "Could not join that invite.");
  }
}

async function connectMultiplayerAnswer() {
  try {
    if (!state.peerConnection) throw new Error("Create a host invite first.");
    const signal = decodeSignal(elements.multiplayerCode.value);
    if (signal.kind !== "babft-lan-answer") throw new Error("Paste your friend's answer code first.");
    await state.peerConnection.setRemoteDescription(signal.description);
    elements.multiplayerHelp.textContent = "Connecting. If it fails, confirm both players are on the same WiFi or Radmin VPN.";
    setMultiplayerStatus("Connecting");
  } catch (error) {
    console.error(error);
    showToast(error.message || "Could not use that answer.");
  }
}

function syncMultiplayerSong() {
  if (!state.dataChannel || state.dataChannel.readyState !== "open") {
    showToast("Connect multiplayer first.");
    return;
  }
  if (!sendCurrentPlanToPeer()) {
    showToast("Load a MIDI before syncing.");
    return;
  }
  showToast("MIDI plan sent to connected friend.");
}

function updateBuildProgress() {
  const localLabel = state.localBuildDone ? "You: done" : "You: not done";
  const remotePart = state.remoteBuildPart && state.remoteBuildPart !== "all"
    ? ` (${state.remoteBuildPart === "first" ? "first half" : "second half"})`
    : "";
  const remoteLabel = state.remoteBuildDone ? `Friend: done${remotePart}` : "Friend: not done";

  elements.myBuildStatus.textContent = localLabel;
  elements.friendBuildStatus.textContent = remoteLabel;
  elements.myBuildStatus.classList.toggle("done", state.localBuildDone);
  elements.friendBuildStatus.classList.toggle("done", state.remoteBuildDone);
  elements.markBuildDone.classList.toggle("done", state.localBuildDone);
  elements.markBuildDone.textContent = state.localBuildDone ? "Part marked done" : "Mark my part done";
}

function sendBuildStatusToPeer() {
  return sendMultiplayerMessage({
    type: "build-status",
    done: state.localBuildDone,
    part: elements.builderPart.value,
  });
}

function setLocalBuildDone(done, broadcast = true) {
  state.localBuildDone = done;
  updateBuildProgress();
  if (broadcast) sendBuildStatusToPeer();
  showToast(done ? "Your part is marked done." : "Your done status was reset.");
}

function applyBuildStatus(message) {
  state.remoteBuildDone = Boolean(message.done);
  state.remoteBuildPart = message.part ?? null;
  updateBuildProgress();
  if (state.remoteBuildDone) {
    showToast("Your friend marked their part done.");
  }
}

async function handleMidi(file) {
  if (!file) return;
  const fileName = file.name.toLowerCase();
  if (!/\.midi?$/.test(fileName) && !file.type.includes("midi")) {
    showToast("Please choose a .mid or .midi file.");
    return;
  }
  if (file.size > MAX_MIDI_SIZE) {
    showToast("That MIDI is over 25 MB. Choose a smaller file to protect browser memory.");
    return;
  }

  stopPreview();
  state.localBuildDone = false;
  state.remoteBuildDone = false;
  state.remoteBuildPart = null;
  updateBuildProgress();
  showLoading("Reading your MIDI…", "The file stays in this browser tab and is never uploaded.");
  await new Promise((resolve) => window.setTimeout(resolve, 80));

  try {
    const buffer = await file.arrayBuffer();
    const midi = new Midi(buffer);
    let skippedPercussionNotes = 0;
    const allNotes = [];

    for (const track of midi.tracks) {
      if (isPercussionTrack(track)) {
        skippedPercussionNotes += track.notes.length;
        continue;
      }

      track.notes.forEach((note) => allNotes.push(createMidiNote(note)));
    }

    if (!allNotes.length) {
      if (skippedPercussionNotes) {
        throw new Error("This MIDI only has drum notes. BABFT Music Notes need pitched notes.");
      }
      throw new Error("This MIDI does not contain any notes.");
    }

    state.file = file;
    state.rawNotes = allNotes;
    state.convertedNotes = allNotes.filter((note) => note.wasConverted).length;
    state.sourceType = "midi";
    state.analysisMeta = {
      skippedPercussionNotes,
    };
    elements.fileName.textContent = file.name;
    elements.fileMeta.textContent = `${formatFileSize(file.size)} · ${allNotes.length.toLocaleString()} notes ready · local only`;
    elements.fileCard.classList.remove("hidden");
    elements.dropZone.classList.add("hidden");
    renderPlan();
    showToast("MIDI converted locally. Nothing was uploaded.");
  } catch (error) {
    console.error(error);
    showToast(error.message || "That MIDI could not be read.");
  } finally {
    hideLoading();
  }
}

function handleFile(file) {
  if (!file) return;
  const fileName = file.name.toLowerCase();
  const isMidi = /\.midi?$/.test(fileName) || file.type.includes("midi");

  if (isMidi) {
    handleMidi(file);
    return;
  }

  showToast("Please choose a .mid or .midi file.");
}

function removeMidi() {
  stopPreview();
  state.file = null;
  state.rawNotes = [];
  state.convertedNotes = 0;
  state.sourceType = null;
  state.analysisMeta = null;
  state.plan = null;
  state.localBuildDone = false;
  state.remoteBuildDone = false;
  state.remoteBuildPart = null;
  elements.midiFile.value = "";
  elements.fileCard.classList.add("hidden");
  elements.dropZone.classList.remove("hidden");
  elements.resultsContent.classList.add("hidden");
  elements.emptyState.classList.remove("hidden");
  elements.previewButton.disabled = true;
  elements.stopButton.disabled = true;
  updateBuildProgress();
  updateBuilderPartHint();
  updateBlockSaveSummary();
  showToast("MIDI removed from browser memory.");
}

async function ensureSynth() {
  if (state.synth) {
    await state.audioContext.resume();
    return state.synth;
  }

  if (!state.synthPromise) {
    state.synthPromise = (async () => {
      state.audioContext = new AudioContext();
      await state.audioContext.audioWorklet.addModule("/spessasynth_processor.min.js");
      const synth = new WorkletSynthesizer(state.audioContext);
      const gain = state.audioContext.createGain();
      const compressor = state.audioContext.createDynamicsCompressor();
      gain.gain.value = Number(elements.previewVolume.value) / 100;
      compressor.threshold.value = -5;
      compressor.knee.value = 10;
      compressor.ratio.value = 5;
      compressor.attack.value = 0.003;
      compressor.release.value = 0.2;
      synth.connect(gain);
      gain.connect(compressor);
      compressor.connect(state.audioContext.destination);
      state.outputGain = gain;

      const soundFont = await fetch("/babft-sf.sf2").then((response) => {
        if (!response.ok) throw new Error("BABFT SoundFont could not be loaded.");
        return response.arrayBuffer();
      });
      await synth.soundBankManager.addSoundBank(soundFont, "babft");
      await synth.isReady;
      for (let channel = 0; channel < 16; channel += 1) {
        synth.programChange(channel, 0);
      }
      state.synth = synth;
      return synth;
    })().catch((error) => {
      state.synthPromise = null;
      throw error;
    });
  }

  const synth = await state.synthPromise;
  await state.audioContext.resume();
  return synth;
}

function clearHighlights() {
  state.highlightTimers.forEach((timer) => window.clearTimeout(timer));
  state.highlightTimers = [];
  document.querySelectorAll(".timeline-event.playing").forEach((row) => row.classList.remove("playing"));
  document.querySelectorAll(".piano-key.active").forEach((key) => key.classList.remove("active"));
  resetPianoRoll();
}

function clearAudioTimers() {
  state.audioTimers.forEach((timer) => window.clearTimeout(timer));
  state.audioTimers = [];
}

function setPlaybackButtons(isPlaying) {
  elements.previewButton.classList.toggle("playing", isPlaying);
  elements.previewButton.innerHTML = isPlaying ? "<span>■</span> Stop" : "<span>▶</span> Preview";
  elements.stopButton.disabled = !isPlaying;
}

function stopPreview({ broadcast = false } = {}) {
  window.clearTimeout(state.stopTimer);
  state.stopTimer = null;
  state.previewStartedAt = null;
  clearAudioTimers();
  state.synth?.stopAll(true);
  clearHighlights();
  setPlaybackButtons(false);
  if (broadcast) sendMultiplayerMessage({ type: "stop" });
}

async function previewPlan({ broadcast = true, delayMs = 0 } = {}) {
  if (!state.plan) return;
  if (state.stopTimer) {
    stopPreview({ broadcast });
    return;
  }

  showLoading("Loading the BABFT SoundFont…", "Preview audio is generated on this device.");
  try {
    const synth = await ensureSynth();
    if (broadcast && state.dataChannel?.readyState === "open") {
      sendCurrentPlanToPeer();
      sendMultiplayerMessage({ type: "play", delayMs: 500 });
      await sleep(500);
    } else if (delayMs > 0) {
      await sleep(delayMs);
    }
    stopPreview();
    setPlaybackButtons(true);
    state.previewStartedAt = performance.now();
    startPianoRoll();

    state.plan.events.forEach((event) => {
      state.audioTimers.push(
        window.setTimeout(() => {
          event.notes.forEach((note) => {
            const channel = (note.id - 1) % 16;
            const velocity = Math.max(48, Math.round(note.velocity * 127));
            synth.noteOn(channel, note.midi, velocity);
            setRollKeyActive(note.midi, true);
          });
          state.audioTimers.push(
            window.setTimeout(() => {
              event.notes.forEach((note) => {
                const channel = (note.id - 1) % 16;
                synth.noteOff(channel, note.midi);
                setRollKeyActive(note.midi, false);
              });
            }, NOTE_SUSTAIN * 1000),
          );
        }, event.plannedTime * 1000),
      );

      const row = elements.timeline.querySelector(`[data-event-id="${event.id}"]`);
      if (row) {
        state.highlightTimers.push(
          window.setTimeout(() => {
            document.querySelectorAll(".timeline-event.playing").forEach((active) => active.classList.remove("playing"));
            row.classList.add("playing");
            followTimelineRow(row);
          }, event.plannedTime * 1000),
        );
      }
    });

    state.stopTimer = window.setTimeout(() => {
      stopPreview();
      showToast("Preview finished.");
    }, (state.plan.duration + 0.3) * 1000);
  } catch (error) {
    console.error(error);
    showToast("The SoundFont preview could not start in this browser.");
    stopPreview();
  } finally {
    hideLoading();
  }
}

async function playKeyboardNote(midi, key) {
  showLoading("Loading the BABFT SoundFont…", "The sound is generated on this device.");
  try {
    const synth = await ensureSynth();
    const channel = midi % 16;
    const now = state.audioContext.currentTime + 0.03;
    synth.noteOn(channel, midi, 110, { time: now });
    synth.noteOff(channel, midi, { time: now + NOTE_SUSTAIN });
    key.classList.add("active");
    window.setTimeout(() => key.classList.remove("active"), NOTE_SUSTAIN * 1000);
  } catch (error) {
    console.error(error);
    showToast("The SoundFont preview could not start in this browser.");
  } finally {
    hideLoading();
  }
}

function renderKeyboard() {
  const fragment = document.createDocumentFragment();
  for (let midi = MIN_NOTE; midi <= MAX_NOTE; midi += 1) {
    const name = midiToName(midi);
    const key = document.createElement("button");
    key.type = "button";
    key.className = `piano-key${name.includes("#") ? " sharp" : ""}`;
    key.dataset.midi = midi;
    key.textContent = name;
    key.title = `${name} · ${midi - MIN_NOTE === 0 ? "default key" : `increment ${midi - MIN_NOTE} times from F#3`}`;
    key.addEventListener("click", () => playKeyboardNote(midi, key));
    fragment.append(key);
  }
  elements.keyboard.replaceChildren(fragment);
}

function setupScrollReveal() {
  const targets = document.querySelectorAll(
    ".hero-copy, .hero-visual, .section-heading, .workspace, .guide-grid article, .notes-copy, .keyboard-card",
  );
  targets.forEach((target) => target.classList.add("reveal"));

  if (!("IntersectionObserver" in window) || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    targets.forEach((target) => target.classList.add("visible"));
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("visible");
        observer.unobserve(entry.target);
      });
    },
    { threshold: 0.14, rootMargin: "0px 0px -8% 0px" },
  );

  targets.forEach((target) => observer.observe(target));
}

function rerenderFromSettings() {
  elements.startOffsetOutput.value = formatSeconds(Number(elements.startOffset.value));
  elements.tempoScaleOutput.value = `${elements.tempoScale.value}%`;
  stopPreview();
  if (state.rawNotes.length) {
    renderPlan();
  } else {
    updateBlockSaveSummary();
  }
}

function handleBuilderPartChange() {
  stopPreview();
  if (state.plan) {
    renderInstructions();
    renderNoteTable();
  }
  updateBuilderPartHint();
  sendBuildStatusToPeer();
}

function activateView(button) {
  document.querySelectorAll(".view-tabs button").forEach((tab) => {
    const active = tab === button;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  });

  document.querySelectorAll(".view-panel").forEach((panel) => panel.classList.remove("active"));
  document.querySelector(`#${button.dataset.view}View`).classList.add("active");

  if (button.dataset.view === "piano" && state.previewStartedAt !== null) {
    const elapsed = (performance.now() - state.previewStartedAt) / 1000;
    window.requestAnimationFrame(() => startPianoRoll(elapsed));
  }

  if (button.dataset.view === "timeline" && elements.autoFollow.checked) {
    const activeRow = elements.timeline.querySelector(".timeline-event.playing");
    if (activeRow) window.requestAnimationFrame(() => followTimelineRow(activeRow));
  }
}

elements.midiFile.addEventListener("change", (event) => handleFile(event.target.files[0]));
elements.removeFile.addEventListener("click", removeMidi);
elements.previewButton.addEventListener("click", previewPlan);
elements.stopButton.addEventListener("click", () => stopPreview({ broadcast: true }));
elements.copyInstructions.addEventListener("click", () =>
  copyText(buildInstructionsText(), "Build steps copied."),
);
elements.copyNotes.addEventListener("click", () => copyText(buildNotesText(), "Music Note list copied."));
elements.startOffset.addEventListener("input", rerenderFromSettings);
elements.tempoScale.addEventListener("input", rerenderFromSettings);
elements.previewVolume.addEventListener("input", updatePreviewVolume);
elements.mergeNotes.addEventListener("change", rerenderFromSettings);
elements.reuseNotes.addEventListener("change", rerenderFromSettings);
elements.builderPart.addEventListener("change", handleBuilderPartChange);
elements.hostRoom.addEventListener("click", hostMultiplayerRoom);
elements.joinRoom.addEventListener("click", joinMultiplayerRoom);
elements.connectAnswer.addEventListener("click", connectMultiplayerAnswer);
elements.syncMultiplayer.addEventListener("click", syncMultiplayerSong);
elements.markBuildDone.addEventListener("click", () => setLocalBuildDone(true));
elements.resetBuildDone.addEventListener("click", () => setLocalBuildDone(false));

document.querySelectorAll(".view-tabs button").forEach((button) => {
  button.addEventListener("click", () => activateView(button));
});

["dragenter", "dragover"].forEach((eventName) => {
  elements.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropZone.classList.add("dragging");
  });
});

["dragleave", "drop"].forEach((eventName) => {
  elements.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropZone.classList.remove("dragging");
  });
});

elements.dropZone.addEventListener("drop", (event) => handleFile(event.dataTransfer.files[0]));
window.addEventListener("beforeunload", stopPreview);

renderKeyboard();
setupScrollReveal();
updateBuildProgress();
updateBuilderPartHint();
updateBlockSaveSummary();
updatePreviewVolume();
rerenderFromSettings();
