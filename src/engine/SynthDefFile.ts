/**
 * SynthDefFile — the one place that reads and checks SuperCollider SynthDef files (SCgf).
 *
 * Why this exists (#622): `load_synthdef` lets user code hand the audio server any
 * SynthDef bytes. The server is a safety net, not a validator — measured against the live
 * WASM scsynth, it refuses unknown/unsupported UGens and malformed files with `/fail`, but it
 * ACCEPTS a graph whose input points at a UGen that does not exist (`/done`). So every byte
 * that reaches `/d_recv` from user code passes through `checkSynthDefFile` first.
 *
 * Format reference: SuperCollider "Synth Definition File Format"
 * (https://doc.sccode.org/Reference/Synth-Definition-File-Format.html). Big-endian; version 1
 * stores counts and input indices as int16, version 2 as int32. The encoder twin of this
 * decoder is `buildTrackMonitorSynthDef.ts` (v1, hand-written).
 */

export interface SynthDefUGen {
  name: string
  /** 0 = scalar (ir), 1 = control (kr), 2 = audio (ar), 3 = demand (dr) */
  rate: number
  /** [source UGen index, output index], or [-1, constant index] */
  inputs: Array<[number, number]>
  outputRates: number[]
  special: number
}

export interface SynthDefGraph {
  name: string
  constants: number[]
  params: number[]
  paramNames: Array<{ name: string; index: number }>
  ugens: SynthDefUGen[]
  variants: number
}

export interface SynthDefFile {
  version: number
  defs: SynthDefGraph[]
  byteLength: number
}

export class SynthDefFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SynthDefFormatError'
  }
}

/** Decode an SCgf file. Throws SynthDefFormatError on anything malformed (never reads past the end). */
export function decodeSynthDefFile(input: Uint8Array | ArrayBuffer): SynthDefFile {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let o = 0
  const need = (n: number, what: string) => {
    if (o + n > bytes.byteLength) {
      throw new SynthDefFormatError(`file ends early while reading ${what} (byte ${o} of ${bytes.byteLength})`)
    }
  }
  const i8 = (what: string) => { need(1, what); const v = view.getInt8(o); o += 1; return v }
  const u8 = (what: string) => { need(1, what); const v = view.getUint8(o); o += 1; return v }
  const i16 = (what: string) => { need(2, what); const v = view.getInt16(o, false); o += 2; return v }
  const i32 = (what: string) => { need(4, what); const v = view.getInt32(o, false); o += 4; return v }
  const f32 = (what: string) => { need(4, what); const v = view.getFloat32(o, false); o += 4; return v }
  const pstr = (what: string) => {
    const n = u8(what)
    need(n, what)
    let s = ''
    for (let k = 0; k < n; k++) s += String.fromCharCode(bytes[o + k])
    o += n
    return s
  }
  const count = (n: number, what: string) => {
    if (n < 0) throw new SynthDefFormatError(`negative ${what} count (${n})`)
    // Every counted item takes at least one byte, so a count larger than what's left is corrupt.
    if (n > bytes.byteLength - o) throw new SynthDefFormatError(`${what} count ${n} is larger than the rest of the file`)
    return n
  }

  need(4, 'header')
  if (bytes[0] !== 0x53 || bytes[1] !== 0x43 || bytes[2] !== 0x67 || bytes[3] !== 0x66) {
    throw new SynthDefFormatError('not a SynthDef file (missing "SCgf" header)')
  }
  o = 4
  const version = i32('version')
  if (version !== 1 && version !== 2) throw new SynthDefFormatError(`unsupported SynthDef file version ${version}`)
  const int = version === 1 ? i16 : i32
  const numDefs = count(i16('SynthDef count'), 'SynthDef')
  if (numDefs === 0) throw new SynthDefFormatError('file contains no SynthDefs')

  const defs: SynthDefGraph[] = []
  for (let d = 0; d < numDefs; d++) {
    const name = pstr('SynthDef name')
    const constants: number[] = []
    for (let k = count(int('constant count'), 'constant'); k > 0; k--) constants.push(f32('constant'))
    const params: number[] = []
    for (let k = count(int('parameter count'), 'parameter'); k > 0; k--) params.push(f32('parameter default'))
    const paramNames: Array<{ name: string; index: number }> = []
    for (let k = count(int('parameter name count'), 'parameter name'); k > 0; k--) {
      paramNames.push({ name: pstr('parameter name'), index: int('parameter index') })
    }
    const ugens: SynthDefUGen[] = []
    for (let k = count(int('UGen count'), 'UGen'); k > 0; k--) {
      const uname = pstr('UGen name')
      const rate = i8('UGen rate')
      const numIn = count(int('UGen input count'), 'UGen input')
      const numOut = count(int('UGen output count'), 'UGen output')
      const special = i16('UGen special index')
      const inputs: Array<[number, number]> = []
      for (let j = 0; j < numIn; j++) inputs.push([int('input source'), int('input index')])
      const outputRates: number[] = []
      for (let j = 0; j < numOut; j++) outputRates.push(i8('output rate'))
      ugens.push({ name: uname, rate, inputs, outputRates, special })
    }
    const numVariants = count(i16('variant count'), 'variant')
    for (let v = 0; v < numVariants; v++) {
      pstr('variant name')
      for (let k = 0; k < params.length; k++) f32('variant value')
    }
    defs.push({ name, constants, params, paramNames, ugens, variants: numVariants })
  }
  if (o !== bytes.byteLength) {
    throw new SynthDefFormatError(`${bytes.byteLength - o} unexpected bytes after the last SynthDef`)
  }
  return { version, defs, byteLength: bytes.byteLength }
}

