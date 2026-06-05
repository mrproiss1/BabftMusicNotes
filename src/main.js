import { Midi } from "@tonejs/midi";
import { WorkletSynthesizer } from "spessasynth_lib";
import "./styles.css";

const MIN_NOTE = 54; // F#3
const MAX_NOTE = 78; // F#5
const MIN_DELAY = 0.05;
const MAX_DELAY = 10;
const NOTE_SUSTAIN = 0.85;
const MAX_MIDI_SIZE = 25 * 1024 * 1024;
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
  mergeNotes: document.querySelector("#mergeNotes"),
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
  plan: null,
  synth: null,
  synthPromise: null,
  audioContext: null,
  outputGain: null,
  stopTimer: null,
  audioTimers: [],
  highlightTimers: [],
  toastTimer: null,
};

function midiToName(midi) {
  return `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
}

function foldIntoPlayableRange(midi) {
  let foldedMidi = midi;

  while (foldedMidi < MIN_NOTE) foldedMidi += 12;
  while (foldedMidi > MAX_NOTE) foldedMidi -= 12;

  return foldedMidi;
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
  let adjustedGaps = 0;

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
        id: nextMusicBlockId++,
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

  return {
    events,
    speed,
    adjustedGaps,
    noteCount: events.reduce((total, event) => total + event.notes.length, 0),
    delayCount: nextDelayId - 1,
    duration: plannedTime + NOTE_SUSTAIN,
  };
}

function renderPlan() {
  state.plan = createPlan();
  if (!state.plan) return;

  const { plan } = state;
  elements.statNotes.textContent = plan.noteCount.toLocaleString();
  elements.statBlocks.textContent = plan.noteCount.toLocaleString();
  elements.statDelays.textContent = plan.delayCount.toLocaleString();
  elements.statDuration.textContent = formatClock(plan.duration);

  const notices = [];
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

  elements.planNotice.textContent = notices.join(" ");
  elements.planNotice.classList.toggle("hidden", notices.length === 0);
  renderTimeline();
  renderInstructions();
  renderNoteTable();
  elements.emptyState.classList.add("hidden");
  elements.resultsContent.classList.remove("hidden");
  elements.previewButton.disabled = false;
  elements.stopButton.disabled = true;
}

function renderTimeline() {
  const displayEvents = state.plan.events.slice(0, 250);
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
      chip.innerHTML = `<i></i> Note ${note.id} · ${note.name}`;
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

  if (state.plan.events.length > displayEvents.length) {
    const message = document.createElement("div");
    message.className = "notice";
    message.textContent = `Timeline preview is showing the first ${displayEvents.length} activations. All activations are still included in Build steps and Note list.`;
    fragment.append(message);
  }

  elements.timeline.replaceChildren(fragment);
}

function delayRangeLabel(delays) {
  if (delays.length === 1) return `Delay ${delays[0].id}`;
  return `Delays ${delays[0].id}–${delays.at(-1).id}`;
}

function delaySettingsLabel(delays) {
  return delays.map((delay) => `${delay.id}: ${formatSeconds(delay.duration)}`).join(", ");
}

function renderInstructions() {
  const fragment = document.createDocumentFragment();

  const trigger = document.createElement("li");
  trigger.innerHTML =
    "<div><strong>Place your trigger seat</strong><span>Place a Pilot Seat or Car Seat. Bind it to Delay 1. Any seat input can activate it, so choose your trigger key carefully.</span></div>";
  fragment.append(trigger);

  for (const event of state.plan.events) {
    const item = document.createElement("li");
    const source =
      event.id === 1
        ? "the seat"
        : `Delay ${state.plan.events[event.id - 2].delays.at(-1).id}`;
    const noteLabels = event.notes
      .map((note) => `Music Note ${note.id} (${note.name})`)
      .join(", ");
    const next = state.plan.events[event.id]?.delays[0]?.id;
    const nextText = next ? ` Also bind it to Delay ${next} to continue the chain.` : " This is the end of the chain.";

    item.innerHTML = `<div><strong>${delayRangeLabel(event.delays)} → ${event.notes.map((note) => note.name).join(" + ")}</strong><span>Bind ${source} through ${delayRangeLabel(event.delays)}. Set ${delaySettingsLabel(event.delays)}. Bind the final Delay to ${noteLabels}.${nextText}</span></div>`;
    fragment.append(item);
  }

  elements.instructionList.replaceChildren(fragment);
}

function renderNoteTable() {
  const fragment = document.createDocumentFragment();

  for (const event of state.plan.events) {
    for (const note of event.notes) {
      const row = document.createElement("tr");
      row.innerHTML = `
        <td>${note.id}</td>
        <td>${formatSeconds(event.plannedTime)}</td>
        <td>${note.wasConverted ? `${note.name} (from ${note.originalName})` : note.name}</td>
        <td>${note.propertyClicks === 0 ? "Default F#3" : `+${note.propertyClicks} from F#3`}</td>
        <td>~${NOTE_SUSTAIN.toFixed(2)}s</td>
      `;
      fragment.append(row);
    }
  }

  elements.noteTableBody.replaceChildren(fragment);
}

function buildInstructionsText() {
  const lines = [
    "BABFT MUSIC BUILD PLAN",
    `Playable notes: ${state.plan.noteCount} | Delay blocks: ${state.plan.delayCount} | Length: ${formatClock(state.plan.duration)}`,
    "",
    "1. Place a Pilot Seat or Car Seat and bind it to Delay 1.",
  ];

  state.plan.events.forEach((event, index) => {
    const source =
      index === 0 ? "seat" : `Delay ${state.plan.events[index - 1].delays.at(-1).id}`;
    const notes = event.notes.map((note) => `Music Note ${note.id} (${note.name})`).join(", ");
    const nextDelay = state.plan.events[index + 1]?.delays[0]?.id;
    lines.push(
      `${index + 2}. Bind ${source} through ${delayRangeLabel(event.delays)} [${delaySettingsLabel(event.delays)}]. Bind the final Delay to ${notes}.${nextDelay ? ` Also bind it to Delay ${nextDelay}.` : ""}`,
    );
  });

  return lines.join("\n");
}

function buildNotesText() {
  const lines = ["BABFT MUSIC NOTE BLOCKS", ""];
  for (const event of state.plan.events) {
    for (const note of event.notes) {
      lines.push(
        `Music Note ${note.id}: ${note.name}${note.wasConverted ? ` (converted from ${note.originalName})` : ""} at ${formatSeconds(event.plannedTime)} (${note.propertyClicks === 0 ? "default F#3" : `increment ${note.propertyClicks}× from F#3`})`,
      );
    }
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

async function handleMidi(file) {
  if (!file) return;
  if (!/\.midi?$/i.test(file.name)) {
    showToast("Please choose a .mid or .midi file.");
    return;
  }
  if (file.size > MAX_MIDI_SIZE) {
    showToast("That MIDI is over 25 MB. Choose a smaller file to protect browser memory.");
    return;
  }

  stopPreview();
  showLoading("Reading your MIDI…", "The file stays in this browser tab and is never uploaded.");
  await new Promise((resolve) => window.setTimeout(resolve, 80));

  try {
    const buffer = await file.arrayBuffer();
    const midi = new Midi(buffer);
    const allNotes = midi.tracks.flatMap((track) =>
      track.notes.map((note) => {
        const foldedMidi = foldIntoPlayableRange(note.midi);
        return {
          midi: foldedMidi,
          originalMidi: note.midi,
          originalName: midiToName(note.midi),
          wasConverted: foldedMidi !== note.midi,
          sourceTime: note.time,
          sourceDuration: note.duration,
          velocity: note.velocity,
        };
      }),
    );

    if (!allNotes.length) throw new Error("This MIDI does not contain any notes.");

    state.file = file;
    state.rawNotes = allNotes;
    state.convertedNotes = allNotes.filter((note) => note.wasConverted).length;
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

function removeMidi() {
  stopPreview();
  state.file = null;
  state.rawNotes = [];
  state.convertedNotes = 0;
  state.plan = null;
  elements.midiFile.value = "";
  elements.fileCard.classList.add("hidden");
  elements.dropZone.classList.remove("hidden");
  elements.resultsContent.classList.add("hidden");
  elements.emptyState.classList.remove("hidden");
  elements.previewButton.disabled = true;
  elements.stopButton.disabled = true;
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

function stopPreview() {
  window.clearTimeout(state.stopTimer);
  state.stopTimer = null;
  clearAudioTimers();
  state.synth?.stopAll(true);
  clearHighlights();
  setPlaybackButtons(false);
}

async function previewPlan() {
  if (!state.plan) return;
  if (state.stopTimer) {
    stopPreview();
    return;
  }

  showLoading("Loading the BABFT SoundFont…", "Preview audio is generated on this device.");
  try {
    const synth = await ensureSynth();
    stopPreview();
    setPlaybackButtons(true);

    state.plan.events.forEach((event) => {
      state.audioTimers.push(
        window.setTimeout(() => {
          event.notes.forEach((note) => {
            const channel = (note.id - 1) % 16;
            const velocity = Math.max(48, Math.round(note.velocity * 127));
            synth.noteOn(channel, note.midi, velocity);
          });
          state.audioTimers.push(
            window.setTimeout(() => {
              event.notes.forEach((note) => {
                const channel = (note.id - 1) % 16;
                synth.noteOff(channel, note.midi);
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
    key.textContent = name;
    key.title = `${name} · ${midi - MIN_NOTE === 0 ? "default key" : `increment ${midi - MIN_NOTE} times from F#3`}`;
    key.addEventListener("click", () => playKeyboardNote(midi, key));
    fragment.append(key);
  }
  elements.keyboard.replaceChildren(fragment);
}

function rerenderFromSettings() {
  elements.startOffsetOutput.value = formatSeconds(Number(elements.startOffset.value));
  elements.tempoScaleOutput.value = `${elements.tempoScale.value}%`;
  stopPreview();
  if (state.rawNotes.length) renderPlan();
}

function activateView(button) {
  document.querySelectorAll(".view-tabs button").forEach((tab) => {
    const active = tab === button;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  });

  document.querySelectorAll(".view-panel").forEach((panel) => panel.classList.remove("active"));
  document.querySelector(`#${button.dataset.view}View`).classList.add("active");
}

elements.midiFile.addEventListener("change", (event) => handleMidi(event.target.files[0]));
elements.removeFile.addEventListener("click", removeMidi);
elements.previewButton.addEventListener("click", previewPlan);
elements.stopButton.addEventListener("click", stopPreview);
elements.copyInstructions.addEventListener("click", () =>
  copyText(buildInstructionsText(), "Build steps copied."),
);
elements.copyNotes.addEventListener("click", () => copyText(buildNotesText(), "Music Note list copied."));
elements.startOffset.addEventListener("input", rerenderFromSettings);
elements.tempoScale.addEventListener("input", rerenderFromSettings);
elements.previewVolume.addEventListener("input", updatePreviewVolume);
elements.mergeNotes.addEventListener("change", rerenderFromSettings);

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

elements.dropZone.addEventListener("drop", (event) => handleMidi(event.dataTransfer.files[0]));
window.addEventListener("beforeunload", stopPreview);

renderKeyboard();
updatePreviewVolume();
rerenderFromSettings();
