/**
 * Static component scan — extract the LITERAL sample / FX / synth names a
 * piece of user code references, without building or running it. The
 * pre-Run path of the preflight EPIC (#318, child #318.3 / #323).
 *
 * Why static (not the #321 Step-walker): loop Programs are built lazily
 * per-iteration inside the scheduler (`SonicPiEngine.ts:694`); there is no
 * pre-Run moment where Step[]s exist, and re-running builderFn to get them
 * is an SP72 build-phase-state-mutation hazard. A textual scan of the user
 * code is the only side-effect-free pre-Run option. The result feeds the
 * unchanged `ComponentResolver` (#322) — same `ComponentManifest` shape.
 *
 * BOUNDED BY DESIGN: only LITERAL names are found —
 *   `sample :x` / `sample "x"` / `sample('x')`
 *   `use_synth :x` · `synth :x` · `with_fx :x`  (and quoted/paren forms)
 * Runtime-computed names (`sample SAMPS.tick`, a name from a variable) are
 * deliberately NOT found: they cannot be known pre-Run, so they are not
 * preflighted and not blocked — they fall back to normal lazy-load (which,
 * post-#320/#317, self-heals on transient failure). This is the precise,
 * intended limit, not a gap to paper over. Literal names are exactly the
 * set that bites users (typos, SP89 never-shipped names are always literal).
 *
 * Over-collection is harmless (a real, loadable name just resolves).
 * Under-collection of a literal, or collecting a name from a COMMENT,
 * is not: a commented-out `sample :typo` must never block Run — so
 * comments are stripped before scanning.
 */

import type { ComponentManifest } from './ComponentManifest'
import { resolveSynthName } from './SoundLayer'

/**
 * Strip Ruby comments so a commented-out `sample :typo` cannot false-block
 * Run. Handles line comments (`#` … EOL) and `=begin`/`=end` block
 * comments. A `#` inside a `"…"` or `'…'` string (backslash escapes
 * respected) is NOT a comment — `load_synthdef` URLs routinely carry one
 * (`…/bass.scsyndef#v2`, #624), and `"#{x}"` interpolation lives there too.
 * Strings are tracked per line: one left open at end of line keeps the
 * rest of that line (over-collection is harmless; a false comment cut is
 * not). Not handled: `%q()`-style literals and heredocs.
 */
function stripComments(code: string): string {
  const withoutBlocks = code.replace(/^=begin\b[\s\S]*?^=end\b.*$/gm, '')
  return withoutBlocks
    .split('\n')
    .map((line) => {
      let quote: string | null = null
      for (let i = 0; i < line.length; i++) {
        const c = line[i]
        if (quote) {
          if (c === '\\') i++ // skip the escaped character
          else if (c === quote) quote = null
        } else if (c === '"' || c === "'") {
          quote = c
        } else if (c === '#') {
          return line.slice(0, i)
        }
      }
      return line
    })
    .join('\n')
}

// `\bsample\s*\(?\s*[:"']([name])` — `\b` before `synth` does NOT match the
// `synth` inside `use_synth` (`_` is a word char → no boundary), so the two
// patterns are unambiguous. Name = Ruby ident: letter/underscore start.
const NAME = '([a-zA-Z_][a-zA-Z0-9_]*)'
const PATTERNS: ReadonlyArray<[keyof ComponentManifest, RegExp]> = [
  ['samples', new RegExp(`\\bsample\\s*\\(?\\s*[:"']${NAME}`, 'g')],
  ['synths', new RegExp(`\\buse_synth\\s*\\(?\\s*[:"']${NAME}`, 'g')],
  // `with_synth :x do … end` references a synth just like `use_synth :x`, but the
  // `\bsynth` pattern below CANNOT catch it (the `_` before `synth` kills the word
  // boundary — same reason it skips `use_synth`). Without its own pattern, a synth
  // used ONLY inside `with_synth` (e.g. tron_bike's `:dsaw`) is never preloaded →
  // its first `play` takes the slow `ensureSynthDefLoaded().then()` path, whose
  // `/s_new` is queued AFTER the iteration's synchronous flush → the first node is
  // silently dropped (#568). Mirrors the `with_fx` line. `\(?\s*[:"']` after the
  // name does NOT match `with_synth_defaults …` (the next char is `_`, not a
  // separator), so that DSL form is correctly ignored.
  ['synths', new RegExp(`\\bwith_synth\\s*\\(?\\s*[:"']${NAME}`, 'g')],
  ['synths', new RegExp(`\\bsynth\\s*\\(?\\s*[:"']${NAME}`, 'g')],
  ['fx', new RegExp(`\\bwith_fx\\s*\\(?\\s*[:"']${NAME}`, 'g')],
]

/**
 * Scan user code for literal component references. Pure: input string →
 * name Sets. Feeds `resolveComponentManifest` (#322) unchanged.
 */
export function scanComponentNames(code: string): ComponentManifest {
  const manifest: ComponentManifest = {
    samples: new Set(),
    fx: new Set(),
    synths: new Set(),
  }
  const src = stripComments(code)
  for (const [bucket, re] of PATTERNS) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(src)) !== null) {
      // SV14: resolve the synth alias (`:sine`→`beep`, `:mod_beep`→`mod_sine`)
      // at scan time so the preflight loads the synthdef the runtime will
      // actually /s_new (AudioInterpreter.ts:110 resolves identically). The
      // CDN package ships no `sonic-pi-sine.scsyndef`; without this the
      // preflight resolver fetches a 404 (SP89 CORS-masquerade) and the
      // 5s preflight spuriously times out on every `:sine` Run. Samples/FX
      // have no alias layer — pass through unchanged.
      manifest[bucket].add(bucket === 'synths' ? resolveSynthName(m[1]) : m[1])
    }
  }
  return manifest
}

/**
 * #622: `load_synthdef "<url>"` calls, found the same way as component names (literal,
 * comments stripped) so the pre-Run step can fetch, check and load each SynthDef BEFORE
 * the component preflight sees `synth :name` — otherwise the preflight would refuse Run
 * for a custom synth it cannot find on the CDN.
 *
 * `urls`     literal string arguments, in source order, de-duplicated.
 * `dynamic`  calls whose argument is not a string literal (can't be known before Run).
 * `folders`  `load_synthdefs` calls — desktop loads a whole directory; the browser has none.
 */
export interface SynthDefLoadScan {
  urls: string[]
  dynamic: number
  folders: number
}

export function scanSynthDefLoads(code: string): SynthDefLoadScan {
  const src = stripComments(code)
  const urls: string[] = []
  let dynamic = 0
  let folders = 0
  const call = /\bload_synthdef(s?)\b\s*\(?\s*(.?)/g
  let m: RegExpExecArray | null
  while ((m = call.exec(src)) !== null) {
    if (m[1] === 's') { folders++; continue }
    const q = m[2]
    if (q !== '"' && q !== "'") { dynamic++; continue }
    const start = m.index + m[0].length
    const end = src.indexOf(q, start)
    if (end < 0) { dynamic++; continue }
    const url = src.slice(start, end)
    if (q === '"' && url.includes('#{')) { dynamic++; continue } // Ruby interpolation
    if (!urls.includes(url)) urls.push(url)
  }
  return { urls, dynamic, folders }
}