/**
 * UGens SuperSonic (scsynth in an AudioWorklet) does not ship, from SuperSonic's
 * docs/SCSYNTH_DIFFERENCES.md "Unsupported UGen List": UI (no DOM in the worklet), disk I/O (no
 * filesystem), Ableton Link (no sockets), Bela hardware, and the machine-listening set.
 * The server refuses these with `/fail … not installed`; we refuse them before sending so the
 * message can name the synth and the reason.
 */
export const BROWSER_UNSUPPORTED_UGENS: ReadonlyMap<string, string> = new Map([
  ...['MouseX', 'MouseY', 'MouseButton', 'KeyState'].map((n) => [n, 'needs the mouse or keyboard, which the audio thread cannot see'] as const),
  ...['DiskIn', 'DiskOut', 'VDiskIn'].map((n) => [n, 'reads or writes files, and the browser audio thread has no file system'] as const),
  ...['LinkJump', 'LinkPhase', 'LinkTempo'].map((n) => [n, 'needs Ableton Link (network sockets)'] as const),
  ...['AnalogIn', 'AnalogOut', 'DigitalIn', 'DigitalIO', 'DigitalOut', 'MultiplexAnalogIn', 'BelaScopeOut'].map((n) => [n, 'is for Bela hardware'] as const),
  ...['BeatTrack', 'BeatTrack2', 'KeyTrack', 'Loudness', 'MFCC', 'Onsets', 'SpecCentroid', 'SpecFlatness', 'SpecPcile'].map((n) => [n, 'is not built into the browser engine'] as const),
])

/** UGens that write the synth's sound somewhere. A graph with none of these is silent. */
const OUTPUT_UGENS = new Set(['Out', 'OffsetOut', 'ReplaceOut', 'XOut'])

/**
 * UGens whose `doneAction` input can free the synth, and that input's position in the
 * graph's input list (mul/add are separate UGens, so they don't count):
 *   EnvGen(gate, levelScale, levelBias, timeScale, doneAction, …envelope)
 *   Line/XLine(start, end, dur, doneAction)
 *   Linen(gate, attackTime, susLevel, releaseTime, doneAction)
 *   DetectSilence(in, amp, time, doneAction)
 * FreeSelf / FreeSelfWhenDone free unconditionally when triggered or done.
 */
const DONE_ACTION_INPUT: ReadonlyMap<string, number> = new Map([
  ['EnvGen', 4], ['Line', 3], ['XLine', 3], ['Linen', 4], ['DetectSilence', 3],
])
const ALWAYS_FREES = new Set(['FreeSelf', 'FreeSelfWhenDone'])

