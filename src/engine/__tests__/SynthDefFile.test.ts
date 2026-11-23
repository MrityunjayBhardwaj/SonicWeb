import { describe, it, expect } from 'vitest'
import { decodeSynthDefFile, checkSynthDefFile, SynthDefFormatError } from '../SynthDefFile'
import { buildTrackMonitorSynthDef } from '../buildTrackMonitorSynthDef'

/**
 * #622 — SynthDef decoder + checker. The checker is the only thing between user bytes and
 * /d_recv that looks at graph wiring (the live server accepted an input pointing at a
 * UGen that doesn't exist), so every rule here has a case that must fire and one that must not.
 */

// Minimal SCgf v1 writer for test graphs (same layout as buildTrackMonitorSynthDef).
interface G {
  name: string
  constants?: number[]
  params?: Array<[string, number]>
  ugens: Array<{ name: string; rate?: number; inputs: Array<[number, number]>; outputs?: number; special?: number }>
}
function writeV1(g: G): Uint8Array {
  const out: number[] = []
  const i16 = (v: number) => out.push((v >> 8) & 0xff, v & 0xff)
  const i32 = (v: number) => out.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff)
  const f32 = (v: number) => { const d = new DataView(new ArrayBuffer(4)); d.setFloat32(0, v); for (let i = 0; i < 4; i++) out.push(d.getUint8(i)) }
  const ps = (s: string) => { out.push(s.length); for (const c of s) out.push(c.charCodeAt(0)) }
  const consts = g.constants ?? []
  const params = g.params ?? []
  out.push(0x53, 0x43, 0x67, 0x66); i32(1); i16(1); ps(g.name)
  i16(consts.length); consts.forEach(f32)
  i16(params.length); params.forEach(([, v]) => f32(v))
  i16(params.length); params.forEach(([n], i) => { ps(n); i16(i) })
  i16(g.ugens.length)
  for (const u of g.ugens) {
    const rate = u.rate ?? 2
    const outs = u.outputs ?? 1
    ps(u.name); out.push(rate); i16(u.inputs.length); i16(outs); i16(u.special ?? 0)
    for (const [a, b] of u.inputs) { i16(a); i16(b) }
    for (let k = 0; k < outs; k++) out.push(rate)
  }
  i16(0)
  return Uint8Array.from(out)
}

/** A well-behaved Sonic Pi-style synth: note → Saw × percussive envelope that frees itself. */
const GOOD: G = {
  name: 'web_bass',
  constants: [0, 1, 2],
  params: [['note', 52], ['amp', 1], ['release', 0.3], ['out_bus', 0]],
  ugens: [
    { name: 'Control', rate: 1, inputs: [], outputs: 4 },
    { name: 'UnaryOpUGen', rate: 1, special: 17, inputs: [[0, 0]] }, // midicps
    { name: 'Saw', inputs: [[1, 0]] },
    // EnvGen(gate, levelScale, levelBias, timeScale, doneAction=2, …)
    { name: 'EnvGen', rate: 1, inputs: [[-1, 1], [-1, 1], [-1, 0], [0, 2], [-1, 2]] },
    { name: 'BinaryOpUGen', special: 2, inputs: [[2, 0], [3, 0]] },
    { name: 'Out', inputs: [[0, 3], [4, 0], [4, 0]], outputs: 0 },
  ],
}
const clone = (g: G): G => JSON.parse(JSON.stringify(g))

// sclang 3.14.1 output for `SynthDef(\patch_saw_lpf, {|freq=220, cutoff=2000, amp=0.3, out_bus=0|
//   var s = LPF.ar(Saw.ar(freq), cutoff) * amp; Out.ar(out_bus, [s, s]) })` — a real v2 file.
const SCLANG_V2_HEX =
  '534367660000000200010d70617463685f7361775f6c70660000000000000004435c000044fa00003e99999a0000000000000004046672657100000000066375746f66660000000103616d7000000002076f75745f627573000000030000000507436f6e74726f6c010000000000000004000001010101035361770200000001000000010000000000000000000002034c5046020000000200000001000000000001000000000000000000000001020c42696e6172794f705547656e02000000020000000100020000000200000000000000000000000202034f757402000000030000000000000000000000000003000000030000000000000003000000000000'
const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)))

describe('decodeSynthDefFile', () => {
  it('decodes the engine’s own hand-written track monitor (v1)', () => {
    const f = decodeSynthDefFile(buildTrackMonitorSynthDef())
    expect(f.version).toBe(1)
    expect(f.byteLength).toBe(246)
    expect(f.defs[0].name).toBe('sonic_pi_track_monitor')
    expect(f.defs[0].ugens.map((u) => u.name)).toEqual(['Control', 'In', 'BinaryOpUGen', 'BinaryOpUGen', 'Out', 'Out'])
    expect(f.defs[0].paramNames.map((p) => p.name)).toEqual(['in_bus', 'out_bus_master', 'out_bus_track', 'amp'])
  })

  it('decodes a real sclang-compiled v2 file', () => {
    const f = decodeSynthDefFile(hex(SCLANG_V2_HEX))
    expect(f.version).toBe(2)
    expect(f.defs[0].name).toBe('patch_saw_lpf')
    expect(f.defs[0].ugens.map((u) => u.name)).toEqual(['Control', 'Saw', 'LPF', 'BinaryOpUGen', 'Out'])
    expect(f.defs[0].params[0]).toBe(220)
  })

  it('rejects bad magic, unknown versions, truncation and trailing bytes', () => {
    const ok = writeV1(GOOD)
    const magic = ok.slice(); magic[0] = 0x58
    expect(() => decodeSynthDefFile(magic)).toThrow(/SCgf/)
    const ver = ok.slice(); ver[7] = 3
    expect(() => decodeSynthDefFile(ver)).toThrow(/version 3/)
    for (const cut of [3, 10, 40, ok.length - 1]) {
      expect(() => decodeSynthDefFile(ok.slice(0, cut))).toThrow(SynthDefFormatError)
    }
    expect(() => decodeSynthDefFile(Uint8Array.from([...ok, 0]))).toThrow(/unexpected bytes/)
  })
})

