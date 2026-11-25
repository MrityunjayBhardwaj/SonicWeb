import { describe, it, expect } from 'vitest'
import { scanComponentNames, scanSynthDefLoads } from '../ComponentScan'

const s = (code: string) => {
  const m = scanComponentNames(code)
  return {
    samples: [...m.samples].sort(),
    fx: [...m.fx].sort(),
    synths: [...m.synths].sort(),
  }
}

describe('scanComponentNames (#318.3 / #323 static extractor)', () => {
  it('finds symbol, string, and paren literal forms', () => {
    expect(s('sample :bd_haus')).toMatchObject({ samples: ['bd_haus'] })
    expect(s('sample "bd_haus"')).toMatchObject({ samples: ['bd_haus'] })
    expect(s("sample('bd_haus', amp: 2)")).toMatchObject({ samples: ['bd_haus'] })
  })

  it('separates use_synth / synth / with_fx into the right buckets', () => {
    const r = s('use_synth :prophet\nsynth :saw, note: 60\nwith_fx :reverb do\nend')
    expect(r.synths).toEqual(['prophet', 'saw'])
    expect(r.fx).toEqual(['reverb'])
  })

  it('does NOT mistake the synth inside use_synth for a separate synth ref', () => {
    // \b before `synth` cannot match mid-word in `use_synth` (_ is a word char).
    expect(s('use_synth :tb303')).toEqual({ samples: [], fx: [], synths: ['tb303'] })
  })

  it('collects the synth inside with_synth :x (#568 — else its synthdef never preloads → first /s_new silent)', () => {
    expect(s('with_synth :dsaw do\n  play :e3\nend')).toEqual({
      samples: [], fx: [], synths: ['dsaw'],
    })
    // tron_bike shape: with_synth is the ONLY reference to :dsaw.
    expect(s('live_loop :t do\n  with_synth :dsaw do\n    play :e1\n  end\n  sleep 8\nend').synths)
      .toEqual(['dsaw'])
  })

  it('does NOT mistake with_synth_defaults for a synth ref (no name after the keyword)', () => {
    // `\(?\s*[:"']` cannot match the `_` that follows `with_synth` in the _defaults form.
    expect(s('with_synth_defaults release: 2\nplay :e3')).toEqual({
      samples: [], fx: [], synths: [],
    })
  })

  it('deduplicates repeated references', () => {
    expect(s('sample :bd_haus\nsleep 1\nsample :bd_haus').samples).toEqual(['bd_haus'])
  })

  it('a commented-out reference must NOT be collected (no false-block)', () => {
    expect(s('# sample :typo_should_not_block\nsample :bd_haus').samples).toEqual([
      'bd_haus',
    ])
    expect(s('sample :bd_haus  # with_fx :ghost').fx).toEqual([])
  })

  it('strips =begin/=end block comments', () => {
    const code = '=begin\nsample :commented_out\n=end\nsample :real'
    expect(s(code).samples).toEqual(['real'])
  })

  it('preserves #{} interpolation (only # not followed by { is a comment)', () => {
    // The `#{i}` must not truncate the line; the literal name is still found.
    expect(s('with_fx :echo do\n  play "#{note}"\nend').fx).toEqual(['echo'])
  })

  it('a # inside a string does not hide a reference after it (#624)', () => {
    expect(s('puts "step #1"; sample :bd_haus').samples).toEqual(['bd_haus'])
    expect(s("puts 'a # b'; with_fx :echo do\nend").fx).toEqual(['echo'])
    // …but a real comment after such a string is still a comment.
    expect(s('puts "#1" # sample :ghost').samples).toEqual([])
    // An escaped quote does not end the string, so the # after it is still inside.
    expect(s('puts "a\\"#b"; sample :bd_haus').samples).toEqual(['bd_haus'])
    expect(s("puts 'it\\'s #1'; sample :bd_haus").samples).toEqual(['bd_haus'])
  })

  it('does NOT collect runtime-computed names (bounded by design)', () => {
    const r = s('use_synth SYNTHS.tick\nsample samps.choose\nwith_fx fx_name')
    expect(r).toEqual({ samples: [], fx: [], synths: [] })
  })

  it('collects user_ custom sample names (resolver applies the exemption, not the scanner)', () => {
    expect(s('sample :user_mykick').samples).toEqual(['user_mykick'])
  })

  it('handles a realistic multi-component snippet', () => {
    const code = `
      use_synth :tb303
      live_loop :bass do
        with_fx :reverb do
          synth :saw, note: 40
          sample :bd_haus
        end
        sleep 1
      end
    `
    expect(s(code)).toEqual({
      samples: ['bd_haus'],
      fx: ['reverb'],
      synths: ['saw', 'tb303'],
    })
  })

  it('resolves synth aliases so the preflight loads the real synthdef (SP89 / #337)', () => {
    // `:sine` has no `sonic-pi-sine.scsyndef` in the CDN package — it aliases
    // to `beep`. The preflight resolver consumes this scan; keeping the raw
    // name fetches a 404 (SP89 CORS-masquerade) and the 5s preflight
    // spuriously times out on every `:sine` Run. SV14.
    expect(s('use_synth :sine\nplay :a3')).toMatchObject({ synths: ['beep'] })
    expect(s('synth :mod_beep, note: 60')).toMatchObject({ synths: ['mod_sine'] })
    // Non-aliased synths pass through; samples/FX have no alias layer.
    expect(s('use_synth :prophet\nwith_fx :reverb do\nend')).toMatchObject({
      synths: ['prophet'],
      fx: ['reverb'],
    })
  })

  it('empty / component-free code yields empty sets', () => {
    expect(s('play 60\nsleep 1')).toEqual({ samples: [], fx: [], synths: [] })
    expect(s('')).toEqual({ samples: [], fx: [], synths: [] })
  })
})