/** Names under this prefix belong to Sonic Pi's built-in library; a user file may not replace them. */
export const RESERVED_SYNTHDEF_PREFIX = 'sonic-pi-'

export interface SynthDefCheck {
  file: SynthDefFile | null
  /** Problems that must stop the file from reaching the server. */
  errors: string[]
  /** Things that will load and run, but behave unexpectedly in Sonic Web. */
  warnings: string[]
}

function checkGraph(def: SynthDefGraph, errors: string[], warnings: string[]) {
  const where = `SynthDef "${def.name}"`
  if (!def.name) errors.push('a SynthDef has an empty name')
  if (def.name.startsWith(RESERVED_SYNTHDEF_PREFIX)) {
    errors.push(`${where}: names starting with "${RESERVED_SYNTHDEF_PREFIX}" are Sonic Pi's built-in synths and can't be replaced`)
  }
  for (const p of def.paramNames) {
    if (p.index < 0 || p.index >= def.params.length) {
      errors.push(`${where}: parameter "${p.name}" points at slot ${p.index}, but there are ${def.params.length} slots`)
    }
  }
  def.ugens.forEach((u, i) => {
    const label = `${where}, UGen ${i} (${u.name})`
    const unsupported = BROWSER_UNSUPPORTED_UGENS.get(u.name)
    if (unsupported) errors.push(`${label} ${unsupported}`)
    if (u.rate < 0 || u.rate > 3) errors.push(`${label}: unknown calculation rate ${u.rate}`)
    u.inputs.forEach(([src, idx], j) => {
      if (src === -1) {
        if (idx < 0 || idx >= def.constants.length) {
          errors.push(`${label}, input ${j}: constant ${idx} does not exist (there are ${def.constants.length})`)
        }
      } else if (src < 0 || src >= def.ugens.length) {
        errors.push(`${label}, input ${j}: reads from UGen ${src}, which does not exist`)
      } else if (src >= i) {
        // sclang and Overtone always order UGens after their inputs; a forward or self
        // reference would read whatever that wire held from the previous block.
        errors.push(`${label}, input ${j}: reads from UGen ${src}, which runs later in the graph`)
      } else if (idx < 0 || idx >= def.ugens[src].outputRates.length) {
        errors.push(`${label}, input ${j}: reads output ${idx} of UGen ${src} (${def.ugens[src].name}), which has ${def.ugens[src].outputRates.length}`)
      }
    })
  })
  if (!def.ugens.some((u) => OUTPUT_UGENS.has(u.name))) {
    warnings.push(`${where} has no Out UGen, so it will make no sound`)
  }
  if (!def.paramNames.some((p) => p.name === 'out_bus')) {
    warnings.push(`${where} has no out_bus parameter, so it can't follow Sonic Web's per-loop routing (and with_fx won't reach it)`)
  }
  const frees = def.ugens.some((u) => {
    if (ALWAYS_FREES.has(u.name)) return true
    const at = DONE_ACTION_INPUT.get(u.name)
    if (at === undefined || at >= u.inputs.length) return false
    const [src, idx] = u.inputs[at]
    if (src !== -1) return true // set by a parameter or signal — may free; don't warn
    return (def.constants[idx] ?? 0) >= 2
  })
  if (!frees) {
    warnings.push(`${where} never frees itself (no envelope or Line with doneAction: 2), so every note keeps running until Stop`)
  }
}

/** Decode and check a SynthDef file. Never throws; problems come back as errors/warnings. */
export function checkSynthDefFile(input: Uint8Array | ArrayBuffer): SynthDefCheck {
  let file: SynthDefFile
  try {
    file = decodeSynthDefFile(input)
  } catch (e) {
    return { file: null, errors: [e instanceof Error ? e.message : String(e)], warnings: [] }
  }
  const errors: string[] = []
  const warnings: string[] = []
  const seen = new Set<string>()
  for (const def of file.defs) {
    if (seen.has(def.name)) errors.push(`the file defines "${def.name}" twice`)
    seen.add(def.name)
    checkGraph(def, errors, warnings)
  }
  return { file, errors, warnings }
}