describe('checkSynthDefFile', () => {
  it('passes a well-formed self-freeing synth with no errors and no warnings', () => {
    const c = checkSynthDefFile(writeV1(GOOD))
    expect(c.errors).toEqual([])
    expect(c.warnings).toEqual([])
  })

  it('passes the sclang file (no envelope → only the never-frees warning)', () => {
    const c = checkSynthDefFile(hex(SCLANG_V2_HEX))
    expect(c.errors).toEqual([])
    expect(c.warnings).toHaveLength(1)
    expect(c.warnings[0]).toMatch(/never frees itself/)
  })

  it('refuses an input wired to a UGen that does not exist (the server accepts this)', () => {
    const g = clone(GOOD); g.ugens[4].inputs[0] = [99, 0]
    expect(checkSynthDefFile(writeV1(g)).errors.join()).toMatch(/UGen 99, which does not exist/)
  })

  it('refuses a forward reference (reads a UGen that runs later)', () => {
    const g = clone(GOOD); g.ugens[2].inputs[0] = [4, 0]
    expect(checkSynthDefFile(writeV1(g)).errors.join()).toMatch(/runs later in the graph/)
  })

  it('refuses a missing output index and a missing constant', () => {
    const g = clone(GOOD); g.ugens[4].inputs[0] = [2, 1] // Saw has 1 output
    expect(checkSynthDefFile(writeV1(g)).errors.join()).toMatch(/output 1 of UGen 2 \(Saw\), which has 1/)
    const h = clone(GOOD); h.ugens[3].inputs[0] = [-1, 7]
    expect(checkSynthDefFile(writeV1(h)).errors.join()).toMatch(/constant 7 does not exist/)
  })

  it('refuses UGens the browser engine does not have, naming the reason', () => {
    const g = clone(GOOD); g.ugens[2] = { name: 'MouseX', rate: 1, inputs: [[-1, 0], [-1, 1], [-1, 0], [-1, 0]] }
    expect(checkSynthDefFile(writeV1(g)).errors.join()).toMatch(/MouseX\) needs the mouse/)
    const d = clone(GOOD); d.ugens[2] = { name: 'DiskOut', inputs: [[-1, 0], [1, 0]] }
    expect(checkSynthDefFile(writeV1(d)).errors.join()).toMatch(/no file system/)
  })

  it('refuses names that would replace a built-in Sonic Pi synth', () => {
    const g = clone(GOOD); g.name = 'sonic-pi-saw'
    expect(checkSynthDefFile(writeV1(g)).errors.join()).toMatch(/built-in synths/)
  })

  it('refuses a parameter name pointing past the parameter slots', () => {
    const bytes = writeV1(GOOD)
    // The "out_bus" name entry is followed by its int16 slot (3); point it at slot 9.
    const needle = [...'out_bus'].map((c) => c.charCodeAt(0))
    const at = bytes.findIndex((_, i) => needle.every((c, k) => bytes[i + k] === c)) + 7
    const b = bytes.slice(); b[at + 1] = 9
    expect(checkSynthDefFile(b).errors.join()).toMatch(/points at slot 9/)
  })

  it('warns (but allows) no Out, no out_bus, and no way to free itself', () => {
    const g = clone(GOOD)
    g.ugens[3].inputs[4] = [-1, 0] // doneAction 0 → never frees
    const c = checkSynthDefFile(writeV1(g))
    expect(c.errors).toEqual([])
    expect(c.warnings.join()).toMatch(/never frees itself/)

    const noOut = clone(GOOD); noOut.ugens.pop()
    expect(checkSynthDefFile(writeV1(noOut)).warnings.join()).toMatch(/no Out UGen/)

    const noBus = clone(GOOD); noBus.params![3][0] = 'bus'
    expect(checkSynthDefFile(writeV1(noBus)).warnings.join()).toMatch(/no out_bus parameter/)
  })

  it('does not warn about freeing when doneAction comes from a parameter', () => {
    const g = clone(GOOD); g.ugens[3].inputs[4] = [0, 1] // doneAction ← amp param (unknown until run time)
    expect(checkSynthDefFile(writeV1(g)).warnings).toEqual([])
  })

  it('never throws: a corrupt file comes back as an error', () => {
    const c = checkSynthDefFile(Uint8Array.from([1, 2, 3]))
    expect(c.file).toBeNull()
    expect(c.errors[0]).toMatch(/file ends early|SCgf/)
  })
})