describe('scanSynthDefLoads (#622)', () => {
  it('collects literal URLs in source order, de-duplicated, ignoring comments', () => {
    const code = `
      load_synthdef "https://a.example/one.scsyndef"
      load_synthdef('two.scsyndef')
      # load_synthdef "commented-out.scsyndef"
      load_synthdef "https://a.example/one.scsyndef"
      synth :one
    `
    expect(scanSynthDefLoads(code)).toEqual({ urls: ['https://a.example/one.scsyndef', 'two.scsyndef'], dynamic: 0, folders: 0 })
  })
  it('counts computed URLs and folder loads instead of guessing', () => {
    const code = 'base = "x"\nload_synthdef base\nload_synthdef "#{base}/y.scsyndef"\nload_synthdefs "~/synths"'
    expect(scanSynthDefLoads(code)).toEqual({ urls: [], dynamic: 2, folders: 1 })
  })
  it('keeps a # inside the URL string (#624) — it is not a comment', () => {
    expect(scanSynthDefLoads('load_synthdef "https://ex.com/web_bass.scsyndef#v2"').urls).toEqual([
      'https://ex.com/web_bass.scsyndef#v2',
    ])
    expect(scanSynthDefLoads("load_synthdef 'https://ex.com/a.scsyndef#x' # load_synthdef 'ghost'").urls).toEqual([
      'https://ex.com/a.scsyndef#x',
    ])
  })
  it('still strips a real comment after a quoted string that contains #', () => {
    // The trailing comment holds a second call; it must not be collected.
    expect(scanSynthDefLoads('load_synthdef "a#b.scsyndef" # load_synthdef "c.scsyndef"')).toEqual({
      urls: ['a#b.scsyndef'], dynamic: 0, folders: 0,
    })
  })
  it('finds nothing in code without load_synthdef', () => {
    expect(scanSynthDefLoads('use_synth :saw\nplay 60')).toEqual({ urls: [], dynamic: 0, folders: 0 })
  })
})
